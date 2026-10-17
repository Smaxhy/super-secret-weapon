/**
 * Entry momentum gate — prevents buying at the peak.
 *
 * 69% of losing trades never went above 1.05x = the bot enters at the tip of a pump.
 * This gate checks the price shape RIGHT before buying and blocks entries that are
 * chasing (big recent run), at the top (not off the high), or into sellers (low buy share).
 * Blocked entries go to the DipWatcher (MC ≥ $15k) or trade at half size (under $15k).
 */

export interface MomentumGateConfig {
  enabled: boolean;
  maxRun1mPct: number;
  maxRun3mPct: number;
  minOffHighPct: number;
  minBuyShare2m: number;
  maxLastCandlePct: number;
  skipForExplore: boolean;
  skipForDipEntry: boolean;
}

export interface ShapeInput {
  run1m?: number | null;
  run3m?: number | null;
  offHigh10m?: number | null;
  buyShare2m?: number | null;
  lastCandlePct?: number | null;
}

/** null = pass, string = why it's blocked. */
export function momentumGateFails(shape: ShapeInput | null, c: MomentumGateConfig): string | null {
  if (!c.enabled || !shape) return null;

  const run1m = shape.run1m ?? 0;
  if (c.maxRun1mPct > 0 && run1m > c.maxRun1mPct) {
    return `chasing: +${Math.round(run1m)}% in the last minute (max ${c.maxRun1mPct}%)`;
  }

  const run3m = shape.run3m ?? 0;
  if (c.maxRun3mPct > 0 && run3m > c.maxRun3mPct) {
    return `chasing: +${Math.round(run3m)}% in 3 min (max ${c.maxRun3mPct}%)`;
  }

  const offHigh = shape.offHigh10m ?? 100;
  if (c.minOffHighPct > 0 && offHigh < c.minOffHighPct) {
    return `too close to the top: only ${offHigh.toFixed(1)}% off the 10-min high (need ${c.minOffHighPct}%)`;
  }

  const buyShare = shape.buyShare2m ?? 0.5;
  if (c.minBuyShare2m > 0 && buyShare < c.minBuyShare2m) {
    return `sellers winning: buy share ${Math.round(buyShare * 100)}% in 2 min (need ${Math.round(c.minBuyShare2m * 100)}%)`;
  }

  const lastCandle = shape.lastCandlePct ?? 0;
  if (c.maxLastCandlePct > 0 && lastCandle > c.maxLastCandlePct) {
    return `buying the tip: last candle +${Math.round(lastCandle)}% (max ${c.maxLastCandlePct}%)`;
  }

  return null;
}
