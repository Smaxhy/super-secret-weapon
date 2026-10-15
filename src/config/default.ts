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
    minPositionSol: 0.1, // v9.9: 0.05 lost ~6% to gas + tips per round trip; 0.1 halves that
    maxPositionSolCeiling: 0.3, // the dashboard slider can't go above this
    /** v7: 8 (owner: trade more often so the bot learns; swing trades on bigger coins add up to 3). */
    maxConcurrentPositions: 14,
    /**
     * Conviction sizing: maxPositionSol is the size of an AVERAGE-conviction buy.
     * Strong setups (score well over the bar, good learned odds, healthy crowd) go up
     * to ×maxConvictionMultiple, weak ones down to ×minConvictionMultiple.
     * Never more than maxPositionPctOfCapital % of capital in one coin.
     */
    minConvictionMultiple: 0.4,
    maxConvictionMultiple: 1.6,
    maxPositionPctOfCapital: 6,
    /** A strategy may go up to this × maxPositionSol per position (swings on big, deep coins: more budget). */
    maxPositionMultipleByStrategy: { SWING: 2.5 } as Partial<Record<StrategyName, number>>,
    /** Our position ≤ this % of the coin's SOL liquidity (thin coins gap through the stop → losses past −20%). 0 = off. */
    maxPositionPctOfLiquidity: 3,
    /**
     * v10.10 (owner: "only big trades like 1 SOL when the research is good and the score is 80+, otherwise stick to
     * the lower cap"; then: "0.3 / 0.5 is fine, just no big amounts on low-MC or messy coins"). Normal caps stay; the big
     * size needs score ≥ minScore, MC ≥ minMarketCapUsd, not a learning / probe trade, no risk half-size, and the
     * strategy isn't losing (allocator ×≥1). Still limited by the strategy budget, balance and coin liquidity.
     */
    /** v10.30 — buy in two steps (src/executor/scale-in.ts): firstPct now, the rest only when the coin holds ≥ +minRisePct
     *  above the entry with buyers ≥ minBuySharePct of the last 30 s (between minWaitSec and windowSec, ≤ +maxRisePct);
     *  a drop of cancelDropPct, a rug signal or no follow-through cancels it. Learning trades / legs under the minimum
     *  size buy everything at once. */
    scaleIn: { enabled: true as boolean, firstPct: 50, minWaitSec: 20, windowSec: 180, minRisePct: 2, maxRisePct: 30, cancelDropPct: 6, minBuySharePct: 55 },
    highConviction: {
      enabled: true, minScore: 80, minMarketCapUsd: 50_000, sizeSol: 1, maxPctOfCapital: 12,
      /** v10.13: every trade that ISN'T a big strong-setup trade is capped here (SOL), whatever the size settings say. */
      normalMaxSol: 0.5,
      /** …and a score under this never gets more than lowScoreMaxSol (no upsizing on weak setups). */
      lowScore: 65, lowScoreMaxSol: 0.25,
    },
    /**
     * Fraction of capital per strategy. Must add up to 1. v5 (research, Oct 2026): the edge for a
     * bot with ~0.3 s latency is fresh pairs AFTER the snipers' supply is absorbed (CURVE_SNIPE =
     * "New pairs"); late-curve / migration plays get less; copying wallets lost under every exit
     * rule in public tests (2 s late = their exit liquidity) → off.
     */
    /**
     * v10.21 (owner's CSV, 515 trades Oct 9–14: since the 5-min hold SOON −1.8% / MIGRATION −2.9% / KOL follow −3.5% per
     * trade vs RUNNER −10.7%, SWING −10%, new pairs −12%): the budget goes to the three that are close to break-even.
     */
    allocation: {
      // v10.27: new pairs back on under the owner's new-pair filter (≤ 1.5 min old, ≤ $100k MC, no Mayhem / bad words).
      CURVE_SNIPE: 0.15,
      MIGRATION_MOMENTUM: 0.35,
      SOON: 0.25,
      // v10.23 (owner: "5 trades in 6 hours is way too little"): RUNNER back on, small (size ×0.5 → the minimum).
      RUNNER: 0.05,
      // v8.9: KOL follow (kol.follow) — coins several KOLs / smart wallets bought.
      SMART_MONEY_COPY: 0.2,
      SWING: 0,
    } satisfies Record<StrategyName, number>,
    /** v10.21: RUNNER, SWING and new pairs (CURVE_SNIPE) off — they lost clearly (Controls → Rules can switch them back on). */
    enabledStrategies: {
      MIGRATION_MOMENTUM: true,
      SOON: true,
      SMART_MONEY_COPY: true,
      CURVE_SNIPE: true,
      SWING: false,
      RUNNER: true,
    } satisfies Record<StrategyName, boolean>,
    /**
     * v10.21: no NEW buys between these UTC hours (00–04 UTC: 97 trades, 9% winners, −2.8 SOL). Open trades are still
     * managed; refused signals still become shadow trades, so the learners keep seeing those hours.
     */
    // v10.23 (owner: too few trades): off by default — it cut 4 of every 24 hours.
    quietHours: { enabled: false as boolean, fromUtc: 0, toUtc: 4 },
    /** At most this many open positions per strategy. */
    maxOpenByStrategy: { CURVE_SNIPE: 4, SOON: 4, MIGRATION_MOMENTUM: 6, SMART_MONEY_COPY: 3, SWING: 3, RUNNER: 2 } as Partial<Record<StrategyName, number>>,
    /**
     * Strategy cool-off: once a strategy has `minTrades` closed trades among its last `lastN` and they
     * average worse than `maxAvgPnlPct` per trade, it takes no new entries for `pauseMinutes`
     * (the strategy lab keeps paper-testing its signals meanwhile).
     */
    strategyBreaker: { enabled: true as boolean, lastN: 20, minTrades: 12, maxAvgPnlPct: -4, pauseMinutes: 120 },
  },

  entry: {
    /**
     * Price action read from the trade tape (evaluator/price-action.ts; owner's "big update", Oct 11):
     * trend line, defended support / resistance, setup, buyer quality. Hard "not this coin" rules +
     * timing rules (stretched → the dip watcher waits for a pullback instead of buying the top).
     */
    priceAction: {
      // Owner (Oct 11): "trade more like before" → buy rules off; the chart read is still stored for the learners.
      enabled: false as boolean,
      /** Chart says no: lost support with sellers in control / sellers taking over. */
      blockSetups: ['BREAKDOWN', 'DISTRIBUTION'] as string[],
      /** 0–1 bot / wash-trading likelihood (top buyer share, churn, uniform sizes) above which → no buy. */
      maxManipulation: 0.6,
      /** Real demand in the last minute. */
      minTrades60: 5,
      minUniqueBuyers60: 4,
      /**
       * v10.13 (owner: "it bought 1.6 SOL on a 50 score chasing a candle and got top-blasted"): the "stretched → wait for a
       * dip" part works even while the buy rules above are off. It never blocks a coin, it only waits for a pullback.
       */
      dipWait: { enabled: true as boolean },
      /** Don't chase: up more than this in 60 s, or this far above its own trend line → wait for a dip. */
      maxChange60Pct: 40,
      maxExtensionPct: 30,
      /** More than this % under the recent high = a failed run, not a dip (0 = off; fresh curve coins only). */
      maxOffHighPctByStrategy: { CURVE_SNIPE: 45, RUNNER: 45, SOON: 45 } as Partial<Record<StrategyName, number>>,
      /** Room to the next defended resistance must be ≥ this × the round-trip cost (else it only feeds fees). */
      minEdgeMultiple: 2,
      /** No resistance above (price discovery) → assume this much room (%). */
      openSkyRoomPct: 60,
    },
    /** Owner's limits per candle timeframe (evaluator/timeframes.ts; 0 = off; Controls → Buy rules → Timeframes). */
    timeframes: {
      maxLastCandlePct: { s5: 0, s15: 0, s30: 0, m1: 0, m5: 0, h1: 0 },
      maxRun3Pct: { s5: 0, s15: 0, s30: 0, m1: 0, m5: 0, h1: 0 },
      maxLastDropPct: { s5: 0, s15: 0, s30: 0, m1: 0, m5: 0, h1: 0 },
    },
    // v9.6 (owner: "it isn't trading enough"): 55 — soft insider flags (bursts, transfers, dev-slot sells) used to
    // stack under 70 on normal busy coins; hard fails (mint / freeze authority, bad extensions…) still block,
    // and the rug guard (dump risk, launch whale, staircase, holder dumps) covers the rest at entry.
    minSafetyScore: 55,
    minCombinedScore: 65, // v9.9 (owner: more trades) — autopsy + AI coach tighten it back where it loses
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
    /** Owner: "know whether buyers or sellers are getting high" — sellers own more than maxSellSharePct of the SOL traded
     *  in the last windowSec → not now (checked again at the next checkpoint). Copies are exempt. */
    pressure: { enabled: true as boolean, windowSec: 30, prevWindowSec: 60, maxSellSharePct: 55, minTrades: 4 },
    /** Never buy a coin younger than this (the first seconds are bots and bundles). */
    minAgeSec: 15,
    /**
     * Confirmation delay: a BUY signal is re-checked `confirmDelaySec` later and only
     * executed if it still passes AND the price didn't dump > maxDropPct, didn't run
     * away > maxPumpPct (no chasing), and buyers are still at least even with sellers.
     */
    // v10.21 (owner's CSV: 228 of 515 trades died within 60 s, −7.3 SOL = 70% of all losses, most never went up 2% —
    // bought the top of a spike): wait 25 s and the price must HOLD (≤4% lower, ≤15% higher, buyers ≥1.1× sellers).
    // v10.23 (owner: "5 trades in 6 hours is way too little"): 15 s, ≤6% lower (still ≤15% higher, buyers ≥1.1×).
    confirmDelaySec: 15,
    confirm: { maxDropPct: 6, maxPumpPct: 15, minBuyRatio: 1.1 },
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
    // ---- Rug guard v2 (src/executor/rug-watch.ts; owner: "still gets rugged way too much") ----
    rugGuard: {
      enabled: true as boolean,
      /**
       * No buy when the 3 biggest holders dumping everything would crash the price this much…
       * (was 45 / 25: a PumpSwap pool only holds ~20% of the supply, so ONE normal 3% holder already
       * "could dump it 25%" → nearly every migrated / late-curve coin was refused — the bot stopped trading)
       */
      maxTop3DumpImpactPct: 80,
      /** …or the single biggest holder alone this much (≈ a 10%+ holder on a fresh PumpSwap pool). */
      maxTopDumpImpactPct: 60,
      /** Wallets that dumped on us before (+ devs of coins that rugged us): this many among the top-10 holders → no buy (dev = 2). */
      ruggerWalletMin: 3,
      ruggerMemoryDays: 14,
      /** While holding: the biggest holders at entry sold this % of the supply → out. */
      holderDumpPct: 4,
      holderDumpTop: 15,
      /** …or one holder with ≥2% of supply sold ≥60% of it. */
      bigSellerMinSupplyPct: 2,
      bigSellerSoldPct: 60,
      /** Sell cascade: ≥20% under the 20-second high, sells ≥3× buys, ≥2 sellers → out at once (not above 1.3x: the trail handles winners). */
      cascade: {
        enabled: true as boolean, windowSec: 20, dropPct: 20, sellBuyRatio: 3, minSellers: 2, maxMultiple: 1.3,
        /** v10.11 (owner: "obvious rugs are the main issue"): ONE wallet crashing it ≥25% in 20 s (sells ≥3× buys) → out. */
        soloDropPct: 25,
        /** …and a rug sold in slices: ≥30% under the 90-second high with sells ≥2× buys → out. Both skip the 5-min hold. */
        crashWindowSec: 90, crashDropPct: 30, crashSellBuyRatio: 2,
      },
      /**
       * Launch-whale pump (owner: "a dev or someone buys A LOT at the start → huge spike → a bunch of new
       * wallets buy it"): a wallet that bought ≥5% of the supply in the first 30 s and still holds ≥5% → no
       * buy; one that paid ≥30% of the launch buying, spiked it ≥1.8x, and then ≥15 wallets — ≥75% of them
       * never seen trading other coins — piled in → no buy even if it sold some.
       */
      launchPump: { enabled: true as boolean, windowSec: 30, whaleSupplyPct: 5, maxWhaleHoldPct: 5, spikeMultiple: 1.8, whaleBuySharePct: 30, swarmMinBuyers: 15, swarmFreshPct: 75 },
      /**
       * Spread-out bundle (owner: "top holders all held 0.5%, wallets made the same day 5 months ago, bought the exact
       * same"; then "tiny bundlers are okay, every coin has them — loosen it a little"). Only BIG groups (≥5% of the supply
       * together) count: ≥10 of the 30 biggest holders (≥0.3% each, dev excluded) within 5% of the same size; or ≥6 of the 15
       * biggest holders' wallets (≥2 days old) created within the same 24 h; or ≥4 same-size wallets sharing a birthday.
       * Wallet ages come from the funding-graph cache (24 h); missing ones over RPC right before a buy (≤2.5 s wait).
       * Coins we joined late: same-size check only (RPC top 20).
       */
      bundle: {
        enabled: true as boolean, topHolders: 30, minHolderPct: 0.3, sameSizeTolerancePct: 5, sameSizeMinWallets: 10, minGroupPct: 5,
        ageWallets: 15, sameDayHours: 24, sameDayMinWallets: 6, sameDayMinAgeDays: 2, comboMinWallets: 4, rpcLookups: true as boolean, lookupTimeoutMs: 2500,
      },
    },
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
      // v10.27: owner's new-pair filter = ≤ 1.5 min old
      maxAgeSec: 90,
      // v10.31: 15 holders was the top skip — a ≤ 90 s old coin rarely has them yet; the demand rules below
      // (≥10 real buyers in 60 s) are the real check. Owner's new-pair filter: ≥ 2 holders.
      minHolders: 8,
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
      // organic demand (last 60 s) — v7: a little looser (owner: one trade an hour is too few to learn from;
      // the absorption rules above, which protect against the sniper dump, are unchanged)
      minBuyers60s: 10,
      minNewBuyers60s: 6,
      minNetFlowSol60s: 1,
      minBuyRatioSol: 1.2,
      minBuyRatioCount: 1.3,
      requireAcceleration: true as boolean,
      minSizeCv: 0.5,
      maxSameSizePct: 25,
      minMedianBuySol: 0.05,
      maxGapSec: 20,
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
      minMarketCapUsd: 12_000,
      minVolumeUsd: 12_000,
      minActiveWallets5m: 25,
      // v10.31 (owner's Bot health: SOON "holders < 50" 99× and "safety < 55" 53× in an hour, 0 buys): 35 holders, safety 45
      // (soft insider flags stack on busy curve coins; hard fails + rug / bundle guard still block).
      minHolders: 35,
      minSafetyScore: 45,
      scoreThresholdDelta: 0,
      sizeMultiplier: 1,
    },
    migrated: {
      minTotalFeesSol: 9,
      minMarketCapUsd: 25_000,
      /** Pool liquidity in USD (both sides, like trading terminals show it). */
      minLiquidityUsd: 2_000,
      /** v10.33: 12 = what the migrated scanner sends (≥ 12 real buyers); 15 bounced coins it had just sent. */
      minActiveWallets5m: 12,
      /**
       * No entries in the first minutes after migration: pump.fun's BOOST buys ~17.6 SOL over the
       * first 5 min (mechanical, front-run by bots) and liquidity drains ~57% from minute 5 to 30.
       */
      noEntryFirstSec: 330,
      /**
       * v10.20 (owner: "0 buy signals"; "MIGRATION: safety < 55" was the top migrated skip): a coin that graduated with
       * real trading collects soft insider flags (tokens moved by transfer, sells in the dev's slot, same-size bursts,
       * dev's launch buy) just by being busy — they stack under 55. Its own minimum: 40. Hard fails (mint / freeze
       * authority, bad extensions, serial rugger, hidden dev over the limit) still block; rug / bundle guard still run.
       */
      minSafetyScore: 40,
      // v9.7 (owner: "trade A LOT more on migrated coins with ≥$2k liquidity, ≥$25k MC, ≥9 SOL fees"): those rules
      // are the filter, so the score bar is 15 lower for migrated coins (safety / rug / staircase / vamp still apply).
      scoreThresholdDelta: -15,
      sizeMultiplier: 1,
      /**
       * v9.2 (owner: "trade a lot more, especially migrated coins with lots of organic, real volume"):
       * src/scanner/migrated-scanner.ts checks ANY migrated coin (not only in its first hour) whose 5-min
       * organic flow is strong: ≥20 real buyers, ≥5 SOL real buying, buyers ≥55% of it, ≥60% of all volume
       * organic, not already up >35% in 3 min, MC ≥ $25k. Once per coin per 5 min.
       */
      scan: { enabled: true as boolean, everySec: 15, minOrganicBuyers5m: 12, minOrganicBuySol5m: 3, minBuySharePct: 52, minOrganicPct: 50, maxRun3mPct: 35, minMarketCapUsd: 25_000, cooldownMin: 3, maxChecksPerTick: 12 },
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
      /**
       * v10.22 (owner: "already traded this token" refused the scanner's re-signals on coins it made money on): a SOON /
       * migrated coin we closed in PROFIT may be bought once more when the scanner flags it again, ≥ profitCooldownMin later.
       */
      reentryOnRescan: true as boolean,
      profitCooldownMin: 30,
      /**
       * v10.22 (owner: "rebuy if it looks good for a rebound"): after a LOSS (never a rug) the coin is watched for a rebound
       * (pullback + bounce with buyers in control, swingSignal) and bought once more ≥ cooldownMin later — only as a
       * minimum-size learning trade, so the data shows whether loss rebounds pay before they get real size.
       */
      reboundAfterLoss: { enabled: true as boolean, cooldownMin: 60 },
      watchMinutes: 120,
      minPullbackPct: 10,
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
    // v8.2: every 30 s (owner: good coins pop up within minutes) + a 5-minute "hot right now" list.
    pollSec: 30,
    trendingSize: 30,
    hot5mSize: 15,
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
    /** A wallet with at least this weight is TRUSTED (owner's top picks, 1.5): it counts as two KOLs, so one trusted buy
     *  starts a KOL-follow check on its own. */
    trustedMinWeight: 1.5,
    /** Owner: "it's okay if top holders are a bit high when a lot of KOLs are buying at good entries": with ≥ minKols
     *  (trusted count double) still holding, top-10 / one-wallet / bundler limits up to the higher-risk caps
     *  (entry.riskyEntry) don't block and don't halve the size. Every rug / bundle / dip-entry check still applies. */
    concentrationRelax: { enabled: true as boolean, minKols: 3 },
    /**
     * KOL follow (owner: "trade more alongside coins that a lot of KOLs buy"): when ≥ minKols KOLs /
     * discovered smart wallets bought a coin and are still holding, it is checked as its own trade
     * (strategy SMART_MONEY_COPY, any curve stage / age) at 0 / 30 / 90 / 180 s: bar −6 with 2 KOLs, −10 with
     * 3+, size ×1 / ×1.3, up to maxOpen at once. Every safety, rug and vamp check still applies.
     */
    follow: {
      enabled: true as boolean,
      minKols: 2,
      // v10.28 (owner: "don't blindly copy KOLs!"): KOLs buying only TRIGGERS the check — no easier bar, no bigger size.
      barDelta2: 0,
      barDelta3: 0,
      sizeMultiplier2: 1,
      sizeMultiplier3: 1,
      maxOpen: 3,
      checkpointsSec: [0, 30, 90, 180] as number[],
    },
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
    dip: { enabled: true as boolean, noWaitBelowMcUsd: 15_000, minPullbackPct: 10, zoneTopMaxPct: 15, maxPullbackPct: 40, bounceConfirmPct: 3, minBuyRatio: 1.1, waitMinutes: 15, runAwayPct: 100, breakdownPct: 7, maxAboveZonePct: 8, blowOff: { enabled: true as boolean, runPct: 100, minDipPct: 35, holdSec: 45, dropRunPct: 500 },
      /** v10.24 (owner: "buy dip only if it's above 15k MC, under 15k you're allowed to top blast"): every BUY on a coin
       *  at/above `noWaitBelowMcUsd` waits for a pullback ≥ minPullbackPct off the recent high + a bounce (dip watcher). */
      dipOnly: {
        enabled: true as boolean,
        minPullbackPct: 10,
        /** Owner: "…unless there's a crazy amount of volume" → buy straight away when the last 5 min of REAL buying
         *  (bots, churners, dust removed) is this strong. */
        hotVolume: { enabled: true as boolean, minBuyers: 30, minBuySol: 12, minBuySharePct: 60, minOrganicPct: 60 },
      } },
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
   * SWING trading bigger coins (v7, owner: "swing trading more often, especially on bigger coins like
   * $clude that keep bouncing back — it's allowed to hold bigger MC coins if it sees potential").
   *  - Universe (src/scanner/swing-universe.ts, every `refreshSec`): your `watchlist` (mint addresses,
   *    Scanner page), coins on the trending tabs / DexScreener trending that already migrated, and our
   *    own tracked coins that grew. Kept: on PumpSwap (pump.fun's own pool) ≥ `minAgeMin`, market cap
   *    `minMarketCapUsd`–`maxMarketCapUsd`, pool liquidity ≥ `minLiquidityUsd`, 24 h volume ≥
   *    `minVolume24hUsd`. The best `maxCoins` (+ the watchlist) are followed live, trade by trade.
   *  - Bounce-back power (src/evaluator/swing.ts): 24 h of 5-min candles (GeckoTerminal, ≤ `history.maxPerMin`
   *    calls/min) → dips of ≥ `dipPct`% that won back ≥ `recoverPct`% of the drop vs dips that kept falling.
   *  - Entry: pulled back `minPullbackPct`–`maxPullbackPct` from its recent high, bounced `minBouncePct`–
   *    `maxBouncePct` off the low with buyers in control (buy/sell ≥ `minBuyRatio`) and a higher low —
   *    or one of the dip-type chart strategies (`taStrategies`) firing; score ≥ `minScore` (watchlist
   *    coins `watchlistScoreDelta` easier). Top-10 holders (RPC, every `holdersCheckMin`) > `maxTop10Pct`%
   *    → no buy, > `halfSizeTop10Pct`% → half size.
   *  - Re-trading a coin is the point (it keeps bouncing): `reentryCooldownMin` after a close
   *    (`lossCooldownMin` after a loss), ≤ `maxTradesPerCoinPerDay`, 2 losses in a row → paused
   *    `lossStreakPauseHours`. Exits: `exit.byStrategy.SWING`.
   */
  swing: {
    enabled: true as boolean,
    /** Mint addresses you want swing-traded (e.g. a coin you know keeps bouncing back). */
    watchlist: [] as string[],
    refreshSec: 60,
    everySec: 10,
    maxCoins: 30,
    maxWatchlist: 20,
    // v8 (owner: "be very strict with swing trading, especially higher MC coins"): bigger, busier coins only.
    minMarketCapUsd: 50_000,
    maxMarketCapUsd: 25_000_000,
    minLiquidityUsd: 25_000,
    minVolume24hUsd: 250_000,
    minAgeMin: 60,
    /** Stop following a coin this long after it left the universe (never while we hold it). */
    evictAfterMin: 90,
    history: { enabled: true as boolean, refreshMin: 20, maxPerMin: 4 },
    dipPct: 20,
    recoverPct: 60,
    minPullbackPct: 15,
    maxPullbackPct: 35,
    minBouncePct: 3,
    maxBouncePct: 8,
    minBuyRatio: 1.3,
    /** Real trades in the last 10 minutes (we only buy coins that are trading right now). */
    minTrades10m: 40,
    /** Down more than this in the last hour = falling knife → no buy. */
    maxDrop1hPct: 30,
    /** The higher timeframe shows lower lows (a downtrend) → no buy (watchlist coins exempt). */
    blockDowntrend: true as boolean,
    minScore: 78,
    watchlistScoreDelta: -3,
    /** Bounce-back power below this (0–1) → no buy (watchlist coins exempt). */
    minResilience: 0.45,
    maxTop10Pct: 45,
    halfSizeTop10Pct: 35,
    holdersCheckMin: 30,
    sizeMultiplier: 1,
    /**
     * Owner: "lower MC coins less amount, higher MC can be higher investing". Size × mult for the
     * highest step at or below the coin's market cap (capped by trading.maxPositionMultipleByStrategy).
     */
    sizeByMarketCap: [
      { fromUsd: 0, mult: 0.5 },
      { fromUsd: 150_000, mult: 0.8 },
      { fromUsd: 500_000, mult: 1 },
      { fromUsd: 2_000_000, mult: 1.3 },
      { fromUsd: 10_000_000, mult: 1.6 },
    ] as Array<{ fromUsd: number; mult: number }>,
    reentryCooldownMin: 30,
    lossCooldownMin: 240,
    maxTradesPerCoinPerDay: 3,
    lossStreakPauseHours: 48,
    /** Dip / reversal chart strategies that count as a swing entry setup. */
    taStrategies: [
      'fib_golden_pocket',
      'pullback_shallow',
      'pullback_deep',
      'ema_pullback',
      'rsi_oversold_bounce',
      'rsi_bull_divergence',
      'vwap_reclaim',
      'vwap_band_bounce',
      'capitulation_reversal',
      'liquidity_sweep',
      'double_bottom',
      'cvd_divergence',
      'climax_retest',
      'break_of_structure',
    ] as string[],
  },

  /**
   * Vamp guard (src/evaluator/vamp-guard.ts, owner: "watch out for fake coins — vamps: you make money on a
   * coin, then buy a vamp and lose it"). Every coin the bot buys, and every bigger coin it sees (swing
   * universe, trending tabs, DexScreener trending, our grown coins with MC ≥ minOriginalMcUsd), becomes
   * the ORIGINAL for its ticker and name; a different coin using that ticker / name (also "baby…", "…2",
   * "…inu", "…ai", "real…" …) is a vamp and is never bought. Originals: keepDaysBig (MC ≥ $100k) /
   * keepDaysSmall days; tickers shorter than minKeyLength are too generic to guard.
   */
  vamp: { enabled: true as boolean, minOriginalMcUsd: 30_000, keepDaysBig: 7, keepDaysSmall: 3, minKeyLength: 3 },

  /**
   * Learning trades (v7, owner: "trade more frequently, not once every hour — it won't learn like that").
   * A coin that passes EVERY rule but scores up to `scoreMargin` points under the bar is bought at
   * `sizeMultiplier`× size (≤ `maxOpen` at a time, ≤ `maxPerHour` per hour). Score calibration learns
   * from their real results: if near-misses win, their score band gets marked up and they become normal
   * buys; if they lose, they stay small learning trades. They don't count for the strategy cool-off.
   */
  /**
   * Moonshot TEST mode (src/learner/moonshot.ts, owner Oct 13): migrated coins where everything lines up — huge
   * organic buying, ≥2 KOLs still holding, on a trending list — get two pretend trades (moonshot exits vs normal
   * exits). `live` stays false (no paper money) until the results prove it.
   */
  /**
   * v10.27 — the owner's own terminal filters (src/evaluator/owner-filters.ts): EVERY buy must match the set for the
   * coin's stage ("ONLY buy coins with these things, not below — they'd be a rug"). Ages in minutes.
   */
  ownerFilters: {
    enabled: true as boolean,
    migrated: { minMarketCapUsd: 25_000, minHolders: 50, minLiquidityUsd: 2_000, minTotalFeesSol: 9 },
    soon: { maxAgeMin: 70, minVolumeUsd: 12_000, minMarketCapUsd: 12_000, minTotalFeesSol: 1 },
    newPair: { maxAgeMin: 1.5, minVolumeUsd: 200, maxMarketCapUsd: 100_000, minHolders: 2, excludeKeywords: ['test', 'fuck'] as string[], hideMayhem: true as boolean },
    /** Narrative 0–1 (0.5 neutral): below this the story is weak (copycat / junk description) → no buy. 0 = off. */
    minNarrative: 0.35,
  },

  moonshot: {
    enabled: true as boolean,
    live: false as boolean,
    everySec: 15,
    minBuyers5m: 40,
    minBuySol5m: 20,
    minBuySharePct: 60,
    minOrganicPct: 65,
    maxRun3mPct: 60,
    minMarketCapUsd: 30_000,
    minKolsHolding: 2,
    needTrend: true as boolean,
    cooldownMin: 60,
    maxOpen: 60,
    keep: 1000,
    exits: {
      tiers: [
        { multiple: 1.5, sellPct: 20 },
        { multiple: 2, sellPct: 20 },
        { multiple: 3, sellPct: 15 },
        { multiple: 5, sellPct: 15 },
      ],
      trailFrom: 1.5,
      trailLadder: [
        { fromMultiple: 1.5, pct: 25 },
        { fromMultiple: 3, pct: 30 },
        { fromMultiple: 5, pct: 28 },
        { fromMultiple: 10, pct: 25 },
      ],
      maxHoldMinutes: 480,
    },
  },

  explore: {
    enabled: true as boolean,
    // v8: only just-missed coins (owner: stop trading stupidly), never swings (owner: be very strict there).
    // v9.6: wider and more of them (owner: trade a lot more) — still every rule passed, still half size.
    scoreMargin: 12, // v10.16 (owner: more trades to learn from) — was 8
    // Half size (0.1 SOL at the default 0.2): smaller and the fixed tx costs (~3% round trip) distort what it learns.
    sizeMultiplier: 0.5,
    maxOpen: 6,
    maxPerHour: 20,
    // No entry at all for this long (owner: "it hasn't traded in an hour") → learning trades may take
    // coins up to droughtScoreMargin under the bar (still every rule passed, still half size).
    droughtMinutes: 45,
    droughtScoreMargin: 10,
    strategies: ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'RUNNER'] as StrategyName[],
  },

  /**
   * RUNNER (v9.4, owner: "stop skipping good coins — they went 2–4× after we skipped them"): curve coins
   * (15–92% curve, ≥3 min old) whose 5-min ORGANIC flow takes off: ≥25 real buyers, ≥4 SOL real buying,
   * buyers ≥58% and ≥60% organic, MC ≥ $8k → evaluated as RUNNER: the score bar is `scoreThresholdDelta`
   * lower (the flow is the proof; the scorer under-rates these), size ×`sizeMultiplier`, every safety / rug /
   * staircase / vamp rule still applies, stretched coins wait for a pullback (dip watcher), own exits
   * (exit.byStrategy.RUNNER). Once per coin per 4 min.
   */
  runner: {
    scoreThresholdDelta: -20,
    // v10.23: back on after the cut, but small (×0.5 → the minimum size) until it proves itself.
    sizeMultiplier: 0.5,
    scan: { enabled: true as boolean, everySec: 15, minOrganicBuyers5m: 18, minOrganicBuySol5m: 3, minBuySharePct: 55, minOrganicPct: 60, maxRun3mPct: 300, minMarketCapUsd: 8_000, cooldownMin: 4, maxChecksPerTick: 8, minCurvePct: 15, maxCurvePct: 92 },
  },

  /**
   * AI coach (src/learner/ai-coach.ts; owner: "learn from the behaviours it sees, not only statistics").
   * Needs ANTHROPIC_API_KEY in the VPS .env (optional AI_MODEL — default claude-sonnet-5-5 —, AI_DAILY_BUDGET_USD — default $0.5/day).
   * Every `everyMin` with ≥ minNewTrades new closed trades, Claude reads the last `tradesPerReview` trades
   * and proposes insights + rules; a rule goes live only after ≥ minForward new trades prove it
   * (≥ edgePct points better/worse than the rest). Live avoid rules let 1 in probeEvery through small.
   */
  aiCoach: { enabled: true as boolean, everyMin: 120, minNewTrades: 8, tradesPerReview: 30, maxRules: 12, minForward: 8, edgePct: 5, probeEvery: 5, preferBarDelta: -4 },

  /**
   * Loss autopsy (src/learner/loss-autopsy.ts; owner: "it keeps losing — scan what goes wrong and learn"):
   * every 30 min the closed paper trades (since the reset, ≤14 days) are split into bands per strategy
   * (market cap, coin age, curve, score, time of day). A band with ≥15 trades that averages under −3%
   * even after one standard error, and lost ≥0.1 SOL, is blocked; 1 in 5 of its trades still goes
   * through at the minimum size so it can prove itself again.
   */
  /** The brain (src/learner/brain.ts): win model, rule search, budget allocator. */
  brain: { enabled: true as boolean },

  /**
   * Outcome tracker (learner/outcome-tracker.ts): every coin the bot checks and doesn't buy (once per coin + strategy per
   * cooldownMin) is replayed `watchMin` later on its real trades with the bot's own exits → a training row for the brain at
   * `weight` (real trade 1, shadow 0.5). Thousands of examples a day instead of a handful. No AI, no RPC.
   */
  outcomes: { enabled: true as boolean, watchMin: 45, cooldownMin: 20, maxPending: 4000, maxPerTick: 120, keep: 6000, weight: 0.25 },

  /**
   * Shadow trades (src/learner/shadow-trades.ts; owner: "speed up the learning"): coins the bot didn't buy
   * (refused by the trader, just under the bar, or skipped by a rule with a score within skipWithinPoints)
   * are followed with the live exits — no money. Refused + near ones count for the autopsy / best times /
   * AI coach at `weight` of a real trade; skipped ones show what each filter costs.
   */
  shadow: { enabled: true as boolean, maxOpen: 250, cooldownMin: 30, keep: 3000, skipWithinPoints: 20, weight: 0.5 },

  /**
   * Best times to trade (src/learner/timing.ts; owner: "check which hours / days are best, most motion"):
   * market activity per UTC hour + weekday (recorded every minute) and our own results per hour / day
   * → size ×0.75–1.25 and buy bar −3…+4 for the current hour. Never blocks trading by itself.
   */
  timing: { enabled: true as boolean, minDays: 3, minTrades: 8, shrinkTrades: 20, quietRatio: 0.6, busyRatio: 1.3, sizeMin: 0.75, sizeMax: 1.25, barMin: -3, barMax: 4 },

  autopsy: { enabled: true as boolean, everyMin: 30, lookbackDays: 14, minTrades: 15, maxAvgPct: -3, minLossSol: 0.1, probeEvery: 5, blockMode: 'small' as 'small' | 'block' },

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
  /** Exit tuner (learner/exit-tuner.ts): follows time-based exits for 30 min after the sell and tunes those timers. */
  exitTuner: {
    enabled: true as boolean, watchMin: 30, minExits: 12, ranAfterPct: 40, deadAfterPct: 15, minHoursBetween: 6, maxFactor: 3, minFactor: 0.5,
    /**
     * v10.19: every stop-loss / rug exit followed 30 min. ≥15 of a kind with ≥40% back above our entry (+5%) and ≤30%
     * really dying = false alarm; stops landing ≥5 pts past the stop = late. The three chart rug exits (cascade / one
     * wallet / crash) get their drop % raised by `step` on false alarms, lowered by half a step when they're always right.
     */
    lossExits: { enabled: true as boolean, minExits: 15, falseAlarmPct: 40, maxDiedPct: 30, lateOvershootPts: 5, tuneRugExits: true as boolean, step: 5 },
  },

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
    maxOpen: 1500,
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
    /** Candle timeframes every strategy is tested on (owner: "add timeframes"): '15s' | '5s' | '1m'. */
    timeframes: ['15s', '5s', '1m'] as string[],
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
      // Owner-only: what would selling at the stop straight away (no 5-minute hold) have done? Never auto-applied.
      { id: 'Q', name: 'No 5-minute hold (stop fires straight away)', ownerOnly: true, exit: { stopLoss: { minHoldSec: 0 } } },
    ] as Array<{ id: string; name: string; ownerOnly?: boolean; exit: Record<string, unknown> }>,
  },

  /** Copy trading: react when a wallet on your watch list buys. */
  copy: {
    /**
     * Copy trades are heavily restricted (they underperformed): a STRICTER bar than
     * normal, half size, max `maxOpen` at a time, 5% of capital.
     */
    // v10.25 (owner picked the wallet to copy: "you're allowed to copy trade him"): normal bar + size, 2 at once.
    scoreThresholdDelta: 0,
    sizeMultiplier: 1,
    maxOpen: 2,
    /** Hold a copy trade at least this long before the normal exits (the mirror sell below ignores it). */
    minHoldSec: 0,
    /** Sell our copy position when the wallet we copied sells. */
    exitWhenWalletSells: true,
    /** Owner: "if you're in a trade with him and he sells, sell instantly" — ANY position we hold in a coin (whatever
     *  strategy bought it) is sold at once when a COPY wallet sells that coin after we bought. */
    mirrorSells: true as boolean,
    /** v10.28 (owner: "don't blindly copy KOLs!"): a copy waits for a good entry like every other buy — dip-only above
     *  $15k, the 15 s confirmation and the buyers-vs-sellers check all apply. true = buy the moment he buys. */
    skipDipWait: false as boolean,
    skipConfirm: false as boolean,
    /** Re-check the token this many seconds after the wallet's buy. */
    checkpointsSec: [0, 30, 90, 180],
  },

  /** X accounts whose posts become "hot keywords" (needs TWITTER_BEARER_TOKEN). */
  x: {
    accounts: ['elonmusk'] as string[],
    pollSec: 300,
    /** How long a keyword stays hot after a post. */
    hotHours: 6,
    /**
     * Per-coin X check (src/evaluator/x-check.ts; owner: "check X communities and X tweets"). Free part always:
     * link kind + copy-paste reuse of the same community / post / profile. Live part (TWITTER_BEARER_TOKEN, pay
     * per read) only for coins passing every rule within `liveWithinPoints` of the bar: profile, post, community
     * stats + recent posts with the contract address; ≤ maxReadsPerDay reads a day, cached 30 min per coin.
     */
    check: { enabled: true as boolean, live: true as boolean, liveWithinPoints: 12, maxReadsPerDay: 300 },
  },

  /** Keyword lists matched against name, ticker and description (whole words, case-insensitive). */
  keywords: {
    /** A match nudges the score up. */
    boost: ['elon', 'musk', 'doge', 'grok', 'trump', 'maga', 'agent', 'pepe'] as string[],
    /** A match blocks the buy. */
    block: ['rug', 'scam', 'honeypot', 'test'] as string[],
  },

  exit: {
    /** v10.28 — real sell fee is 0.006 SOL per sale (owner's terminal): a take-profit slice must be worth ≥ this many
     *  sell fees, else it sells a bigger slice; and if what would be left is worth less than that, it sells all of it
     *  (one fee instead of two). 0 = off. Mostly matters for 0.1–0.2 SOL trades. */
    minSaleFeeMultiple: 8,
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
      minutes: { CURVE_SNIPE: 1.5, SOON: 3, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 3, SWING: 30, RUNNER: 4 } as Partial<Record<StrategyName, number>>,
      defaultMinutes: 5,
      minPeakMultiple: 1.1,
      maxMultiple: 1.02,
      stallMinutes: { CURVE_SNIPE: 3, SOON: 5, MIGRATION_MOMENTUM: 10, SMART_MONEY_COPY: 5, SWING: 45, RUNNER: 6 } as Partial<Record<StrategyName, number>>,
    },
    /**
     * Coins bought on the curve that graduate: sell `sellPct` while pump.fun's BOOST is buying
     * (between `fromSec` and `toSec` after migration) — that demand stops at minute 5.
     */
    boostSell: { enabled: true as boolean, fromSec: 60, toSec: 240, sellPct: 40 },
    /**
     * Sell into a spike: up ≥ risePct within windowSec (and ≥ minMultiple) → sell sellPct% of what's
     * left, once per position. Off by default; on for SWING (exit.byStrategy).
     */
    spikeSell: { enabled: false as boolean, risePct: 8, windowSec: 120, sellPct: 50, minMultiple: 1.04 },
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
      // Swings: in and out within hours (the runner gets 2× this).
      SWING: 240,
      RUNNER: 60,
    } satisfies Record<StrategyName, number>,
    /**
     * Let a winner on a BIG coin run (owner: "it's allowed to hold bigger MC coins if it sees
     * potential"): once initials are out (or the first take-profit is in), the market cap is at least
     * `minMarketCapUsd` and the chart still trends up (not breaking down, risk low), the max-hold and
     * no-movement exits are skipped — the trailing stop / break-even floor still protect it — up to
     * `maxHours` in total.
     */
    holdLonger: { enabled: true as boolean, minMarketCapUsd: 60_000, maxHours: 48 },
    /**
     * Per-strategy exit settings layered on top of everything above (any field can be overridden).
     * SWING (bigger coins, slower and smaller moves than fresh pairs, but more of them): first profit
     * at 1.25x (30%), more at 1.6x (30%) and 3x (15%), trail + break-even floor from 1.25x, 12–15%
     * stop, no follow-through after an hour / no new high for 2 hours → out.
     */
    byStrategy: {
      // v10.21 (owner's CSV: only ~1 in 9 trades reached the 1.4x first take-profit, 1 in 4 reached 1.2x; selling half at
      // 1.2x would have added ~2 SOL): SOON + migrated coins bank 30% at 1.2x, 30% at 1.4x, 15% at 5x; trail as before.
      SOON: { takeProfitTiers: [{ multiple: 1.2, sellPct: 30 }, { multiple: 1.4, sellPct: 30 }, { multiple: 5, sellPct: 15 }] },
      MIGRATION_MOMENTUM: { takeProfitTiers: [{ multiple: 1.2, sellPct: 30 }, { multiple: 1.4, sellPct: 30 }, { multiple: 5, sellPct: 15 }] },
      // v8 (owner: "10% is good profit — be faster and stricter with swing trading, sell on spikes"):
      // half out at +10%, a quarter at +20%, 15% at +50%; the rest on a tight trail with a break-even
      // floor from 1.1x; a spike of +8% within 2 minutes sells half of what's left at once.
      SWING: {
        takeProfitTiers: [
          { multiple: 1.1, sellPct: 50 },
          { multiple: 1.2, sellPct: 25 },
          { multiple: 1.5, sellPct: 15 },
        ],
        trailingStopActivateMultiple: 1.1,
        trail: {
          breakEvenAfterMultiple: 1.1,
          ladder: [
            { fromMultiple: 1.1, pct: 6 },
            { fromMultiple: 1.2, pct: 7 },
            { fromMultiple: 1.5, pct: 9 },
            { fromMultiple: 2, pct: 12 },
          ],
          peakHoldMs: 2000,
        },
        protectProfit: { afterMultiple: 1.08, floorMultiple: 1.02 },
        timeStop: { minPeakMultiple: 1.04, maxMultiple: 1.0 },
        spikeSell: { enabled: true, risePct: 8, windowSec: 120, sellPct: 50, minMultiple: 1.04 },
        holdLonger: { enabled: true, minMarketCapUsd: 60_000, maxHours: 8 },
      },
      // v9.4 RUNNER: momentum already proven → take profit early and often, trail tight, out fast if it stalls.
      RUNNER: {
        takeProfitTiers: [
          { multiple: 1.3, sellPct: 35 },
          { multiple: 1.7, sellPct: 25 },
          { multiple: 3, sellPct: 15 },
        ],
        trailingStopActivateMultiple: 1.3,
        trail: {
          breakEvenAfterMultiple: 1.3,
          ladder: [
            { fromMultiple: 1.3, pct: 14 },
            { fromMultiple: 2, pct: 18 },
            { fromMultiple: 3, pct: 20 },
          ],
        },
        protectProfit: { afterMultiple: 1.2, floorMultiple: 1.03 },
        spikeSell: { enabled: true, risePct: 25, windowSec: 60, sellPct: 40, minMultiple: 1.15 },
      },
    } as Partial<Record<StrategyName, Record<string, unknown>>>,
    /**
     * Potential hold (owner: "it sells too early in the minus — hold longer if it sees potential"): while real
     * buyers are in control over the last `windowSec` (≥ minBuyers different wallets, ≥ minBuySharePct % of the
     * volume, ≥ minBuySol SOL; bots / churners / dust removed) and no rug signal, the soft stop, the early risk
     * exit, the stale exit and the time stops wait (time stops up to `extraMinutes` longer). The hard limit
     * (the bottom of the owner's 10–20% band per strategy) always fires.
     */
    potentialHold: { enabled: true as boolean, windowSec: 120, minBuyers: 8, minBuySharePct: 60, minBuySol: 1.5, extraMinutes: 10 },
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
      maxPctByStrategy: { MIGRATION_MOMENTUM: 15, SWING: 12, RUNNER: 14 } as Partial<Record<StrategyName, number>>,
      /** Tighter minimum per strategy (swings: 10–12%, the bottom of the owner's 10–20% band). */
      minPctByStrategy: { SWING: 10 } as Partial<Record<StrategyName, number>>,
      /** A dip under the stop (not the hard limit) must hold this long before selling (no wick sells). */
      confirmTicks: 1,
      confirmSec: 2,
      /**
       * Owner (Oct 12): "memecoins dip and bounce — hold at least 5 minutes before panic selling, unless it's brutally
       * past the stop like a rug". For the first `minHoldSec` the normal stop, the hard limit, the early risk cut and the
       * time / stale stops wait; only a fall past `holdDisasterPct` (after fees) or a rug signal sells. 0 = off.
       */
      minHoldSec: 300,
      holdDisasterPct: 35,
    },
    rugExit: {
      /** Bundle wallets sold this many % of supply since we bought → exit. */
      bundleDumpPct: 5,
      devDumpPct: 10,
      /** A dev who held more than this % of supply: ANY real sell (≥2% of their bag) counts as a rug signal. */
      devAnySellMinHoldingPct: 2,
      /** One sell this big vs the pool / curve liquidity while ≥10% off the peak = a whale exit → out. 0 = off. */
      singleSellLiquidityPct: 15,
      onLiquidityRemoved: true,
      holderConcentrationSpikePct: 15,
    },
    /** Chart-based exits (price-action.ts, owner's big update): */
    priceAction: {
      enabled: true as boolean,
      /** After a ≥ minPeakMultiple peak, a close breakPct% under the last swing low = the uptrend is over → sell the rest. */
      structureStop: { enabled: true as boolean, minPeakMultiple: 1.3, breakPct: 3 },
      /** In profit ≥ minMultiple, dropFromPeakPct% off the peak and sellers own the last minute → bank sellPct% of what's left, once. */
      momentumFade: { enabled: true as boolean, minMultiple: 1.25, dropFromPeakPct: 12, sellPct: 50 },
      /** Trailing distance × weak…strong by chart strength (a strong chart isn't shaken out on noise). */
      trailByStrength: { enabled: true as boolean, weak: 0.85, strong: 1.15 },
    },
    staleMinutes: {
      CURVE_SNIPE: 20,
      SOON: 20,
      MIGRATION_MOMENTUM: 60,
      SMART_MONEY_COPY: 60,
      SWING: 45,
      RUNNER: 15,
    } satisfies Record<StrategyName, number>,
    dailyLossCircuitBreakerPct: 20,
    /**
     * PAPER: the daily loss breaker and the strategy cool-off don't stop trading (owner: get as
     * much data as possible — fake money, the balance can be reset). LIVE: both always apply.
     */
    paperIgnoresLossLimits: true as boolean,
  },

  /** Paper-trading simulation settings. Kept pessimistic so paper results aren't fantasy. */
  paper: {
    startingBalanceSol: 10,
    /** Fake SOL added on top since the last reset ("Add paper SOL" — owner: top up without resetting the learning). */
    addedSol: 0,
    /**
     * Fresh stats WITHOUT deleting anything (owner: "reset the PnL, not the trades or data"): profit / win rate / charts on
     * Overview + Performance count only trades closed after `statsSince` (ISO, '' = all), and the balance gets
     * `balanceOffsetSol` added so it restarts at the chosen amount. Trades, positions and all learning stay.
     */
    statsSince: '' as string,
    balanceOffsetSol: 0,
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
    /** v10.28 — the owner's real terminal settings (priority fee + tip per transaction):
     *  SELL 0.001 prio + 0.005 tip = 0.006 SOL (every sale, also each partial take-profit); BUY 0.0001 + 0.001 = 0.0011 SOL.
     *  (Their 20% slippage is the tolerance, not the cost — fills still pay the real price impact + slippagePct.) */
    txFeeSol: 0.006,
    buyTxFeeSol: 0.0011,
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
    /**
     * A labelled token is a WIN if it reached this multiple of the evaluation price… v8.9: 1.4x = the
     * first take-profit the bot really sells at (was 1.8x — the scorer learned a target the bot never trades).
     */
    winMultiple: 1.4,
    /** …BEFORE it ever fell to this multiple — 0.85 ≈ where the 12–20% stop takes it out (was 0.7). */
    drawdownLossMultiple: 0.85,
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
    /** v10.19: weights only move on real evidence (was 100 / 10 — coincidences moved them). */
    minSamples: 300,
    minPerClass: 40,
    /** Each weight stays within these multiples of its default. */
    minWeightFactor: 0.4,
    maxWeightFactor: 2.5,
    /** Newest N labelled evaluations are held out: new weights must rank them at least as well (AUC) as the old. */
    holdoutSize: 300,
    minHoldoutPerClass: 20,
    /**
     * v10.19 (review: "learning should mean measurable improvement"): new weights are kept only if, on the held-out
     * newest data they never trained on, they rank better by ≥ minAucGain, no strategy with ≥ strategyMinPerClass
     * winners and losers gets worse by > maxStrategyDrop, and (≥ minTradeHoldout real trades) the trades they'd
     * have picked earn at least as much after costs. A thin holdout = keep the current weights.
     */
    minAucGain: 0.005,
    strategyMinPerClass: 8,
    maxStrategyDrop: 0.02,
    minTradeHoldout: 20,
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
