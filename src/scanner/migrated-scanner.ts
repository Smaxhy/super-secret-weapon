/**
 * Migrated-coin scanner (owner: "trade a lot more, especially migrated coins with a lot of organic,
 * real volume — I see plenty of tradeable coins on the chart"). Before this, a migrated coin was only
 * looked at on a fixed schedule in its first hour; one that took off later was never checked.
 *
 * Every `everySec` it scans every migrated coin that traded in the last 2 minutes and measures its
 * ORGANIC flow over 5 minutes — repeat-size bots, dust and wallets churning in and out removed:
 * different real buyers, real SOL bought, buyers' share of the volume, fake volume, and whether the
 * price is already stretched (it doesn't chase a coin up 35% in 3 min). Coins that pass are checked
 * by the normal MIGRATION evaluation right away (all rules, rug and vamp checks still apply), at most
 * once per `cooldownMin` per coin.
 */
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { getSolUsd } from '../lib/sol-price';
import { moduleLogger } from '../lib/logger';
import type { CrowdTrade, CrowdTracker } from './crowd-tracker';

const log = moduleLogger('migrated-scanner');

export interface OrganicFlow {
  buyers: number;
  buySol: number;
  sellSol: number;
  buySharePct: number;
  /** Organic SOL ÷ all SOL (%). */
  organicPct: number;
  run3mPct: number | null;
  priceSol: number;
}

/** Pure: real (organic) buying over `windowMs` — bots, dust and churners removed. */
export function organicFlow(trades: readonly CrowdTrade[], now: number, windowMs = 300_000): OrganicFlow | null {
  const win = trades.filter((x) => x.t <= now && now - x.t <= windowMs);
  if (win.length < 5) return null;
  const byWallet = new Map<string, CrowdTrade[]>();
  for (const x of win) byWallet.set(x.w, [...(byWallet.get(x.w) ?? []), x]);
  const bot = (xs: CrowdTrade[]) => {
    const buys = xs.filter((x) => x.buy).map((x) => x.sol);
    const sells = xs.filter((x) => !x.buy).length;
    if (buys.length >= 3) {
      const m = [...buys].sort((a, b) => a - b)[Math.floor(buys.length / 2)]!;
      if (m > 0 && buys.filter((v) => Math.abs(v - m) / m <= 0.02).length >= 3) return true; // same size again and again
    }
    return buys.length >= 3 && sells >= 3; // churning in and out
  };
  let buySol = 0;
  let sellSol = 0;
  let organic = 0;
  let total = 0;
  const buyers = new Set<string>();
  for (const [w, xs] of byWallet) {
    const isBot = bot(xs);
    for (const x of xs) {
      total += x.sol;
      if (isBot || x.sol < 0.01) continue;
      organic += x.sol;
      if (x.buy) {
        buySol += x.sol;
        buyers.add(w);
      } else sellSol += x.sol;
    }
  }
  const px = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
  const last = win[win.length - 1]!;
  const before = [...trades].reverse().find((x) => now - x.t >= 180_000);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    buyers: buyers.size,
    buySol: r1(buySol),
    sellSol: r1(sellSol),
    buySharePct: buySol + sellSol > 0 ? Math.round((buySol / (buySol + sellSol)) * 100) : 0,
    organicPct: total > 0 ? Math.round((organic / total) * 100) : 0,
    run3mPct: before && px(before) > 0 ? r1((px(last) / px(before) - 1) * 100) : null,
    priceSol: px(last),
  };
}

export interface MigratedScanConfig {
  enabled: boolean;
  everySec: number;
  minOrganicBuyers5m: number;
  minOrganicBuySol5m: number;
  minBuySharePct: number;
  minOrganicPct: number;
  maxRun3mPct: number;
  minMarketCapUsd: number;
  cooldownMin: number;
  maxChecksPerTick: number;
}

/** Pure: does this coin's flow deserve a check right now? Returns why not, or null. */
export function scanVerdict(f: OrganicFlow | null, mcUsd: number | null, c: MigratedScanConfig): string | null {
  if (!f) return 'too few trades';
  if (f.buyers < c.minOrganicBuyers5m) return `${f.buyers} real buyers`;
  if (f.buySol < c.minOrganicBuySol5m) return `${f.buySol} SOL real buying`;
  if (f.buySharePct < c.minBuySharePct) return `buyers ${f.buySharePct}% of volume`;
  if (f.organicPct < c.minOrganicPct) return `only ${f.organicPct}% organic volume`;
  if (f.run3mPct !== null && f.run3mPct > c.maxRun3mPct) return `already up ${f.run3mPct}% in 3 min`;
  if (mcUsd !== null && mcUsd < c.minMarketCapUsd) return 'market cap too small';
  return null;
}

export class MigratedScanner {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastCheck = new Map<string, number>();
  stats = { scans: 0, hot: 0, checked: 0, lastHot: [] as Array<{ mint: string; at: string; buyers: number; buySol: number; buySharePct: number }> };

  constructor(
    private readonly crowd: CrowdTracker,
    private readonly check: (mint: string, why: string) => Promise<void>,
    private readonly held: (mint: string) => boolean = () => false,
  ) {}

  private cfg(): MigratedScanConfig {
    return getConfig().focus.migrated?.scan ?? DEFAULT_CONFIG.focus.migrated.scan;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), Math.max(5, this.cfg().everySec) * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled) return;
    try {
      this.stats.scans++;
      const sol = await getSolUsd().catch(() => null);
      const hot: Array<{ mint: string; f: OrganicFlow }> = [];
      for (const mint of this.crowd.activeAmmMints(120_000, now)) {
        if (this.held(mint)) continue;
        if (now - (this.lastCheck.get(mint) ?? 0) < c.cooldownMin * 60_000) continue;
        const f = organicFlow(this.crowd.trades(mint), now);
        // pump.fun coins: 1 billion supply.
        const mcUsd = f && sol ? f.priceSol * 1e9 * sol : null;
        if (scanVerdict(f, mcUsd, c) === null && f) hot.push({ mint, f });
      }
      hot.sort((a, b) => b.f.buySol - a.f.buySol);
      for (const { mint, f } of hot.slice(0, c.maxChecksPerTick)) {
        this.lastCheck.set(mint, now);
        this.stats.hot++;
        this.stats.lastHot = [{ mint, at: new Date(now).toISOString(), buyers: f.buyers, buySol: f.buySol, buySharePct: f.buySharePct }, ...this.stats.lastHot].slice(0, 20);
        await this.check(mint, `organic flow: ${f.buyers} buyers, ${f.buySol} SOL, ${f.buySharePct}% buys`);
        this.stats.checked++;
      }
      if (this.lastCheck.size > 20_000) this.lastCheck.clear();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'migrated scan failed');
    }
  }
}
