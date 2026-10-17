/**
 * Adaptive stop loss — tighten the stop based on entry quality signals.
 *
 * The fixed 10–20% stop band loses money on bad entries that never go up.
 * This module reads the entry context and narrows the stop when the entry
 * shows weakness, and widens it when the entry is strong.
 *
 * Applied in the sell manager as a multiplier on the stop-loss percent.
 */

export interface AdaptiveStopConfig {
  enabled: boolean;
  /** Tighten the stop by this factor when the entry quality was 'caution'. */
  cautionFactor: number;
  /** Tighten when the momentum gate was close to blocking. */
  weakMomentumFactor: number;
  /** Widen when entry quality was 'boost'. */
  boostFactor: number;
  /** Tighten when the coin has a high RugCheck score (risky). */
  highRiskFactor: number;
  /** RugCheck score above which to tighten. */
  highRiskScoreThreshold: number;
  /** MC-based multiplier bands: wider stops for tiny volatile coins, tighter for liquid ones. */
  mcBands: readonly { maxMcUsd: number; factor: number }[];
  /** Age-based multiplier: wider stops for very fresh coins. */
  ageBands: readonly { maxAgeMin: number; factor: number }[];
}

export const DEFAULT_ADAPTIVE_STOP: AdaptiveStopConfig = {
  enabled: true,
  cautionFactor: 0.75,
  weakMomentumFactor: 0.85,
  boostFactor: 1.15,
  highRiskFactor: 0.8,
  highRiskScoreThreshold: 300,
  mcBands: [
    { maxMcUsd: 10_000, factor: 1.3 },
    { maxMcUsd: 50_000, factor: 1.1 },
    { maxMcUsd: 200_000, factor: 1.0 },
  ],
  ageBands: [
    { maxAgeMin: 2, factor: 1.2 },
  ],
};

export interface EntrySignals {
  entryQualityVerdict?: 'block' | 'caution' | 'ok' | 'boost' | null;
  rugCheckScore?: number | null;
  momentumGateBlocked?: boolean;
  score?: number;
  threshold?: number;
}

export function adaptiveStopMultiplier(
  signals: EntrySignals,
  cfg: AdaptiveStopConfig,
): number {
  if (!cfg.enabled) return 1;

  let factor = 1;

  if (signals.entryQualityVerdict === 'caution') {
    factor *= cfg.cautionFactor;
  } else if (signals.entryQualityVerdict === 'boost') {
    factor *= cfg.boostFactor;
  }

  if (signals.rugCheckScore != null && signals.rugCheckScore > cfg.highRiskScoreThreshold) {
    factor *= cfg.highRiskFactor;
  }

  // Score barely above the bar = less conviction = tighter stop
  if (signals.score != null && signals.threshold != null) {
    const margin = signals.score - signals.threshold;
    if (margin < 5) {
      factor *= 0.9;
    } else if (margin > 20) {
      factor *= 1.1;
    }
  }

  return Math.max(0.5, Math.min(1.3, factor));
}

/** MC/age-aware stop multiplier — wider for tiny/fresh coins, tighter for big/old ones. */
export function mcAgeStopMultiplier(
  mcUsd: number | null,
  ageMin: number | null,
  cfg: Pick<AdaptiveStopConfig, 'mcBands' | 'ageBands'>,
): number {
  let factor = 1;

  if (mcUsd != null && cfg.mcBands?.length) {
    const band = cfg.mcBands.find((b) => mcUsd <= b.maxMcUsd);
    if (band) factor *= band.factor;
    // Above all bands = large liquid coin → tighter
    if (!band) factor *= 0.85;
  }

  if (ageMin != null && cfg.ageBands?.length) {
    const band = cfg.ageBands.find((b) => ageMin <= b.maxAgeMin);
    if (band) factor *= band.factor;
  }

  return Math.max(0.5, Math.min(1.8, factor));
}
