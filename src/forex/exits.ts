/**
 * Exit lab (v14 → v15). The same entries with different exits: a stop moved to break-even at +1R, half taken off at
 * +1R, a closer target, no target (let winners run on a trail), a shorter time limit — and (v15, "more pips") a
 * bigger target, a trailing take-profit (at the target the stop locks behind it and trails instead of closing),
 * half off at the target with the rest trailing, and (v15.1) a trailing stop-loss that follows the price from the
 * start. Each strategy keeps the exit that did best on the FIRST 70% of the history (same rule as the filters), so the
 * last 30% stays a fair test. Pure.
 */
import type { Ctx } from './ta';
import type { Signal } from './types';

export type ExitKind = 'designed' | 'breakeven' | 'scale' | 'tight' | 'runner' | 'quick' | 'wide' | 'trail_tp' | 'half_trail' | 'trail_sl' | 'roomy' | 'swing';
export const EXITS: ExitKind[] = ['designed', 'breakeven', 'scale', 'tight', 'runner', 'quick', 'wide', 'trail_tp', 'half_trail', 'trail_sl', 'roomy', 'swing'];
export const EXIT_LABEL: Record<ExitKind, string> = {
  designed: 'as designed',
  breakeven: 'stop to break-even at +1R',
  scale: 'half off at +1R, rest rides',
  tight: 'closer target',
  runner: 'no target, trail the winner',
  quick: 'shorter time limit',
  wide: 'bigger target (1.6× the distance)',
  trail_tp: 'trailing take-profit: at the target the stop locks behind it and trails',
  half_trail: 'half off at the target, the rest trails',
  trail_sl: 'trailing stop-loss: the stop follows the price from the start, at the target it keeps trailing',
  roomy: 'bigger trade: stop and target 1.6× further away',
  swing: 'swing trade: stop 2.2× and target 2.5× further away, held longer',
};
/**
 * The owner's exits, in order of preference: the trailing stop-loss first (v15.1, "for safety": the stop moves up with
 * the trade from the start), then the trailing take-profits. A strategy uses the first one that tests as well as its
 * best exit on the first 70% (`preferVariant`).
 */
export const OWNER_EXITS: readonly ExitKind[] = ['trail_sl', 'trail_tp', 'half_trail'];

/** The signal with the exit variant applied (null stays null; a variant that doesn't apply returns the same object). */
export function applyExit(sig: Signal | null, kind: ExitKind, c: Ctx, i: number): Signal | null {
  if (!sig || kind === 'designed') return sig;
  const px = c.close[i]!;
  const risk = Math.abs(px - sig.stop);
  if (!(risk > 0)) return sig;
  switch (kind) {
    case 'breakeven':
      return { ...sig, beAtR: 1 };
    case 'scale':
      return { ...sig, scaleAtR: 1, scaleFrac: 0.5 };
    case 'tight':
      return sig.target !== null ? { ...sig, target: px + 0.6 * (sig.target - px) } : { ...sig, target: px + sig.side * 1.5 * risk };
    case 'runner':
      return { ...sig, target: null, trailAtr: sig.trailAtr ?? 2.5 };
    case 'quick': {
      const cap = c.barMin <= 60 ? 12 : 6;
      return { ...sig, maxBars: Math.min(sig.maxBars ?? cap, cap) };
    }
    case 'wide':
      // more pips: a target 1.6× as far; a trail-only rule trails 1.5× wider; an indicator / time exit holds twice as long
      if (sig.target !== null) return { ...sig, target: px + 1.6 * (sig.target - px) };
      if (sig.trailAtr) return { ...sig, trailAtr: sig.trailAtr * 1.5 };
      return sig.maxBars ? { ...sig, maxBars: sig.maxBars * 2 } : sig;
    case 'trail_tp':
      return sig.target !== null ? { ...sig, tpTrail: 1.5, tpFrac: 0 } : sig;
    case 'half_trail':
      return sig.target !== null ? { ...sig, tpTrail: 2, tpFrac: 0.5 } : sig;
    case 'trail_sl':
      // the stop follows the best close at its starting distance (1R): +1R → break-even, +2R → +1R locked, …;
      // at the target it does not close but keeps trailing (a trailing take-profit), so the winner keeps running
      return { ...sig, trailR: 1, ...(sig.target !== null ? { tpTrail: 1.5, tpFrac: 0 } : {}) };
    case 'roomy':
      return wider(sig, px, 1.6, 1.6);
    case 'swing':
      return wider(sig, px, 2.2, 2.5);
    default:
      return sig;
  }
}

/**
 * v26.5 (owner: "use more risk when you trade for more profit"): the venue's fee is a share of the whole position, so
 * on a tight stop it eats a big slice of every trade (≈ 0.15R on a 15-pip hourly stop). The same signal with the stop
 * `kStop`× and the target `kTarget`× further away risks the same money on a smaller position — the fee shrinks in R by
 * `kStop` — and aims for a bigger move. Trails widen with the stop, time limits stretch with the target. Pure.
 */
function wider(sig: Signal, px: number, kStop: number, kTarget: number): Signal {
  const stop = px - (px - sig.stop) * kStop;
  if ((sig.side === 1 && !(stop < px)) || (sig.side === -1 && !(stop > px)) || !(stop > 0)) return sig;
  return {
    ...sig,
    stop,
    target: sig.target !== null ? px + (sig.target - px) * kTarget : null,
    ...(sig.trailAtr ? { trailAtr: sig.trailAtr * kStop } : {}),
    ...(sig.maxBars ? { maxBars: Math.round(sig.maxBars * kTarget) } : {}),
  };
}
