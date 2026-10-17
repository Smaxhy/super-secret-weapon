/**
 * Default bot settings.
 *
 * These are the values the bot uses on first boot. They are written into the
 * `BotConfig` table by the seed script; after that the database copy wins, so
 * you can change things from the dashboard without redeploying.
 *
 * All SOL amounts here are in SOL (not lamports).
 */
import type { MarketRegime, SnapshotInterval, StrategyName } from './types';

export const DEFAULT_CONFIG = {
  trading: {
    mode: 'PAPER' as const,
    maxPositionSol: 0.2,
    minPositionSol: 0.1,
    maxPositionSolCeiling: 0.3, // the dashboard slider can't go above this
    maxConcurrentPositions: 8,
    /** Fraction of capital per strategy. Must add up to 1. */
    allocation: {
      MIGRATION_MOMENTUM: 0.25,
      SMART_MONEY_COPY: 0.15,
      CURVE_SNIPE: 0.15,
      SOON: 0.15,
      RUNNER: 0.20,
      SWING: 0.10,
    } satisfies Record<StrategyName, number>,
    enabledStrategies: {
      MIGRATION_MOMENTUM: true,
      SMART_MONEY_COPY: true,
      CURVE_SNIPE: true,
      SOON: true,
      RUNNER: true,
      SWING: true,
    } satisfies Record<StrategyName, boolean>,
    /**
     * Conviction sizing: a bare-minimum pass gets `minPositionSol`, a setup
     * scoring `convictionFullScore`+ with strong price action gets `maxPositionSol`.
     */
    convictionSizing: true,
    convictionFullScore: 90,
  },

  entry: {
    minSafetyScore: 70,
    minCombinedScore: 65,
    minHoldersCurveSnipe: 20,
    minHoldersMigration: 50,
    maxDevHoldingPct: 10,
    requireNoMintAuthority: true,
    requireNoFreezeAuthority: true,
    minLiquiditySol: 5,
    /** Total traded volume (buys + sells) in USD. */
    minVolumeUsd: 12_000,
    minMarketCapUsd: 12_000,
    /** Total fees traders have paid on the token, in SOL (a proxy for real activity). */
    minTotalFeesSol: 1,

    // ---- Price-action gates (read from the trade tape) ----
    /** Don't chase: skip if price already rose more than this in the last 60s… */
    maxChange60Pct: 40,
    /** …or sits this far above its own trend line (a vertical candle, not a trend). */
    maxExtensionPct: 30,
    /** Below the all-time high by more than this = a failed launch, not a dip. */
    maxDrawdownFromAthPct: 45,
    /** 0-1 bot/wash-trading likelihood above which we walk away. */
    maxManipulation: 0.6,
    /** Real demand needs several different wallets buying in the last minute… */
    minUniqueBuyers60: 4,
    /** …and a tape that is actually printing. */
    minTrades60: 5,
    /**
     * Expected edge: the distance to the nearest resistance (or, with none above,
     * a generous default) must be at least this many times the round-trip cost
     * (two curve fees + two slippages), otherwise the trade just feeds fees.
     */
    minEdgeMultiple: 2,
    /** With no resistance above (price discovery) assume this much room, in %. */
    openSkyRoomPct: 60,
  },

  exit: {
    /** Tiered take-profit: sell `sellPct` of the ORIGINAL position at `multiple`x. */
    takeProfitTiers: [
      { multiple: 1.5, sellPct: 25 },
      { multiple: 2.5, sellPct: 25 },
      { multiple: 5, sellPct: 25 },
    ],
    /** The remaining 25% rides with the trailing stop. */
    trailingStopActivateMultiple: 1.5,
    trailingStopPct: 25,
    /**
     * Adaptive trailing: a strong chart (higher lows, buyers in control) gets the
     * wide stop so a winner isn't cut on noise; a weak chart gets the tight one.
     */
    trailingStopPctStrong: 30,
    trailingStopPctWeak: 15,
    hardStopLossPct: 20,
    /** Once up this much, the stop moves to entry + costs so a winner can't turn into a loser. */
    breakEvenActivateMultiple: 1.25,
    breakEvenStopMultiple: 1.04,
    /**
     * Failing-trade time stop: still at/below `timeStopMaxMultiple` after this many
     * minutes with no uptrend → cut it and recycle the capital.
     */
    timeStopMinutes: {
      CURVE_SNIPE: 8,
      MIGRATION_MOMENTUM: 30,
      SMART_MONEY_COPY: 30,
      SOON: 12,
      RUNNER: 15,
      SWING: 60,
    } satisfies Record<StrategyName, number>,
    timeStopMaxMultiple: 1.0,
    /** In profit, sellers took over and price is off the peak → bank half. */
    momentumFade: { minMultiple: 1.25, dropFromPeakPct: 12, sellPct: 50 },
    /** After being up ≥ minPeakMultiple, a close below the last swing low (by breakPct) = structure broken → exit. */
    structureStop: { minPeakMultiple: 1.3, breakPct: 3 },
    rugExit: {
      devDumpPct: 10,
      /** Any dev sell at all counts as a rug signal when they held more than this % of supply. */
      devAnySellMinHoldingPct: 2,
      onLiquidityRemoved: true,
      holderConcentrationSpikePct: 15,
      /** Sells ≥ sellSharePct of last-minute volume AND price down ≥ dropPct in that minute. */
      sellSpike: { sellSharePct: 70, dropPct: 25 },
      /** A single sell this big relative to curve liquidity is a whale exit. */
      singleSellLiquidityPct: 15,
    },
    staleMinutes: {
      CURVE_SNIPE: 30,
      MIGRATION_MOMENTUM: 120,
      SMART_MONEY_COPY: 120,
      SOON: 45,
      RUNNER: 60,
      SWING: 180,
    } satisfies Record<StrategyName, number>,
    /** Partial sells smaller than this % of the original position aren't worth the fee. */
    minSellChunkPct: 10,
    dailyLossCircuitBreakerPct: 20,
  },

  /** Paper-trading simulation settings. Kept pessimistic so paper results aren't fantasy. */
  paper: {
    startingBalanceSol: 10,
    /** Pump.fun curve fee (protocol + creator), basis points per side. Approximate. */
    curveFeeBps: 125,
    /** Extra adverse price movement assumed between decision and fill (latency). */
    slippagePct: 1.5,
    /** Network + priority fee per transaction. */
    txFeeSol: 0.0005,
  },

  /** Runtime switches (dashboard-controlled in Phase 5). */
  state: {
    paused: false,
    killSwitch: false,
  },

  scoring: {
    /** Checkpoints (seconds after launch) at which a token is (re)evaluated. */
    checkpointsSec: [20, 45, 90, 180, 300, 480, 720, 900],
    /** Only run the RPC-heavy wallet analysis if the pre-score is within this many points of the threshold. */
    walletAnalysisMargin: 10,
    /** Evaluations scoring at least this are stored even when skipped ("interesting"). */
    storeAboveScore: 60,
    /**
     * When a token passes everything except timing (extended / thin tape), look
     * again after these delays instead of waiting for the next fixed checkpoint.
     */
    recheckDelaysSec: [15, 30, 45],
    /** Hold off on a BUY while the market regime says so (see regimeAdjustments). */
    useRegime: true,
  },

  /**
   * Learning engine knobs (Phase 7 modules: regime detector, Bayesian pattern
   * beliefs, daily weight adjuster, missed-opportunity tracker).
   */
  learning: {
    /** Minimum outcomes a pattern needs before its belief moves the score. */
    beliefMinObservations: 15,
    /** How far the daily adjuster may move any single weight per day (relative). */
    maxWeightStepPct: 10,
    /** Weights never leave this band so one bad day can't zero a feature. */
    weightFloor: 0.01,
    weightCeiling: 0.25,
    /** Minimum resolved outcomes in the lookback window before weights change. */
    adjusterMinSamples: 40,
    adjusterLookbackDays: 7,
    /** An evaluated token that later reached this multiple of its MC at evaluation counts as a "pump". */
    pumpMultiple: 2,
    /** …and one that fell to this fraction counts as "died". */
    deadFraction: 0.4,
  },

  /** How the regime detector nudges size and thresholds (Phase 7). */
  regimeAdjustments: {
    HOT: { sizeMultiplier: 1.2, scoreThresholdDelta: -3 },
    NORMAL: { sizeMultiplier: 1.0, scoreThresholdDelta: 0 },
    COLD: { sizeMultiplier: 0.7, scoreThresholdDelta: 5 },
    RUG_HEAVY: { sizeMultiplier: 0.5, scoreThresholdDelta: 10 },
  } satisfies Record<MarketRegime, { sizeMultiplier: number; scoreThresholdDelta: number }>,
} as const;

