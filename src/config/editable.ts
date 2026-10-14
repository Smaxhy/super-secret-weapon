/**
 * Settings the owner can change on the Controls page ("Buy rules per strategy"). Only these paths can be written
 * through PUT /api/controls/rules — each has a label, a group and safe limits. Paths are `section.key.subkey`.
 */
export interface EditableSetting {
  key: string;
  group: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  help?: string;
}

const S = (group: string, key: string, label: string, min: number, max: number, unit?: string, step?: number, help?: string): EditableSetting => ({ group, key, label, min, max, unit, step, help });

export const EDITABLE: EditableSetting[] = [
  // ---- Migrated coins (PumpSwap) ----
  S('Migrated coins', 'trading.enabledStrategies.MIGRATION_MOMENTUM', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Migrated coins', 'focus.migrated.minMarketCapUsd', 'Min market cap', 0, 10_000_000, '$', 1000),
  S('Migrated coins', 'focus.migrated.minLiquidityUsd', 'Min liquidity', 0, 5_000_000, '$', 500),
  S('Migrated coins', 'focus.migrated.minTotalFeesSol', 'Min total fees paid', 0, 1000, 'SOL', 0.5),
  S('Migrated coins', 'entry.minHoldersMigration', 'Min holders', 0, 5000, undefined, 5),
  S('Migrated coins', 'focus.migrated.minSafetyScore', 'Min safety score (migrated coins)', 0, 100, 'pts', 1),
  S('Migrated coins', 'focus.migrated.minActiveWallets5m', 'Min active wallets (5 min)', 0, 1000, undefined, 1),
  S('Migrated coins', 'focus.migrated.noEntryFirstSec', 'No buys in the first … after migration', 0, 3600, 's', 30),
  S('Migrated coins', 'focus.migrated.scan.minOrganicBuyers5m', 'Real buyers needed (5 min)', 0, 500, undefined, 1),
  S('Migrated coins', 'focus.migrated.scan.minOrganicBuySol5m', 'Real buying needed (5 min)', 0, 500, 'SOL', 0.5),
  S('Migrated coins', 'focus.migrated.scan.minBuySharePct', 'Buyers share of trades', 0, 100, '%', 1),
  S('Migrated coins', 'focus.migrated.scan.maxRun3mPct', "Don't chase: max rise in 3 min", 0, 1000, '%', 5),
  S('Migrated coins', 'focus.migrated.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Migrated coins', 'focus.migrated.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Migrated coins', 'trading.maxOpenByStrategy.MIGRATION_MOMENTUM', 'Max open at once', 0, 30, undefined, 1),
  S('Migrated coins', 'trading.allocation.MIGRATION_MOMENTUM', 'Share of the budget', 0, 1, '0–1', 0.05),
  S('Migrated coins', 'exit.stopLoss.maxPctByStrategy.MIGRATION_MOMENTUM', 'Stop loss (max)', 5, 30, '%', 1),

  // ---- Soon (curve 70–90%) ----
  S('Soon (about to migrate)', 'trading.enabledStrategies.SOON', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Soon (about to migrate)', 'focus.soon.minCurvePct', 'Bonding curve from', 0, 100, '%', 1),
  S('Soon (about to migrate)', 'focus.soon.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('Soon (about to migrate)', 'focus.soon.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 1000),
  S('Soon (about to migrate)', 'focus.soon.minVolumeUsd', 'Min volume', 0, 5_000_000, '$', 1000),
  S('Soon (about to migrate)', 'focus.soon.minTotalFeesSol', 'Min total fees paid', 0, 500, 'SOL', 0.5),
  S('Soon (about to migrate)', 'focus.soon.minActiveWallets5m', 'Min active wallets (5 min)', 0, 1000, undefined, 1),
  S('Soon (about to migrate)', 'focus.soon.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Soon (about to migrate)', 'focus.soon.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Soon (about to migrate)', 'trading.maxOpenByStrategy.SOON', 'Max open at once', 0, 30, undefined, 1),
  S('Soon (about to migrate)', 'trading.allocation.SOON', 'Share of the budget', 0, 1, '0–1', 0.05),

  // ---- New pairs ----
  S('New pairs', 'trading.enabledStrategies.CURVE_SNIPE', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('New pairs', 'focus.newPair.minAgeSec', 'Coin at least … old', 0, 3600, 's', 5),
  S('New pairs', 'focus.newPair.maxAgeSec', 'Coin at most … old', 30, 7200, 's', 30),
  S('New pairs', 'focus.newPair.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 500),
  S('New pairs', 'focus.newPair.maxMarketCapUsd', 'Max market cap', 0, 10_000_000, '$', 500),
  S('New pairs', 'focus.newPair.minCurveSol', 'Min SOL in the curve', 0, 85, 'SOL', 0.5),
  S('New pairs', 'focus.newPair.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('New pairs', 'entry.minHoldersCurveSnipe', 'Min holders', 0, 2000, undefined, 1),
  S('New pairs', 'trading.maxOpenByStrategy.CURVE_SNIPE', 'Max open at once', 0, 30, undefined, 1),
  S('New pairs', 'trading.allocation.CURVE_SNIPE', 'Share of the budget', 0, 1, '0–1', 0.05),

  // ---- Runners ----
  S('Runners (curve coins taking off)', 'trading.enabledStrategies.RUNNER', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Runners (curve coins taking off)', 'runner.scan.minCurvePct', 'Bonding curve from', 0, 100, '%', 1),
  S('Runners (curve coins taking off)', 'runner.scan.maxCurvePct', 'Bonding curve up to', 0, 100, '%', 1),
  S('Runners (curve coins taking off)', 'runner.scan.minMarketCapUsd', 'Min market cap', 0, 1_000_000, '$', 500),
  S('Runners (curve coins taking off)', 'runner.scan.minOrganicBuyers5m', 'Real buyers needed (5 min)', 0, 500, undefined, 1),
  S('Runners (curve coins taking off)', 'runner.scan.minOrganicBuySol5m', 'Real buying needed (5 min)', 0, 500, 'SOL', 0.5),
  S('Runners (curve coins taking off)', 'runner.scoreThresholdDelta', 'Score bar shift (− = easier)', -40, 40, 'pts', 1),
  S('Runners (curve coins taking off)', 'runner.sizeMultiplier', 'Trade size ×', 0.1, 3, '×', 0.1),
  S('Runners (curve coins taking off)', 'trading.maxOpenByStrategy.RUNNER', 'Max open at once', 0, 30, undefined, 1),
  S('Runners (curve coins taking off)', 'trading.allocation.RUNNER', 'Share of the budget', 0, 1, '0–1', 0.05),
  S('Runners (curve coins taking off)', 'exit.stopLoss.maxPctByStrategy.RUNNER', 'Stop loss (max)', 5, 30, '%', 1),

  // ---- Bigger coins / KOL ----
  S('Bigger coins (swing) & KOL follow', 'trading.enabledStrategies.SWING', 'Swing on (1) / off (0)', 0, 1, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.allocation.SWING', 'Swing share of the budget', 0, 1, '0–1', 0.05),
  S('Bigger coins (swing) & KOL follow', 'trading.maxOpenByStrategy.SWING', 'Swing max open', 0, 30, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.enabledStrategies.SMART_MONEY_COPY', 'KOL follow on (1) / off (0)', 0, 1, undefined, 1),
  S('Bigger coins (swing) & KOL follow', 'trading.allocation.SMART_MONEY_COPY', 'KOL follow share of the budget', 0, 1, '0–1', 0.05),

  // ---- Every coin ----
  S('Every coin (safety & holders)', 'entry.minCombinedScore', 'Base score bar', 0, 100, 'pts', 1),
  S('Every coin (safety & holders)', 'entry.minSafetyScore', 'Min safety score', 0, 100, 'pts', 1),
  S('Every coin (safety & holders)', 'entry.confirmDelaySec', 'Wait before buying (price must hold)', 0, 120, 's', 5),
  S('Every coin (safety & holders)', 'entry.confirm.maxDropPct', 'While waiting: max price drop', 0, 50, '%', 1),
  S('Every coin (safety & holders)', 'entry.confirm.maxPumpPct', 'While waiting: max price rise (no chasing)', 0, 200, '%', 1),
  S('Every coin (safety & holders)', 'trading.quietHours.enabled', 'Night pause (no new buys) on (1) / off (0)', 0, 1, undefined, 1),
  S('Every coin (safety & holders)', 'trading.quietHours.fromUtc', 'Night pause from (UTC hour)', 0, 23, 'h', 1),
  S('Every coin (safety & holders)', 'trading.quietHours.toUtc', 'Night pause until (UTC hour)', 0, 23, 'h', 1),
  S('Every coin (safety & holders)', 'entry.maxTop10Pct', 'Max top-10 holders', 5, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxSingleHolderPct', 'Max one wallet holds', 1, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxDevHoldingPct', 'Max dev holds', 0, 100, '%', 1),
  S('Every coin (safety & holders)', 'entry.maxBundlePct', 'Max bundlers hold', 0, 100, '%', 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.maxTopDumpImpactPct', 'Rug guard: one holder could crash it', 10, 100, '%', 5),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.maxTop3DumpImpactPct', 'Rug guard: top-3 could crash it', 10, 100, '%', 5),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.bundle.enabled', 'Bundle guard (same-size / same-day wallets) on (1) / off (0)', 0, 1, undefined, 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.bundle.sameSizeMinWallets', 'Bundle guard: same-size wallets needed', 3, 30, undefined, 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.bundle.sameSizeTolerancePct', 'Bundle guard: "same size" means within', 1, 25, '%', 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.bundle.sameDayMinWallets', 'Bundle guard: top holders made the same day', 3, 15, undefined, 1),
  S('Every coin (safety & holders)', 'antiRug.rugGuard.bundle.minGroupPct', 'Bundle guard: only if the group holds at least', 1, 50, '% of supply', 0.5),

  // ---- Timeframes (every coin; 0 = off) ----
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.s5', "5 s: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.s15', "15 s: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.s30', "30 s: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.m1', "1 min: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.m5', "5 min: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastCandlePct.h1', "1 hour: don't buy if the candle is up more than", 0, 1000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.s5', "5 s: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.s15', "15 s: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.s30', "30 s: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.m1', "1 min: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.m5', "5 min: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxRun3Pct.h1', "1 hour: don't buy if the last 3 candles are up more than", 0, 2000, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.s5', "5 s: don't buy if the candle is down more than", 0, 100, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.s15', "15 s: don't buy if the candle is down more than", 0, 100, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.s30', "30 s: don't buy if the candle is down more than", 0, 100, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.m1', "1 min: don't buy if the candle is down more than", 0, 100, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.m5', "5 min: don't buy if the candle is down more than", 0, 100, '%', 1),
  S('Timeframes (every coin, 0 = off)', 'entry.timeframes.maxLastDropPct.h1', "1 hour: don't buy if the candle is down more than", 0, 100, '%', 1),

  // ---- Exit timers (also tuned by the exit tuner from what coins did after we sold) ----
  S('Exit timers — New pairs', 'exit.timeStop.minutes.CURVE_SNIPE', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — New pairs', 'exit.timeStop.stallMinutes.CURVE_SNIPE', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — New pairs', 'exit.staleMinutes.CURVE_SNIPE', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — New pairs', 'exit.maxHoldMinutes.CURVE_SNIPE', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — Soon', 'exit.timeStop.minutes.SOON', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — Soon', 'exit.timeStop.stallMinutes.SOON', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — Soon', 'exit.staleMinutes.SOON', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — Soon', 'exit.maxHoldMinutes.SOON', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — Migrated', 'exit.timeStop.minutes.MIGRATION_MOMENTUM', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — Migrated', 'exit.timeStop.stallMinutes.MIGRATION_MOMENTUM', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — Migrated', 'exit.staleMinutes.MIGRATION_MOMENTUM', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — Migrated', 'exit.maxHoldMinutes.MIGRATION_MOMENTUM', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — Runners', 'exit.timeStop.minutes.RUNNER', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — Runners', 'exit.timeStop.stallMinutes.RUNNER', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — Runners', 'exit.staleMinutes.RUNNER', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — Runners', 'exit.maxHoldMinutes.RUNNER', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — Swing', 'exit.timeStop.minutes.SWING', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — Swing', 'exit.timeStop.stallMinutes.SWING', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — Swing', 'exit.staleMinutes.SWING', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — Swing', 'exit.maxHoldMinutes.SWING', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — KOL follow', 'exit.timeStop.minutes.SMART_MONEY_COPY', 'Sell if no +10% after', 0.5, 600, 'min', 0.5, 'no follow-through'),
  S('Exit timers — KOL follow', 'exit.timeStop.stallMinutes.SMART_MONEY_COPY', 'Sell if no new high for', 0.5, 600, 'min', 0.5, 'stall'),
  S('Exit timers — KOL follow', 'exit.staleMinutes.SMART_MONEY_COPY', 'Sell if the price barely moves for (stale)', 1, 1440, 'min', 1),
  S('Exit timers — KOL follow', 'exit.maxHoldMinutes.SMART_MONEY_COPY', 'Max hold', 5, 2880, 'min', 5),
  S('Exit timers — every strategy', 'exit.timeStop.minPeakMultiple', 'No follow-through = never reached', 1, 2, '×', 0.01),
  S('Exit timers — every strategy', 'exit.timeStop.maxMultiple', '…and now at or below', 0.8, 1.5, '×', 0.01),

  // ---- Price action (owner's big update) ----
  S('Chart rules — buying (every coin)', 'entry.priceAction.enabled', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxManipulation', 'Max bot / wash score (0–1)', 0, 1, '', 0.05),
  S('Chart rules — buying (every coin)', 'entry.priceAction.minTrades60', 'Min trades in the last minute', 0, 200, undefined, 1),
  S('Chart rules — buying (every coin)', 'entry.priceAction.minUniqueBuyers60', 'Min buyers in the last minute', 0, 200, undefined, 1),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxChange60Pct', 'Wait for a dip if up more than … in 60 s', 0, 1000, '%', 5),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxExtensionPct', 'Wait for a dip if this far above its trend line', 0, 1000, '%', 5),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxOffHighPctByStrategy.CURVE_SNIPE', 'New pairs: max % under the recent high (0 = off)', 0, 100, '%', 5),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxOffHighPctByStrategy.RUNNER', 'Runners: max % under the recent high (0 = off)', 0, 100, '%', 5),
  S('Chart rules — buying (every coin)', 'entry.priceAction.maxOffHighPctByStrategy.SOON', 'Soon: max % under the recent high (0 = off)', 0, 100, '%', 5),
  S('Chart rules — buying (every coin)', 'entry.priceAction.minEdgeMultiple', 'Room to resistance ≥ … × the fees (0 = off)', 0, 10, '×', 0.5),
  S('Chart rules — selling (every coin)', 'exit.priceAction.enabled', 'On (1) / off (0)', 0, 1, undefined, 1),
  S('Chart rules — selling (every coin)', 'exit.priceAction.structureStop.enabled', 'Structure stop on (1) / off (0)', 0, 1, undefined, 1),
  S('Chart rules — selling (every coin)', 'exit.priceAction.structureStop.minPeakMultiple', 'Structure stop after a peak of', 1.05, 5, '×', 0.05),
  S('Chart rules — selling (every coin)', 'exit.priceAction.structureStop.breakPct', 'Structure stop: % under the swing low', 0, 30, '%', 1),
  S('Chart rules — selling (every coin)', 'exit.priceAction.momentumFade.enabled', 'Momentum fade on (1) / off (0)', 0, 1, undefined, 1),
  S('Chart rules — selling (every coin)', 'exit.priceAction.momentumFade.minMultiple', 'Momentum fade from', 1.05, 5, '×', 0.05),
  S('Chart rules — selling (every coin)', 'exit.priceAction.momentumFade.dropFromPeakPct', 'Momentum fade: % off the peak', 1, 50, '%', 1),
  S('Chart rules — selling (every coin)', 'exit.priceAction.momentumFade.sellPct', 'Momentum fade: sell % of what is left', 5, 100, '%', 5),
  S('Chart rules — selling (every coin)', 'exit.rugExit.singleSellLiquidityPct', 'Whale exit: one sell ≥ … % of liquidity (0 = off)', 0, 100, '%', 1),
  S('Chart rules — selling (every coin)', 'exit.rugExit.devAnySellMinHoldingPct', 'Dev holding ≥ … %: any dev sell = rug (0 = off)', 0, 50, '%', 0.5),

  // ---- Size & risk ----
  S('Trade size & risk', 'trading.maxPositionSol', 'Normal trade size', 0.01, 50, 'SOL', 0.05),
  S('Moonshot (test mode)', 'moonshot.enabled', 'Watch for moonshot setups (pretend trades only): on (1) / off (0)', 0, 1, undefined, 1),
  S('Moonshot (test mode)', 'moonshot.minBuyers5m', 'Real buyers in 5 min', 5, 1000, undefined, 1),
  S('Moonshot (test mode)', 'moonshot.minBuySol5m', 'Real buying in 5 min', 1, 10000, 'SOL', 1),
  S('Moonshot (test mode)', 'moonshot.minKolsHolding', 'KOLs still holding', 0, 20, undefined, 1),
  S('Moonshot (test mode)', 'moonshot.minMarketCapUsd', 'Min market cap', 0, 100_000_000, '$', 5000),
  S('Trade size & risk', 'trading.highConviction.enabled', 'Big trades only on strong setups: on (1) / off (0)', 0, 1, undefined, 1),
  S('Trade size & risk', 'trading.highConviction.minScore', 'Big trade needs a score of at least', 50, 100, undefined, 1),
  S('Trade size & risk', 'trading.highConviction.minMarketCapUsd', 'Big trade needs a market cap of at least', 0, 100_000_000, '$', 5000),
  S('Trade size & risk', 'trading.highConviction.normalMaxSol', 'Max size for any normal (not strong-setup) trade', 0.05, 50, 'SOL', 0.05),
  S('Trade size & risk', 'trading.highConviction.lowScoreMaxSol', 'Max size when the score is under the low-score line', 0.05, 50, 'SOL', 0.05),
  S('Trade size & risk', 'trading.highConviction.lowScore', 'Low-score line', 0, 100, undefined, 1),
  S('Trade size & risk', 'entry.priceAction.dipWait.enabled', 'Wait for a dip instead of chasing a pumped candle: on (1) / off (0)', 0, 1, undefined, 1),
  S('Trade size & risk', 'chart.dip.blowOff.enabled', 'Blow-off guard (no dip buys right under a fresh top): on (1) / off (0)', 0, 1, undefined, 1),
  S('Trade size & risk', 'chart.dip.blowOff.runPct', 'Blow-off guard: a run bigger than … in 15 min needs a deep, held dip', 20, 1000, '%', 10),
  S('Trade size & risk', 'chart.dip.blowOff.minDipPct', 'Blow-off guard: dip at least … off the top', 5, 80, '%', 1),
  S('Trade size & risk', 'chart.dip.blowOff.dropRunPct', 'Blow-off guard: a run bigger than … = never buy (0 = off)', 0, 3000, '%', 10),
  S('Trade size & risk', 'trading.highConviction.sizeSol', 'Big trade size', 0.1, 50, 'SOL', 0.1),
  S('Trade size & risk', 'trading.highConviction.maxPctOfCapital', 'Big trade max % of the balance', 1, 50, '%', 1),
  S('Trade size & risk', 'antiRug.rugGuard.cascade.dropPct', 'Rug exit: price crashes … in 20 s with several sellers', 5, 90, '%', 1),
  S('Trade size & risk', 'antiRug.rugGuard.cascade.soloDropPct', 'Rug exit: one wallet crashes it by … in 20 s (0 = off)', 0, 90, '%', 1),
  S('Trade size & risk', 'antiRug.rugGuard.cascade.crashDropPct', 'Rug exit: price crashes … in 90 s with heavy selling (0 = off)', 0, 90, '%', 1),
  S('Trade size & risk', 'trading.minPositionSol', 'Smallest trade', 0.01, 10, 'SOL', 0.01),
  S('Trade size & risk', 'trading.maxPositionPctOfLiquidity', 'Max trade size as % of the coin\'s liquidity (0 = off)', 0, 50, '%', 0.5),
  S('Trade size & risk', 'exit.stopLoss.minHoldSec', 'Hold at least … before the stop loss can sell (0 = off)', 0, 3600, 's', 30),
  S('Trade size & risk', 'exit.stopLoss.holdDisasterPct', 'During that hold, sell only past this loss (rug-level)', 15, 90, '%', 1),
  S('Trade size & risk', 'trading.maxConcurrentPositions', 'Max trades open at once', 1, 100, undefined, 1),
  S('Trade size & risk', 'exit.stopLoss.minPct', 'Stop loss from', 5, 30, '%', 1),
  S('Trade size & risk', 'exit.stopLoss.maxPct', 'Stop loss up to', 5, 40, '%', 1),
];

/** Pure: read a dotted path from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Pure: copy of `obj` with `path` set to `value` (creates missing objects). */
export function setPath<T extends Record<string, unknown>>(obj: T, path: string[], value: unknown): T {
  const copy = structuredClone(obj) as Record<string, unknown>;
  let node = copy;
  for (const k of path.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
  return copy as T;
}

/** Pure: validate a change. Booleans (enabledStrategies) are stored as true/false. */
export function checkEdit(key: string, raw: unknown): { ok: true; setting: EditableSetting; value: number | boolean } | { ok: false; error: string } {
  const setting = EDITABLE.find((x) => x.key === key);
  if (!setting) return { ok: false, error: 'That setting cannot be changed here' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'Not a number' };
  if (n < setting.min || n > setting.max) return { ok: false, error: `${setting.label}: must be ${setting.min}–${setting.max}` };
  return { ok: true, setting, value: key.startsWith('trading.enabledStrategies.') || key.endsWith('.enabled') ? n >= 1 : n };
}
