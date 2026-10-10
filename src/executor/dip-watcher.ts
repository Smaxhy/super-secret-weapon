/**
 * Dip watcher — "don't buy the top, wait for the dip".
 *
 * When a coin passes every rule but its chart is stretched (far above VWAP,
 * overbought, vertical last 2 min), the evaluator hands it here with a buy
 * zone instead of buying. On every trade of that coin (and every few seconds):
 *   - ran away more than `runAwayPct` above the signal price → drop (no chasing)
 *   - broke down more than `breakdownPct` below the zone → drop
 *   - no dip within `waitMinutes` → drop
 *   - dipped into the zone and bounced `bounceConfirmPct` off the low with
 *     buyers in control (last minute buy/sell ≥ minBuyRatio) → full re-check
 *     flagged as a dip entry (all rules + score must still pass; no extra
 *     confirmation delay — the bounce is the confirmation).
 */
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import type { Evaluator } from '../evaluator/evaluator';
import { moduleLogger } from '../lib/logger';
import type { CrowdTracker } from '../scanner/crowd-tracker';

const log = moduleLogger('dip-watcher');

export interface DipWatch {
  mint: string;
  symbol: string;
  strategy: StrategyName;
  zone: { lo: number; hi: number };
  signalPrice: number;
  startedAt: number;
  expiresAt: number;
  /** Lowest price seen inside the zone (null = not in the zone yet). */
  lowest: number | null;
  why: string;
  swing?: boolean;
  wallet?: string;
}

export interface DipRules {
  bounceConfirmPct: number;
  minBuyRatio: number;
  runAwayPct: number;
  breakdownPct: number;
}

/** Pure: what to do with a watch at this price. Mutates `w.lowest`. */
export function dipDecision(w: DipWatch, price: number, buyRatio1m: number | null, now: number, c: DipRules): { action: 'wait' | 'buy' | 'drop'; why: string } {
  if (!(price > 0)) return { action: 'wait', why: 'no price' };
  if (now > w.expiresAt) return { action: 'drop', why: `no dip within ${Math.round((w.expiresAt - w.startedAt) / 60_000)} min` };
  if (price > w.signalPrice * (1 + c.runAwayPct / 100)) return { action: 'drop', why: `ran +${Math.round((price / w.signalPrice - 1) * 100)}% without a dip (not chasing)` };
  if (price < w.zone.lo * (1 - c.breakdownPct / 100)) return { action: 'drop', why: 'broke down below the buy zone' };
  if (price <= w.zone.hi) w.lowest = w.lowest === null ? price : Math.min(w.lowest, price);
  if (w.lowest !== null && price >= w.lowest * (1 + c.bounceConfirmPct / 100) && (buyRatio1m ?? 0) >= c.minBuyRatio) {
    const off = (1 - w.lowest / w.signalPrice) * 100;
    return { action: 'buy', why: `dipped ${off.toFixed(0)}% from the signal into the buy zone and bounced ${((price / w.lowest - 1) * 100).toFixed(0)}% with buyers in control` };
  }
  return { action: 'wait', why: w.lowest === null ? 'waiting for the dip' : 'in the zone, waiting for the bounce' };
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
  add(w: Omit<DipWatch, 'startedAt' | 'expiresAt' | 'lowest'>, now = Date.now()): boolean {
    const key = `${w.mint}:${w.strategy}`;
    if (this.watches.has(key)) return false;
    const mins = getConfig().chart.dip.waitMinutes;
    this.watches.set(key, { ...w, startedAt: now, expiresAt: now + mins * 60_000, lowest: null });
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
    const d = dipDecision(w, price, ratio, now, getConfig().chart.dip);
    if (d.action === 'wait') return;
    this.watches.delete(`${w.mint}:${w.strategy}`);
    if (d.action === 'drop') {
      log.info({ mint: w.mint, why: d.why }, `✋ ${w.symbol}: stopped waiting for a dip — ${d.why}`);
      return;
    }
    log.info({ mint: w.mint, why: d.why }, `🎯 ${w.symbol}: dip entry — ${d.why}`);
    void this.evaluator.checkNow(w.mint, w.strategy, d.why, { dip: true, swing: w.swing, wallet: w.wallet }).catch((err: Error) => log.warn({ mint: w.mint, err: err.message }, 'dip re-check failed'));
  }
}
