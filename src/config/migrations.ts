/**
 * Saved-settings migrations.
 *
 * Every config section saved in the database (seed script, or the Controls page
 * writing a whole section) wins over the code defaults, so a changed default
 * never reaches an existing install on its own. Each migration below sets a few
 * specific settings — only the ones a change deliberately moves — in the saved
 * rows. Everything else the owner set stays untouched. Applied once, in order;
 * the applied version is stored in the BotConfig row `_version`.
 */
import type { Prisma } from '@prisma/client';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('config-migrations');
export const VERSION_KEY = '_version';

export interface ConfigMigration {
  version: number;
  note: string;
  /** [section, path inside the section, new value] */
  set: Array<[string, string[], unknown]>;
}

export const MIGRATIONS: ConfigMigration[] = [
  {
    version: 1,
    note: 'break-even stop from 1.2x, trail from 1.2x, copy trades restricted, crowd log for every coin',
    set: [
      ['exit', ['trail', 'breakEvenAfterMultiple'], 1.2],
      ['exit', ['trailingStopActivateMultiple'], 1.2],
      ['trading', ['allocation', 'SMART_MONEY_COPY'], 0.05],
      ['copy', ['scoreThresholdDelta'], 5],
      ['focus', ['crowdLogFromCurvePct'], 0],
    ],
  },
  {
    version: 2,
    note: 'stricter, instant trailing stop; faster paper fills (150–500 ms)',
    set: [
      ['exit', ['trailingStopActivateMultiple'], 1.15],
      ['exit', ['trail', 'confirmTicks'], 1],
      ['exit', ['trail', 'confirmSec'], 0],
      ['exit', ['trail', 'ladder'], [
        { fromMultiple: 1.15, pct: 6 },
        { fromMultiple: 1.3, pct: 7 },
        { fromMultiple: 1.5, pct: 9 },
        { fromMultiple: 2, pct: 11 },
        { fromMultiple: 3, pct: 14 },
        { fromMultiple: 5, pct: 17 },
        { fromMultiple: 10, pct: 20 },
      ]],
      ['exit', ['trail', 'volAdjust'], { min: 0.8, max: 1.15 }],
      ['paper', ['latencyMinMs'], 150],
      ['paper', ['latencyMaxMs'], 500],
    ],
  },
  {
    version: 3,
    note: 'dip buy zone starts 10–15% below the high and follows new highs; watch until +100% from the signal',
    set: [
      ['chart', ['dip', 'zoneTopMaxPct'], 15],
      ['chart', ['dip', 'runAwayPct'], 100],
    ],
  },
  {
    version: 4,
    note: 'v5 strategy (research): new pairs first, copy trading off, winners pay for losers (40% at 1.4x, wide trail, time stops), late-curve / BOOST-window entries cut',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.55, MIGRATION_MOMENTUM: 0.25, SOON: 0.2, SMART_MONEY_COPY: 0 }],
      ['trading', ['enabledStrategies', 'SMART_MONEY_COPY'], false],
      ['exit', ['takeProfitTiers'], [{ multiple: 1.4, sellPct: 40 }, { multiple: 5, sellPct: 15 }]],
      ['exit', ['trailingStopActivateMultiple'], 1.4],
      ['exit', ['trail', 'confirmSec'], 0.5],
      ['exit', ['trail', 'breakEvenAfterMultiple'], 1.4],
      ['exit', ['trail', 'ladder'], [
        { fromMultiple: 1.4, pct: 20 },
        { fromMultiple: 2, pct: 25 },
        { fromMultiple: 3, pct: 25 },
        { fromMultiple: 5, pct: 22 },
        { fromMultiple: 10, pct: 20 },
      ]],
      ['exit', ['trail', 'volAdjust'], { min: 0.8, max: 1.2 }],
      ['exit', ['trail', 'peakHoldMs'], 2500],
      ['exit', ['protectProfit'], { afterMultiple: 1.4, floorMultiple: 1.03 }],
      ['exit', ['resistance', 'minProfitMultiple'], 1.5],
      ['exit', ['riskExit', 'minProfitMultiple'], 1.5],
      ['exit', ['maxHoldMinutes'], { CURVE_SNIPE: 30, SOON: 45, MIGRATION_MOMENTUM: 240, SMART_MONEY_COPY: 60 }],
      ['exit', ['stopLoss', 'minPct'], 12],
      ['exit', ['stopLoss', 'confirmSec'], 2],
      ['exit', ['staleMinutes'], { CURVE_SNIPE: 20, SOON: 20, MIGRATION_MOMENTUM: 60, SMART_MONEY_COPY: 60 }],
      ['focus', ['soon', 'maxCurvePct'], 90],
      ['focus', ['soon', 'minMarketCapUsd'], 0],
      ['focus', ['soon', 'minVolumeUsd'], 10_000],
      ['focus', ['soon', 'scoreThresholdDelta'], 0],
      ['focus', ['soon', 'sizeMultiplier'], 1],
      ['focus', ['migrated', 'scoreThresholdDelta'], 0],
      ['focus', ['migrated', 'sizeMultiplier'], 1],
      ['focus', ['swing', 'maxReentries'], 1],
      ['scoring', ['checkpointsSec'], [45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720]],
      ['scoring', ['migrationCheckpointsSec'], [330, 480, 660, 900, 1200, 1800, 2400, 3600]],
      ['chart', ['smartSell', 'minMultiple'], 1.6],
    ],
  },
  {
    version: 5,
    note: 'v7 (owner: swing more, especially bigger coins; trade more often to learn): SWING strategy (30% of capital, max 3 open), up to 8 positions, a little looser new-pair demand rules',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.4, MIGRATION_MOMENTUM: 0.15, SOON: 0.15, SMART_MONEY_COPY: 0, SWING: 0.3 }],
      ['trading', ['enabledStrategies', 'SWING'], true],
      ['trading', ['maxConcurrentPositions'], 8],
      ['trading', ['maxOpenByStrategy'], { CURVE_SNIPE: 4, SOON: 2, MIGRATION_MOMENTUM: 2, SMART_MONEY_COPY: 1, SWING: 3 }],
      ['focus', ['newPair', 'minBuyers60s'], 10],
      ['focus', ['newPair', 'minNewBuyers60s'], 6],
      ['focus', ['newPair', 'minNetFlowSol60s'], 1],
      ['focus', ['newPair', 'minBuyRatioSol'], 1.2],
      ['focus', ['newPair', 'minBuyRatioCount'], 1.3],
      ['focus', ['newPair', 'maxGapSec'], 20],
    ],
  },
  {
    version: 6,
    note: 'v8 (owner: be very strict with swings, take 10% profits fast, sell spikes, bigger size on bigger coins; avoid vamps)',
    set: [
      ['swing', ['minMarketCapUsd'], 50_000],
      ['swing', ['minLiquidityUsd'], 25_000],
      ['swing', ['minVolume24hUsd'], 250_000],
      ['swing', ['minPullbackPct'], 15],
      ['swing', ['maxPullbackPct'], 35],
      ['swing', ['maxBouncePct'], 8],
      ['swing', ['minBuyRatio'], 1.3],
      ['swing', ['minTrades10m'], 40],
      ['swing', ['maxDrop1hPct'], 30],
      ['swing', ['blockDowntrend'], true],
      ['swing', ['minScore'], 78],
      ['swing', ['watchlistScoreDelta'], -3],
      ['swing', ['minResilience'], 0.45],
      ['swing', ['maxTop10Pct'], 45],
      ['swing', ['halfSizeTop10Pct'], 35],
      ['swing', ['reentryCooldownMin'], 30],
      ['swing', ['lossCooldownMin'], 240],
      ['swing', ['maxTradesPerCoinPerDay'], 3],
      ['swing', ['lossStreakPauseHours'], 48],
      ['trading', ['maxPositionMultipleByStrategy', 'SWING'], 2.5],
      ['exit', ['byStrategy', 'SWING'], {
        takeProfitTiers: [{ multiple: 1.1, sellPct: 50 }, { multiple: 1.2, sellPct: 25 }, { multiple: 1.5, sellPct: 15 }],
        trailingStopActivateMultiple: 1.1,
        trail: { breakEvenAfterMultiple: 1.1, ladder: [{ fromMultiple: 1.1, pct: 6 }, { fromMultiple: 1.2, pct: 7 }, { fromMultiple: 1.5, pct: 9 }, { fromMultiple: 2, pct: 12 }], peakHoldMs: 2000 },
        protectProfit: { afterMultiple: 1.08, floorMultiple: 1.02 },
        timeStop: { minPeakMultiple: 1.04, maxMultiple: 1.0 },
        spikeSell: { enabled: true, risePct: 8, windowSec: 120, sellPct: 50, minMultiple: 1.04 },
        holdLonger: { enabled: true, minMarketCapUsd: 60_000, maxHours: 8 },
      }],
      ['exit', ['timeStop', 'minutes', 'SWING'], 30],
      ['exit', ['timeStop', 'stallMinutes', 'SWING'], 45],
      ['exit', ['maxHoldMinutes', 'SWING'], 240],
      ['exit', ['staleMinutes', 'SWING'], 45],
      ['exit', ['stopLoss', 'maxPctByStrategy', 'SWING'], 12],
      ['exit', ['stopLoss', 'minPctByStrategy', 'SWING'], 10],
      ['explore', ['scoreMargin'], 5],
      ['explore', ['strategies'], ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM']],
    ],
  },
  {
    version: 7,
    note: 'v8.2 (owner: good coins pop up on DexScreener within minutes): DexScreener every 30 s + a 5-minute hot list',
    set: [
      ['dex', ['pollSec'], 30],
      ['dex', ['hot5mSize'], 15],
    ],
  },
  {
    version: 8,
    note: 'v8.9 (owner: trade more alongside coins many KOLs buy): KOL follow gets 15% of capital and up to 3 open trades',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.35, MIGRATION_MOMENTUM: 0.15, SOON: 0.1, SMART_MONEY_COPY: 0.15, SWING: 0.25 }],
      ['trading', ['enabledStrategies', 'SMART_MONEY_COPY'], true],
      ['trading', ['maxOpenByStrategy', 'SMART_MONEY_COPY'], 3],
      // Labels must match how the bot trades: a win = first take-profit (1.4x) before the stop (≈0.85x).
      ['learning', ['winMultiple'], 1.4],
      ['learning', ['drawdownLossMultiple'], 0.85],
    ],
  },
  {
    version: 9,
    note: 'v9.2 (owner: trade a lot more, especially migrated coins with real volume): migration 25% of capital, 4 open, up to 10 positions',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.3, MIGRATION_MOMENTUM: 0.25, SOON: 0.1, SMART_MONEY_COPY: 0.15, SWING: 0.2 }],
      ['trading', ['maxOpenByStrategy', 'MIGRATION_MOMENTUM'], 4],
      ['trading', ['maxConcurrentPositions'], 10],
    ],
  },
  {
    version: 10,
    note: 'v9.4 (owner: stop skipping coins that then go 2–4×): RUNNER strategy (20% of capital, 4 open), 12 positions',
    set: [
      ['trading', ['allocation'], { CURVE_SNIPE: 0.25, MIGRATION_MOMENTUM: 0.25, SOON: 0.05, SMART_MONEY_COPY: 0.1, SWING: 0.15, RUNNER: 0.2 }],
      ['trading', ['enabledStrategies', 'RUNNER'], true],
      ['trading', ['maxOpenByStrategy', 'RUNNER'], 4],
      ['trading', ['maxConcurrentPositions'], 12],
      ['explore', ['strategies'], ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'RUNNER']],
    ],
  },
  {
    version: 11,
    note: 'v9.6 (owner: not trading enough): safety bar 55 (soft insider flags no longer stack it out), learning trades within 8 points, 4 open, 10 an hour',
    set: [
      ['entry', ['minSafetyScore'], 55],
      ['explore', ['scoreMargin'], 8],
      ['explore', ['maxOpen'], 4],
      ['explore', ['maxPerHour'], 10],
    ],
  },
  {
    version: 12,
    note: 'v9.7 (owner: trade A LOT more on migrated coins with ≥$2k liquidity, ≥$25k MC, ≥9 SOL fees): migrated bar −15, looser real-volume scan, 30% of capital, 6 open, 14 positions',
    set: [
      ['focus', ['migrated', 'minTotalFeesSol'], 9],
      ['focus', ['migrated', 'minMarketCapUsd'], 25_000],
      ['focus', ['migrated', 'minLiquidityUsd'], 2_000],
      ['focus', ['migrated', 'scoreThresholdDelta'], -15],
      ['focus', ['migrated', 'minActiveWallets5m'], 15],
      ['trading', ['allocation'], { CURVE_SNIPE: 0.2, MIGRATION_MOMENTUM: 0.3, SOON: 0.05, SMART_MONEY_COPY: 0.1, SWING: 0.15, RUNNER: 0.2 }],
      ['trading', ['maxOpenByStrategy', 'MIGRATION_MOMENTUM'], 6],
      ['trading', ['maxConcurrentPositions'], 14],
    ],
  },
  {
    version: 13,
    note: 'v9.9 (owner: bigger trades, a lot more of them, then no more changes): minimum size 0.1 SOL, score bar 65, learning trades 6 open / 20 an hour',
    set: [
      ['trading', ['minPositionSol'], 0.1],
      ['entry', ['minCombinedScore'], 65],
      ['explore', ['maxOpen'], 6],
      ['explore', ['maxPerHour'], 20],
    ],
  },
  {
    version: 14,
    note: 'v9.10 (owner: "legit never trading"): rug-guard dump risk 60% / 80% (was 25 / 45 — refused nearly every migrated coin), rugger memory needs 3 of the top-10 holders',
    set: [
      ['antiRug', ['rugGuard', 'maxTopDumpImpactPct'], 60],
      ['antiRug', ['rugGuard', 'maxTop3DumpImpactPct'], 80],
      ['antiRug', ['rugGuard', 'ruggerWalletMin'], 3],
    ],
  },
  {
    version: 15,
    note: 'v10.5.1 (owner: "trade more like before"): the new price-action buy rules off (chart read still stored for the learners; chart exits stay on)',
    set: [['entry', ['priceAction', 'enabled'], false]],
  },
  {
    version: 16,
    note: 'v10.16 (owner: "big lack of trades, the bot can\'t learn"): learning trades for coins up to 12 points under the bar (was 8) — every rule must still pass, half size, low-score cap 0.25 SOL',
    set: [['explore', ['scoreMargin'], 12]],
  },
  {
    version: 17,
    note: 'v10.18.1 (owner: "tiny bundlers are okay, every coin has them — loosen it a little"): the bundle guard only blocks big groups — ≥5% of the supply together, 10 same-size wallets (≥0.3% each), 6 same-day wallets, 4 for both',
    set: [
      ['antiRug', ['rugGuard', 'bundle', 'minHolderPct'], 0.3],
      ['antiRug', ['rugGuard', 'bundle', 'sameSizeMinWallets'], 10],
      ['antiRug', ['rugGuard', 'bundle', 'minGroupPct'], 5],
      ['antiRug', ['rugGuard', 'bundle', 'sameDayMinWallets'], 6],
      ['antiRug', ['rugGuard', 'bundle', 'comboMinWallets'], 4],
    ],
  },
  {
    version: 18,
    note: 'v10.19 (review: "the learner changes weights on weak evidence"): weights only move with 300+ clean labels (40+ wins and losses), tested on the newest 300 it never trained on (20+ of each)',
    set: [
      ['learning', ['minSamples'], 300],
      ['learning', ['minPerClass'], 40],
      ['learning', ['holdoutSize'], 300],
      ['learning', ['minHoldoutPerClass'], 20],
    ],
  },
  {
    version: 19,
    note: 'v10.21 (owner\'s CSV, 515 trades: RUNNER / SWING / new pairs clearly losing, 70% of losses died in the first 60 s, 00–04 UTC worst, few trades reach 1.4x): those 3 strategies off, budget to MIGRATION 45% / SOON 35% / KOL follow 20%, wait 25 s and the price must hold, no new buys 00–04 UTC, SOON + migrated sell 30% at 1.2x',
    set: [
      ['trading', ['enabledStrategies', 'RUNNER'], false],
      ['trading', ['enabledStrategies', 'SWING'], false],
      ['trading', ['enabledStrategies', 'CURVE_SNIPE'], false],
      ['trading', ['allocation', 'MIGRATION_MOMENTUM'], 0.45],
      ['trading', ['allocation', 'SOON'], 0.35],
      ['trading', ['allocation', 'SMART_MONEY_COPY'], 0.2],
      ['trading', ['allocation', 'RUNNER'], 0],
      ['trading', ['allocation', 'SWING'], 0],
      ['trading', ['allocation', 'CURVE_SNIPE'], 0],
      ['trading', ['maxOpenByStrategy', 'SOON'], 4],
      ['trading', ['quietHours'], { enabled: true, fromUtc: 0, toUtc: 4 }],
      ['entry', ['confirmDelaySec'], 25],
      ['entry', ['confirm'], { maxDropPct: 4, maxPumpPct: 15, minBuyRatio: 1.1 }],
      ['exit', ['byStrategy', 'SOON', 'takeProfitTiers'], [{ multiple: 1.2, sellPct: 30 }, { multiple: 1.4, sellPct: 30 }, { multiple: 5, sellPct: 15 }]],
      ['exit', ['byStrategy', 'MIGRATION_MOMENTUM', 'takeProfitTiers'], [{ multiple: 1.2, sellPct: 30 }, { multiple: 1.4, sellPct: 30 }, { multiple: 5, sellPct: 15 }]],
    ],
  },
  {
    version: 20,
    note: 'v10.23 (owner: "5 trades in 6 hours is way too little"): night pause off, buy wait 15 s with ≤6% drop, RUNNER back on at the smallest size (10% budget, max 2 open)',
    set: [
      ['trading', ['quietHours', 'enabled'], false],
      ['entry', ['confirmDelaySec'], 15],
      ['entry', ['confirm', 'maxDropPct'], 6],
      ['trading', ['enabledStrategies', 'RUNNER'], true],
      ['trading', ['allocation', 'RUNNER'], 0.1],
      ['trading', ['allocation', 'MIGRATION_MOMENTUM'], 0.4],
      ['trading', ['allocation', 'SOON'], 0.3],
      ['trading', ['maxOpenByStrategy', 'RUNNER'], 2],
      ['runner', ['sizeMultiplier'], 0.5],
    ],
  },
  {
    version: 21,
    note: 'v10.25 (owner picked a wallet to copy + "if he sells, sell instantly"): copy trades at the normal bar and size, 2 at once, no minimum hold',
    set: [
      ['copy', ['scoreThresholdDelta'], 0],
      ['copy', ['sizeMultiplier'], 1],
      ['copy', ['maxOpen'], 2],
      ['copy', ['minHoldSec'], 0],
    ],
  },
  {
    version: 22,
    note: "v10.27 (owner's terminal filters: migrated / soon / new pair): new pairs back on (≤ 1.5 min old), SOON needs $12k MC + $12k volume",
    set: [
      ['trading', ['enabledStrategies', 'CURVE_SNIPE'], true],
      ['trading', ['allocation', 'CURVE_SNIPE'], 0.15],
      ['trading', ['allocation', 'MIGRATION_MOMENTUM'], 0.35],
      ['trading', ['allocation', 'SOON'], 0.25],
      ['trading', ['allocation', 'RUNNER'], 0.05],
      ['focus', ['newPair', 'maxAgeSec'], 90],
      ['focus', ['soon', 'minMarketCapUsd'], 12_000],
      ['focus', ['soon', 'minVolumeUsd'], 12_000],
    ],
  },
  {
    version: 23,
    note: "v10.28: paper fees = the owner's terminal (sell 0.001 prio + 0.005 tip, buy 0.0001 + 0.001); KOL buys never shortcut the rules",
    set: [
      ['paper', ['txFeeSol'], 0.006],
      ['paper', ['buyTxFeeSol'], 0.0011],
      ['copy', ['skipDipWait'], false],
      ['copy', ['skipConfirm'], false],
      ['kol', ['follow', 'barDelta2'], 0],
      ['kol', ['follow', 'barDelta3'], 0],
      ['kol', ['follow', 'sizeMultiplier3'], 1],
    ],
  },
  {
    version: 24,
    note: 'v10.33: migrated coins need 12 active wallets (5 min), the same as the migrated scanner sends — 12–14 were sent and then bounced',
    set: [['focus', ['migrated', 'minActiveWallets5m'], 12]],
  },
  {
    version: 25,
    note: 'v10.34 (Bot health: every Migration / KOL / Runner buy signal sat in a dip wait that never filled): dip-only waits for 10% off the high (was 15), 15 min (was 10); huge volume = 30 real buyers / 12 SOL in 5 min (was 40 / 20)',
    set: [
      ['chart', ['dip', 'dipOnly', 'minPullbackPct'], 10],
      ['chart', ['dip', 'waitMinutes'], 15],
      ['chart', ['dip', 'dipOnly', 'hotVolume', 'minBuyers'], 30],
      ['chart', ['dip', 'dipOnly', 'hotVolume', 'minBuySol'], 12],
    ],
  },  {
    version: 26,
    note: "v10.35 (owner: \"lower the bot's older rules by a lot, the terminal filters are the main focus\"): bot minimums cut back to the owner's terminal filters; rug / bundle / vamp guards and the owner's filters unchanged",
    set: [
      ['entry', ['minSafetyScore'], 45],
      ['entry', ['minCombinedScore'], 55],
      ['entry', ['maxDevHoldingPct'], 12],
      ['entry', ['minHoldersByStrategy'], { RUNNER: 15, SMART_MONEY_COPY: 5 }],
      ['entry', ['maxBundlePct'], 25],
      ['entry', ['maxTop10Pct'], 60],
      ['entry', ['maxSingleHolderPct'], 12],
      ['entry', ['minLiquiditySol'], 1.5],
      ['entry', ['riskyEntry', 'maxBundlePct'], 35],
      ['entry', ['riskyEntry', 'maxTop10Pct'], 70],
      ['entry', ['riskyEntry', 'maxSingleHolderPct'], 18],
      ['entry', ['confirmDelaySec'], 8],
      ['focus', ['newPair', 'minAgeSec'], 30],
      ['focus', ['newPair', 'minHolders'], 5],
      ['focus', ['newPair', 'minCurveSol'], 3],
      ['focus', ['newPair', 'minMarketCapUsd'], 2500],
      ['focus', ['newPair', 'maxMarketCapUsd'], 100000],
      ['focus', ['newPair', 'minTotalFeesSol'], 0.05],
      ['focus', ['newPair', 'minVolumeUsd'], 200],
      ['focus', ['newPair', 'maxTop10Pct'], 40],
      ['focus', ['newPair', 'minOfHighPct'], 70],
      ['focus', ['newPair', 'minBuyers60s'], 7],
      ['focus', ['newPair', 'minNewBuyers60s'], 4],
      ['focus', ['newPair', 'minNetFlowSol60s'], 0.5],
      ['focus', ['newPair', 'minBuyRatioSol'], 1.1],
      ['focus', ['newPair', 'minBuyRatioCount'], 1.1],
      ['focus', ['newPair', 'requireAcceleration'], false],
      ['focus', ['newPair', 'minSizeCv'], 0.3],
      ['focus', ['newPair', 'maxSameSizePct'], 35],
      ['focus', ['newPair', 'minMedianBuySol'], 0.03],
      ['focus', ['newPair', 'maxGapSec'], 30],
      ['focus', ['newPair', 'maxBotVolumePct'], 50],
      ['focus', ['newPair', 'nearHighPct'], 12],
      ['focus', ['newPair', 'maxRun30sPct'], 50],
      ['focus', ['soon', 'minCurvePct'], 50],
      ['focus', ['soon', 'maxCurvePct'], 95],
      ['focus', ['soon', 'minTotalFeesSol'], 1],
      ['focus', ['soon', 'minActiveWallets5m'], 10],
      ['focus', ['soon', 'minHolders'], 20],
      ['focus', ['soon', 'minSafetyScore'], 40],
      ['focus', ['migrated', 'minActiveWallets5m'], 8],
      ['focus', ['migrated', 'noEntryFirstSec'], 180],
    ],
  },
  {
    version: 27,
    note: 'v10.36 (owner): new pairs always trade the minimum size; the dip analyser trades live (bonus points, checks, and dip entries for coins waiting for a dip)',
    set: [
      ['trading', ['minSizeStrategies'], ['CURVE_SNIPE']],
      ['ta', ['forceLive'], ['dip_analyser']],
      ['ta', ['forceLiveEdgePct'], 10],
      ['ta', ['dipEntrySignals'], ['dip_analyser']],
    ],
  },
  {
    version: 28,
    note: 'v10.37 (Bot health: SWING switched on but 34 buy signals refused "size below minimum" — its allocation was still 0): SWING gets 10%, KOL follow 20% → 10%',
    set: [
      ['trading', ['allocation', 'SWING'], 0.1],
      ['trading', ['allocation', 'SMART_MONEY_COPY'], 0.1],
    ],
  },
  {
    version: 29,
    note: "v10.39 (owner, after an honest review): v10.35's big loosening reverted (back to v25 values; the owner's filters stay on top), the dip analyser back to test-only, and the bar / size nudgers on thin evidence off (trade coach, score calibration, timing); chart buy rules back to their default (off)",
    set: [
      ['entry', ['minSafetyScore'], 55],
      ['entry', ['minCombinedScore'], 65],
      ['entry', ['maxDevHoldingPct'], 10],
      ['entry', ['minHoldersByStrategy'], {}],
      ['entry', ['maxBundlePct'], 18],
      ['entry', ['maxTop10Pct'], 50],
      ['entry', ['maxSingleHolderPct'], 10],
      ['entry', ['minLiquiditySol'], 5],
      ['entry', ['riskyEntry', 'maxBundlePct'], 30],
      ['entry', ['riskyEntry', 'maxTop10Pct'], 65],
      ['entry', ['riskyEntry', 'maxSingleHolderPct'], 15],
      ['entry', ['confirmDelaySec'], 15],
      ['entry', ['autoAdjust'], { coach: false, calibration: false }],
      ['entry', ['priceAction', 'enabled'], false],
      ['focus', ['newPair', 'minAgeSec'], 45],
      ['focus', ['newPair', 'minHolders'], 8],
      ['focus', ['newPair', 'minCurveSol'], 8],
      ['focus', ['newPair', 'minMarketCapUsd'], 3500],
      ['focus', ['newPair', 'maxMarketCapUsd'], 15000],
      ['focus', ['newPair', 'minTotalFeesSol'], 0.25],
      ['focus', ['newPair', 'minVolumeUsd'], 1500],
      ['focus', ['newPair', 'maxTop10Pct'], 30],
      ['focus', ['newPair', 'minOfHighPct'], 80],
      ['focus', ['newPair', 'minBuyers60s'], 10],
      ['focus', ['newPair', 'minNewBuyers60s'], 6],
      ['focus', ['newPair', 'minNetFlowSol60s'], 1],
      ['focus', ['newPair', 'minBuyRatioSol'], 1.2],
      ['focus', ['newPair', 'minBuyRatioCount'], 1.3],
      ['focus', ['newPair', 'requireAcceleration'], true],
      ['focus', ['newPair', 'minSizeCv'], 0.5],
      ['focus', ['newPair', 'maxSameSizePct'], 25],
      ['focus', ['newPair', 'minMedianBuySol'], 0.05],
      ['focus', ['newPair', 'maxGapSec'], 20],
      ['focus', ['newPair', 'maxBotVolumePct'], 40],
      ['focus', ['newPair', 'nearHighPct'], 7],
      ['focus', ['newPair', 'maxRun30sPct'], 35],
      ['focus', ['soon', 'minCurvePct'], 70],
      ['focus', ['soon', 'maxCurvePct'], 90],
      ['focus', ['soon', 'minTotalFeesSol'], 3],
      ['focus', ['soon', 'minActiveWallets5m'], 25],
      ['focus', ['soon', 'minHolders'], 35],
      ['focus', ['soon', 'minSafetyScore'], 45],
      ['focus', ['migrated', 'minActiveWallets5m'], 12],
      ['focus', ['migrated', 'noEntryFirstSec'], 330],
      ['ta', ['forceLive'], []],
      ['ta', ['dipEntrySignals'], []],
      ['timing', ['enabled'], false],
    ],
  },
  {
    version: 30,
    note: 'v10.40 (owner, last fix): total fees by market cap for every coin — MC ≥ $50k needs 9 SOL, under $50k 3 SOL',
    set: [['entry', ['feesByMarketCap'], { enabled: true, mcUsd: 50_000, aboveSol: 9, belowSol: 3 }]],
  },
  {
    version: 31,
    note: "v10.41 (owner): sell fee 0.002 SOL (0.001 priority + 0.001 tip; the 0.005 tip was ~2.5% of every 0.2 SOL sale)",
    set: [['paper', ['txFeeSol'], 0.002]],
  },
  {
    version: 32,
    note: 'v10.43 (owner CSV since the freeze: stop losses averaged −21%, many −25…−40% inside the 5-minute hold): no minimum hold — the normal stop works from the start',
    set: [['exit', ['stopLoss', 'minHoldSec'], 0]],
  },
  {
    version: 33,
    note: 'v11: re-enable learners (coach, calibration, timing, priceAction), add RugCheck + momentum gate + Obsidian config',
    set: [
      ['entry', ['autoAdjust'], { coach: true, calibration: true }],
      ['timing', ['enabled'], true],
      ['entry', ['priceAction', 'enabled'], true],
      ['rugCheck', [], { enabled: true, maxScore: 500, blockDanger: true }],
      ['momentumGate', [], { enabled: true, maxRun1mPct: 25, maxRun3mPct: 40, minOffHighPct: 3, minBuyShare2m: 0.45, maxLastCandlePct: 20, skipForExplore: true, skipForDipEntry: true }],
      ['obsidian', [], { enabled: false, vaultPath: '' }],
    ],
  },
  {
    version: 34,
    note: 'v11.1: exit math fix (lower TP tiers + earlier break-even/trail), learner aggressiveness (lower win-model thresholds, outcome weight 0.5, allocator floor 0.4, autopsy harder on losers), slippage 0.8%',
    set: [
      ['exit', ['takeProfitTiers'], [{ multiple: 1.25, sellPct: 40 }, { multiple: 2, sellPct: 20 }, { multiple: 5, sellPct: 15 }]],
      ['exit', ['trailingStopActivateMultiple'], 1.2],
      ['exit', ['trail', 'breakEvenAfterMultiple'], 1.2],
      ['exit', ['protectProfit'], { afterMultiple: 1.2, floorMultiple: 1.03 }],
      ['exit', ['trail', 'ladder'], [{ fromMultiple: 1.2, pct: 12 }, { fromMultiple: 1.5, pct: 18 }, { fromMultiple: 2, pct: 25 }, { fromMultiple: 3, pct: 25 }, { fromMultiple: 5, pct: 22 }, { fromMultiple: 10, pct: 20 }]],
      ['exit', ['byStrategy', 'SOON'], { takeProfitTiers: [{ multiple: 1.15, sellPct: 40 }, { multiple: 1.3, sellPct: 25 }, { multiple: 5, sellPct: 15 }], trailingStopActivateMultiple: 1.15, trail: { breakEvenAfterMultiple: 1.15, ladder: [{ fromMultiple: 1.15, pct: 8 }, { fromMultiple: 1.3, pct: 14 }, { fromMultiple: 2, pct: 22 }, { fromMultiple: 5, pct: 20 }] }, protectProfit: { afterMultiple: 1.15, floorMultiple: 1.02 } }],
      ['exit', ['byStrategy', 'MIGRATION_MOMENTUM'], { takeProfitTiers: [{ multiple: 1.15, sellPct: 40 }, { multiple: 1.3, sellPct: 25 }, { multiple: 5, sellPct: 15 }], trailingStopActivateMultiple: 1.15, trail: { breakEvenAfterMultiple: 1.15, ladder: [{ fromMultiple: 1.15, pct: 8 }, { fromMultiple: 1.3, pct: 14 }, { fromMultiple: 2, pct: 22 }, { fromMultiple: 5, pct: 20 }] }, protectProfit: { afterMultiple: 1.15, floorMultiple: 1.02 } }],
      ['paper', ['slippagePct'], 0.8],
      ['outcomes', ['weight'], 0.5],
    ],
  },
  {
    version: 35,
    note: 'v11.2: tighter entry quality, spike sell global, scale-in 40%, quiet hours, faster time stops, stricter confirmation, dip stall detection',
    set: [
      ['entryQuality', [], { enabled: true, maxDrop15sPct: 5, maxSellBuyRatio30s: 2.0, spikeRetracePct: 20, bounceBoostPct: 4, minBuyers30s: 3, minVolRatio: 0.3 }],
      ['exit', ['spikeSell'], { enabled: true, risePct: 12, windowSec: 90 }],
      ['trading', ['scaleIn', 'firstPct'], 40],
      ['trading', ['quietHours', 'enabled'], true],
      ['exit', ['timeStop', 'minutes'], { CURVE_SNIPE: 1, SOON: 2, MIGRATION_MOMENTUM: 8, SMART_MONEY_COPY: 2, SWING: 30, RUNNER: 3 }],
      ['exit', ['timeStop', 'defaultMinutes'], 4],
      ['exit', ['timeStop', 'minPeakMultiple'], 1.08],
      ['exit', ['timeStop', 'maxMultiple'], 1.04],
      ['exit', ['timeStop', 'stallMinutes'], { CURVE_SNIPE: 2, SOON: 4, MIGRATION_MOMENTUM: 8, SMART_MONEY_COPY: 4, SWING: 45, RUNNER: 5 }],
      ['entry', ['confirm'], { maxDropPct: 6, maxPumpPct: 10, minBuyRatio: 1.15, minNewBuyers: 2 }],
      ['chart', ['dip', 'maxDipStallSec'], 120],
      ['momentumGate', [], { enabled: true, maxRun1mPct: 18, maxRun3mPct: 30, minOffHighPct: 6, minBuyShare2m: 0.52, maxLastCandlePct: 15, skipForExplore: true, skipForDipEntry: true }],
    ],
  },
  {
    version: 36,
    note: 'v11.3: edge gate (reject negative-EV strategies), early bail (cut dead trades at 45s), adaptive stop MC/age bands',
    set: [
      ['entry', ['edgeGate'], { enabled: true, minEdgePct: 2, costPct: 7, minTrades: 30, window: 40, probeEvery: 4 }],
      ['exit', ['earlyBail'], { enabled: true, maxSec: 45, minPeakMultiple: 1.02, maxBuyRatio: 1.0 }],
      ['adaptiveStop', ['mcBands'], [{ maxMcUsd: 10_000, factor: 1.3 }, { maxMcUsd: 50_000, factor: 1.1 }, { maxMcUsd: 200_000, factor: 1.0 }]],
      ['adaptiveStop', ['ageBands'], [{ maxAgeMin: 2, factor: 1.2 }]],
    ],
  },
  {
    version: 37,
    note: 'v11.6: wallet engine (who is buying → points / no buy) + holder clock exit (sell before the big holders usually do)',
    // (`wallets` is a new section: never saved before → it takes the defaults; only the saved `exit` row needs the clock pushed in)
    set: [['exit', ['holderClock'], { enabled: true, minHolderPct: 1.5, expiryShare: 0.8, tightenTrailFactor: 0.6, sellPct: 40, minMultiple: 1.1 }]],
  },
  {
    version: 38,
    note: 'v11.7: Sniper mode (new section → defaults), new pairs + runners OFF (worst two in the owner\'s CSV), budget to migrated / SOON; pump.fun dead lists off until the owner finds the new URLs',
    set: [
      ['trading', ['enabledStrategies', 'CURVE_SNIPE'], false],
      ['trading', ['enabledStrategies', 'RUNNER'], false],
      ['trading', ['allocation'], { CURVE_SNIPE: 0, MIGRATION_MOMENTUM: 0.5, SOON: 0.3, RUNNER: 0, SMART_MONEY_COPY: 0.1, SWING: 0.1 }],
      ['trending', ['pumpUrls'], { live: '/coins/currently-live?offset=0&limit=60&includeNsfw=false', koth: '', forYou: '', runners: '' }],
    ],
  },
  {
    version: 39,
    note: 'v11.8 research ports: confirmation must pass 2 checks in a row 7 s apart; deployer-funded launch snipers refused (wallets.entry.deployerSniperHoldPct)',
    set: [
      ['entry', ['confirm', 'consecutivePasses'], 2],
      ['entry', ['confirm', 'intervalSec'], 7],
      ['wallets', ['entry', 'deployerSniperHoldPct'], 1],
    ],
  },
  {
    version: 40,
    note: 'v11.9 Obsidian shared brain: inbox tips, note caps (a saved obsidian row keeps its vaultPath / enabled)',
    set: [
      ['obsidian', ['inbox'], { enabled: true, pollSec: 60 }],
      ['obsidian', ['maxCoinNotesPerDay'], 300],
      ['obsidian', ['maxWalletNotes'], 2000],
      ['obsidian', ['minSkippedScoreMargin'], 10],
    ],
  },
];

