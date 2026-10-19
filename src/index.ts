/**
 * Main entry point — boots every module in the right order.
 *
 * Boot order matters:
 *   1. Database + Timescale (everything writes here)
 *   2. Redis + restore live state (so trades for tokens seen before a restart still count)
 *   3. Background workers (snapshots, safety checks)
 *   4. The WebSocket listener LAST — once it starts, events flow immediately
 *
 * Shutdown (Ctrl+C or `docker stop`) runs in reverse so nothing is lost.
 */
import { startNightlyCopyTest } from './learner/copy-consistent';
import { startMarketMood } from './learner/market-mood';
import { startApi } from './api/server';
import { env, redactUrl, rpcEndpoints } from './config/env';
import { bus } from './lib/bus';
import { getConfig, startConfigRefresh, stopConfigRefresh } from './config/runtime-config';
import { DEFAULT_CONFIG } from './config/default';
import { markStrategySince, oneTimeUpgrade, runConfigMigrations } from './config/migrations';
import { startCalibration, stopCalibration } from './learner/score-calibration';
import { screenEntry } from './executor/rug-screen';
import { RuggerMemory } from './executor/rug-watch';
import { TimingLearner } from './learner/timing';
import { shadowAsClosed, ShadowTrades, wouldHaveTaken } from './learner/shadow-trades';
import { OutcomeTracker } from './learner/outcome-tracker';
import { ExitTuner } from './learner/exit-tuner';
import { TapeArchiver } from './learner/tape-archiver';
import { TapeRecorder } from './learner/tape-recorder';
import { DEFAULT_USAGE, UsageBudget, setUsageBudget } from './lib/usage-budget';
import { Brain } from './learner/brain';
import { startPushNotifier } from './lib/push';
import { LossAutopsy } from './learner/loss-autopsy';
import { ObsidianSync } from './integrations/obsidian-sync';
import { SelfLoop, keyAllowed, LOOP_STATE_KEY, DEFAULT_LOOP, type LoopConfig } from './learner/self-loop';
import { replayRunning, runReplayAndWait } from './learner/replay-runner';
import { blockerSnapshot } from './lib/entry-blockers';
import { applyEdit } from './config/apply-edit';
import { EDITABLE, getPath } from './config/editable';
import { sniperRuleLines } from './integrations/obsidian-notes';
import { recentChanges } from './lib/change-log';
import { MigratedScanner } from './scanner/migrated-scanner';
import { RunningCoins } from './scanner/running-coins';
import { priceShape } from './evaluator/price-shape';
import { AiCoach } from './learner/ai-coach';
import { Evaluator } from './evaluator/evaluator';
import { WalletAnalyzer } from './evaluator/wallet-analyzer';
import { createExecutor } from './executor/executor';
import { SellManager } from './executor/sell-manager';
import { startPositionHistory, stopPositionHistory } from './executor/position-history';
import { Trader } from './executor/trader';
import { ensureTimescale } from './db/timescale';
import { SafetyChecker } from './evaluator/safety-checker';
import { InsiderTracker } from './evaluator/insider-cluster';
import { CrowdTracker } from './scanner/crowd-tracker';
import { DexScreener } from './scanner/dexscreener';
import { MarketLeaders } from './scanner/market-leaders';
import { WalletPnl } from './learner/wallet-pnl';
import { WalletBook } from './learner/wallet-book';
import { DeployerBook, type BackfillRow } from './learner/deployer-book';
import { getSolUsd } from './lib/sol-price';
import { DipWatcher } from './executor/dip-watcher';
import { StrategyLab } from './learner/strategy-lab';
import { Tournament } from './learner/tournament';
import { ForexLab } from './forex/lab';
import { feeds as fxFeeds } from './forex/feeds';
import { FastLab } from './forex/fast';
import { Practice } from './forex/practice';
import { loadPythConf, pythConf, pythKey, pythLive, setPythConf, testPythKey } from './forex/pyth';
import { yahooLive } from './forex/yahoo-live';
import { startLivePush } from './forex/live-push';
import { ForexCalendar } from './forex/calendar';
import { ForexHeadlines } from './forex/headlines';
import { TradeAi } from './forex/trade-ai';
import { TradeWatch } from './forex/trade-watch';
import { MemeReader } from './evaluator/meme-reader';
import { NewPairWatcher } from './scanner/new-pair-watcher';
import { TaLab } from './learner/ta-lab';
import { TrendingFeeds } from './scanner/trending-feeds';
import { TrendingHub } from './scanner/trending-hub';
import { deriveMetrics } from './scanner/live-state';
import { TradeCoach } from './learner/trade-coach';
import { SwingWatcher } from './executor/swing-watcher';
import { SwingTrader } from './executor/swing-trader';
import { SwingUniverse } from './scanner/swing-universe';
import { VampGuard } from './evaluator/vamp-guard';
import { ObservationLogger, removeParkedSnapshotJobs } from './learner/observation-logger';
import { requestAdjustment, scheduleDailyAdjuster } from './learner/daily-adjuster';
import { startBeliefCache, stopBeliefCache } from './learner/bayesian-updater';
import { OutcomeLabeler } from './learner/outcome-labeler';
import { startRegimeDetector } from './learner/regime-detector';
import { logger } from './lib/logger';
import { installProcessGuards } from './lib/process-guard';
import { recordError, recordExit, recordStart, setDeployerStatsSource, setMemeStatsSource, setTapeStatsSource, setWalletBookStatsSource } from './lib/bot-health';
import { prisma } from './lib/prisma';
import { setLastEntryAt } from './lib/entry-blockers';
import { closeQueues } from './lib/queues';
import { closeRedis, redis } from './lib/redis';
import { rpcLimiter } from './lib/solana';
import { LiveState } from './scanner/live-state';
import { GrpcListener } from './scanner/grpc-listener';
import { effectiveFeed, loadFeedSettings, setActiveFeed } from './lib/feed-settings';
import { PumpFunListener, type ListenerStats } from './scanner/pumpfun-listener';
import { recordEvent } from './lib/bot-events';
import { addPaperFunds, resetPaperStats } from './api/paper-reset';
import { PumpPortalListener } from './scanner/pumpportal-listener';
import { WhaleTracker } from './scanner/whale-tracker';
import { startSpikeWatcher } from './scanner/spike-watcher';
import { startXWatcher } from './scanner/x-watcher';
import { TokenRegistry } from './scanner/token-registry';

const log = logger.child({ module: 'main' });

// Network/socket blips are logged and survived; real bugs still exit so Docker restarts cleanly.
installProcessGuards(log, undefined, { onError: (m) => recordError(m), onFatal: (r) => recordExit(r) });

