/**
 * Outcome tracker (owner: "improve the learning drastically"): learn from EVERY coin the bot checks, not only the
 * ~100 it trades. Each coin it looked at and didn't buy (once per coin + strategy per `cooldownMin`) is remembered with
 * its entry features; `watchMin` later its real trade tape from the crowd log is replayed through the bot's own exit
 * engine (backtester.replayTape → VirtualBook → decideExit, same costs as paper) — "what would buying it right then
 * have made?". A coin with no trades after the check is a dead coin: it would have lost the round-trip costs.
 *
 * Results (Redis `outcome:res`, newest first, ≤ `keep`) join the brain's training rows at `weight` (learn-rows.ts), so
 * the win model / tree model / rule search learn from thousands of examples a day instead of a handful. No AI, no RPC:
 * the trades are already in memory. Bounded: ≤ `maxPending` waiting, ≤ `maxPerTick` replays a minute, yields between.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { poolFeeBps } from '../lib/pumpfun';
import { moduleLogger } from '../lib/logger';
import type { CrowdTrade } from '../scanner/crowd-tracker';
import { replayTape } from './backtester';

const log = moduleLogger('outcomes');
const RES = 'outcome:res';

export interface OutcomeSignal {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  atMs: number;
  onAmm: boolean;
  marketCapSol: number | null;
  score: number;
  bar: number;
  why: string;
  flat: Record<string, number>;
}

export interface OutcomeResult extends Omit<OutcomeSignal, 'onAmm' | 'marketCapSol'> {
  pnlPct: number;
  peakX: number;
  holdSec: number;
  exitReason: string;
  /** v11.17: the same coin through other exit-lab variants (id → % after costs) — "Where's the money" compares exits. */
  alt?: Record<string, number>;
}

export type OutcomeConfig = (typeof DEFAULT_CONFIG)['outcomes'];

const r1 = (x: number) => Math.round(x * 10) / 10;
/** Compact features for storage (4 significant digits). */
const compact = (flat: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(flat)) if (Number.isFinite(v)) out[k] = Number(v.toPrecision(4));
  return out;
};

/** Other exit settings to try on the same coin (exit-lab variant ids, `outcomes.altVariants`), as replay variants. */
export function altVariantsFor(ids: readonly string[], lab: ReadonlyArray<{ id: string; exit: Record<string, unknown> }>): Array<{ id: string; exit: Record<string, unknown> }> {
  return ids.flatMap((id) => {
    const v = lab.find((x) => x.id === id);
    // chart-reading exits off here too (CPU); the variant's own exit settings layer over that
    return v && id !== 'L' ? [{ id, exit: { priceAction: { enabled: false }, ...v.exit } }] : [];
  });
}

/** Pure: replay one remembered check on the trades that followed it (live exits, plus `alt` exit variants when given). */
export function outcomeOf(sig: OutcomeSignal, trades: readonly CrowdTrade[], watchMs: number, roundTripCostPct: number, alt: ReadonlyArray<{ id: string; exit: Record<string, unknown> }> = []): Omit<OutcomeResult, keyof OutcomeSignal | never> & { pnlPct: number; peakX: number; holdSec: number; exitReason: string; alt?: Record<string, number> } {
  const tape = trades.filter((t) => t.t >= sig.atMs && t.t <= sig.atMs + watchMs);
  const dead = r1(-roundTripCostPct);
  const deadAlt = alt.length ? Object.fromEntries(alt.map((v) => [v.id, dead])) : undefined;
  if (tape.length < 2) return { pnlPct: dead, peakX: 1, holdSec: Math.round(watchMs / 1000), exitReason: 'no trades after the check (dead coin)', ...(deadAlt ? { alt: deadAlt } : {}) };
  // (chart-reading exits off in the replay: they re-read the chart every simulated second — too much CPU for thousands of coins)
  const all = replayTape(sig.mint, tape, [{ id: 'o', mint: sig.mint, symbol: sig.symbol, strategy: sig.strategy, openedAtMs: sig.atMs, onAmm: sig.onAmm, actualPnlPct: 0 }], [{ id: 'O', exit: { priceAction: { enabled: false } } }, ...alt]);
  const res = all.get('o:O');
  if (!res) return { pnlPct: dead, peakX: 1, holdSec: 0, exitReason: 'not replayable', ...(deadAlt ? { alt: deadAlt } : {}) };
  const altOut: Record<string, number> = {};
  for (const v of alt) altOut[v.id] = r1(all.get(`o:${v.id}`)?.pnlPct ?? dead);
  return { pnlPct: r1(res.pnlPct), peakX: Math.round(res.peakX * 100) / 100, holdSec: Math.round(res.holdSec), exitReason: res.reason.slice(0, 80), ...(alt.length ? { alt: altOut } : {}) };
}

