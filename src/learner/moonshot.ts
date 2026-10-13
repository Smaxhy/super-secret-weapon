/**
 * Moonshot test mode (owner: "if the bot sees mega REAL volume on a migrated coin with a good narrative and KOLs buying,
 * enter early, let it moon and clip along the way"). For now it only TESTS the idea, with no money: every 15 s it scans
 * migrated coins; when ALL signals line up (huge organic buying, ≥2 KOLs still holding, on a trending list) it opens two
 * pretend trades through the bot's own exit engine (VirtualBook, same prices and fees): "M" = moonshot exits (smaller
 * clips on the way up, wide trail, long hold) and "L" = the normal live exits. The report shows how many setups there
 * were and which exits made more. `moonshot.live` stays off until the owner switches it on.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { BotConfigShape } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { getSolUsd } from '../lib/sol-price';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { kolActivity } from '../scanner/kol-signal';
import { organicFlow, type OrganicFlow } from '../scanner/migrated-scanner';
import { VirtualBook, type VirtualResult } from './virtual-book';

type ExitRules = BotConfigShape['exit'];

const log = moduleLogger('moonshot');
const RES = 'moon:res';

export type MoonshotConfig = (typeof DEFAULT_CONFIG)['moonshot'];

export interface MoonSignals {
  flow: OrganicFlow | null;
  mcUsd: number | null;
  kolsHolding: number;
  trendLists: number;
  dexTrending: boolean;
}

/** Pure: do ALL moonshot signals line up? Returns the first thing missing, or null. */
export function moonshotVerdict(s: MoonSignals, c: MoonshotConfig): string | null {
  const f = s.flow;
  if (!f) return 'too few trades';
  if (f.buyers < c.minBuyers5m) return `${f.buyers} real buyers (need ${c.minBuyers5m})`;
  if (f.buySol < c.minBuySol5m) return `${f.buySol} SOL real buying (need ${c.minBuySol5m})`;
  if (f.buySharePct < c.minBuySharePct) return `buyers ${f.buySharePct}% of volume`;
  if (f.organicPct < c.minOrganicPct) return `only ${f.organicPct}% organic`;
  if (f.run3mPct !== null && f.run3mPct > c.maxRun3mPct) return `already +${f.run3mPct}% in 3 min`;
  if (s.mcUsd !== null && s.mcUsd < c.minMarketCapUsd) return 'market cap too small';
  if (s.kolsHolding < c.minKolsHolding) return `${s.kolsHolding} KOLs holding (need ${c.minKolsHolding})`;
  if (c.needTrend && s.trendLists === 0 && !s.dexTrending) return 'not on any trending list';
  return null;
}

/** Pure: the moonshot exit rules layered over the live ones (smaller clips, wider trail, longer hold). */
export function moonshotRules(live: ExitRules, c: MoonshotConfig): ExitRules {
  const e = c.exits;
  const l = live as unknown as Record<string, unknown> & { trail: Record<string, unknown>; maxHoldMinutes?: Record<string, number> };
  return {
    ...l,
    takeProfitTiers: e.tiers,
    initials: { atMultiple: 1_000, feeBufferPct: 4 }, // the tiers already take the stake back
    trailingStopActivateMultiple: e.trailFrom,
    trail: { ...l.trail, breakEvenAfterMultiple: e.trailFrom, ladder: e.trailLadder },
    maxHoldMinutes: { ...(l.maxHoldMinutes ?? {}), MIGRATION_MOMENTUM: e.maxHoldMinutes },
  } as unknown as ExitRules;
}