async function main(): Promise<void> {
  log.info({ mode: env.TRADING_MODE, env: env.NODE_ENV }, '🚀 Pump.fun bot starting');

  // 1. Database
  await prisma.$connect();
  log.info('postgres connected');
  await ensureTimescale();
  // Push deliberate setting changes into saved settings (owner edits elsewhere are kept).
  await runConfigMigrations();
  // Owner (Oct 13): "reset the PnL, not the trades or data — start from 15 SOL again" (once; nothing deleted).
  await oneTimeUpgrade('stats-reset-oct13', async () => {
    await resetPaperStats(15);
  });
  // v10.32: drop the tens of thousands of parked 1 h / 6 h / 24 h snapshot jobs (Redis was near its 1 GB cap). Background.
  await oneTimeUpgrade('obs-chain-cleanup', async () => {
    void removeParkedSnapshotJobs()
      .then((n) => log.info({ removed: n }, 'parked snapshot jobs removed'))
      .catch((err: Error) => log.warn({ err: err.message }, 'snapshot job cleanup failed'));
  });
  // Owner (Oct 15): "reset the PnLs as well" — fresh headline numbers again from 15 SOL (nothing deleted; the daily
  // calendar keeps every day).
  await oneTimeUpgrade('stats-reset-oct15', async () => {
    await resetPaperStats(15);
  });
  // v5 strategy: the trade coach's lessons came from the old setup (late-curve buys, 1.15x trails) —
  // they'd shrink sizes and raise the bar for the new one. Start its lessons fresh, once.
  await oneTimeUpgrade('v5-strategy', async () => {
    await TradeCoach.reset(redis);
    await markStrategySince();
  });
  // v11 strategy (edge gate, early bail, momentum / entry-quality gates, new exits): the coach's lessons and the
  // per-strategy record the edge gate judges by both come from the old setup → start both fresh, once.
  await oneTimeUpgrade('v11-strategy', async () => {
    await TradeCoach.reset(redis);
    await markStrategySince();
  });
  // v15.4 (owner: "reset the crypto strategies, trade smarter and faster, only SOON and migrated coins" — config
  // migration v55): the coach's lessons and every strategy's record start fresh for the focused setup, once.
  await oneTimeUpgrade('v15.4-crypto-reset', async () => {
    await TradeCoach.reset(redis);
    await markStrategySince();
  });
  // v17.15 (owner: "lower things even more, gather a lot of data, everything on" — config migration v57): every strategy
  // starts a fresh record, and the coach's old lessons (which raised the bar on the strategies that were off) start over
  await oneTimeUpgrade('v17.15-crypto-data', async () => {
    await TradeCoach.reset(redis);
    await markStrategySince();
  });
  // v15.4 (owner): track 5aLY… as a trusted COPY wallet (copied only once the copy test finds it consistent).
  await oneTimeUpgrade('track-5aLY', async () => {
    const { OWNER_TRUSTED_COPY } = await import('./config/kol-wallets');
    const data = { kind: 'COPY', weight: 1.5, active: true, label: 'Trusted 5aLY', notes: "owner (Oct 18): trustworthy wallet — copied once the nightly copy test finds it consistent" };
    await prisma.trackedWallet.upsert({ where: { address: OWNER_TRUSTED_COPY }, update: data, create: { address: OWNER_TRUSTED_COPY, ...data, source: 'MANUAL' } });
  });
  await startConfigRefresh();

  // 2. Redis
  await redis.ping();
  log.info('redis connected');
  const { lastExit } = await recordStart(redis);
  if (lastExit) log.info({ lastExit }, 'previous run ended');
  // "Why no trades": a restart shouldn't hide how long it has been since the last buy.
  const lastPos = await prisma.position.findFirst({ orderBy: { openedAt: 'desc' }, select: { openedAt: true } }).catch(() => null);
  setLastEntryAt(lastPos?.openedAt.getTime() ?? null);
  const liveState = new LiveState(redis);
  await liveState.restore();

  // 3. Workers
  const observations = env.ENABLE_OBSERVATIONS ? new ObservationLogger(liveState) : null;
  observations?.start();
  const safety = env.ENABLE_SAFETY_CHECKS ? new SafetyChecker(liveState, redis) : null;

  // Execution: PAPER (with the live dry run) unless every live gate passes — see executor/executor.ts.
  const { executor, reconciler: liveReconciler } = await createExecutor(liveState, redis);
  // v17.15: up to 30 open crypto paper trades need room — a paper balance under 20 SOL is topped up to 25 SOL once (a
  // top-up counts as capital, not profit; nothing is reset)
  await oneTimeUpgrade('v17.15-paper-room', async () => {
    if (executor.mode !== 'PAPER') return;
    const bal = await executor.getBalanceSol();
    if (Number.isFinite(bal) && bal < 20) await addPaperFunds(Math.round((25 - bal) * 100) / 100);
  });
  const trader = new Trader(executor);
  const sellManager = new SellManager(executor, liveState, redis);
  sellManager.start();
  // Learning engine: label outcomes, weight tuning (every 20 min + after each closed trade), market regime.
  const outcomes = new OutcomeLabeler(liveState, redis);
  outcomes.afterTradeClosed = () => requestAdjustment('trade_closed');
  outcomes.start();
  const nightly = scheduleDailyAdjuster(redis);
  startBeliefCache();
  const regimeTimer = await startRegimeDetector();
  startCalibration();
  const evaluator = new Evaluator(redis, liveState, new WalletAnalyzer(redis, { blockByThrow: false }), trader, outcomes);
  evaluator.start();

  // How people behave on each coin (eyes, dip buying, paper hands, bots) + "Soon" detection.
  const crowd = new CrowdTracker();
  crowd.start();
  // Last look before every buy: anything rug-like since the signal?
  // Rug guard v2: wallets that dumped on us before are refused at entry (sell manager records them).
  const ruggers = new RuggerMemory(redis);
  sellManager.ruggers = ruggers;
  evaluator.ruggers = ruggers;
  trader.screen = (req) => screenEntry(req, { liveState, redis, crowd, ruggers });
  // Migrated coins with strong organic flow → checked any time, not only in their first hour.
  const migratedScanner = new MigratedScanner(crowd, (mint, why) => evaluator.checkNow(mint, 'MIGRATION_MOMENTUM', why, { rescan: true, bucketSec: 300 }), (mint) => sellManager.isHolding(mint));
  migratedScanner.start();
  // Runners: curve coins whose real buying took off after the first checks passed on them.
  const runnerScanner = new MigratedScanner(crowd, (mint, why) => evaluator.checkNow(mint, 'RUNNER', why, { rescan: true, bucketSec: 240 }), (mint) => sellManager.isHolding(mint), 'runner');
  runnerScanner.start();
  // AI coach: Claude reads the trades for behaviour patterns → rules that must prove themselves first.
  const aiCoach = new AiCoach(redis, () => getConfig().aiCoach ?? DEFAULT_CONFIG.aiCoach);
  aiCoach.start();
  // v10.40 (owner): the brain made "avoid coins under 9 SOL fees" for EVERY coin — the owner meant only ≥ $50k MC. The
  // fee rule is now in code (entry.feesByMarketCap); the tip behind that rule is removed so it can't keep blocking.
  // v10.42 (owner): no more instant copies / mirror sells of 4vw54… — it's a normal (trusted) KOL buy signal like the others.
  await oneTimeUpgrade('copy-wallet-to-kol', async () => {
    const { OWNER_COPY_WALLETS } = await import('./config/kol-wallets');
    await prisma.trackedWallet.updateMany({ where: { address: { in: OWNER_COPY_WALLETS } }, data: { kind: 'KOL', weight: 1.5 } });
  });
  await oneTimeUpgrade('retract-launch-priors', async () => {
    await aiCoach.remember('Research check (Oct 18 2026): the Telegram 8.9× and launch-size 4.5× graduation multipliers were withdrawn by their author, and the deployer-history multipliers (second launch of the day dies, quiet proven dev) have no source. Treat launch.* and deployer.* as features to test on our own data, never as known effects. No public study shows a positive after-cost strategy for a bot buying 1–3 s late; measured winners are launch-block snipers and sandwich bots.');
  });
  await oneTimeUpgrade('fee-rule-by-mc', async () => {
    const ids = await aiCoach.removeFeeTips();
    log.info({ tips: ids }, 'owner fee tips replaced by the market-cap fee rule');
  });
  // Loss autopsy: what keeps going wrong → the kinds of trades that keep losing are blocked.
  const autopsy = new LossAutopsy(redis, () => getConfig().autopsy ?? DEFAULT_CONFIG.autopsy);
  autopsy.start();
  // Best hours / days to trade: market motion per hour + weekday and our results → size and bar for now.
  const timing = new TimingLearner(redis, () => getConfig().timing ?? DEFAULT_CONFIG.timing);
  timing.start();
  aiCoach.timingSource = () => timing.snapshot();
  // Exit tuner: what coins did after a time-based exit → tunes those timers (no AI, free).
  const exitTuner = new ExitTuner(redis, (m) => crowd.trades(m));
  exitTuner.start();
  aiCoach.exitSource = () => exitTuner.snapshot();
  // Real trade tapes around every paper trade → backtests of exit settings (learner/backtester.ts).
  const tapeArchiver = new TapeArchiver((m) => crowd.trades(m));
  tapeArchiver.start();
  aiCoach.autopsySource = () => autopsy.snapshot();
  trader.bandCheck = (req) =>
    autopsy.check({
      strategy: req.strategy,
      mcUsd: req.market.marketCapUsd ?? null,
      ageMin: Number.isFinite(req.market.ageSec) ? req.market.ageSec / 60 : null,
      curvePct: req.market.complete || req.market.onAmm ? 'migrated' : req.market.bondingCurvePct,
      score: req.score,
      hourUtc: new Date().getUTCHours(),
      dowUtc: new Date().getUTCDay(),
      ...(() => {
        const sh = priceShape(crowd.candles(req.mint), Date.now());
        return { run3m: sh?.run3m ?? null, offHigh10m: sh?.offHigh10m ?? null };
      })(),
    });
  evaluator.crowd = crowd;
  crowd.onSoon = (mint, pct) => {
    log.info({ mint, curvePct: +pct.toFixed(1) }, '⏳ coin entered the Soon zone — checking');
    void evaluator.scheduleSoon(mint).catch((err: Error) => log.warn({ mint, err: err.message }, 'could not schedule Soon checks'));
  };
  // Review every closed trade and adjust how the bot trades; swing re-entries on Soon/migrated coins.
  const coach = new TradeCoach(redis, liveState, crowd);
  await coach.start();
  const swings = new SwingWatcher(redis, liveState, crowd, evaluator);
  swings.start();

  const insiders = new InsiderTracker(redis);
  const registry = new TokenRegistry(liveState, observations, safety, evaluator, insiders, crowd);
  // v11.5: every trade on every followed coin → Postgres TradeTape (the replay engine's recording).
  const tapeRecorder = new TapeRecorder();
  tapeRecorder.start();
  registry.tape = tapeRecorder;
  setTapeStatsSource(() => tapeRecorder.snapshot());
  // v11.7: requests per provider per day; optional lookups pause at the soft limit (owner: "don't drain my usage").
  const usageBudget = new UsageBudget(redis, () => getConfig().usage ?? DEFAULT_USAGE, (provider, used, budget) => {
    void recordEvent({ level: 'WARN', module: 'usage', type: 'usage_soft_limit', message: `${provider}: ${used.toLocaleString()} of ${budget.toLocaleString()} requests today — optional lookups paused until midnight UTC` });
  });
  setUsageBudget(usageBudget);
  await usageBudget.start();
  // DexScreener: trending coins + DEX paid. A tracked coin that starts trending is checked right away.
  const dex = new DexScreener();
  evaluator.dex = dex;
  dex.onTrending = (c) => {
    if (!liveState.isTracked(c.mint)) return;
    void liveState
      .isComplete(c.mint)
      .then(async (done) => {
        const why = `dex-trending#${c.rank}`;
        if (done) return evaluator.checkNow(c.mint, 'MIGRATION_MOMENTUM', why);
        await evaluator.checkNow(c.mint, 'SOON', why);
        await evaluator.checkNow(c.mint, 'CURVE_SNIPE', why);
      })
      .catch(() => undefined);
  };
  dex.start();
  // "What's working now": top coins + the narratives they share → hot keywords for scoring.
  const leaders = new MarketLeaders(liveState, dex);
  evaluator.leaders = leaders;
  leaders.start();
  // Smart-money discovery: real profit per wallet → the best become KOL wallets automatically.
  const walletPnl = new WalletPnl(redis);
  registry.pnl = walletPnl;
  walletPnl.start();
  // v11.6: the wallet book — every wallet's record from the same trades (who is buying at entry, holder clock at exit).
  const walletBook = new WalletBook(redis);
  await walletBook.load();
  walletBook.start();
  registry.book = walletBook;
  evaluator.walletBook = walletBook;
  sellManager.walletBook = walletBook;
  setWalletBookStatsSource(() => walletBook.stats());
  // v11.10: the deployer book — every creator's record (launches / graduations / died fast / rugs), zero RPC.
  const deployerBook = new DeployerBook(redis);
  await deployerBook.load();
  deployerBook.start();
  registry.deployers = deployerBook;
  evaluator.deployers = deployerBook;
  sellManager.deployers = deployerBook;
  setDeployerStatsSource(() => deployerBook.stats());
  // Backfill once per gap (Token rows + rugged positions of the last `backfillDays`), paged + yielding; never blocks startup.
  void (async () => {
    try {
      const dc = getConfig().deployers ?? DEFAULT_CONFIG.deployers;
      if (!dc.enabled) return;
      const startedAtMs = Date.now();
      const since = Math.max(await deployerBook.backfilledUntil(), startedAtMs - dc.backfillDays * 86_400_000);
      const rugged = new Set((await prisma.position.findMany({ where: { exitReason: 'RUG_DETECTED', openedAt: { gte: new Date(since - 86_400_000) } }, select: { mint: true } })).map((p) => p.mint));
      let cursor: string | null = null;
      let rows = 0;
      for (;;) {
        const page: Array<{ mint: string; creator: string; createdAt: Date; completedAt: Date | null; status: string; lastHolderCount: number | null; peakMarketCapSol: number | null }> = await prisma.token.findMany({
          where: { createdAt: { gte: new Date(since), lt: new Date(startedAtMs) } },
          select: { mint: true, creator: true, createdAt: true, completedAt: true, status: true, lastHolderCount: true, peakMarketCapSol: true },
          orderBy: { mint: 'asc' },
          take: 1000,
          ...(cursor ? { cursor: { mint: cursor }, skip: 1 } : {}),
        });
        if (!page.length) break;
        const solUsd = (await getSolUsd().catch(() => null)) ?? 0;
        const batch: BackfillRow[] = page.map((t) => ({
          creator: t.creator, mint: t.mint, createdAtMs: t.createdAt.getTime(), completedAtMs: t.completedAt?.getTime() ?? null,
          rugged: t.status === 'RUGGED' || rugged.has(t.mint), holders: t.lastHolderCount, peakMcUsd: t.peakMarketCapSol && solUsd ? t.peakMarketCapSol * solUsd : null,
        }));
        rows += deployerBook.backfillFrom(batch, startedAtMs);
        cursor = page[page.length - 1]!.mint;
        await new Promise((r) => setImmediate(r));
      }
      await deployerBook.markBackfilled(startedAtMs);
      await deployerBook.persist();
      log.info({ rows, creators: deployerBook.size }, '🏗️ deployer book backfilled');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'deployer backfill failed');
    }
  })();
  // Don't buy the top: stretched charts wait here for a dip + bounce.
  const dips = new DipWatcher(crowd, evaluator);
  evaluator.dips = dips;
  registry.onTradeApplied.push((mint) => dips.onTrade(mint));
  dips.start();
  // New pairs: a fresh coin whose buying heats up is checked at once (not just at checkpoints).
  const newPairs = new NewPairWatcher(crowd, liveState, evaluator);
  registry.onTradeApplied.push((mint) => newPairs.onTrade(mint));
  // Strategy lab: forward-tests exit setups on every BUY signal / near-miss (virtual, no money).
  const lab = new StrategyLab(redis, crowd);
  evaluator.lab = lab;
  registry.onTradeApplied.push((mint) => lab.onTrade(mint));
  lab.start();
  // v11.15 policy tournament: Sniper entry + exit variants trade virtually on the same live candidates.
  const tournament = new Tournament(redis, crowd);
  evaluator.tournament = tournament;
  // v11.16 AI meme-reading for serious candidates (cached, capped, never blocks a buy).
  const memeReader = new MemeReader(redis);
  evaluator.meme = memeReader;
  setMemeStatsSource(async () => {
    const m = await memeReader.snapshot();
    return { enabled: m.enabled, hasKey: m.hasKey, today: m.today, spentTodayUsd: m.spentTodayUsd, budgetUsd: m.budgetUsd };
  });
  registry.onTradeApplied.push((mint) => tournament.onTrade(mint));
  tournament.start();
  // v12 forex lab: hourly candles, every forex strategy backtested + paper traded (no real orders).
  const forex = new ForexLab(redis);
  // v17: what every free data feed did last time (feed health survives restarts)
  await fxFeeds.load(redis);
  forex.start();
  const practice = new Practice(redis);
  practice.start();
  // v17.9 / v17.11: live currency-pair prices → the practice account's checks + the dashboard. Yahoo's streamer (free,
  // no account); Pyth only with an API key (Hermes refuses keyless requests since August 2026)
  yahooLive.start();
  // v17.12: the key pasted on the dashboard (DB) wins over the .env one; an .env key finds its endpoint first
  await loadPythConf();
  if (pythConf().source === 'env') {
    void testPythKey(pythKey()).then((t) => {
      if (t.ok) setPythConf({ key: pythKey(), base: t.base });
      pythLive.restart();
    });
  } else if (pythKey()) pythLive.start();
  const stopLivePush = startLivePush();
  forex.practice = practice;
  const fxCalendar = new ForexCalendar(redis);
  void fxCalendar.start();
  forex.calendar = fxCalendar;
  const fxNews = new ForexHeadlines(redis);
  void fxNews.start();
  forex.headlines = fxNews;
  // v15: the same strategies on 15-minute and 1-minute candles (tested hourly, checked live at every close)
  const fastFx = new FastLab(redis, forex);
  fastFx.start();
  // v17.14: a live read of every open trade + an AI read of its price action every 15 min (display only)
  const tradeWatch = new TradeWatch(practice, new TradeAi(redis), { markets: () => forex.marketsNow, news: (pair, now) => fxCalendar.upcoming(pair, now) });
  tradeWatch.start();
  // Shadow trades: pretend trades on coins it didn't buy (refused / just under the bar / skipped by a rule).
  const shadow = new ShadowTrades(redis, crowd);
  evaluator.shadow = shadow;
  registry.onTradeApplied.push((mint) => shadow.onTrade(mint));
  shadow.start();
  // Learn from every coin it checks, not only its trades (replayed with its own exits 45 min later).
  const coinOutcomes = new OutcomeTracker(redis, (m) => crowd.trades(m));
  evaluator.coinOutcomes = coinOutcomes;
  coinOutcomes.start();
  // Shadow trades the bot would have taken count for the autopsy, the best times and the AI coach too.
  const shadowCfg = () => getConfig().shadow ?? DEFAULT_CONFIG.shadow;
  autopsy.shadowSource = async (since) => (await shadow.results(since)).filter(wouldHaveTaken).map((r) => shadowAsClosed(r, shadowCfg().weight, getConfig().trading.minPositionSol));
  timing.shadowSource = async (since) => (await shadow.results(since)).filter(wouldHaveTaken).map((r) => ({ openedAtMs: r.openedAtMs, pnlPct: r.pnlPct, w: shadowCfg().weight }));
  aiCoach.shadowSource = async (since) => shadow.results(since);
  aiCoach.shadowReport = async (since) => shadow.report(since);
  // The brain: win-probability model, statistical rule search and budget allocator on real + shadow trades.
  // Phone notifications: a trade closed in profit → push to the installed app.
  const stopPush = startPushNotifier();
  // Obsidian vault sync: writes trades as Markdown files when OBSIDIAN_VAULT_PATH is set.
  const obsCfg = getConfig().obsidian ?? DEFAULT_CONFIG.obsidian;
  const obsVaultPath = process.env.OBSIDIAN_VAULT_PATH || obsCfg.vaultPath;
  const obsidian = new ObsidianSync({ enabled: obsCfg.enabled || !!obsVaultPath, vaultPath: obsVaultPath || '' }, {
    closedSince: async (since) => (await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: new Date(since) } },
      select: { strategy: true, realizedPnlSol: true, sizeSol: true, token: { select: { symbol: true } } },
    })).map((p) => ({ symbol: p.token?.symbol ?? null, strategy: p.strategy, pnlSol: p.realizedPnlSol, sizeSol: p.sizeSol })),
    positionFor: async (mint) => {
      const p = await prisma.position.findFirst({ where: { mint, mode: 'PAPER' }, orderBy: { openedAt: 'desc' }, select: { strategy: true, sizeSol: true, openedAt: true, entryContext: true, evaluation: { select: { combinedScore: true } } } });
      return p ? { strategy: p.strategy, sizeSol: p.sizeSol, openedAtMs: p.openedAt.getTime(), score: p.evaluation?.combinedScore ?? null, mcUsd: (p.entryContext as { marketCapUsd?: number } | null)?.marketCapUsd ?? null } : null;
    },
    strategies: () => {
      const a = autopsy.snapshot();
      return a ? a.byStrategy.map((s) => ({ strategy: s.strategy, trades: s.n, winRate: s.winRatePct, avgPnl: s.avgPct, totalPnl: s.pnlSol, verdict: a.cards?.find((k) => k.strategy === s.strategy)?.verdict })) : [];
    },
    insights: async () => (await redis.lrange('ai:insights', 0, 19)).map((s) => { try { const x = JSON.parse(s) as { text: string; at?: string }; return { text: x.text, at: x.at }; } catch { return { text: s }; } }),
    // v11.9 shared brain: wallet classes for the coin / wallet notes, the owner's inbox → tips, the coach's memory + diary.
    walletRec: (w) => walletBook.get(w),
    walletClass: (w) => walletBook.classOf(w),
    topWallets: () => [...walletBook.top('proven', 50).map((x) => ({ wallet: x.wallet, cls: 'proven' as const })), ...walletBook.top('dumper', 50).map((x) => ({ wallet: x.wallet, cls: 'dumper' as const }))],
    tips: () => aiCoach.tips(),
    addTip: (text) => aiCoach.addTip(text),
    changesSince: async (since) => (await recentChanges(60)).filter((c) => Date.parse(c.at) > since),
    incrDaily: async (key) => { const n = await redis.incr(key); if (n === 1) await redis.expire(key, 3 * 86_400); return n; },
    markSeen: async (key, member) => (await redis.sadd(key, member)) === 1,
    memory: () => aiCoach.memory(),
    sniperRules: () => sniperRuleLines(getConfig().sniper ?? DEFAULT_CONFIG.sniper, getConfig().trading.highConviction?.sizeSol ?? 1),
    deployerRec: (c) => deployerBook.get(c),
  });
  void obsidian.start(bus);
  evaluator.obsidian = obsidian;
  aiCoach.ownerNotesSource = () => obsidian.ownerNotes();
  aiCoach.onReview = (e) => obsidian.onReview(e);
  // v11.13 self-improving loop: one proven change a day (AI idea or Bot health), replay-tested, watched, reverted if live disagrees.
  const loopCfg = (): LoopConfig => ({ ...DEFAULT_LOOP, ...((getConfig() as { loop?: Partial<LoopConfig> }).loop ?? {}) });
  const selfLoop = new SelfLoop({
    cfg: loopCfg,
    current: (key) => getPath(getConfig(), key),
    health: () => blockerSnapshot(Date.now(), { ...getConfig().trading.enabledStrategies }),
    proposeAi: (ctx) => aiCoach.proposeOne({ ...ctx, keys: EDITABLE.filter((e) => keyAllowed(e.key, loopCfg()).ok).map((e) => ({ key: e.key, label: `${e.group}: ${e.label}`, min: e.min, max: e.max, now: getPath(getConfig(), e.key) })) }),
    runReplay: (set, fromMs, toMs) => runReplayAndWait({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), policy: 'live', set }),
    replayRunning,
    tapeStartMs: async () => (await prisma.tradeTape.findFirst({ orderBy: { t: 'asc' }, select: { t: true } }))?.t.getTime() ?? null,
    apply: (key, value, source, why) => applyEdit(key, typeof value === 'boolean' ? (value ? 1 : 0) : value, source, why),
    liveTrades: async ({ sinceMs, untilMs, strategy, limit }) => {
      const rows = await prisma.position.findMany({
        where: { mode: 'PAPER', status: 'CLOSED', ...(strategy ? { strategy: strategy as never } : {}), closedAt: { ...(sinceMs ? { gte: new Date(sinceMs) } : {}), ...(untilMs ? { lt: new Date(untilMs) } : {}) } },
        orderBy: { closedAt: 'desc' },
        take: limit ?? 500,
        select: { sizeSol: true, realizedPnlSol: true },
      });
      return rows.reverse().filter((p) => p.sizeSol > 0).map((p) => (p.realizedPnlSol / p.sizeSol) * 100);
    },
    load: () => redis.get(LOOP_STATE_KEY),
    save: async (raw) => void (await redis.set(LOOP_STATE_KEY, raw)),
    liveMode: () => env.TRADING_MODE === 'LIVE' || executor.mode === 'LIVE',
    note: (atMs, title, lines) => obsidian.appendDiary(atMs, title, lines),
    remember: (bullet) => aiCoach.remember(bullet),
  });
  selfLoop.start();
  // Tournament winners are OFFERED to the loop (never applied by the tournament itself).
  tournament.loop = selfLoop;
  const brain = new Brain(redis, (since) => shadow.results(since), aiCoach, (since) => coinOutcomes.results(since));
  brain.outcomeSource = () => coinOutcomes.snapshot();
  brain.exitSource = () => exitTuner.snapshot();
  if ((getConfig().brain ?? DEFAULT_CONFIG.brain).enabled) brain.start();
  evaluator.brain = brain;
  trader.allocFactor = (strategy) => brain.allocFactor(strategy);
  aiCoach.brainSource = () => brain.snapshot(true);
  // Chart strategies (Fibonacci, EMA, breakouts, divergences…) forward-tested live vs random entries;
  // the proven ones get a say in real buys.
  const taLab = new TaLab(redis, crowd, liveState);
  taLab.evaluator = evaluator;
  taLab.dips = dips;
  evaluator.ta = taLab;
  registry.onTradeApplied.push((mint) => taLab.onTrade(mint));
  taLab.start();
  // Trending tabs (pump.fun live / KOTH / for-you / runners, GeckoTerminal, DexScreener narratives):
  // a coin newly on a list is checked at once (never bought just for that) and paper-tested by the lab.
  const trendFeeds = new TrendingFeeds();
  const trending = new TrendingHub(trendFeeds);
  evaluator.trending = trending;
  trendFeeds.onEntry = (source, coin) => {
    trending.sample();
    const tc = getConfig().trending;
    if (!liveState.isTracked(coin.mint) || coin.banned || coin.mayhem) return;
    void liveState
      .read(coin.mint)
      .then(async (view) => {
        if (!view) return;
        const strategy = view.complete ? 'MIGRATION_MOMENTUM' : deriveMetrics(view).bondingCurvePct >= 70 ? 'SOON' : 'CURVE_SNIPE';
        if (tc.checkOnEntry) await evaluator.checkNow(coin.mint, strategy, `trend:${source}`, { bucketSec: 60 });
        if (tc.labOnEntry) await taLab.externalSignal(source.startsWith('pump') ? 'trend_pump' : 'trend_gecko', coin.mint, `new on ${source}`);
      })
      .catch(() => undefined);
  };
  trendFeeds.start();
  trending.start();
  // Swing trading BIGGER coins (watchlist, trending tabs, our own grown coins): follow them live,
  // measure their bounce-back power, buy confirmed dips (owner: "swing more, especially bigger coins").
  const swingUniverse = new SwingUniverse(redis, liveState, registry, dex, trendFeeds, leaders);
  swingUniverse.start();
  // Coins already running (trending lists) that we never saw launch → follow them so the scanners see them.
  const runningCoins = new RunningCoins(liveState, registry, trending, dex);
  runningCoins.start();
  const swingTrader = new SwingTrader(redis, liveState, crowd, swingUniverse, trader, outcomes);
  swingTrader.walletBook = walletBook;
  swingTrader.deployers = deployerBook;
  swingTrader.ta = taLab;
  swingTrader.trending = trending;
  swingTrader.start();
  // Vamps (copycat coins): every coin we buy and every bigger coin becomes the original for its
  // ticker / name; copies are refused everywhere (evaluator, swing trader, and the trader's last gate).
  const vamp = new VampGuard(redis);
  evaluator.vamp = vamp;
  swingTrader.vamp = vamp;
  swingUniverse.vamp = vamp;
  const tokenNames = (mint: string) => prisma.token.findUnique({ where: { mint }, select: { symbol: true, name: true } }).catch(() => null);
  trader.vampCheck = async (req) => {
    const t = await tokenNames(req.mint);
    return t ? vamp.check(req.mint, t.symbol, t.name) : null;
  };
  trader.onEntered = (req) => {
    void tokenNames(req.mint).then((t) => t && vamp.record({ mint: req.mint, symbol: t.symbol, name: t.name, mcUsd: req.market.marketCapUsd ?? null, why: 'traded' }));
  };
  const vampPrune = setInterval(() => void vamp.prune().catch(() => undefined), 30 * 60_000);
  vampPrune.unref();
  // Memory: dead launches (30+ min old, < 10 holders, no trade for 15 min) are forgotten for good —
  // otherwise ~50k of them pile up in memory and Redis (26 h TTL) and the small VPS starts swapping.
  let sweeping = false;
  const deadSweep = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const held = new Set((await prisma.position.findMany({ where: { status: { in: ['OPEN', 'CLOSING'] } }, select: { mint: true } })).map((p) => p.mint));
      const dead = (await liveState.deadMints(30 * 60, 10, 15 * 60)).filter((m) => !held.has(m));
      for (let i = 0; i < dead.length; i++) {
        const meta = liveState.meta(dead[i]!);
        if (meta?.creator) deployerBook.onDead(meta.creator, dead[i]!, Math.max(0, Date.now() / 1000 - meta.createdSec), 0);
        await liveState.forget(dead[i]!);
        if (i % 200 === 199) await new Promise((r) => setImmediate(r));
      }
      if (dead.length) log.info({ forgotten: dead.length, tracked: liveState.trackedCount }, '🧹 forgot dead launches');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'dead-launch sweep failed');
    } finally {
      sweeping = false;
    }
  }, 5 * 60_000);
  deadSweep.unref();
  // Coins traded in the last 3 days (before the guard existed) count as originals too — oldest first.
  void prisma.position
    .findMany({ where: { openedAt: { gte: new Date(Date.now() - 3 * 86_400_000) } }, orderBy: { openedAt: 'asc' }, select: { mint: true, entryContext: true, token: { select: { symbol: true, name: true } } } })
    .then(async (rows) => {
      for (const r of rows) await vamp.record({ mint: r.mint, symbol: r.token.symbol, name: r.token.name, mcUsd: Number((r.entryContext as { marketCapUsd?: number } | null)?.marketCapUsd ?? 0) || null, why: 'traded' });
    })
    .catch(() => undefined);
  // Exits react to every trade on a coin we hold (not just the 1s tick); real trade highs count as peaks.
  sellManager.crowd = crowd;
  // Market mood (SOL's own trend + Fear & Greed) — stored on every evaluation for the learners; changes no trade.
  startMarketMood(redis);
  // Two-step buys: the second half is bought (or cancelled) by the trader when the sell manager says so.
  sellManager.scaleIn = (id, action, why, px) => trader.scaleInLeg(id, action, why, px);
  registry.onTradeApplied.push((mint) => sellManager.onTrade(mint));
  registry.startSafetyWorker();
  // Copy trading: watch the wallets you added on the dashboard.
  const whales = new WhaleTracker(redis, liveState, evaluator);
  whales.onAdopt = (ev) => registry.adopt(ev);
  // The copied wallet sold a coin we hold → check our positions in it right now (mirror sell).
  whales.onCopySold = (mint) => sellManager.onTrade(mint);
  // Several KOLs (Cupsey, Cented…) bought the same coin → check it now.
  whales.onKolCluster = (mint, kols) => {
    const why = `kols:${kols}`;
    // KOL follow: its own trade, whatever the coin's stage (the other strategies are checked too).
    void evaluator.scheduleKolFollow(mint, kols).catch(() => undefined);
    void liveState
      .isComplete(mint)
      .then(async (done) => {
        if (done) return evaluator.checkNow(mint, 'MIGRATION_MOMENTUM', why);
        await evaluator.checkNow(mint, 'SOON', why);
        await evaluator.checkNow(mint, 'CURVE_SNIPE', why);
      })
      .catch(() => undefined);
  };

  // 4. Live data sources
  const { ws } = rpcEndpoints();
  const sources: Array<{ stop(): Promise<void> }> = [];
  let portalRef: PumpPortalListener | null = null;
  let logsRef: PumpFunListener | null = null;
  let grpcRef: GrpcListener | null = null;
  let backupRef: PumpFunListener | null = null;

  const startPortal = (followTrades: boolean) => {
    const portal = new PumpPortalListener(env.PUMPPORTAL_API_KEY ? `wss://pumpportal.fun/api/data?api-key=${env.PUMPPORTAL_API_KEY}` : undefined);
    portal.on('event', (e) => {
      if (followTrades && e.event.kind === 'create') portal.watch(e.event.mint);
      registry.handle(e);
      whales.onEvent(e);
    });
    if (followTrades) {
      whales.onWalletsChanged = (list) => portal.watchAccounts(list);
      whales.onWatchToken = (m) => portal.watch(m);
      for (const m of liveState.trackedMints()) portal.watch(m);
      liveState.onForget.push((m) => portal.unwatch(m));
      // Stop streaming trades for dead launches (20+ min old, < 10 holders).
      const dormant = new Set<string>();
      setInterval(async () => {
        try {
          for (const m of await liveState.dormantMints(20 * 60, 10)) {
            if (dormant.has(m)) continue;
            dormant.add(m);
            portal.unwatch(m);
          }
          if (dormant.size > 100_000) dormant.clear();
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'dormant sweep failed');
        }
      }, 60_000).unref();
    }
    portal.start();
    sources.push(portal);
    portalRef = portal;
  };

  const startLogs = (url: string, fetchMissingCreates: boolean, programs: 'all' | 'curve' | 'amm' = 'all', start = true) => {
    const l = new PumpFunListener(url, fetchMissingCreates, programs);
    l.on('event', registry.handle);
    l.on('event', whales.onEvent);
    if (start) l.start();
    sources.push(l);
    logsRef = l;
    return l;
  };

  /**
   * Free-feed watchdog (owner: "no coins checked for hours", 0 paid credits): a free trade stream that delivers
   * nothing for 2 minutes gets a fresh socket; after 2 restarts in a row that didn't help it switches to
   * TRADES_WS_URL_BACKUP (if set) and back. Never touches paid streams.
   */
  const watchFreeFeed = (l: PumpFunListener, name: string) => {
    let since = Date.now();
    let fails = 0;
    setInterval(() => {
      const now = Date.now();
      if (now - Math.max(l.stats.lastEventAt ?? 0, since) < 120_000) {
        fails = 0;
        return;
      }
      fails++;
      const urls = [env.TRADES_WS_URL, env.TRADES_WS_URL_BACKUP].filter(Boolean);
      const next = fails >= 3 && urls.length > 1 ? urls[(urls.indexOf(l.url) + 1) % urls.length] : undefined;
      if (next) fails = 0;
      since = now;
      log.warn({ feed: name, switchTo: next ? redactUrl(next) : undefined }, 'free trade stream silent for 2 min — restarting it');
      void recordEvent({ level: 'WARN', module: 'scanner', type: 'feed_restart', message: `${name} trade stream silent for 2 min — restarted${next ? ' on the backup node' : ''}` });
      void l.restart(next);
    }, 30_000).unref();
  };

  // Paid feed pasted on the dashboard (stored in this server's DB only) wins over .env.
  const feed = effectiveFeed(await loadFeedSettings(), env);
  setActiveFeed(feed);
  if (!env.ENABLE_SCANNER) {
    log.warn('scanner disabled (ENABLE_SCANNER=false)');
  } else if (feed.dataSource === 'hybrid') {
    // Launches + migrations from PumpPortal, every trade from Solana's public node. Both free.
    startPortal(false);
    if (feed.tradesWsUrl !== env.TRADES_WS_URL) {
      // A paid node bills every message: give it MIGRATED coins only (PumpSwap, far fewer messages than the curve);
      // bonding-curve coins stay on the free node.
      const curve = startLogs(env.TRADES_WS_URL, false, 'curve');
      backupRef = startLogs(feed.tradesWsUrl, false, 'amm');
      logsRef = curve;
      watchFreeFeed(curve, 'curve');
      log.info({ trades: redactUrl(feed.tradesWsUrl) }, 'data source: hybrid — paid node for migrated coins only, free node for curve coins');
    } else {
      const l = startLogs(feed.tradesWsUrl, false);
      if (feed.tradesWsUrl === env.TRADES_WS_URL) watchFreeFeed(l, 'main');
      log.info({ trades: redactUrl(feed.tradesWsUrl) }, 'data source: hybrid (PumpPortal launches + trade stream)');
    }
  } else if (feed.dataSource === 'grpc' && feed.grpcEndpoint) {
    // Paid Yellowstone gRPC stream = MIGRATED coins only (PumpSwap) — the expensive, important part. Bonding-curve coins
    // (new pairs, Soon, runners, curve coins we hold) come from Solana's FREE public node. The paid WebSocket is never
    // used here (it bills every message). If gRPC drops, a free PumpSwap stream fills in until it's back.
    startPortal(false);
    const curve = startLogs(env.TRADES_WS_URL, false, 'curve');
    const ammBackup = startLogs(env.TRADES_WS_URL, false, 'amm', false);
    logsRef = curve;
    watchFreeFeed(curve, 'curve');
    const g = new GrpcListener(feed.grpcEndpoint, feed.grpcToken);
    g.on('event', registry.handle);
    g.on('event', whales.onEvent);
    let backupTimer: NodeJS.Timeout | null = null;
    let backupOn = false;
    g.on('connected', () => {
      if (backupTimer) clearTimeout(backupTimer);
      backupTimer = null;
      if (backupOn) void ammBackup.stop();
      backupOn = false;
      log.info('gRPC stream up (migrated coins) — free backup paused');
    });
    g.on('disconnected', () => {
      backupTimer ??= setTimeout(() => {
        backupTimer = null;
        if (!g.connected && !backupOn) {
          ammBackup.start();
          backupOn = true;
          log.warn('gRPC stream down for 10s — free PumpSwap backup on');
        }
      }, 10_000);
    });
    g.start();
    sources.push(g);
    grpcRef = g;
    backupRef = ammBackup;
    log.info({ endpoint: redactUrl(feed.grpcEndpoint) }, 'data source: gRPC for migrated coins + free node for curve coins');
  } else if (feed.dataSource === 'grpc') {
    log.error('DATA_SOURCE=grpc but GRPC_ENDPOINT is empty — using the free trade stream instead');
    startPortal(false);
    startLogs(feed.tradesWsUrl, false);
  } else if (feed.dataSource === 'pumpportal') {
    startPortal(true);
    log.info('data source: PumpPortal only');
  } else if (!ws) {
    log.error('no WebSocket endpoint — set HELIUS_API_KEY in .env. Scanner not started.');
  } else {
    startLogs(ws, true);
    log.warn('data source: Helius logsSubscribe — this uses a lot of Helius credits');
  }

  /** Combined view of all sources for stats + dashboard. */
  const statsOf = (): ListenerStats | null => {
    const l0 = (logsRef as PumpFunListener | null)?.stats;
    const bk = (backupRef as PumpFunListener | null)?.stats;
    // curve stream + its PumpSwap backup add up (each counts only what it delivered)
    const l = l0 && bk ? { ...l0, connected: l0.connected, reconnects: l0.reconnects + bk.reconnects, notifications: l0.notifications + bk.notifications, creates: l0.creates + bk.creates, trades: l0.trades + bk.trades, completes: l0.completes + bk.completes, ammPools: l0.ammPools + bk.ammPools, ammTrades: l0.ammTrades + bk.ammTrades, decodeErrors: l0.decodeErrors + bk.decodeErrors, truncatedLogs: l0.truncatedLogs + bk.truncatedLogs } : l0;
    const g = (grpcRef as GrpcListener | null)?.stats;
    // gRPC + its backup: counters add up (each only counts what it delivered), connected if either is.
    const a: ListenerStats | undefined =
      l && g
        ? { ...g, connected: g.connected || l.connected, reconnects: g.reconnects + l.reconnects, notifications: g.notifications + l.notifications, creates: g.creates + l.creates, trades: g.trades + l.trades, completes: g.completes + l.completes, ammPools: g.ammPools + l.ammPools, ammTrades: g.ammTrades + l.ammTrades, decodeErrors: g.decodeErrors + l.decodeErrors, truncatedLogs: g.truncatedLogs + l.truncatedLogs, lastEventAt: Math.max(g.lastEventAt ?? 0, l.lastEventAt ?? 0) || null }
        : (g ?? l);
    const b = (portalRef as PumpPortalListener | null)?.stats;
    if (!a && !b) return null;
    if (!a || !b) return (a ?? b)!;
    return {
      ...a,
      connected: a.connected && b.connected,
      creates: Math.max(a.creates, b.creates),
      completes: Math.max(a.completes, b.completes),
      reconnects: a.reconnects + b.reconnects,
      decodeErrors: a.decodeErrors + b.decodeErrors,
      notifications: a.notifications + b.notifications,
    };
  };

  await whales.start();
  // v15.4: the copy test re-runs every night so "consistent" follows what the copied wallets do now
  const nightlyCopy = startNightlyCopyTest(redis, () => getConfig().copy.nightlyTest ?? DEFAULT_CONFIG.copy.nightlyTest);
  const spikeTimer = startSpikeWatcher(liveState, evaluator);
  // Saves each open position's price every 5s (Redis) for the dashboard chart.
  startPositionHistory();
  const xTimer = startXWatcher(redis, (word, mints) => {
    for (const m of mints) void evaluator.checkNow(m, 'CURVE_SNIPE', `x:${word}`);
  });

  // 5. Dashboard API + WebSocket
  const startedAt = Date.now();
  const api = await startApi({ liveState, executor, listenerStats: statsOf, startedAt, sellManager, dex, leaders, walletPnl, dips, crowd, lab, taLab, trending, swing: { universe: swingUniverse, trader: swingTrader }, autopsy, aiCoach, timing, shadow, brain, tape: tapeRecorder, walletBook, deployers: deployerBook, selfLoop, tournament, meme: memeReader, forex, fastFx, practice, fxCalendar, fxNews, tradeWatch }).catch((err: Error) => {
    log.error({ err: err.message }, 'dashboard API failed to start — bot keeps running without it');
    return null;
  });
  const pushTimer = setInterval(() => {
    const s = statsOf();
    bus.publish({ type: 'stats', data: { connected: s?.connected ?? false, launches: s?.creates ?? 0, trades: s?.trades ?? 0, tracked: liveState.trackedCount, uptimeSec: Math.round((Date.now() - startedAt) / 1000) } });
  }, 5_000);

  // Heartbeat line every minute so you can see it's alive at a glance.
  let lastCreates = 0;
  let lastTrades = 0;
  let lastAmm = 0;
  let lastCompletes = -1;
  let lastEvaluated = 0;
  let stallMin = 0;
  const CHECKER_STALL_MIN = 20;
  const statsTimer = setInterval(async () => {
    const s = statsOf();
    const [balance, openPositions] = await Promise.all([
      executor.getBalanceSol().catch(() => NaN),
      prisma.position.count({ where: { status: 'OPEN', mode: executor.mode } }).catch(() => -1),
    ]);
    log.info(
      {
        connected: s?.connected ?? false,
        launchesPerMin: (s?.creates ?? 0) - lastCreates,
        tradesPerMin: (s?.trades ?? 0) - lastTrades,
        totalLaunches: s?.creates ?? 0,
        completes: s?.completes ?? 0,
        tracked: liveState.trackedCount,
        snapshots: observations?.snapshotsWritten ?? 0,
        decodeErrors: s?.decodeErrors ?? 0,
        reconnects: s?.reconnects ?? 0,
        rpcQueue: rpcLimiter.pending,
        avgLatencyMs: Math.round(registry.stats.latencyMsAvg),
        ammTradesPerMin: (s?.ammTrades ?? 0) - lastAmm,
        ...(portalRef ? { watching: (portalRef as PumpPortalListener).watchedCount, portalMsgs: { ...(portalRef as PumpPortalListener).seen } } : {}),
        evaluated: evaluator.stats.evaluated,
        buySignals: evaluator.stats.buys,
        walletLookups: evaluator.stats.walletLookups,
        openPositions,
        [`${executor.mode.toLowerCase()}BalanceSol`]: +balance.toFixed(4),
      },
      '📊 stats',
    );
    // (first minute after a start has no baseline → not recorded)
    if (lastCompletes >= 0) {
      void timing
        .recordMinute({ trades: (s?.trades ?? 0) - lastTrades, ammTrades: (s?.ammTrades ?? 0) - lastAmm, launches: (s?.creates ?? 0) - lastCreates, migrations: Math.max(0, (s?.completes ?? 0) - lastCompletes) })
        .catch(() => undefined);
    }
    // v18.2 checker watchdog (owner: 52 coins checked in 7 hours while the stream ran at 7,500 trades/min): the trade
    // stream flows (launches arrive) but the evaluator scores (almost) nothing for CHECKER_STALL_MIN minutes in a row →
    // WARN event + a clean exit, so Docker brings a fresh process instead of a stuck one sitting there for hours.
    const launchesNow = (s?.creates ?? 0) - lastCreates;
    const evalNow = evaluator.stats.evaluated - lastEvaluated;
    lastEvaluated = evaluator.stats.evaluated;
    if (launchesNow >= 10 && evalNow === 0) stallMin++;
    else stallMin = 0;
    if (stallMin >= CHECKER_STALL_MIN) {
      log.error({ stallMin, launchesNow }, 'coin checker stalled while the stream flows — restarting the bot');
      void recordEvent({ level: 'WARN', module: 'evaluator', type: 'checker_stalled', message: `no coin scored for ${stallMin} min while ${launchesNow} launches/min arrived — the bot restarted itself` }).catch(() => undefined);
      setTimeout(() => void shutdown('checker stalled'), 2_000);
      stallMin = -1_000_000; // once
    }
    lastCreates = s?.creates ?? 0;
    lastAmm = s?.ammTrades ?? 0;
    lastTrades = s?.trades ?? 0;
    lastCompletes = s?.completes ?? 0;
  }, 60_000);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down…');
    clearInterval(statsTimer);
    clearInterval(pushTimer);
    const force = setTimeout(() => process.exit(1), 15_000); // don't hang forever
    try {
      await api?.close();
      for (const src of sources) await src.stop();
      whales.stop();
      clearInterval(nightlyCopy);
      nightly.stop();
      stopBeliefCache();
      clearInterval(regimeTimer);
      clearInterval(spikeTimer);
      stopPositionHistory();
      if (xTimer) clearInterval(xTimer);
      coach.stop();
      dex.stop();
      leaders.stop();
      walletPnl.stop();
      await walletBook.stop();
      await deployerBook.stop();
      dips.stop();
      lab.stop();
      tournament.stop();
      forex.stop();
      fastFx.stop();
      practice.stop();
      tradeWatch.stop();
      pythLive.stop();
      yahooLive.stop();
      stopLivePush();
      await fxFeeds.persist(redis, true).catch(() => undefined);
      fxCalendar.stop();
      fxNews.stop();
      shadow.stop();
      brain.stop();
      stopPush();
      obsidian.stop();
      liveReconciler?.stop();
      selfLoop.stop();
      await tapeRecorder.stop();
      usageBudget.stop();
      taLab.stop();
      trendFeeds.stop();
      trending.stop();
      swingTrader.stop();
      swingUniverse.stop();
      clearInterval(vampPrune);
      clearInterval(deadSweep);
      stopCalibration();
      swings.stop();
      crowd.stop();
      await outcomes.stop();
      await evaluator.stop();
      await sellManager.stop();
      stopConfigRefresh();
      await registry.stop();
      await observations?.stop();
      await closeQueues();
      await recordExit(`clean stop (${signal}) — restart or update`);
      await closeRedis();
      await prisma.$disconnect();
      log.info('bye 👋');
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  log.fatal({ err: err.message }, 'failed to start');
  process.exit(1);
});