/** `as const` gives literal types (e.g. `45`); the runtime config and backtest variants need plain numbers. */
type Widen<T> = T extends number ? number : T extends boolean ? boolean : T extends readonly (infer U)[] ? readonly Widen<U>[] : T extends object ? { -readonly [K in keyof T]: Widen<T[K]> } : T;

export type BotConfigShape = Widen<typeof DEFAULT_CONFIG>;

/** Observation schedule: delay after creation (ms) for each snapshot. */
export const SNAPSHOT_SCHEDULE: ReadonlyArray<{ interval: SnapshotInterval; delayMs: number }> = [
  // A couple of seconds in, so the dev's launch buy (same transaction) is counted.
  { interval: 'CREATION', delayMs: 2_000 },
  { interval: 'M1', delayMs: 60_000 },
  { interval: 'M5', delayMs: 5 * 60_000 },
  { interval: 'M15', delayMs: 15 * 60_000 },
  { interval: 'H1', delayMs: 60 * 60_000 },
  { interval: 'H6', delayMs: 6 * 60 * 60_000 },
  { interval: 'H24', delayMs: 24 * 60 * 60_000 },
];

/** How long live per-token state stays in Redis (a bit longer than the last snapshot). */
export const LIVE_STATE_TTL_SECONDS = 26 * 60 * 60;

