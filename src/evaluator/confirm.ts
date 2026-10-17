/**
 * Consecutive-pass confirmation (v11.8): a BUY signal must pass the confirmation rules N times in a row,
 * `intervalSec` apart, because a rugged pool's numbers lag — one good reading isn't proof. Pure.
 */
export type ConfirmStep = 'confirmed' | 'again' | 'failed';

/** `passesBefore` = confirmation checks already passed for this signal (0 on the first one). */
export function confirmStep(passedNow: boolean, passesBefore: number, needed: number): ConfirmStep {
  if (!passedNow) return 'failed';
  return passesBefore + 1 >= Math.max(1, Math.floor(needed)) ? 'confirmed' : 'again';
}

/** Longest a signal can sit in confirmation: the first wait plus the extra passes. */
export function confirmHoldSec(delaySec: number, needed: number, intervalSec: number): number {
  return Math.max(0, delaySec) + Math.max(0, Math.floor(needed) - 1) * Math.max(1, intervalSec);
}
