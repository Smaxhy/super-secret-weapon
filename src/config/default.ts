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
    /**
     * Conviction sizing: maxPositionSol is the size of an AVERAGE-conviction buy.
     * Strong setups (score well over the bar, good learned odds, healthy crowd) go up
     * to ×maxConvictionMultiple, weak ones down to ×minConvictionMultiple.
     * Never more than maxPositionPctOfCapital % of capital in one coin.
     */
    minConvictionMultiple: 0.4,
    maxConvictionMultiple: 1.6,
    maxPositionPctOfCapital: 6,
    /**
     * Fraction of capital per strategy. Must add up to 1. v5 (research, Oct 2026): the edge for a
     * bot with ~0.3 s latency is fresh pairs AFTER the snipers' supply is absorbed (CURVE_SNIPE =
     * "New pairs"); late-curve / migration plays get less; copying wallets lost under every exit
     * rule in public tests (2 s late = their exit liquidity) → off.
     */
    allocation: {
      CURVE_SNIPE: 0.55,
      MIGRATION_MOMENTUM: 0.25,
      SOON: 0.2,
      SMART_MONEY_COPY: 0,
    } satisfies Record<StrategyName, number>,
    enabledStrategies: {
      MIGRATION_MOMENTUM: true,
      SOON: true,
      SMART_MONEY_COPY: false,
      CURVE_SNIPE: true,
    } satisfies Record<StrategyName, boolean>,
    /** At most this many open positions per strategy (fresh pairs: 3 — research). */
    maxOpenByStrategy: { CURVE_SNIPE: 3, SOON: 2, MIGRATION_MOMENTUM: 2, SMART_MONEY_COPY: 1 } as Partial<Record<StrategyName, number>>,
    /**
     * Strategy cool-off: once a strategy has `minTrades` closed trades among its last `lastN` and they
     * average worse than `maxAvgPnlPct` per trade, it takes no new entries for `pauseMinutes`
     * (the strategy lab keeps paper-testing its signals meanwhile).
     */
    strategyBreaker: { enabled: true as boolean, lastN: 20, minTrades: 12, maxAvgPnlPct: -4, pauseMinutes: 120 },
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
    /** Never buy a coin younger than this (the first seconds are bots and bundles). */
    minAgeSec: 15,
    /**
     * Confirmation delay: a BUY signal is re-checked `confirmDelaySec` later and only
     * executed if it still passes AND the price didn't dump > maxDropPct, didn't run
     * away > maxPumpPct (no chasing), and buyers are still at least even with sellers.
     */
    confirmDelaySec: 12,
    confirm: { maxDropPct: 8, maxPumpPct: 30, minBuyRatio: 1 },
    /**
     * Fake volume / bundles / chasing (from the live trade log):
     *  - fake volume = wallets trading back and forth (wash trading, volume bots)
     *  - bundled buys = 3+ wallets buying near-identical sizes in the same slot
     *  - top-3 volume = three wallets making most of the volume
     *  - chase = price up this % in the last 3 minutes (buying a vertical candle)
     * Over the max → no buy. Below it, points come off the score.
     */
    manipulation: { maxFakeVolumePct: 50, maxBundledBuyPct: 30, maxTop3VolumePct: 65, chasePct: 40 },
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
    /** Only look for same-size bursts this long after launch (bundles are launch-time; later
     *  bursts on hyped coins are real people using the same buy presets). */
    burstMaxAgeSec: 180,
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

  /**
   * Where the bot hunts hardest: "Soon" coins (bonding curve 70%+, about to
   * graduate) and freshly migrated coins. Each has its own entry rules on top
   * of the general `entry` rules (these replace the matching general minimums),
   * an easier score bar and bigger size, because the rules themselves are strict.
   * `minActiveWallets5m` = different wallets that traded in the last 5 minutes
   * (the closest public measure of how many people are watching a coin).
   */
  focus: {
    /**
     * NEW PAIRS (strategy CURVE_SNIPE) — v5, from research (Oct 2026). Fresh coins, bought straight
     * away (no dip wait, no confirmation delay) but only once:
     *  1. the zone is right: 45 s – 12 min old, ≥ `minCurveSol` SOL in the curve (≈1.6× launch MC),
     *     market cap under `maxMarketCapUsd` (owner: under ~$15k) and the curve under `maxCurvePct`;
     *  2. the launch snipers' supply is ABSORBED (they're the ones who dump on late buyers):
     *     early wallets hold ≤ maxSniperHoldPct or sold ≥ minSniperSoldPct of their buys, dev hasn't
     *     sold and holds ≤ 10%, top 10 ≤ maxTop10Pct, top 10 not mostly first-25 buyers, the price
     *     still ≥ minOfHighPct of its post-launch high;
     *  3. REAL new buyers are arriving right now (last 60 s, dev/snipers/repeat-size bots excluded):
     *     many different wallets, most first-timers, accelerating, net SOL in, buy/sell ratios,
     *     varied (human) sizes, no dead gaps;
     *  4. trigger: at / near its recent high (breaking out), not a vertical candle (> maxRun30sPct in
     *     30 s), no holder dumping ≥ 1% of supply in the last 5 s.
     * These replace the general $12k MC / $12k volume / 1 SOL fee minimums (with SOL near $80 those
     * only allowed coins 75%+ up the curve — right where holders dump into graduation).
     */
    newPair: {
      minAgeSec: 45,
      maxAgeSec: 720,
      minCurveSol: 8,
      maxCurvePct: 85,
      minMarketCapUsd: 3_500,
      maxMarketCapUsd: 15_000,
      minTotalFeesSol: 0.25,
      minVolumeUsd: 1_500,
      // absorption
      sniperWindowSec: 4,
      maxSniperHoldPct: 10,
      minSniperSoldPct: 50,
      maxDevSoldFraction: 0.05,
      maxDevHoldingPct: 10,
      maxTop10Pct: 30,
      maxTop10EarlyShare: 0.8,
      minOfHighPct: 80,
      // organic demand (last 60 s)
      minBuyers60s: 12,
      minNewBuyers60s: 8,
      minNetFlowSol60s: 1.5,
      minBuyRatioSol: 1.3,
      minBuyRatioCount: 1.5,
      requireAcceleration: true as boolean,
      minSizeCv: 0.5,
      maxSameSizePct: 25,
      minMedianBuySol: 0.05,
      maxGapSec: 15,
      maxBotVolumePct: 40,
      // trigger
      nearHighPct: 7,
      maxRun30sPct: 35,
      maxHolderDumpPct: 1,
      /** Fresh pairs are bought on the spot: the absorption + demand checks replace the 12 s confirmation. */
      confirmDelaySec: 0,
      scoreThresholdDelta: -8,
      sizeMultiplier: 1,
      /** Re-check a fresh pair this often while its flow looks hot (trade-driven, see new-pair watcher). */
      flowCheckCooldownSec: 15,
    },
    /**
     * SOON: coins about to graduate. Research: most graduates PEAK at graduation and holders sell into
     * it, so only the 70–90% part of the curve (≥ ~1.65× left to graduation), strict rules, normal bar.
     */
    soon: {
      minCurvePct: 70,
      maxCurvePct: 90,
      /** Seconds after the coin first reaches `minCurvePct` at which it's checked. */
      checkpointsSec: [0, 20, 45, 90, 150, 240, 360, 600, 900],
      minTotalFeesSol: 3,
      minMarketCapUsd: 0,
      minVolumeUsd: 10_000,
      minActiveWallets5m: 25,
      scoreThresholdDelta: 0,
      sizeMultiplier: 1,
    },
    migrated: {
      minTotalFeesSol: 9,
      minMarketCapUsd: 25_000,
      /** Pool liquidity in USD (both sides, like trading terminals show it). */
      minLiquidityUsd: 2_000,
      minActiveWallets5m: 20,
      /**
       * No entries in the first minutes after migration: pump.fun's BOOST buys ~17.6 SOL over the
       * first 5 min (mechanical, front-run by bots) and liquidity drains ~57% from minute 5 to 30.
       */
      noEntryFirstSec: 330,
      scoreThresholdDelta: 0,
      sizeMultiplier: 1,
    },
    /** Active wallets in 5 min at which the attention score is full (the "50+ eyes" rule of thumb). */
    fullAttentionWallets: 50,
    /** Start keeping a per-trade log (crowd behaviour, fake volume, bundles) once the curve is this full. */
    crowdLogFromCurvePct: 0,
    /**
     * Swing trading Soon / migrated coins: after we exit (not on a rug), keep
     * watching; buy again when it pulls back `minPullbackPct`–`maxPullbackPct` from
     * its high and bounces `bounceConfirmPct` off the low with buyers in control.
     */
    swing: {
      enabled: true,
      /** Only re-enter a coin every earlier trade of which made money (never after a stop loss). */
      onlyAfterProfit: true as boolean,
      maxReentries: 1,
      cooldownSec: 120,
      watchMinutes: 120,
      minPullbackPct: 15,
      maxPullbackPct: 45,
      bounceConfirmPct: 4,
      /** Buy SOL ÷ sell SOL over the last 2 minutes. */
      minBuyRatio: 1.2,
      everySec: 15,
    },
  },

  /**
   * DexScreener (free public API): trending coins + "DEX paid" (approved enhanced
   * token profile) / community takeover. Adds points to the score and checks
   * tracked coins that start trending right away. `requirePaidFor` = strategies
   * that ONLY buy DEX-paid (or CTO) coins (empty = just a bonus).
   */
  dex: {
    enabled: true as boolean,
    pollSec: 60,
    trendingSize: 30,
    paidPoints: 4,
    ctoPoints: 2,
    trendingPoints: 5,
    requirePaidFor: [] as StrategyName[],
  },

  /**
   * KOLs (well-known traders like Cupsey / Cented / Orangie — wallets on the Wallets page with kind KOL).
   * Several KOLs buying the same coin is a strong signal: `minKols` different KOLs within `windowMin`
   * → the coin is checked right away; each KOL adds `pointsPerKol` (max `maxPoints`). KOLs who bought
   * now selling (≥ dumpMinKols, at least half of them) → `dumpPenalty` points off, no new buy, and an
   * open position in profit is sold.
   */
  kol: {
    enabled: true as boolean,
    windowMin: 60,
    minKols: 2,
    pointsPerKol: 3,
    maxPoints: 12,
    dumpMinKols: 2,
    dumpWindowMin: 5,
    dumpPenalty: 6,
    checkCooldownSec: 120,
  },

  /**
   * Chart reading (src/evaluator/chart-reader.ts) on 15s candles from live trades:
   *  - entries: a coin stretched above VWAP (> maxAboveVwapPct) / overbought (RSI > overboughtRsi) /
   *    up > maxRun2mPct in 2 min is NOT bought at the top — it waits up to `dip.waitMinutes` for a
   *    pullback into the buy zone (dip.minPullbackPct–maxPullbackPct off the high, near VWAP/support)
   *    and a bounce (dip.bounceConfirmPct, buyers ≥ dip.minBuyRatio). Ran away (> runAwayPct) or
   *    broke down (> breakdownPct under the zone) → skipped. Breaking-down charts are never bought;
   *    a healthy dip + bounce in an uptrend gets `buyDipPoints`.
   *  - exits: blow-off top (vertical run on a volume climax being rejected) → sell blowOffSellPct of
   *    what's left; bearish divergence (new high, weaker RSI) → sell divergenceSellPct (once each,
   *    only above smartSell.minMultiple).
   */
  chart: {
    enabled: true as boolean,
    minCandles: 12,
    maxAboveVwapPct: 25,
    overboughtRsi: 78,
    maxRun2mPct: 35,
    buyDip: { minPullbackPct: 8, minBouncePct: 2 },
    buyDipPoints: 4,
    dip: { enabled: true as boolean, noWaitBelowMcUsd: 15_000, minPullbackPct: 10, zoneTopMaxPct: 15, maxPullbackPct: 40, bounceConfirmPct: 3, minBuyRatio: 1.1, waitMinutes: 10, runAwayPct: 100, breakdownPct: 7, maxAboveZonePct: 8 },
    smartSell: { enabled: true as boolean, minMultiple: 1.6, blowOffSellPct: 50, divergenceSellPct: 30 },
  },

  /**
   * Smart-money discovery (src/learner/wallet-pnl.ts): real profit per wallet from every trade
   * the bot sees (creators and launch snipers excluded). Every `everyMin` the `top` wallets with
   * ≥ minSells sells, ≥ minWinRate wins, ≥ minPnlSol profit and ≥ minAvgPnlSol per sell (filters
   * spray bots) become KOL wallets automatically (weight `weight`); dropped ones are paused.
   */
  discovery: {
    enabled: true as boolean,
    everyMin: 30,
    top: 40,
    minSells: 8,
    maxSells: 3000,
    minWinRate: 0.45,
    minPnlSol: 5,
    minAvgPnlSol: 0.05,
    sniperWindowSec: 15,
    decayPerDay: 0.85,
    weight: 0.6,
  },

  /**
   * "What's working now": every `everyMin` the top coins (DexScreener trending + our biggest-volume
   * tracked coins of the last hour) are read; words shared by ≥ `minLeaders` of them become hot
   * narratives (like X hot keywords) for `narrative` scoring.
   */
  leaders: { enabled: true as boolean, everyMin: 5, topOwn: 15, minLeaders: 2, maxKeywords: 12 },

  /**
   * Trending tabs (src/scanner/trending-feeds.ts + trending-hub.ts): pump.fun live / King of the
   * Hill / for-you / top runners (≤ 6 req/min of the ~50 allowed), GeckoTerminal 5m + 1h trending
   * pools, DexScreener trending narratives. A coin newly on a list is checked at once
   * (checkOnEntry) and paper-traded by the chart lab (labOnEntry) so list entries are MEASURED
   * against random entries; +pointsPerSource per organic list (max maxSourcePoints), live with
   * ≥ liveViewers viewers and rising +2, banned / Mayhem coins never bought. See trendScore().
   */
  trending: {
    enabled: true as boolean,
    pump: { enabled: true as boolean, liveSec: 30, kothSec: 30, forYouSec: 60, runnersSec: 60 },
    gecko: { enabled: true as boolean, everySec: 180 },
    dexMetas: { enabled: true as boolean, everySec: 300, maxWords: 10 },
    pointsPerSource: 2,
    maxSourcePoints: 6,
    liveViewers: 50,
    checkOnEntry: true as boolean,
    labOnEntry: true as boolean,
  },

  /**
   * Chart strategies (src/evaluator/ta/strategies.ts) + their live lab (src/learner/ta-lab.ts).
   * Every `everySec` the most active coins (≤ maxCoinsPerTick, ≥ minTradesLast2m trades in 2 min,
   * passing the cheap gates) are run through every strategy; each signal opens a VIRTUAL trade
   * (once per coin + strategy per cooldownMin) with the live exits — against a random-entry
   * baseline (1 in baselineOneIn looks). A strategy is PROVEN with ≥ minTrades results, a
   * cautious average > 0 and an average ≥ minEdgePct better than random; proven strategies add
   * up to maxPoints to a coin's score (pointsPerSignal each, scaled by their edge) and, with
   * triggerChecks, make the bot check a coin the moment one fires. `disabled` = ids to skip.
   */
  ta: {
    enabled: true as boolean,
    labEnabled: true as boolean,
    everySec: 15,
    maxCoinsPerTick: 150,
    minTradesLast2m: 6,
    minMarketCapUsd: 3_000,
    maxTop10Pct: 50,
    maxDevHoldingPct: 15,
    maxBundlePct: 25,
    baselineOneIn: 40,
    cooldownMin: 30,
    maxOpen: 800,
    keepResults: 400,
    /** Promotion (see provenStrategies): results needed, edge over random, profit factor, false-discovery rate. */
    minTrades: 60,
    minEdgePct: 2,
    minProfitFactor: 1.2,
    fdrQ: 0.1,
    pointsPerSignal: 3,
    maxPoints: 8,
    triggerChecks: true as boolean,
    disabled: [] as string[],
  },

  /**
   * Strategy lab (src/learner/strategy-lab.ts): every BUY signal and near-miss is also traded
   * VIRTUALLY by each variant below (same live prices, same costs, the bot's own exit logic with
   * the variant's settings layered on top). The dashboard shows which setup makes money; with
   * `autoApply` the best one (≥ minTrades results, cautious average > 0, beats the setup in use by
   * minEdgePct) becomes the live exit setup, at most once per applyEveryHours. Variants never
   * change the stop-loss band.
   */
  lab: {
    enabled: true as boolean,
    autoApply: true as boolean,
    minTrades: 40,
    minEdgePct: 2,
    applyEveryHours: 6,
    keepResults: 400,
    maxOpen: 400,
    /** Near-misses (rules pass, score up to this many points short) are lab-traded too (reported separately). */
    nearMissMargin: 6,
    /** The variant that mirrors the live settings (no overrides). */
    liveVariant: 'L',
    variants: [
      { id: 'L', name: 'Live settings', exit: {} },
      {
        id: 'S',
        name: 'Scalp: half at +25%, 10–15% trail',
        exit: {
          takeProfitTiers: [{ multiple: 1.25, sellPct: 50 }],
          trailingStopActivateMultiple: 1.25,
          trail: { breakEvenAfterMultiple: 1.25, ladder: [{ fromMultiple: 1.25, pct: 10 }, { fromMultiple: 2, pct: 15 }, { fromMultiple: 5, pct: 18 }] },
          protectProfit: { afterMultiple: 1.25, floorMultiple: 1.03 },
          timeStop: { minutes: { CURVE_SNIPE: 1, SOON: 2, MIGRATION_MOMENTUM: 6, SMART_MONEY_COPY: 2 }, stallMinutes: { CURVE_SNIPE: 2, SOON: 3, MIGRATION_MOMENTUM: 6, SMART_MONEY_COPY: 3 } },
        },
      },
      {
        id: 'B',
        name: 'Bigger target: 40% at 1.5x, 25% at 2x, 30% trail',
        exit: {
          takeProfitTiers: [{ multiple: 1.5, sellPct: 40 }, { multiple: 2, sellPct: 25 }],
          trailingStopActivateMultiple: 1.5,
          trail: { breakEvenAfterMultiple: 1.5, ladder: [{ fromMultiple: 1.5, pct: 30 }, { fromMultiple: 3, pct: 25 }] },
          protectProfit: { afterMultiple: 1.5, floorMultiple: 1.03 },
          timeStop: { minutes: { CURVE_SNIPE: 3, SOON: 4, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 3 }, minPeakMultiple: 1.1, maxMultiple: 1.1 },
        },
      },
      {
        id: 'R',
        name: 'Runner: nothing sold before 2x, then a 30% trail',
        exit: {
          takeProfitTiers: [{ multiple: 5, sellPct: 15 }],
          trailingStopActivateMultiple: 2,
          trail: { breakEvenAfterMultiple: 1.6, ladder: [{ fromMultiple: 2, pct: 30 }, { fromMultiple: 5, pct: 25 }] },
          protectProfit: { afterMultiple: 1.6, floorMultiple: 1.03 },
          timeStop: { minutes: { CURVE_SNIPE: 3, SOON: 4, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 3 }, stallMinutes: { CURVE_SNIPE: 5, SOON: 6, MIGRATION_MOMENTUM: 12, SMART_MONEY_COPY: 5 } },
        },
      },
      { id: 'N', name: 'Live settings without time stops', exit: { timeStop: { enabled: false } } },
      {
        id: 'W',
        name: 'Wider stop (−25 to −30%) — research suggests it; outside your 10–20% rule, so never applied automatically',
        ownerOnly: true,
        exit: { stopLoss: { minPct: 25, maxPct: 30, fallbackPct: 30, maxPctByStrategy: { MIGRATION_MOMENTUM: 25 } }, hardStopLossPct: 30 },
      },
    ] as Array<{ id: string; name: string; ownerOnly?: boolean; exit: Record<string, unknown> }>,
  },

  /** Copy trading: react when a wallet on your watch list buys. */
  copy: {
    /**
     * Copy trades are heavily restricted (they underperformed): a STRICTER bar than
     * normal, half size, max `maxOpen` at a time, 5% of capital.
     */
    scoreThresholdDelta: 5,
    sizeMultiplier: 0.5,
    maxOpen: 1,
    /** Hold a copy trade at least this long: the copied wallet selling / momentum wobbles
     *  don't shake us out early (the stop loss and rug exits still apply). */
    minHoldSec: 120,
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
     * v5 (research): the old exits banked +3% wins against −16% losses (needs 84% winners).
     * Now winners must pay for losers:
     *  - 40% at 1.4x: the first real profit (pays for ~3 small losses),
     *  - initials at 2x (stake + fees back, below), 15% at 5x, the rest rides a wide trail.
     */
    takeProfitTiers: [
      { multiple: 1.4, sellPct: 40 },
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
    /** The trailing stop arms here (v5: only once the first take-profit is in — no 1.15x trail). */
    trailingStopActivateMultiple: 1.4,
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
      /** A break must hold 0.5 s (one sandwich / bad print can't sell us); a gap far below sells at once. */
      confirmTicks: 1,
      confirmSec: 0.5,
      gapMultiple: 1.5,
      /** Once the peak reached this (= the first take-profit), the rest never sells below break-even (+fees). */
      breakEvenAfterMultiple: 1.4,
      /**
       * Dynamic trail: tight on small moves, wider on big ones (room to run).
       * Trail % for the peak multiple, linear between the points. Volatility then
       * nudges it ×volAdjust.min–max (2.5 × volatility vs the ladder value).
       */
      ladder: [
        { fromMultiple: 1.4, pct: 20 },
        { fromMultiple: 2, pct: 25 },
        { fromMultiple: 3, pct: 25 },
        { fromMultiple: 5, pct: 22 },
        { fromMultiple: 10, pct: 20 },
      ],
      volAdjust: { min: 0.8, max: 1.2 },
      peakRefTolerancePct: 25,
      /**
       * A new peak only counts once the price HELD that level this long (ms). Sandwiched /
       * high-slippage buys print 20%+ above the market for a few ms — nobody can sell there,
       * and counting them armed the trailing stop and sold positions at a loss.
       */
      peakHoldMs: 2500,
    },
    /**
     * Time stops (only before any profit was taken) — a fresh-coin trade that works, works fast:
     *  - no follow-through: held `minutes[strategy]`, the peak never reached `minPeakMultiple` and the
     *    price is at or below `maxMultiple` → out at a small loss instead of riding to the stop;
     *  - stall: no new high for `stallMinutes[strategy]` while below the first take-profit → out.
     */
    timeStop: {
      enabled: true as boolean,
      minutes: { CURVE_SNIPE: 1.5, SOON: 3, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 3 } as Partial<Record<StrategyName, number>>,
      defaultMinutes: 5,
      minPeakMultiple: 1.1,
      maxMultiple: 1.02,
      stallMinutes: { CURVE_SNIPE: 3, SOON: 5, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 5 } as Partial<Record<StrategyName, number>>,
    },
    /**
     * Coins bought on the curve that graduate: sell `sellPct` while pump.fun's BOOST is buying
     * (between `fromSec` and `toSec` after migration) — that demand stops at minute 5.
     */
    boostSell: { enabled: true as boolean, fromSec: 60, toSec: 240, sellPct: 40 },
    /** After reaching `afterMultiple`, sell everything if it falls back to `floorMultiple` (before initials are out). */
    protectProfit: { afterMultiple: 1.4, floorMultiple: 1.03 },
    /**
     * Resistance: the price keeps hitting the same ceiling and getting knocked
     * back. Once in profit, sell there instead of hoping it breaks through.
     */
    resistance: {
      minProfitMultiple: 1.5,
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
      minProfitMultiple: 1.5,
      /** Cut a loser early on high risk once below this multiple (0.85 = −15%). */
      cutLossBelowMultiple: 0.85,
    },
    maxHoldMinutes: {
      CURVE_SNIPE: 30,
      SOON: 45,
      MIGRATION_MOMENTUM: 240,
      SMART_MONEY_COPY: 60,
    } satisfies Record<StrategyName, number>,
    /** Old hard stop (kept for saved configs) — the real limit is stopLoss.maxPct. */
    hardStopLossPct: 20,
    /**
     * Stop loss band (owner's rule: never stop out on less than 10% noise,
     * never lose more than 20%). Inside the band it follows volatility:
     * stop % = volMultiplier × volatility (+ trade-coach bias), clamped to minPct–maxPct.
     * Below maxPct it sells at once; between the stop and maxPct it needs a
     * confirmed break (exit.trail.confirmTicks / confirmSec).
     */
    stopLoss: {
      minPct: 12,
      maxPct: 20,
      volMultiplier: 2,
      fallbackPct: 15,
      /** Tighter max per strategy (migration plays: 15%). */
      maxPctByStrategy: { MIGRATION_MOMENTUM: 15 } as Partial<Record<StrategyName, number>>,
      /** A dip under the stop (not the hard limit) must hold this long before selling (no wick sells). */
      confirmTicks: 1,
      confirmSec: 2,
    },
    rugExit: {
      /** Bundle wallets sold this many % of supply since we bought → exit. */
      bundleDumpPct: 5,
      devDumpPct: 10,
      onLiquidityRemoved: true,
      holderConcentrationSpikePct: 15,
    },
    staleMinutes: {
      CURVE_SNIPE: 20,
      SOON: 20,
      MIGRATION_MOMENTUM: 60,
      SMART_MONEY_COPY: 60,
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
    latencyMinMs: 150,
    latencyMaxMs: 500,
    /** Network + priority fee + Jito tip per transaction (realistic for fast Pump.fun fills). */
    txFeeSol: 0.0015,
    /** PumpSwap pool fee (LP + protocol + creator), basis points per side, when tiered fees are off. */
    ammFeeBps: 30,
    /**
     * Graduated pump.fun coins pay tiered PumpSwap fees by market cap (1.25% under 420 SOL,
     * 1.20% to 1,470 SOL, … 0.30% from 98,240 SOL) — see pumpSwapFeeBps. On by default: the
     * flat 0.3% made migration trades look ~1.8 points better per round trip than reality.
     */
    ammTieredFees: true as boolean,
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
    checkpointsSec: [45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720],
    /** Checkpoints (seconds after migration to PumpSwap) for the migration strategy. */
    migrationCheckpointsSec: [330, 480, 660, 900, 1200, 1800, 2400, 3600],
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
  safety: 0.12,
  holders: 0.06,
  buyPressure: 0.08,
  volume: 0.02,
  volumeSpike: 0.04,
  curveVelocity: 0.05,
  distribution: 0.07,
  devHolding: 0.06,
  devBehavior: 0.05,
  snipers: 0.07,
  retention: 0.04,
  creatorLaunches: 0.03,
  creatorSuccess: 0.03,
  funderReuse: 0.03,
  walletAge: 0.02,
  socials: 0.03,
  narrative: 0.04,
  /** How the crowd behaves: dip buying, holding vs paper hands, organic vs bot churn, smart wallets. */
  crowd: 0.1,
  /** How many different wallets are active right now (eyes on the coin). */
  attention: 0.06,
} as const;

export type FeatureName = keyof typeof DEFAULT_WEIGHTS;
export type Weights = Record<FeatureName, number>;
