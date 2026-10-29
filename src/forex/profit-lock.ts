/**
 * v17.11 the owner's profit lock (owner: "it's not actively trailing its stop-loss closer; TP is +30 €, when it reaches
 * a 10 € profit it moves the stop past the buying price so we always sell in profit"). For every trade with a target
 * (or, without one, twice the starting stop distance) — D = the distance from the entry to it:
 * - once the price has gone `atFrac` (⅓) of D its way, the stop jumps past the entry: entry + costs + `keepFrac` (10%)
 *   of D, so a stop-out from there still closes in profit (a gap can still fill worse);
 * - from then on the stop trails `gapFrac` (⅓) of D behind the best price reached, and only ever moves with the trade.
 * Example (v27.28 numbers): target +30 → at +4.5 the stop goes to about +1.5, at +20 it sits at +15.5, at +29 at +24.5.
 * The engine simulates it on every backtest / paper trade (so the tested numbers are what the bot does), the bot
 * account and the owner's own trades apply it on live prices every second. Pure.
 */

// v27.28 (owner: "trail its SL VERY tightly once it's in profit"; was ⅓ / ⅓ / 0.1): arms at 15% of the way to the target
// (+0.3R on a 2R target), locks entry + costs + 5%, then trails 15% of the target distance (0.3R) behind the best price.
// The engine tests every row with it too, so the strict test grades exactly this exit.
export const PROFIT_LOCK = {
  on: true,
  /** arms once the price went this share of the way to the target */
  atFrac: 0.15,
  /** then trails this share of the target distance behind the best price */
  gapFrac: 0.15,
  /** profit kept by the first locked stop (share of the target distance), on top of the costs */
  keepFrac: 0.05,
};

/**
 * v27.61 (owner: "trailing SL on his calls is fine, just not too tight early on"): the lock for Kojiro's calls (Discord
 * copies with no target; D = 2 × the starting stop): arms at a quarter of D (+0.5R), locks entry + costs + 3% of D,
 * trails a quarter of D (0.5R) behind the best price, and only once the price has gone 60% of D (+1.2R) its way does the
 * trail tighten to the normal 15% of D (0.3R). His NQ long on Oct 27 (stop 147 pts, ran +60 then pulled back 45) would
 * have stayed open.
 */
export const COPY_LOCK = {
  on: true,
  atFrac: 0.25,
  gapFrac: 0.25,
  keepFrac: 0.03,
  /** past this share of D the trail tightens to `tightGapFrac` */
  tightAtFrac: 0.6,
  tightGapFrac: 0.15,
};

/**
 * v28.6 (owner: "high win rate but the losses outweigh the wins"): the coin bot's winners closed at ≈ +0.15R on the tight
 * lock while a loser costs −1R. Every row is now tested with three locks and keeps the one its FIRST 70% scored best on
 * (lab.ts): 'tight' (PROFIT_LOCK), 'loose' (arms at a quarter of the way to the target, trails a quarter behind, a
 * quarter → 15% once 60% of the way there — the Kojiro copy lock) or 'off' (stop / target / the strategy's own exits only).
 */
export type LockKind = 'tight' | 'loose' | 'off';
export const LOCK_KINDS: readonly LockKind[] = ['tight', 'loose', 'off'];
export const LOOSE_LOCK = { on: true, atFrac: 0.25, gapFrac: 0.25, keepFrac: 0.03, tightAtFrac: 0.6, tightGapFrac: 0.15 };
/** the lock settings of a kind ('off' → null). Pure. */
export const lockCfgOf = (k: LockKind | undefined): (typeof PROFIT_LOCK & { tightAtFrac?: number; tightGapFrac?: number }) | null => (k === 'off' ? null : k === 'loose' ? LOOSE_LOCK : PROFIT_LOCK);

export interface LockPlan {
  /** the price that arms the lock */
  at: number;
  /** the stop it jumps to (past the entry) */
  to: number;
  /** how far the stop trails behind the best price once armed (price) */
  gap: number;
  /** v27.61: once the best price passes `from`, the trail tightens to `gap` (price) */
  tight?: { from: number; gap: number };
}

/**
 * The lock for one trade, or null (no target and no usable stop, or costs so large the locked stop would not sit
 * between the entry and the arming price). `costPx` = what a close costs on top of the price (spread / slippage).
 */
export function lockPlan(side: 1 | -1, entry: number, stop0: number | null, target0: number | null, costPx: number, cfg: typeof PROFIT_LOCK & { tightAtFrac?: number; tightGapFrac?: number } = PROFIT_LOCK): LockPlan | null {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  let d = NaN;
  if (target0 !== null && Number.isFinite(target0) && side * (target0 - entry) > 0) d = Math.abs(target0 - entry);
  else if (stop0 !== null && Number.isFinite(stop0) && side * (entry - stop0) > 0) d = 2 * Math.abs(entry - stop0);
  if (!(d > 0)) return null;
  const at = entry + side * cfg.atFrac * d;
  const to = entry + side * (Math.max(0, costPx) + cfg.keepFrac * d);
  if (side * (at - to) <= 0) return null;
  const plan: LockPlan = { at, to, gap: cfg.gapFrac * d };
  if (cfg.tightAtFrac !== undefined && cfg.tightGapFrac !== undefined) plan.tight = { from: entry + side * cfg.tightAtFrac * d, gap: cfg.tightGapFrac * d };
  return plan;
}

/**
 * v27.72: the live lock with the venue fee counted (owner: a "locked" exit must not lose money after fees). The
 * locked stop sits past entry + spread + the round-trip fee; when that is beyond the normal arming price, the lock
 * arms one trail-gap further out instead of not at all. The lab engine keeps `lockPlan` (fees are taken from R there).
 */
export function lockPlanNet(side: 1 | -1, entry: number, stop0: number | null, target0: number | null, halfPx: number, feePx: number, cfg: typeof PROFIT_LOCK & { tightAtFrac?: number; tightGapFrac?: number } = PROFIT_LOCK): LockPlan | null {
  const cost = Math.max(0, halfPx) + Math.max(0, feePx);
  const plan = lockPlan(side, entry, stop0, target0, cost, cfg);
  if (plan || !(feePx > 0)) return plan;
  const base = lockPlan(side, entry, stop0, target0, 0, cfg);
  if (!base) return null;
  const to = entry + side * (cost + (side * (base.to - entry)));
  return { ...base, to, at: to + side * base.gap };
}

/** The stop after the best price moved to `best` (armed lock): never looser than `stop` or the locked level. Pure. */
export function lockedStop(side: 1 | -1, plan: LockPlan, best: number, stop: number | null): number {
  const gap = plan.tight && side * (best - plan.tight.from) >= 0 ? plan.tight.gap : plan.gap;
  const trail = best - side * gap;
  let s = side === 1 ? Math.max(plan.to, trail) : Math.min(plan.to, trail);
  if (stop !== null && (side === 1 ? stop > s : stop < s)) s = stop;
  return s;
}
