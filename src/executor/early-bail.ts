/**
 * Early bail — cut dead trades before they bleed out.
 *
 * 69% of losing trades never went above 1.05x. Most of them show no life
 * from the start: no new high, more sellers than buyers. This module exits
 * within 45 seconds when the trade is clearly dead on arrival.
 *
 * Fires even during the min-hold period (unlike time stops) — only rug exits
 * and the disaster limit also fire during the hold.
 */

export interface EarlyBailConfig {
  enabled: boolean;
  /** Maximum seconds before the bail fires — after this, normal time stops handle it. */
  maxSec: number;
  /** The trade must not have gone above this multiple to be considered dead. */
  minPeakMultiple: number;
  /** Buy/sell ratio over the hold period must be below this (sellers winning). */
  maxBuyRatio: number;
}

export const DEFAULT_EARLY_BAIL: EarlyBailConfig = {
  enabled: true,
  maxSec: 45,
  minPeakMultiple: 1.02,
  maxBuyRatio: 1.0,
};

export interface EarlyBailInput {
  heldSec: number;
  peakMultiple: number;
  buyRatio: number | null;
  multiple: number;
}

/** Pure: should we bail on this dead trade? null = no, string = why. */
export function earlyBailReason(input: EarlyBailInput, cfg: EarlyBailConfig): string | null {
  if (!cfg.enabled) return null;
  if (input.heldSec < 10) return null; // too early to judge
  if (input.heldSec > cfg.maxSec) return null; // normal time stops handle it
  if (input.peakMultiple >= cfg.minPeakMultiple) return null; // showed some life
  if (input.multiple >= 1) return null; // still above entry
  if (input.buyRatio !== null && input.buyRatio > cfg.maxBuyRatio) return null; // buyers still trying

  return `dead on arrival: ${input.heldSec}s in, peak ${((input.peakMultiple - 1) * 100).toFixed(1)}%, sellers in control (ratio ${input.buyRatio?.toFixed(2) ?? '?'}) — cutting losses at ${((input.multiple - 1) * 100).toFixed(1)}%`;
}
