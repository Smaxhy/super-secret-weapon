/**
 * Virtual book — paper-of-paper positions for the labs (exit lab + chart-strategy lab).
 *
 * A virtual position is traded exactly like a real paper position: the bot's own exit logic
 * (decideExit) on every trade of the coin (and every second), the same settled-peak logic,
 * the same costs as paper fills (pool fee incl. tiered PumpSwap fees, slippage, tx fee both
 * ways). Nothing is bought or sold — when a position closes, `onClose` gets the result.
 * Price = the pool price after the latest trade of the coin (crowd log).
 */
import type { BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { decideExit, exitCostPctFor, trailRules, type ExitInput } from '../executor/sell-manager';
import { poolFeeBps } from '../lib/pumpfun';
import { settledHigh } from '../lib/settled-price';
import type { CrowdTracker } from '../scanner/crowd-tracker';

type ExitRules = BotConfigShape['exit'];

export interface VirtualOpen {
  /** Unique key (one open position per key). */
  key: string;
  mint: string;
  symbol: string;
  /** Strategy whose exit settings apply (time stops, max hold, stale…). */
  strategy: StrategyName;
  onAmm: boolean;
  priceSol: number;
  /** Anything the owner of the book wants back with the result. */
  tag: Record<string, unknown>;
}

export interface VirtualResult {
  key: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  tag: Record<string, unknown>;
  /** P&L after every cost, % of what the position cost. */
  pnlPct: number;
  peakX: number;
  holdSec: number;
  reason: string;
  at: number;
}

interface VPos extends VirtualOpen {
  sizeSol: number;
  costSol: number;
  tokens: number;
  entryPriceSol: number;
  openedAt: number;
  remainingPct: number;
  proceedsSol: number;
  peakPriceSol: number;
  trailingActive: boolean;
  tpTiersHit: number[];
  refPriceSol: number;
  lastMoveAtMs: number;
  breachSinceMs: number | null;
  breachTicks: number;
  lastCheck: number;
  peakAtMs: number;
}

const priceOfLast = (crowd: CrowdTracker, mint: string): number => {
  const t = crowd.trades(mint);
  const last = t[t.length - 1];
  return last ? (last.pp && last.pp > 0 ? last.pp : last.px) : 0;
};

export class VirtualBook {
  private readonly open = new Map<string, VPos>();
  private readonly lastStep = new Map<string, number>();

  constructor(
    private readonly crowd: CrowdTracker,
    /** Exit rules for a position (null = drop it, e.g. its variant was removed). */
    private readonly rulesFor: (tag: Record<string, unknown>, live: ExitRules) => ExitRules | null,
    private readonly onClose: (r: VirtualResult) => void,
    private readonly maxOpen: () => number,
  ) {}

  get size(): number {
    return this.open.size;
  }

  has(key: string): boolean {
    return this.open.has(key);
  }

  /** Open a virtual position at the current price (+ buy costs). false = not opened. */
  add(o: VirtualOpen, now = Date.now()): boolean {
    if (this.open.has(o.key) || this.open.size >= this.maxOpen() || !(o.priceSol > 0)) return false;
    const cfg = getConfig();
    const p = cfg.paper;
    const feeBps = poolFeeBps(p, o.onAmm, o.priceSol * 1e9);
    const sizeSol = cfg.trading.maxPositionSol;
    const tokens = (sizeSol * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100)) / o.priceSol;
    if (!(tokens > 0)) return false;
    const entry = sizeSol / tokens;
    this.open.set(o.key, {
      ...o,
      sizeSol,
      costSol: sizeSol + p.txFeeSol,
      tokens,
      entryPriceSol: entry,
      openedAt: now,
      remainingPct: 100,
      proceedsSol: 0,
      peakPriceSol: entry,
      trailingActive: false,
      tpTiersHit: [],
      refPriceSol: entry,
      lastMoveAtMs: now,
      breachSinceMs: null,
      breachTicks: 0,
      lastCheck: now,
      peakAtMs: now,
    });
    return true;
  }

  /** A trade happened on `mint`: step its positions (at most every 200 ms per coin). */
  onTrade(mint: string, now = Date.now()): void {
    if (now - (this.lastStep.get(mint) ?? 0) < 200) return;
    let any = false;
    for (const vp of this.open.values()) {
      if (vp.mint !== mint) continue;
      any = true;
      this.step(vp, now);
    }
    if (any) this.lastStep.set(mint, now);
  }

  /** Step everything (quiet coins, time stops) — call every second. */
  stepAll(now = Date.now()): void {
    for (const vp of [...this.open.values()]) this.step(vp, now);
    if (this.lastStep.size > 5_000) this.lastStep.clear();
  }

  private step(vp: VPos, now: number): void {
    const cfg = getConfig();
    const rules = this.rulesFor(vp.tag, cfg.exit);
    if (!rules) {
      this.open.delete(vp.key);
      return;
    }
    const trades = this.crowd.trades(vp.mint);
    const price = priceOfLast(this.crowd, vp.mint);
    // No price for a long time (coin went quiet / dropped from the log) → close at the last price we had.
    if (!(price > 0)) {
      if (now - vp.openedAt > 60 * 60_000) this.finish(vp, vp.refPriceSol, 'no price', now);
      return;
    }
    const holdMs = trailRules(rules).peakHoldMs ?? 1_200;
    const since = Math.max(vp.openedAt, vp.lastCheck - holdMs - 2_000);
    vp.lastCheck = now;
    const p = cfg.paper;
    const input: ExitInput = {
      entryPriceSol: vp.entryPriceSol,
      peakPriceSol: vp.peakPriceSol,
      remainingPct: vp.remainingPct,
      tpTiersHit: vp.tpTiersHit,
      trailingActive: vp.trailingActive,
      refPriceSol: vp.refPriceSol,
      lastMoveAtMs: vp.lastMoveAtMs,
      staleMinutes: rules.staleMinutes[vp.strategy],
      priceSol: price,
      migratedNoMarket: false,
      bundlePctEntry: 0,
      bundlePctNow: 0,
      devHoldingPctEntry: 0,
      devHoldingPctNow: 0,
      top10PctEntry: 0,
      top10PctNow: 0,
      nowMs: now,
      copyWalletSold: false,
      risk: 0,
      riskWhy: '',
      openedAtMs: vp.openedAt,
      maxHoldMinutes: rules.maxHoldMinutes[vp.strategy],
      resistance: { hit: false, level: 0, touches: 0 },
      sizeSol: vp.sizeSol,
      costSol: vp.costSol,
      proceedsSol: vp.proceedsSol,
      volatilityPct: null,
      txFeeSol: p.txFeeSol,
      priceTrusted: true,
      breachSinceMs: vp.breachSinceMs,
      breachTicks: vp.breachTicks,
      exitCostPct: exitCostPctFor(p, vp.onAmm, (vp.sizeSol * vp.remainingPct) / 100, price * 1e9),
      strategy: vp.strategy,
      instantPeak: true,
      recentHighSol: settledHigh(trades, since, now, holdMs, price * 2.5),
      peakAtMs: vp.peakAtMs,
      migratedAgoSec: null,
    };
    const d = decideExit(input, rules);
    vp.peakPriceSol = d.state.peakPriceSol;
    vp.trailingActive = d.state.trailingActive;
    vp.refPriceSol = d.state.refPriceSol;
    vp.lastMoveAtMs = d.state.lastMoveAtMs;
    vp.tpTiersHit = d.state.tpTiersHit;
    vp.breachSinceMs = d.state.breachSinceMs;
    vp.breachTicks = d.state.breachTicks;
    vp.peakAtMs = d.state.peakAtMs;
    const feeBps = poolFeeBps(p, vp.onAmm, price * 1e9);
    for (const s of d.sells) {
      const pct = Math.min(s.pct, vp.remainingPct);
      if (!(pct > 0)) continue;
      // Same costs as a paper sell: pool fee, slippage, tx fee.
      vp.proceedsSol += ((vp.tokens * pct) / 100) * price * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100) - p.txFeeSol;
      vp.remainingPct = Math.max(0, vp.remainingPct - pct);
      if (vp.remainingPct <= 0.01) {
        this.finish(vp, price, `${s.reason}: ${s.detail}`, now);
        return;
      }
    }
  }

  private finish(vp: VPos, price: number, reason: string, now: number): void {
    this.open.delete(vp.key);
    const p = getConfig().paper;
    const feeBps = poolFeeBps(p, vp.onAmm, price * 1e9);
    if (vp.remainingPct > 0.01) {
      vp.proceedsSol += ((vp.tokens * vp.remainingPct) / 100) * price * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100) - p.txFeeSol;
      vp.remainingPct = 0;
    }
    this.onClose({
      key: vp.key,
      mint: vp.mint,
      symbol: vp.symbol,
      strategy: vp.strategy,
      tag: vp.tag,
      pnlPct: Math.round(((vp.proceedsSol - vp.costSol) / vp.costSol) * 10_000) / 100,
      peakX: Math.round((vp.peakPriceSol / vp.entryPriceSol) * 1000) / 1000,
      holdSec: Math.round((now - vp.openedAt) / 1000),
      reason: reason.slice(0, 160),
      at: now,
    });
  }
}