export interface MoonResult {
  mint: string;
  symbol: string;
  variant: 'M' | 'L';
  openedAtMs: number;
  closedAtMs: number;
  pnlPct: number;
  peakX: number;
  holdSec: number;
  exitReason: string;
  why: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export class MoonshotLab {
  private readonly book: VirtualBook;
  private readonly last = new Map<string, number>();
  private readonly meta = new Map<string, { openedAtMs: number; why: string }>();
  private timer: NodeJS.Timeout | null = null;
  private stepper: NodeJS.Timeout | null = null;
  readonly stats = { scans: 0, setups: 0, lastSetups: [] as Array<{ mint: string; symbol: string; at: string; why: string }> };

  constructor(
    private readonly redis: Redis,
    private readonly crowd: CrowdTracker,
    private readonly trend: (mint: string) => { lists: number; dex: boolean },
    private readonly symbolOf: (mint: string) => Promise<string>,
    private readonly cfg: () => MoonshotConfig = () => getConfig().moonshot ?? DEFAULT_CONFIG.moonshot,
  ) {
    this.book = new VirtualBook(
      crowd,
      (tag, live) => (tag.variant === 'M' ? moonshotRules(live, this.cfg()) : live),
      (r) => this.save(r),
      () => this.cfg().maxOpen,
    );
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), Math.max(5, this.cfg().everySec) * 1000);
    this.stepper = setInterval(() => this.book.stepAll(), 1_000);
    this.timer.unref?.();
    this.stepper.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.stepper) clearInterval(this.stepper);
  }

  onTrade(mint: string, now = Date.now()): void {
    this.book.onTrade(mint, now);
  }

  async tick(now = Date.now()): Promise<number> {
    const c = this.cfg();
    if (!c.enabled) return 0;
    let opened = 0;
    try {
      this.stats.scans++;
      const sol = await getSolUsd().catch(() => null);
      const kolCfg = getConfig().kol ?? DEFAULT_CONFIG.kol;
      for (const mint of this.crowd.activeAmmMints(120_000, now)) {
        if (now - (this.last.get(mint) ?? 0) < c.cooldownMin * 60_000) continue;
        const flow = organicFlow(this.crowd.trades(mint), now);
        // cheap checks first; KOL lookup (Redis) only for coins with real mega flow
        if (!flow || flow.buyers < c.minBuyers5m || flow.buySol < c.minBuySol5m) continue;
        const kol = await kolActivity(this.redis, mint, kolCfg, now).catch(() => null);
        const sellers = new Set((kol?.recentSellers ?? []).map((s) => s.wallet));
        const kolsHolding = (kol?.buyers ?? []).filter((b) => !sellers.has(b.wallet)).length;
        const t = this.trend(mint);
        const mcUsd = sol ? flow.priceSol * 1e9 * sol : null;
        if (moonshotVerdict({ flow, mcUsd, kolsHolding, trendLists: t.lists, dexTrending: t.dex }, c) !== null) continue;
        this.last.set(mint, now);
        const symbol = await this.symbolOf(mint).catch(() => mint.slice(0, 6));
        const why = `${flow.buyers} real buyers, ${flow.buySol} SOL in 5 min (${flow.buySharePct}% buys), ${kolsHolding} KOLs holding, ${t.lists} trending lists${t.dex ? ' + DexScreener' : ''}`;
        for (const variant of ['M', 'L'] as const) {
          const key = `moon:${variant}:${mint}:${now}`;
          if (this.book.add({ key, mint, symbol, strategy: 'MIGRATION_MOMENTUM', onAmm: true, priceSol: flow.priceSol, tag: { variant } }, now)) this.meta.set(key, { openedAtMs: now, why });
        }
        this.stats.setups++;
        this.stats.lastSetups = [{ mint, symbol, at: new Date(now).toISOString(), why }, ...this.stats.lastSetups].slice(0, 20);
        log.info({ mint, why }, `🌙 ${symbol}: moonshot setup (test mode)`);
        opened++;
      }
      if (this.last.size > 20_000) this.last.clear();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'moonshot scan failed');
    }
    return opened;
  }

  private save(v: VirtualResult): void {
    const m = this.meta.get(v.key);
    this.meta.delete(v.key);
    const r: MoonResult = { mint: v.mint, symbol: v.symbol, variant: v.tag.variant === 'M' ? 'M' : 'L', openedAtMs: m?.openedAtMs ?? v.at, closedAtMs: v.at, pnlPct: r1(v.pnlPct), peakX: Math.round(v.peakX * 100) / 100, holdSec: Math.round(v.holdSec), exitReason: v.reason.slice(0, 80), why: m?.why ?? '' };
    void this.redis.multi().lpush(RES, JSON.stringify(r)).ltrim(RES, 0, this.cfg().keep - 1).exec().catch((err: Error) => log.warn({ err: err.message }, 'moonshot result not saved'));
  }

  async results(): Promise<MoonResult[]> {
    const raw = await this.redis.lrange(RES, 0, this.cfg().keep - 1);
    const out: MoonResult[] = [];
    for (const x of raw) {
      try {
        out.push(JSON.parse(x) as MoonResult);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async report(): Promise<ReturnType<typeof moonReport> & { live: boolean; open: number; setups: number; lastSetups: MoonshotLab['stats']['lastSetups'] }> {
    return { ...moonReport(await this.results()), live: this.cfg().live, open: this.book.size, setups: this.stats.setups, lastSetups: this.stats.lastSetups };
  }
}

/** Pure: moonshot exits vs normal exits on the same setups. */
export function moonReport(rows: readonly MoonResult[]) {
  const agg = (v: 'M' | 'L') => {
    const rs = rows.filter((r) => r.variant === v);
    const n = rs.length;
    return {
      n,
      avgPct: n ? r1(rs.reduce((s, r) => s + r.pnlPct, 0) / n) : 0,
      winRatePct: n ? Math.round((rs.filter((r) => r.pnlPct > 0).length / n) * 100) : 0,
      went2xPct: n ? Math.round((rs.filter((r) => r.peakX >= 2).length / n) * 100) : 0,
      bestPct: n ? Math.max(...rs.map((r) => r.pnlPct)) : 0,
    };
  };
  return { moonshot: agg('M'), normal: agg('L'), recent: rows.filter((r) => r.variant === 'M').slice(0, 15) };
}
