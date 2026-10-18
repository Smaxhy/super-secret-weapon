/**
 * Exit lab (v14). The same entries with different exits: a stop moved to break-even at +1R, half taken off at +1R,
 * a closer target, no target (let winners run on a trail), a shorter time limit. Each strategy keeps the exit that did
 * best on the FIRST 70% of the history (same rule as the filters), so the last 30% stays a fair test. Pure.
 */
import type { Ctx } from './ta';
import type { Signal } from './types';

export type ExitKind = 'designed' | 'breakeven' | 'scale' | 'tight' | 'runner' | 'quick';
export const EXITS: ExitKind[] = ['designed', 'breakeven', 'scale', 'tight', 'runner', 'quick'];
export const EXIT_LABEL: Record<ExitKind, string> = {
  designed: 'as designed',
  breakeven: 'stop to break-even at +1R',
  scale: 'half off at +1R, rest rides',
  tight: 'closer target',
  runner: 'no target, trail the winner',
  quick: 'shorter time limit',
};

/** The signal with the exit variant applied (null stays null). */
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
      const cap = c.barMin === 60 ? 12 : 6;
      return { ...sig, maxBars: Math.min(sig.maxBars ?? cap, cap) };
    }
    default:
      return sig;
  }
}