export class OutcomeTracker {
  private readonly pending: OutcomeSignal[] = [];
  private readonly last = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  readonly stats = { recorded: 0, labelled: 0, dropped: 0, lastTickMs: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly trades: (mint: string) => readonly CrowdTrade[],
    private readonly cfg: () => OutcomeConfig = () => getConfig().outcomes ?? DEFAULT_CONFIG.outcomes,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** A coin the bot checked and didn't buy. */
  record(s: Omit<OutcomeSignal, 'flat'> & { flat: Record<string, number> }): boolean {
    const c = this.cfg();
    if (!c.enabled) return false;
    const k = `${s.mint}:${s.strategy}`;
    const prev = this.last.get(k);
    if (prev !== undefined && s.atMs - prev < c.cooldownMin * 60_000) return false;
    if (this.pending.length >= c.maxPending) {
      this.stats.dropped++;
      return false;
    }
    this.last.set(k, s.atMs);
    if (this.last.size > 50_000) for (const [x, t] of this.last) if (s.atMs - t > c.cooldownMin * 60_000) this.last.delete(x);
    this.pending.push({ ...s, flat: compact(s.flat) });
    this.stats.recorded++;
    return true;
  }

  /** Label everything that's old enough (≤ maxPerTick per run). */
  async tick(now = Date.now()): Promise<number> {
    const c = this.cfg();
    if (!c.enabled || this.busy) return 0;
    this.busy = true;
    const t0 = Date.now();
    let n = 0;
    try {
      const watchMs = c.watchMin * 60_000;
      const p = getConfig().paper;
      const alt = altVariantsFor(c.altVariants ?? [], (getConfig().lab?.variants ?? DEFAULT_CONFIG.lab.variants) as Array<{ id: string; exit: Record<string, unknown> }>);
      const rows: string[] = [];
      while (this.pending.length && this.pending[0]!.atMs <= now - watchMs && n < c.maxPerTick) {
        const sig = this.pending.shift()!;
        const cost = (2 * poolFeeBps(p, sig.onAmm, sig.marketCapSol)) / 100 + 2 * p.slippagePct;
        const o = outcomeOf(sig, this.trades(sig.mint), watchMs, cost, alt);
        const { onAmm: _a, marketCapSol: _m, ...rest } = sig;
        rows.push(JSON.stringify({ ...rest, ...o } satisfies OutcomeResult));
        n++;
        if (n % 10 === 0) await new Promise((r) => setImmediate(r));
      }
      if (rows.length) await this.redis.multi().lpush(RES, ...rows).ltrim(RES, 0, c.keep - 1).exec();
      this.stats.labelled += n;
      this.stats.lastTickMs = Date.now() - t0;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'outcome labelling failed');
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** Labelled outcomes, newest first (optionally only since `sinceMs`). */
  async results(sinceMs = 0): Promise<OutcomeResult[]> {
    const raw = await this.redis.lrange(RES, 0, this.cfg().keep - 1);
    const out: OutcomeResult[] = [];
    for (const x of raw) {
      try {
        const r = JSON.parse(x) as OutcomeResult;
        if (r.atMs >= sinceMs) out.push(r);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Brain page: how much it is learning from coins it didn't buy, and what those coins did. */
  async snapshot(): Promise<{ pending: number; stored: number; stats: OutcomeTracker['stats']; byStrategy: Array<{ strategy: string; n: number; avgPct: number; winRatePct: number; went2xPct: number }>; byScore: Array<{ band: string; n: number; avgPct: number; winRatePct: number }> }> {
    const rows = await this.results(Date.now() - 2 * 86_400_000);
    const agg = (rs: OutcomeResult[]) => ({ n: rs.length, avgPct: rs.length ? r1(rs.reduce((s, r) => s + r.pnlPct, 0) / rs.length) : 0, winRatePct: rs.length ? Math.round((rs.filter((r) => r.pnlPct > 0).length / rs.length) * 100) : 0 });
    const strategies = [...new Set(rows.map((r) => r.strategy))];
    const bands: Array<[string, (r: OutcomeResult) => boolean]> = [
      ['20+ under the bar', (r) => r.score < r.bar - 20],
      ['10–20 under', (r) => r.score >= r.bar - 20 && r.score < r.bar - 10],
      ['0–10 under', (r) => r.score >= r.bar - 10 && r.score < r.bar],
      ['at / over the bar (a rule said no)', (r) => r.score >= r.bar],
    ];
    return {
      pending: this.pending.length,
      stored: (await this.redis.llen(RES).catch(() => 0)) as number,
      stats: this.stats,
      byStrategy: strategies.map((s) => {
        const rs = rows.filter((r) => r.strategy === s);
        return { strategy: s, ...agg(rs), went2xPct: rs.length ? Math.round((rs.filter((r) => r.peakX >= 2).length / rs.length) * 100) : 0 };
      }).sort((a, b) => b.n - a.n),
      byScore: bands.map(([band, f]) => ({ band, ...agg(rows.filter(f)) })),
    };
  }
}
