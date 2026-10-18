/**
 * Exit lab (v14 → v15). The same entries with different exits: a stop moved to break-even at +1R, half taken off at
 * +1R, a closer target, no target (let winners run on a trail), a shorter time limit — and (v15, "more pips") a
 * bigger target, a trailing take-profit (at the target the stop locks behind it and trails instead of closing) and
 * half off at the target with the rest trailing. Each strategy keeps the exit that did best on the FIRST 70% of the
 * history (same rule as the filters), so the last 30% stays a fair test. Pure.
 */
import type { Ctx } from './ta';
import type { Signal } from './types';

export type ExitKind = 'designed' | 'breakeven' | 'scale' | 'tight' | 'runner' | 'quick' | 'wide' | 'trail_tp' | 'half_trail';
export const EXITS: ExitKind[] = ['designed', 'breakeven', 'scale', 'tight', 'runner', 'quick', 'wide', 'trail_tp', 'half_trail'];
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
};
/** v15: the trailing take-profit exits (the owner wants them used wherever they test as well as the alternative) */
export const TRAIL_TP_EXITS: ReadonlySet<ExitKind> = new Set<ExitKind>(['trail_tp', 'half_trail']);

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
    default:
      return sig;
  }
}
