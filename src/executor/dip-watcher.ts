/**
 * Dip watcher — "don't buy the top, wait for the dip".
 *
 * When a coin passes every rule but its chart is stretched (far above VWAP,
 * overbought, vertical last 2 min), the evaluator hands it here with a buy
 * zone instead of buying. On every trade of that coin (and every few seconds):
 *   - ran away more than `runAwayPct` above the signal price without a dip → drop
 *   - broke down more than `breakdownPct` below the zone → drop
 *   - no dip within `waitMinutes` → drop
 *   - new high before the dip → the zone moves up with it
 *   - dipped into the zone and bounced `bounceConfirmPct` off the low with
 *     buyers in control (last minute buy/sell ≥ minBuyRatio) → full re-check
 *     flagged as a dip entry (all rules + score must still pass; no extra
 *     confirmation delay — the bounce is the confirmation).
 */
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import type { Evaluator } from '../evaluator/evaluator';
import { noteStage } from '../lib/entry-blockers';
import { moduleLogger } from '../lib/logger';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import type { OrganicFlow } from '../scanner/migrated-scanner';

const log = moduleLogger('dip-watcher');

export interface DipWatch {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  zone: { lo: number; hi: number };
  signalPrice: number;
  /** Highest price the zone is measured from (moves up with new highs until the dip starts). */
  high: number;
  startedAt: number;
  expiresAt: number;
  /** Lowest price seen inside the zone (null = not in the zone yet). */
  lowest: number | null;
  /** When `lowest` was last lowered (a dip that keeps making new lows hasn't found a floor yet). */
  lowestAt?: number | null;
  why: string;
  swing?: boolean;
  wallet?: string;
}

export interface DipRules {
  bounceConfirmPct: number;
  minBuyRatio: number;
  runAwayPct: number;
  breakdownPct: number;
  /** Bounce must happen within this % above the zone top — past it the entry was missed (not chasing). */
  maxAboveZonePct?: number;
  /**
   * Blow-off guard (owner: "a coin scalps hard, dips, the bot thinks that's the entry, but it's the all-time high and it
   * dumps"): after a run of ≥ runPct from the 15-min low, a dip only counts if it went ≥ minDipPct off the high AND the
   * low held ≥ holdSec; a run ≥ dropRunPct is a blow-off top → stop waiting (no entry).
   */
  blowOff?: { enabled: boolean; runPct: number; minDipPct: number; holdSec: number; dropRunPct: number };
}

/** Pure: what to do with a watch at this price. Mutates `w.lowest`. */
export function dipDecision(w: DipWatch, price: number, buyRatio1m: number | null, now: number, c: DipRules, runLowPx: number | null = null): { action: 'wait' | 'buy' | 'drop'; why: string } {
  if (!(price > 0)) return { action: 'wait', why: 'no price' };
  const bo = c.blowOff;
  const runPct = runLowPx && runLowPx > 0 ? (w.high / runLowPx - 1) * 100 : 0;
  if (bo?.enabled && bo.dropRunPct > 0 && runPct >= bo.dropRunPct) return { action: 'drop', why: `blow-off top: +${Math.round(runPct)}% in 15 min — dips after a run like that usually keep dumping` };
  if (now > w.expiresAt) return { action: 'drop', why: `no dip within ${Math.round((w.expiresAt - w.startedAt) / 60_000)} min` };
  if (price > w.signalPrice * (1 + c.runAwayPct / 100)) return { action: 'drop', why: `ran +${Math.round((price / w.signalPrice - 1) * 100)}% without a dip (not chasing)` };
  if (price < w.zone.lo * (1 - c.breakdownPct / 100)) return { action: 'drop', why: 'broke down below the buy zone' };
  // New high before any dip: the zone moves up with it (same distance below the high).
  if (w.lowest === null && price > w.high) {
    const k = price / w.high;
    w.zone = { lo: w.zone.lo * k, hi: w.zone.hi * k };
    w.high = price;
  }
  if (price <= w.zone.hi && (w.lowest === null || price < w.lowest)) {
    w.lowest = price;
    w.lowestAt = now;
  }
  if (w.lowest !== null && price > w.zone.hi * (1 + (c.maxAboveZonePct ?? 8) / 100)) {
    // Shot back up before we could confirm: missed this dip — wait for the next one from here.
    w.lowest = null;
    if (price > w.high) {
      const k = price / w.high;
      w.zone = { lo: w.zone.lo * k, hi: w.zone.hi * k };
      w.high = price;
    }
    return { action: 'wait', why: 'bounced too fast — waiting for the next dip' };
  }
  if (w.lowest !== null && price >= w.lowest * (1 + c.bounceConfirmPct / 100) && (buyRatio1m ?? 0) >= c.minBuyRatio) {
    const off = (1 - w.lowest / w.high) * 100;
    if (bo?.enabled && runPct >= bo.runPct) {
      if (off < bo.minDipPct) return { action: 'wait', why: `after a +${Math.round(runPct)}% run, a ${off.toFixed(0)}% dip is still near the top — waiting for ≥${bo.minDipPct}%` };
      if (now - (w.lowestAt ?? now) < bo.holdSec * 1000) return { action: 'wait', why: `after a +${Math.round(runPct)}% run, waiting for the low to hold ${bo.holdSec}s` };
    }
    return { action: 'buy', why: `dipped ${off.toFixed(0)}% from the high into the buy zone and bounced ${((price / w.lowest - 1) * 100).toFixed(0)}% with buyers in control` };
  }
  return { action: 'wait', why: w.lowest === null ? 'waiting for the dip' : 'in the zone, waiting for the bounce' };
}

