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
    minPositionSol: 0.05,
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
    /**
     * "Still worth a shot": a token that only breaks the bundler / top-10 /
     * single-wallet limits (within these looser caps) but scores this many
     * points above the bar is bought at reduced size instead of skipped.
     */
    riskyEntry: {
      enabled: true,
      maxBundlePct: 30,
      maxTop10Pct: 65,
      maxSingleHolderPct: 15,
      extraScore: 5,
      sizeMultiplier: 0.5,
    },
    /** Only buy tokens that link an X account / post / community in their metadata. */
    requireTwitter: false,
  },

  /**
   * Anti-rug: hidden dev wallets + insider clusters (src/evaluator/insider-cluster.ts).
   * Hidden wallets count toward the entry limits above (dev / bundlers / single wallet).
   * Flat keys on purpose: the dashboard config merge is shallow.
   */
  antiRug: {
    // ---- Free signals from the trade stream (no RPC) ----
    /** Buys this many seconds after the create (≈ same / next 2 slots) are bundle buys. */
    bundleWindowSec: 1,
    /** Same-size burst: this many wallets buying within `burstWindowSec`… */
    burstMinWallets: 3,
    burstWindowSec: 2,
    /** …with SOL sizes within this % of each other. */
    burstSizeTolerancePct: 1.5,
    /** Buys smaller than this (SOL) are ignored for burst detection (dust bots). */
    burstMinSol: 0.05,
    /** Sells this many seconds from a dev sell (0 = same second ≈ same slot) mark the seller as an insider. */
    devSellWindowSec: 0,
    // ---- Funding graph (RPC, only for tokens that passed the market gates) ----
    fundingGraphEnabled: true,
    /** Max wallets looked up per token (dev + biggest holders). 2 RPC calls each, cached. */
    fundingMaxWallets: 10,
    /** Cache each wallet's first funder this long. */
    fundingCacheHours: 24,
    /** Re-run a token's funding graph at most this often (new holders only cost RPC). */
    fundingRecheckMinutes: 10,
    /** Wallets younger than this can be clustered by a shared funder (old wallets are real traders). */
    freshWalletHours: 72,
    /** A funder that bankrolled this many looked-up wallets is an exchange / hub → ignored for clustering. */
    hubFunderMinWallets: 20,
    // ---- Serial ruggers ----
    serialRuggerEnabled: true,
    /** A past token that fell this many % from its peak within `serialRugWindowMin` of launch = rug. */
    serialRugDropPct: 80,
    serialRugWindowMin: 60,
    /** Hard fail once a creator / funder has this many rugs on record. */
    serialRugMinRugs: 1,
    serialRugMemoryDays: 30,
    // ---- Live insider dump watch (while we hold) ----
    /** Insider wallets sold this % of their bag within `insiderDumpWindowSec` → rug exit. */
    insiderDumpPct: 30,
    insiderDumpWindowSec: 60,
    /** Ignore the dump signal if insiders held less than this % of supply. */
    insiderDumpMinClusterPct: 1,
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

  /** X accounts whose posts become "hot keywords" (needs TWITTER_BEARER_TOKEN). */
  x: {
    accounts: ['elonmusk'] as string[],
    pollSec: 300,
    /** How long a keyword stays hot after a post. */
    hotHours: 6,
  },

  /** Keyword lists matched against name, ticker and description (whole words, case-insensitive). */
  keywords: {
    /** A match nudges the score up. */
    boost: ['elon', 'musk', 'doge', 'grok', 'trump', 'maga', 'agent', 'pepe'] as string[],
    /** A match blocks the buy. */
    block: ['rug', 'scam', 'honeypot', 'test'] as string[],
  },

  exit: {
    /**
     * Tiered take-profit: sell `sellPct` of the ORIGINAL position at `multiple`x.
     *  - 25% at 1.3x: a small "de-risk" sale so every winner banks something early.
     *  - 15% at 5x:   a bonus slice off the runner on a big move (the rest keeps riding).
     * The big sale in between is "take initials" below.
     */
    takeProfitTiers: [
      { multiple: 1.3, sellPct: 25 },
      { multiple: 5, sellPct: 15 },
    ],
    /**
     * Take initials: at `atMultiple`x, sell exactly enough that everything we
     * got back (after fees) covers everything we paid. What's left is "house
     * money" — the runner. `feeBufferPct` is a safety margin for the sell fee,
     * slippage and our own price impact (so we don't come up a little short).
     */
    initials: { atMultiple: 2, feeBufferPct: 4 },
    /**
     * The runner (what's left after initials) uses a trailing stop that follows
     * how wild the chart is: calm chart → tighter trail, wild chart → wider
     * trail, so normal wicks don't shake us out of a 5-20x move.
     *   trail % = volMultiplier × volatility, kept between minTrailPct and maxTrailPct.
     * Volatility = how much the price typically moves per `volStepSec` seconds,
     * measured over the last `volWindowSec` seconds.
     */
    runner: {
      volMultiplier: 3,
      minTrailPct: 12,
      maxTrailPct: 35,
      /** Used until there's enough price history to measure volatility. */
      fallbackTrailPct: 25,
      /** Volatility = robust spread of `volStepSec`-second returns over the last `volWindowSec` seconds. */
      volWindowSec: 240,
      volStepSec: 15,
      /** After a really big peak, lock in more: the trail is never wider than this. */
      bigWinMultiple: 10,
      bigWinMaxTrailPct: 20,
      /** The runner may stay this many times the strategy's normal max hold. */
      maxHoldMultiplier: 2,
    },
    /** Before initials are out, the trailing stop arms here and trails this far below the peak. */
    trailingStopActivateMultiple: 1.25,
    trailingStopPct: 20,
    /** The higher the peak, the tighter the trail (only before initials are out). */
    trailingTightening: [
      { fromMultiple: 2, pct: 15 },
      { fromMultiple: 3, pct: 10 },
    ],
    /**
     * How the trailing stop is measured and triggered (both before initials and for the runner).
     *  - Before initials the trail is `pre.volMultiplier × volatility`, kept between
     *    `pre.minTrailPct` and the trailingStopPct/trailingTightening value above
     *    (that value is also used while there's no volatility data yet).
     *  - The runner trail (see `runner`) is capped tighter as the peak grows: `runnerProfitCaps`.
     *  - A break only counts when confirmed: the price stays under the stop for
     *    `confirmTicks` checks in a row AND at least `confirmSec` seconds, so a single
     *    wick doesn't shake us out. A gap far below (more than `gapMultiple` × the
     *    trail distance from the peak) exits immediately.
     *  - Once the peak reached `breakEvenAfterMultiple`, the stop never sits below
     *    break-even incl. fees for what's left.
     *  - A live price more than `peakRefTolerancePct` away from the last real trade's
     *    price is suspicious: it can't set a new peak (and is left out of volatility).
     */
    trail: {
      pre: { volMultiplier: 2.5, minTrailPct: 10 },
      runnerProfitCaps: [
        { fromMultiple: 3, maxTrailPct: 30 },
        { fromMultiple: 5, maxTrailPct: 25 },
        { fromMultiple: 10, maxTrailPct: 20 },
      ],
      confirmTicks: 2,
      confirmSec: 3,
      gapMultiple: 1.5,
      breakEvenAfterMultiple: 1.5,
      peakRefTolerancePct: 25,
    },
    /** After reaching `afterMultiple`, sell everything if it falls back to `floorMultiple` (before initials are out). */
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
    /**
     * Time for a real transaction to land (sign → send → confirm). Each paper buy/sell
     * waits a random delay in this range and THEN fills at the live price, so fast
     * pumps and dumps move against us exactly like they would with real money.
     */
    latencyMinMs: 400,
    latencyMaxMs: 1200,
    /** Network + priority fee + Jito tip per transaction (realistic for fast Pump.fun fills). */
    txFeeSol: 0.0015,
    /** PumpSwap pool fee (LP + protocol + creator), basis points per side. Approximate. */
    ammFeeBps: 30,
    /**
     * Sanity guard: a paper fill is checked against the price the most recent REAL
     * trade of that token happened at. A sell quoted more than this many times
     * above it (or a buy this many times below it) is a pricing bug, not a win:
     * the fill is clamped to the reference price (minus fees/slippage) and a
     * WARN 'suspicious_fill' event is logged. Real runs still pay — the reference
     * moves with every real trade.
     */
    maxFillVsRefMultiple: 3,
  },

  /** Runtime switches (dashboard-controlled in Phase 5). */
  state: {
    paused: false as boolean,
    killSwitch: false as boolean,
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
    /** Watchlist: near-misses (within this many points, or only soft rules failing) get re-checked. */
    watchlist: { scoreMargin: 8, everySec: 120, maxExtraChecks: 6 },
    /** Volume spike → check the token immediately (outside the normal schedule). */
    volumeSpike: { minSolPer15s: 2, multipleOfAverage: 4 },
    /**
     * Save Helius credits: only run the (RPC) safety check once a token has
     * this many holders. Most launches never get there.
     */
    safetyMinHolders: 10,
  },

  /**
   * Learning engine (Phase 7). Labels, weight tuning and learned pattern odds.
   * Flat keys on purpose: the dashboard config merge is shallow.
   */
  learning: {
    /** A labelled token is a WIN if it reached this multiple of the evaluation price… */
    winMultiple: 1.8,
    /** …BEFORE it ever fell to this multiple (otherwise you'd have been stopped out first). */
    drawdownLossMultiple: 0.7,
    /** Anything that "went" more than this within the hour is treated as bad price data and excluded. */
    maxPlausibleMultiple: 25,
    /** Weight tuning runs every N minutes… */
    adjustEveryMinutes: 20,
    /** …and again (at most once per N minutes) right after a position fully closes. */
    minMinutesBetweenAdjustments: 5,
    /** Look-back for labelled evaluations used to tune weights (never before the last paper reset). */
    lookbackDays: 7,
    /** Max relative change of one weight per run (0.04 = 4%). */
    maxStep: 0.04,
    /** How strongly a winner/loser difference turns into a weight change. */
    sensitivity: 0.5,
    /** Recency: an outcome this many hours old counts half as much as a fresh one. */
    halfLifeHours: 24,
    /** A feature that shows up on losers is cut this many times faster than one on winners is raised. */
    lossWeight: 1.5,
    /** Our own buys (realised trades) count this many times more than tokens we only watched. */
    ownBuyWeight: 3,
    /** Effective sample size (per class) at which a step reaches full size; less data = smaller steps. */
    fullEvidenceAt: 150,
    minSamples: 100,
    minPerClass: 10,
    /** Each weight stays within these multiples of its default. */
    minWeightFactor: 0.4,
    maxWeightFactor: 2.5,
    /** Newest N labelled evaluations are held out: new weights must rank them at least as well (AUC) as the old. */
    holdoutSize: 200,
    minHoldoutPerClass: 5,
    /** Learned pattern odds → score points. */
    oddsEnabled: true,
    oddsMinSamples: 15,
    /** Pseudo-samples pulling a pattern's win rate toward the overall rate (shrinkage). */
    oddsPriorStrength: 20,
    oddsMaxPoints: 8,
    /** Points per 1.0 of log-odds difference vs the overall rate. */
    oddsPointsPerLogit: 6,
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
  serialRugger: 100, // hard fail: creator / funder rugged before
  hiddenDevWallets: 35, // wallets funded by (or funding) the creator hold supply
  insiderBurst: 10, // several wallets bought near-identical sizes in a burst
  transferRecipients: 10, // wallets hold tokens they never bought (transfers)
  devSyncSells: 15, // wallets sold in the same slot as the dev
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
  volume: 0.02,
  volumeSpike: 0.04,
  curveVelocity: 0.05,
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