/** Safety-check penalties (points subtracted from 100). Tuned later by the learner. */
export const SAFETY_PENALTIES = {
  mintAuthority: 100, // hard fail
  freezeAuthority: 100, // hard fail
  unknownTokenProgram: 100, // hard fail
  dangerousExtension: 100, // hard fail (transfer hook, permanent delegate, etc.)
  transferFee: 60,
  devBigInitialBuy: 25, // dev bought > devBigInitialBuyPct of supply at launch
  devBigInitialBuyPct: 10,
  blacklistedCreator: 100, // hard fail
  suspiciousName: 10,
  missingMetadataUri: 15,
  unexpectedSupply: 30,
} as const;

/**
 * Scorer feature weights. Every feature is normalised to 0-1 (1 = good), and
 * the combined score is 100 x the weighted average. The weights add up to 1.
 * Phase 7's daily adjuster nudges these and stores new versions in WeightSnapshot.
 */
export const DEFAULT_WEIGHTS = {
  // Safety + holder base (what the token IS)
  safety: 0.12,
  holders: 0.08,
  buyPressure: 0.06,
  volume: 0.04,
  curveVelocity: 0.06,
  distribution: 0.08,
  devHolding: 0.05,
  devBehavior: 0.05,
  snipers: 0.07,
  retention: 0.04,
  // Price action (what the chart is DOING)
  trend: 0.07,
  structure: 0.05,
  momentumQuality: 0.06,
  buyerQuality: 0.06,
  // Learned prior from the Bayesian pattern beliefs (0.5 until there's data)
  patternPrior: 0.03,
  // Creator history (who is behind it)
  creatorLaunches: 0.03,
  creatorSuccess: 0.02,
  funderReuse: 0.02,
  walletAge: 0.01,
} as const;

export type FeatureName = keyof typeof DEFAULT_WEIGHTS;
export type Weights = Record<FeatureName, number>;