/**
 * Owner's rule (v10.24): coins at/above `minMcUsd` are only bought on a dip + bounce; under it (or MC unknown)
 * the signal is bought straight away. Dip re-checks and swing-watcher re-entries are already dip entries.
 */
export function dipOnlyApplies(o: { enabled: boolean; mcUsd: number | null; minMcUsd: number; dipEntry: boolean; swing: boolean }): boolean {
  return o.enabled && !o.dipEntry && !o.swing && o.mcUsd !== null && o.mcUsd >= o.minMcUsd;
}

export interface HotVolumeConfig { enabled: boolean; minBuyers: number; minBuySol: number; minBuySharePct: number; minOrganicPct: number }
/** "Crazy volume" = the 5-min organic flow clears every bar → the dip-only rule steps aside. Returns why, or null. */
export function hotVolume(flow: OrganicFlow | null, c: HotVolumeConfig | undefined): string | null {
  if (!c?.enabled || !flow) return null;
  if (flow.buyers < c.minBuyers || flow.buySol < c.minBuySol || flow.buySharePct < c.minBuySharePct || flow.organicPct < c.minOrganicPct) return null;
  return `huge real volume: ${flow.buyers} buyers, ${flow.buySol} SOL bought in 5 min (${flow.buySharePct}% buys)`;
}

/** The high a dip-only entry measures its pullback from: the recent high, never below the current price. */
export function dipOnlyHigh(price: number, recentHigh: number | null | undefined, offHigh10mPct: number | null | undefined): number {
  const fromShape = offHigh10mPct && offHigh10mPct > 0 ? price / Math.max(0.01, 1 - offHigh10mPct / 100) : 0;
  return Math.max(price, recentHigh && recentHigh > 0 ? recentHigh : 0, fromShape);
}

export class DipWatcher {
  private readonly watches = new Map<string, DipWatch>();
  private readonly lastCheck = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly crowd: CrowdTracker,
    private readonly evaluator: Evaluator,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      for (const w of [...this.watches.values()]) this.check(w);
    }, 3_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Start watching (keeps an existing watch for the same coin + strategy). */
  add(w: Omit<DipWatch, 'startedAt' | 'expiresAt' | 'lowest' | 'high'> & { high?: number }, now = Date.now()): boolean {
    const key = `${w.mint}:${w.strategy}`;
    if (this.watches.has(key)) return false;
    const mins = getConfig().chart.dip.waitMinutes;
    this.watches.set(key, { ...w, high: Math.max(w.high ?? 0, w.signalPrice), startedAt: now, expiresAt: now + mins * 60_000, lowest: null });
    log.info({ mint: w.mint, zone: w.zone }, `⏳ ${w.symbol}: not buying the top — waiting up to ${mins} min for a dip (${w.why})`);
    return true;
  }

  watching(mint: string): boolean {
    for (const w of this.watches.values()) if (w.mint === mint) return true;
    return false;
  }

  list(): DipWatch[] {
    return [...this.watches.values()];
  }

  /** A trade happened on `mint` (wired from the token registry). */
  onTrade(mint: string, now = Date.now()): void {
    if ((now - (this.lastCheck.get(mint) ?? 0)) < 500) return;
    let any = false;
    for (const w of this.watches.values()) {
      if (w.mint !== mint) continue;
      any = true;
      this.check(w, now);
    }
    if (any) this.lastCheck.set(mint, now);
  }

  private check(w: DipWatch, now = Date.now()): void {
    const trades = this.crowd.trades(w.mint);
    const last = trades[trades.length - 1];
    const price = last?.px ?? 0;
    const minute = trades.filter((x) => now - x.t <= 60_000);
    const b = minute.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0);
    const s = minute.filter((x) => !x.buy).reduce((s2, x) => s2 + x.sol, 0);
    const ratio = b + s >= 0.2 ? (s > 0 ? b / s : 5) : null;
    // Lowest price in the 15 min before now: how big the run into the high was (blow-off guard).
    let runLow: number | null = null;
    for (const x of trades) if (now - x.t <= 15 * 60_000) { const p = x.pp && x.pp > 0 ? x.pp : x.px; if (p > 0 && (runLow === null || p < runLow)) runLow = p; }
    const d = dipDecision(w, price, ratio, now, getConfig().chart.dip, runLow);
    if (d.action === 'wait') return;
    this.watches.delete(`${w.mint}:${w.strategy}`);
    if (d.action === 'drop') {
      log.info({ mint: w.mint, why: d.why }, `✋ ${w.symbol}: stopped waiting for a dip — ${d.why}`);
      noteStage(w.strategy, 'dipGaveUp');
      return;
    }
    log.info({ mint: w.mint, why: d.why }, `🎯 ${w.symbol}: dip entry — ${d.why}`);
    void this.evaluator.checkNow(w.mint, w.strategy, d.why, { dip: true, swing: w.swing, wallet: w.wallet }).catch((err: Error) => log.warn({ mint: w.mint, err: err.message }, 'dip re-check failed'));
  }
}
