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
    maxConcurrentPositions: 5,
    /** Fraction of capital per strategy. Must add up to 1. */
    allocation: {
      MIGRATION_MOMENTUM: 0.6,
      SMART_MONEY_COPY: 0.25,
      CURVE_SNIPE: 0.15,
    } satisfies Record<StrategyName, number>,
    enabledStrategies: {
      MIGRATION_MOMENTUM: true,
      SMART_MONEY_COPY: true,
      CURVE_SNIPE: true,
    } satisfies Record<StrategyName, boolean>,
  },

  entry: {
    minSafetyScore: 70,
    minCombinedScore: 70,
    minHoldersCurveSnipe: 15,
    minHoldersMigration: 40,
    maxDevHoldingPct: 10,
    // ---- Anti-rug: hard limits, any one of them blocks a buy ----
    /** Bundled / sniper wallets (bought within ~1s of launch, dev excluded) may hold at most this % of supply. */
    maxBundlePct: 18,
    /** Top 10 wallets combined may hold at most this % of supply. */
    maxTop10Pct: 50,
    /** No single wallet (dev excluded) may hold more than this % of supply. */
    maxSingleHolderPct: 10,
    /** Skip if the dev has already sold more than this share of what they bought (0-1). */
    maxDevSoldFraction: 0.9,
    requireNoMintAuthority: true,
    requireNoFreezeAuthority: true,
    minLiquiditySol: 5,
    /** Total traded volume (buys + sells) in USD. */
    minVolumeUsd: 12_000,
    minMarketCapUsd: 12_000,
    /** Total fees traders have paid on the token, in SOL (a proxy for real activity). */
    minTotalFeesSol: 1,
    /**
     * Total fees paid also includes priority fees + tips, which the live stream
     * doesn't show. Until a token's transactions are sampled, assume this much
     * per trade (SOL). Typical Pump.fun trades pay ~0.001-0.005.
     */
    assumedExtraFeePerTradeSol: 0.002,
    /** Only buy tokens that link an X account / post / community in their metadata. */
    requireTwitter: false,
  },

  /** Copy trading: react when a wallet on your watch list buys. */
  copy: {
    /** Points added to the buy threshold for copy trades (negative = easier, e.g. 75 - 10 = 65). */
    scoreThresholdDelta: -10,
    /** Sell our copy position when the wallet we copied sells. */
    exitWhenWalletSells: true,
    /** Re-check the token this many seconds after the wallet's buy. */
    checkpointsSec: [0, 30, 90, 180],
  },

  /** Keyword lists matched against name, ticker and description (whole words, case-insensitive). */
  keywords: {
    /** A match nudges the score up. */
    boost: [] as string[],
    /** A match blocks the buy. */
    block: ['rug', 'scam', 'honeypot', 'test'] as string[],
  },

  exit: {
    /** Tiered take-profit: sell `sellPct` of the ORIGINAL position at `multiple`x. */
    takeProfitTiers: [
      { multiple: 1.3, sellPct: 30 },
      { multiple: 1.8, sellPct: 40 },
      { multiple: 3, sellPct: 20 },
    ],
    /** The remaining 10% rides with the trailing stop. */
    trailingStopActivateMultiple: 1.25,
    trailingStopPct: 20,
    /** The higher the peak, the tighter the trail (locks in more of a big run). */
    trailingTightening: [
      { fromMultiple: 2, pct: 15 },
      { fromMultiple: 3, pct: 10 },
    ],
    /** After reaching `afterMultiple`, sell everything if it falls back to `floorMultiple`. */
    protectProfit: { afterMultiple: 1.3, floorMultiple: 1.05 },
    /**
     * Resistance: the price keeps hitting the same ceiling and getting knocked
     * back. Once in profit, sell there instead of hoping it breaks through.
     */
    resistance: {
      minProfitMultiple: 1.2,
      /** Rejections at the ceiling needed (separate touches). */
      minTouches: 2,
      /** A "touch" = within this % of the recent high. */
      bandPct: 3,
      /** A rejection = falling at least this % below the high between touches. */
      rejectPct: 6,
      /** How far back to look (seconds). */
      windowSec: 300,
    },
    /** Momentum-based exits (risk 0-1 from recent sells / holders / price). */
    riskExit: {
      threshold: 0.5,
      /** Take profit early on high risk once at least this multiple. */
      minProfitMultiple: 1.15,
      /** Cut a loser early on high risk once below this multiple (0.85 = −15%). */
      cutLossBelowMultiple: 0.85,
    },
    maxHoldMinutes: {
      CURVE_SNIPE: 45,
      MIGRATION_MOMENTUM: 120,
      SMART_MONEY_COPY: 90,
    } satisfies Record<StrategyName, number>,
    hardStopLossPct: 40,
    rugExit: {
      /** Bundle wallets sold this many % of supply since we bought → exit. */
      bundleDumpPct: 5,
      devDumpPct: 10,
      onLiquidityRemoved: true,
      holderConcentrationSpikePct: 15,
    },
    staleMinutes: {
      CURVE_SNIPE: 30,
      MIGRATION_MOMENTUM: 120,
      SMART_MONEY_COPY: 120,
    } satisfies Record<StrategyName, number>,
    dailyLossCircuitBreakerPct: 20,
  },

  /** Paper-trading simulation settings. Kept pessimistic so paper results aren't fantasy. */
  paper: {
    startingBalanceSol: 10,
    /** Pump.fun curve fee (protocol + creator), basis points per side. Approximate. */
    curveFeeBps: 125,
    /** Extra adverse price movement assumed between decision and fill (latency). */
    slippagePct: 1.5,
    /** Network + priority fee + Jito tip per transaction (realistic for fast Pump.fun fills). */
    txFeeSol: 0.0015,
    /** PumpSwap pool fee (LP + protocol + creator), basis points per side. Approximate. */
    ammFeeBps: 30,
  },

  /** Runtime switches (dashboard-controlled in Phase 5). */
  state: {
    paused: false,
    killSwitch: false,
  },

  scoring: {
    /** Checkpoints (seconds after launch) at which a token is (re)evaluated. */
    checkpointsSec: [20, 45, 90, 180, 300, 480, 720, 900, 1080, 1200],
    /** Checkpoints (seconds after migration to PumpSwap) for the migration strategy. */
    migrationCheckpointsSec: [60, 180, 300, 600, 1200, 2400, 3600],
    /** Only run the RPC-heavy wallet analysis if the pre-score is within this many points of the threshold. */
    walletAnalysisMargin: 10,
    /** Evaluations scoring at least this are stored even when skipped ("interesting"). */
    storeAboveScore: 60,
    /**
     * Save Helius credits: only run the (RPC) safety check once a token has
     * this many holders. Most launches never get there.
     */
    safetyMinHolders: 10,
  },

  /** How the regime detector nudges size and thresholds (Phase 7). */
  regimeAdjustments: {
    HOT: { sizeMultiplier: 1.2, scoreThresholdDelta: -3 },
    NORMAL: { sizeMultiplier: 1.0, scoreThresholdDelta: 0 },
    COLD: { sizeMultiplier: 0.7, scoreThresholdDelta: 5 },
    RUG_HEAVY: { sizeMultiplier: 0.5, scoreThresholdDelta: 10 },
  } satisfies Record<MarketRegime, { sizeMultiplier: number; scoreThresholdDelta: number }>,
} as const;

export type BotConfigShape = typeof DEFAULT_CONFIG;

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
  safety: 0.15,
  holders: 0.1,
  buyPressure: 0.1,
  volume: 0.03,
  curveVelocity: 0.08,
  distribution: 0.08,
  devHolding: 0.06,
  devBehavior: 0.06,
  snipers: 0.08,
  retention: 0.05,
  creatorLaunches: 0.05,
  creatorSuccess: 0.03,
  funderReuse: 0.03,
  walletAge: 0.02,
  socials: 0.06,
  narrative: 0.02,
} as const;

export type FeatureName = keyof typeof DEFAULT_WEIGHTS;
export type Weights = Record<FeatureName, number>;