/** BotConfig row: the time the current strategy version went live (learning that reads our own trades starts here). */
export const STRATEGY_SINCE_KEY = '_strategySince';
const UPGRADES_KEY = '_upgrades';

/** Run a one-time step once per database (recorded in the `_upgrades` row). Never throws. */
export async function oneTimeUpgrade(id: string, step: () => Promise<void>): Promise<boolean> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: UPGRADES_KEY } });
    const done = ((row?.value as { done?: string[] } | null)?.done ?? []).slice();
    if (done.includes(id)) return false;
    await step();
    done.push(id);
    await prisma.botConfig.upsert({ where: { key: UPGRADES_KEY }, update: { value: { done } }, create: { key: UPGRADES_KEY, value: { done } } });
    log.info({ id }, 'one-time upgrade applied');
    return true;
  } catch (err) {
    log.warn({ id, err: (err as Error).message }, 'one-time upgrade failed — will retry next start');
    return false;
  }
}

/** Mark "the current strategy starts now" (used by the strategy cool-off breaker). */
export async function markStrategySince(at = new Date()): Promise<void> {
  await prisma.botConfig.upsert({ where: { key: STRATEGY_SINCE_KEY }, update: { value: { at: at.toISOString() } }, create: { key: STRATEGY_SINCE_KEY, value: { at: at.toISOString() } } });
}

