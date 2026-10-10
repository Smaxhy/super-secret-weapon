/**
 * The exit settings as they were before the v5 strategy change (Oct 10). Tests written for
 * that behaviour (tiers at 1.3x, the 1.15x ladder, break-even from 1.2x, no time stops …)
 * run against these, so they keep checking the logic itself; v5 defaults have their own tests.
 */
import { DEFAULT_CONFIG } from '../src/config/default';

const d = DEFAULT_CONFIG.exit;
export const V4_EXIT = {
  ...d,
  takeProfitTiers: [
    { multiple: 1.3, sellPct: 25 },
    { multiple: 5, sellPct: 15 },
  ],
  trailingStopActivateMultiple: 1.15,
  trail: {
    ...d.trail,
    confirmTicks: 1,
    confirmSec: 0,
    breakEvenAfterMultiple: 1.2,
    ladder: [
      { fromMultiple: 1.15, pct: 6 },
      { fromMultiple: 1.3, pct: 7 },
      { fromMultiple: 1.5, pct: 9 },
      { fromMultiple: 2, pct: 11 },
      { fromMultiple: 3, pct: 14 },
      { fromMultiple: 5, pct: 17 },
      { fromMultiple: 10, pct: 20 },
    ],
    volAdjust: { min: 0.8, max: 1.15 },
    peakHoldMs: 1200,
  },
  timeStop: { ...d.timeStop, enabled: false },
  boostSell: { ...d.boostSell, enabled: false },
  protectProfit: { afterMultiple: 1.3, floorMultiple: 1.05 },
  resistance: { ...d.resistance, minProfitMultiple: 1.2 },
  riskExit: { ...d.riskExit, minProfitMultiple: 1.15 },
  maxHoldMinutes: { CURVE_SNIPE: 45, SOON: 60, MIGRATION_MOMENTUM: 120, SMART_MONEY_COPY: 90 },
  stopLoss: { ...d.stopLoss, minPct: 10, confirmSec: 1.5 },
  staleMinutes: { CURVE_SNIPE: 30, SOON: 20, MIGRATION_MOMENTUM: 120, SMART_MONEY_COPY: 120 },
} as unknown as typeof DEFAULT_CONFIG.exit;