let sinceCache: { at: number; value: Date | null } | null = null;
/** When the current strategy went live (cached 5 min). null = unknown (count everything). */
export async function strategySince(): Promise<Date | null> {
  if (sinceCache && Date.now() - sinceCache.at < 300_000) return sinceCache.value;
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: STRATEGY_SINCE_KEY } });
    const iso = (row?.value as { at?: string } | null)?.at;
    sinceCache = { at: Date.now(), value: iso ? new Date(iso) : null };
  } catch {
    sinceCache = { at: Date.now(), value: null };
  }
  return sinceCache.value;
}

/** Pure: apply `set` to saved rows. Returns only the rows that changed (sections never saved are skipped). */
export function applyMigration(rows: Record<string, unknown>, m: ConfigMigration): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [section, path, value] of m.set) {
    const base = changed[section] ?? rows[section];
    if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
    // Empty path = the whole section (a saved row would otherwise keep its stale values).
    if (path.length === 0) {
      changed[section] = structuredClone(value);
      continue;
    }
    const copy = structuredClone(base) as Record<string, unknown>;
    let node = copy;
    for (const k of path.slice(0, -1)) {
      const next = node[k];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        node[k] = {};
      }
      node = node[k] as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = value;
    changed[section] = copy;
  }
  return changed;
}

/** Run pending migrations against the database. Never throws (logs instead). */
export async function runConfigMigrations(list: readonly ConfigMigration[] = MIGRATIONS): Promise<number> {
  try {
    const rows = await prisma.botConfig.findMany();
    const saved: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let version = Number((saved[VERSION_KEY] as { version?: number } | undefined)?.version ?? 0);
    let applied = 0;
    for (const m of list) {
      if (m.version <= version) continue;
      const changed = applyMigration(saved, m);
      for (const [key, value] of Object.entries(changed)) {
        await prisma.botConfig.update({ where: { key }, data: { value: value as Prisma.InputJsonValue } });
        saved[key] = value;
      }
      version = m.version;
      await prisma.botConfig.upsert({ where: { key: VERSION_KEY }, update: { value: { version } }, create: { key: VERSION_KEY, value: { version } } });
      applied++;
      log.info({ version, sections: Object.keys(changed) }, `saved settings migrated: ${m.note}`);
    }
    return applied;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'config migrations failed — keeping saved settings as they are');
    return 0;
  }
}
