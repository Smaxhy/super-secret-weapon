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
import { mondayOf, weeklyLog, weekText } from './forex/pnl';
import { chosenAt, WeekendReview, type WeekendDeskDef } from './forex/weekend';
import { staleReason } from './forex/freshness';
import { runKojiroStudy } from './forex/kojiro-study';
import { COPIER_HB, DISCORD_COPY, copierDown, handleSignal, loadHeartbeat, loadLevels, savePosted } from './forex/discord';
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
import { ForexLab, FX_CHOSEN_HIST, FX_PREP } from './forex/lab';
import type { PrepReport } from './forex/prep';
import { feeds as fxFeeds } from './forex/feeds';
import { FastLab } from './forex/fast';
import { ledgerRows, Practice } from './forex/practice';
import { loadPythConf, pythConf, pythKey, pythLive, setPythConf, testPythKey } from './forex/pyth';
import { yahooLive } from './forex/yahoo-live';
import { coinbaseLive, fetchCoinbaseFast } from './forex/coinbase';
import { HL_FUTURES_KEY, hyperliquidLive } from './forex/hyperliquid';
import { INSTRUMENTS, isFutures } from './forex/types';
import { LevelWatch, replayMissedLevels } from './forex/level-watch';
import { VENUE_FEES } from './forex/venue-fees';
import { startLivePush } from './forex/live-push';
import { ForexCalendar, marketClock } from './forex/calendar';
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
import { checkerVerdict, recordError, recordExit, recordStart, setCheckerStatsSource, setDeployerStatsSource, setMemeStatsSource, setTapeStatsSource, setWalletBookStatsSource, type CheckerStats, type QueueCounts } from './lib/bot-health';
import { CHECKER_WATCH, checkerStalled, restartAllowed, type WatchMinute } from './lib/checker-watch';
import { prisma } from './lib/prisma';
import { setLastEntryAt } from './lib/entry-blockers';
import { closeQueues, evaluateQueue, safetyQueue } from './lib/queues';
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
  coinbaseLive.start();
  hyperliquidLive.onDiscover = (found) => void redis.set(HL_FUTURES_KEY, JSON.stringify(found)).catch(() => undefined); // v27.52: for the labs' live candles
  // v27.75 (owner: "the live price updating is being delayed"): say once per change which futures markets have a live
  // Hyperliquid price and which still run on Yahoo's ~10-minute-late CME price
  {
    let lastSig = '';
    hyperliquidLive.onMarkets = (found, unknown) => {
      const late = INSTRUMENTS.filter((x) => isFutures(x.id) && !found[x.id]).map((x) => x.id);
      const sig = `${Object.entries(found).sort().join(',')}|${late.join(',')}`;
      if (sig === lastSig) return;
      lastSig = sig;
      forex.logBot([`live prices: ${Object.entries(found).map(([id, c]) => `${id} ← Hyperliquid ${c}`).join(', ') || 'no Hyperliquid index / metal market found'}${late.length ? ` · still ~10 min late (Yahoo): ${late.join(', ')}` : ''}${late.length && unknown.length ? ` · other index-like markets there: ${unknown.join(', ')}` : ''}`]);
    };
  }
  hyperliquidLive.start();
  // v17.12: the key pasted on the dashboard (DB) wins over the .env one; an .env key finds its endpoint first
  await loadPythConf();
  if (pythConf().source === 'env') {
    void testPythKey(pythKey()).then((t) => {
      if (t.ok) setPythConf({ key: pythKey(), base: t.base });
      pythLive.restart();
    });
  } else if (pythKey()) pythLive.start();
  const stopLivePush = startLivePush();
  // v27.75 (owner: "the profits are delayed, not only the chart"): Nasdaq / S&P / gold tick on the dashboard too — the
  // Hyperliquid builder market's move, shifted onto the futures price by the measured gap (the account's own price)
  const stopFutPush = startLivePush({
    onTicks: (fn) => hyperliquidLive.onFutTicks((ts) => {
      const out = ts.map((t) => practice.liveFutTick(t.id)).filter((t): t is NonNullable<typeof t> => !!t);
      if (out.length) fn(out);
    }),
  });
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
  // v22.1 (owner: "change the crypto bot from memecoins to liquid real coins with real strategies"): a second lab of the
  // same engine on BTC / ETH / SOL — its own report (`cm:…`), its own bot account ('cbot'), its own pages. The forex
  // lab never sees a coin; the coin lab shares only the bars, feeds, calendar and headlines.
  const cryptoLab = new ForexLab(redis, 'crypto');
  cryptoLab.practice = practice;
  cryptoLab.calendar = fxCalendar;
  cryptoLab.headlines = fxNews;
  cryptoLab.start();
  const fastCrypto = new FastLab(redis, cryptoLab);
  fastCrypto.start();
  // v27.52 (owner: "copy his trades immediately, or 1–2 minutes later"): Kojiro's levels watched on live 1-minute candles
  const levelWatch = new LevelWatch(redis, practice, (_pair, lines) => forex.logBot(lines));
  levelWatch.start();
  // v27.32 (owner: "recap the past week and think how to improve all weekend, be ready Monday"): the weekend review per desk
  const deskOf = (lab: ForexLab, fast: FastLab): WeekendDeskDef => ({
    universe: lab.universe,
    k: lab.k,
    // v27.33: before the forex open, fresh prices + a full re-test so Monday's first look starts warm
    ...(lab.universe === 'fx' ? { warmUp: async () => {
      await lab.run(true);
      await fast.evaluate();
    } } : {}),
    gather: async (now) => {
      const [report, account, pnl, lossRaw, shadowRaw, histRaw, prepRaw] = await Promise.all([
        lab.last(),
        practice.rawAccount(lab.acct).catch(() => null),
        practice.pnlRows(lab.acct).catch(() => []),
        redis.get(lab.k('fx:lossrev')).catch(() => null),
        redis.get(lab.k('fx:shadow')).catch(() => null),
        redis.lrange(lab.k(FX_CHOSEN_HIST), 0, 499).catch(() => [] as string[]),
        redis.get(lab.k(FX_PREP)).catch(() => null),
      ]);
      if (!report) return null;
      const js = <T,>(raw: string | null, d: T): T => {
        try {
          return raw ? (JSON.parse(raw) as T) : d;
        } catch {
          return d;
        }
      };
      const weeks = weeklyLog(pnl, 0, {}, 4);
      const monday = mondayOf(new Date(now).toISOString().slice(0, 10));
      const prevMonday = new Date(Date.parse(`${monday}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
      const hist = histRaw.map((h) => js<{ t: number; keys: string[] } | null>(h, null)).filter((h): h is { t: number; keys: string[] } => !!h && Array.isArray(h.keys));
      const equity = account ? await practice.snapshot(lab.acct).then((x) => x.account.equityUsd).catch(() => account.balanceUsd) : null;
      const ran = report.at ?? null;
      return {
        universe: lab.universe,
        now,
        week: weeks.find((w) => w.week === monday) ?? null,
        prevWeek: weeks.find((w) => w.week === prevMonday) ?? null,
        ledger: account ? ledgerRows(account) : [],
        rows: report.rows ?? [],
        chosen: lab.chosen,
        chosenAtStart: chosenAt(hist, Date.parse(`${monday}T00:00:00Z`)),
        proven: lab.proven,
        dropped: lab.dropped,
        losses: js(lossRaw, []),
        shadow: js(shadowRaw, []),
        events: fxCalendar.get().events,
        prep: js<PrepReport | null>(prepRaw, null),
        ready: {
          labRanAt: ran,
          labError: lab.lastError?.msg ?? null,
          staleMarkets: Object.values(lab.dataAge).filter((a) => staleReason(a, now)).map((a) => a.id),
          openPositions: account?.open.length ?? 0,
          riskMode: account?.riskMode ?? 'normal',
          equityUsd: equity,
          opensInMin: null,
        },
      };
    },
  });
  const weekendReview = new WeekendReview(redis, [deskOf(forex, fastFx), deskOf(cryptoLab, fastCrypto)], marketClock, (universe, text, ok) =>
    bus.publish({ type: 'fxTrade', data: { kind: 'ready', pair: '', side: 1, pnlUsd: 0, reason: text, acct: universe === 'fx' ? 'bot' : 'cbot', ok } }),
  );
  weekendReview.start();
  // v18.8 (owner): the two 1-minute trades never happened — strike every 1-minute trade from the bot account once
  await oneTimeUpgrade('v18.8-undo-1m', async () => {
    const line = await practice.undoChart('bot', '1m');
    forex.logBot([line]);
    log.info({ line }, 'forex bot: 1-minute trades struck');
  });
  // v27.21 (owner: "if it was a bug revert the last 3 losses"): the three coin mss_sweep 15m shorts the missing
  // losing-market check let through on Oct 21 (BTC / ETH / DOGE, −$79) are struck from the coin bot once
  await oneTimeUpgrade('v27.21-undo-mss-15m', async () => {
    const from = Date.UTC(2026, 9, 21, 0);
    const to = Date.UTC(2026, 9, 21, 14);
    const pairs = new Set(['BTCUSD', 'ETHUSD', 'DOGEUSD']);
    const line = await practice.undoClosed('cbot', (c) => c.strategy === 'mss_sweep' && (c.tf ?? '') === '15m' && pairs.has(c.pair) && c.closedAt >= from && c.closedAt < to && c.pnlUsd < 0, 'coin bot: the 3 mss_sweep 15m losses a missing check let through');
    cryptoLab.logBot([line]);
    log.info({ line }, 'coin bot: mss_sweep losses struck');
  });
  // v27.21 (owner: "needs to be added onto the PnL"): the $79.37 those three struck losses gave back shows on TODAY's P&L,
  // not on Oct 21 — two correction rows (Oct 21 −79.37, today +79.37); balance and all-time unchanged
  await oneTimeUpgrade('v27.21-mss-credit-today', async () => {
    const row = (id: string, t: number, usd: number) => ({ id, t, usd, pair: 'BTCUSD', side: -1 as const, strategy: 'mss_sweep', tf: '15m', reason: 'adjust', entry: 0, exit: 0, openedAt: null });
    await practice.bookAdjust('cbot', [row('adjust-mss-1021', Date.UTC(2026, 9, 21, 13, 0, 1), -79.37), row('adjust-mss-today', Date.now(), 79.37)]);
    cryptoLab.logBot(['coin bot: the $79.37 from the struck mss_sweep losses now shows on today\'s P&L (correction rows)']);
  });
  // v27.22 (owner: "take away the trade that's −60 right now, don't make it count"): the forex NZDUSD pivot_bounce 4h long
  // that opened before the forex bot had the $20 cap is struck as if it never happened (and never re-opened)
  await oneTimeUpgrade('v27.22-undo-nzd-pivot', async () => {
    const since = Date.UTC(2026, 9, 22, 18);
    const nzd = (p: { pair: string; strategy?: string | null; side: number; openedAt: number }) => p.pair === 'NZDUSD' && p.strategy === 'pivot_bounce' && p.side === 1 && p.openedAt >= since;
    const label = 'forex bot: the NZDUSD pivot_bounce trade opened before the $20 cap';
    // still open → strike it; already closed (the cap deploy can close it at market first) → strike the close
    const lines = [await practice.undoPositions('bot', nzd, label), await practice.undoClosed('bot', nzd, label)];
    forex.logBot(lines);
    log.info({ lines }, 'forex bot: NZDUSD trade struck');
  });
  // v27.29 (owner: "only trade rsi, revert the results from today"): every coin-bot trade closed today (Oct 23 UTC) that
  // wasn't rsi_dip is struck from the account and the P&L log, and the still-open trades of strategies now off are struck too
  await oneTimeUpgrade('v27.29-undo-coin-oct23', async () => {
    const from = Date.UTC(2026, 9, 23, 0);
    const to = Date.UTC(2026, 9, 24, 0);
    const label = 'coin bot: today\'s non-rsi_dip results (owner: only rsi_dip trades now)';
    const lines = [
      await practice.undoClosed('cbot', (c) => c.strategy !== 'rsi_dip' && c.closedAt >= from && c.closedAt < to, label),
      await practice.undoPositions('cbot', (p) => p.strategy !== 'rsi_dip', 'coin bot: open trades of strategies that are now off'),
    ];
    cryptoLab.logBot(lines);
    log.info({ lines }, 'coin bot: today struck');
  });
  // v27.42 (owner: "the coin bot trades way too much and too risky … revert all trades till the point where it made 60+,
  // cancel all current trades"): today (owner's clock, from 22:00 UTC) peaked at +$63.09 right after the LINK stoch_trend
  // close at 06:00 UTC on Oct 25; the burst after it (15m / 1h shorts, three −$20 cap stops) gave back $39. Every coin-bot
  // close after that point and every open coin-bot trade is struck as if it never happened; their signals never re-open.
  await oneTimeUpgrade('v27.42-undo-coin-after-peak', async () => {
    const from = Date.UTC(2026, 9, 25, 6, 0);
    const lines = [
      await practice.undoClosed('cbot', (c) => c.closedAt >= from && !(c.pair === 'LINKUSD' && c.strategy === 'stoch_trend'), 'coin bot: trades after today\'s +$63 peak (owner)'),
      await practice.undoPositions('cbot', () => true, 'coin bot: open trades cancelled (owner)'),
      'coin bot: at most 15 new trades a day and 3 in any hour from now on (owner)',
    ];
    cryptoLab.logBot(lines);
    log.info({ lines }, 'coin bot: reverted to the +$60 point');
  });
  // v27.58 (owner: "adjust the current live trade as if it has 20%"): the Kojiro copies open at deploy were sized at 2% /
  // the $20 cap; they are re-sized once as if they had opened at the new 20% (same entry and original stop, more units)
  await oneTimeUpgrade('v27.58-resize-kojiro', async () => {
    for (const [acct, lab] of [['bot', forex], ['cbot', cryptoLab]] as const) {
      const lines = await practice.resizeCopies(acct, DISCORD_COPY.riskPct);
      if (lines.length) {
        lab.logBot(lines.map((l) => `Kojiro copy: ${l} (owner: 20% on his calls)`));
        log.info({ acct, lines }, 'Kojiro copies re-sized');
      }
    }
  });
  // v27.60 (owner: "just revert exiting and put it at 20% instead of 1, enter it where you were earlier and continue the
  // trade"): his NQ long (copied 01:34 UTC Oct 27 at 29,486) was closed at 01:51 by the copy's profit lock, not by him.
  // The close is struck and the trade put back as it was — same entry, original stop 29,338.57, no profit lock — at 20%.
  // (v27.59's market re-entry is dropped; if it already opened one, that one is struck first.)
  await oneTimeUpgrade('v27.60-revive-kojiro-nq', async () => {
    const ref = 'discord_kojiro:signal:NDXUSD:1564452300599066716';
    const lines = [
      ...(await practice.rawAccount('bot')).open.some((p) => p.ref?.startsWith(`${ref}:re`)) ? [await practice.undoPositions('bot', (p) => !!p.ref?.startsWith(`${ref}:re`), 'Kojiro copy: the v27.59 market re-entry')] : [],
      ...(await practice.reviveCopy('bot', ref, DISCORD_COPY.riskPct)),
    ];
    forex.logBot(lines.map((l) => (l.startsWith('Kojiro') ? l : `Kojiro copy: ${l} (owner)`)));
    log.info({ lines }, 'Kojiro NQ copy put back');
  });
  // v27.61 (owner: "trailing SL on his calls is fine, just not too tight early on"): open Kojiro calls without a lock get
  // the looser copy lock (after v27.60, so the put-back NQ long gets it too)
  await oneTimeUpgrade('v27.61-relock-kojiro', async () => {
    const lines = await practice.relockCopies('bot');
    if (lines.length) forex.logBot(lines.map((l) => `Kojiro copy: ${l} (owner)`));
  });
  // v27.62 (owner: "revert the trade as if it never happened"): his NQ long (posted 29,470, copied 01:34 UTC Oct 27, put back
  // at 20% by v27.60) is struck from the bot account — open or closed, every leg and any re-entry of it — balance, record
  // and P&L log as if it never happened
  await oneTimeUpgrade('v27.62-strike-kojiro-nq', async () => {
    const ref = 'discord_kojiro:signal:NDXUSD:1564452300599066716';
    const mine = (p: { ref?: string }) => !!p.ref && (p.ref === ref || p.ref.startsWith(`${ref}:`));
    const label = 'Kojiro copy: his NQ long of Oct 27 (owner: as if it never happened)';
    const lines = [await practice.undoPositions('bot', mine, label), await practice.undoClosed('bot', mine, label)];
    forex.logBot(lines);
    log.info({ lines }, 'Kojiro NQ copy struck');
  });
  // v27.63 (owner pasted Kojiro's daily plan; it never reached the copier — posted in a channel it doesn't read):
  // saved once by hand through the same path as a Discord post → NDXUSD bias bullish, DOL 29,713.75 (valid 24 h)
  await oneTimeUpgrade('v27.63-kojiro-plan-oct27', async () => {
    const text = '📅 27/10/2026\nBias: bullish\nDOL: 29,713.75\nNarrative: I want to see a manipulation to the downside, and then try to long off my levels';
    const row = await handleSignal(redis, practice, { id: 'owner-paste-plan-2026-10-27', text, at: Date.parse('2026-10-27T14:25:00Z'), source: 'kojiro' });
    forex.logBot([`Discord (kojiro, pasted by the owner): ${row.what}`]);
    log.info({ row }, 'Kojiro plan saved by hand');
  });
  // v27.64 (owner: "Short Levels … do the levels that were said, don't miss out"): his 14:55 "Short Levels" post had replaced
  // his 13:24 levels (one list per market then) → both put back: the 13:24 list = his long levels (bias bullish, DOL), the
  // 14:55 list = shorts only
  await oneTimeUpgrade('v27.64-kojiro-short-levels-oct27', async () => {
    const t13 = Date.parse('2026-10-27T13:24:40Z');
    const t14 = Date.parse('2026-10-27T14:55:13Z');
    await savePosted(redis, 'NDXUSD', { levels: [29562.25, 29431.25, 29418.75, 29383.75, 29305], t: t13, msgId: '1564630918029647943', source: 'kojiro' }, true);
    await savePosted(redis, 'NDXUSD', { levels: [29783, 29765, 29736.25, 29727.75, 29713.75], t: t14, msgId: '1564653704878231745', source: 'kojiro', side: -1 }, true);
    const lv = (await loadLevels(redis)).NDXUSD;
    const line = `Kojiro levels on NDXUSD put back: long levels ${lv?.levels.join(' · ') || '—'} (plan ${lv?.bias === 1 ? 'bullish' : lv?.bias === -1 ? 'bearish' : 'none'}${lv?.dol ? `, DOL ${lv.dol}` : ''}); SHORT levels ${lv?.shortLevels?.join(' · ') || '—'} (shorts only)`;
    forex.logBot([line]);
    log.info({ lv }, 'Kojiro levels restored');
  });
  // v27.65 (owner: "count it in as well in the portfolio"): his "SIGNAL · NQ — SELL @ 29,189.75" (Oct 26 ~01:55 UTC) came before
  // the copier ran on the server; booked as if copied at today's copy size (20%), closed where his screenshot showed
  // +$770 on one contract (38.5 points → 29,151.25)
  await oneTimeUpgrade('v27.65-book-kojiro-nq-sell-oct26', async () => {
    const line = await practice.bookMissedCopy('bot', { pair: 'NDXUSD', side: -1, entry: 29189.75, exit: 29151.25, openedAt: Date.parse('2026-10-26T01:55:00Z'), closedAt: Date.parse('2026-10-26T02:10:00Z'), ref: 'discord_kojiro:signal:NDXUSD:missed-2026-10-26-sell', strategy: 'discord_kojiro', riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage });
    forex.logBot([`Kojiro copy (missed, booked by hand): ${line}`]);
    log.info({ line }, 'missed Kojiro call booked');
  });
  // v27.70 (owner: "did it take the call correctly?"): no — the old build (bias still the morning's bullish) BOUGHT NQ at
  // 29,815.75 at 00:33 UTC off his 29,804 level while he was leaning bearish. Struck as the bias bug's trade (open or
  // closed, never re-opened); the v27.69 replay books the shorts the right rules would have taken.
  await oneTimeUpgrade('v27.70-strike-wrong-side-level', async () => {
    const from = Date.parse('2026-10-27T23:59:06Z');
    const to = Date.parse('2026-10-28T03:00:00Z');
    const pick = (p: { ref?: string; side: 1 | -1; openedAt: number }) => !!p.ref?.startsWith('discord_kojiro_levels:signal:NDXUSD:') && p.side === 1 && p.openedAt >= from && p.openedAt < to;
    const label = 'Kojiro level: NQ long of 00:33 UTC Oct 28 (bought against his bearish lean — the bias bug)';
    const lines = [await practice.undoPositions('bot', pick, label), await practice.undoClosed('bot', pick, label)];
    // his lean saved before the level watcher's first look (else the first minutes after the restart buy again)
    await savePosted(redis, 'NDXUSD', { bias: -1, dol: null, biasT: Date.parse('2026-10-28T00:08:44Z'), source: 'kojiro' }, true);
    forex.logBot([...lines, 'Kojiro: "Leaning towards bearish" (00:08 UTC) saved as his NDXUSD bias — level trades are shorts only now']);
    log.info({ lines }, 'wrong-side Kojiro level trade struck');
  });
  // v27.78 (owner: "redo those 2 trades with a limit of 50 loss and let it grow properly as if it never closed"): the coin
  // bot's two LINK keltner 1h longs of Oct 28 that the $20 cap stopped (04:07 → −$20.04, 10:09 → −$20.00) are struck and
  // replayed minute by minute on Coinbase's candles with a $50 cap (stop = the tested stop, pulled in only to $50) and the
  // normal profit lock; the first also ends where the bot would have followed the lab's exit (its 09:09 run). Retried
  // while Coinbase's 1-minute candles don't reach back.
  {
    let tries = 0;
    const replay = async (): Promise<void> => {
      const ok = await oneTimeUpgrade('v27.78-link-cap50', async () => {
        const inst = INSTRUMENTS.find((x) => x.id === 'LINKUSD')!;
        const from = Date.parse('2026-10-28T04:00:00Z');
        const bars = (await fetchCoinbaseFast(inst, '1m', from)).filter((b) => b.t + 60_000 <= Date.now());
        if (bars.length < 300 || bars[0]!.t > Date.parse('2026-10-28T04:08:00Z')) throw new Error(`only ${bars.length} 1-minute LINK candles`);
        const lines = [
          await practice.replayBotTrade('cbot', 'keltner:1h:LINKUSD:1793160000000', 50, bars, Date.parse('2026-10-28T09:09:00Z')),
          await practice.replayBotTrade('cbot', 'keltner:1h:LINKUSD:1793181600000', 50, bars),
        ];
        cryptoLab.logBot([...lines, 'coin bot loss cap raised to $50 a trade (was $20); the smart per-strategy caps can no longer go under it']);
        log.info({ lines }, 'LINK trades replayed with a $50 cap');
      });
      if (!ok && ++tries < 10) setTimeout(() => void replay(), 60_000).unref?.();
    };
    setTimeout(() => void replay(), 20_000).unref?.();
  }
  // v27.80 (owner: "skip the Dow charts, remove it, also stop the current Dow trades"): the Dow is out of the forex desk
  // (OFF_MARKETS) and its open bot trades are closed at the market once (a pending close if there is no price yet)
  await oneTimeUpgrade('v27.80-close-dow', async () => {
    const a = await practice.rawAccount('bot');
    const dow = a.open.filter((p) => p.pair === 'DJIUSD');
    const lines: string[] = [];
    for (const p of dow) {
      const r = await practice.close(p.id, 'bot');
      lines.push(`Dow ${p.side === 1 ? 'long' : 'short'} (${p.strategy ?? 'bot'} ${p.tf ?? ''}) closed: ${r.ok ? 'done' : r.error}`);
    }
    forex.logBot([...lines, 'Dow 30 removed from the forex desk: no live price (Yahoo is ~10 min late) — no charts, lab rows or new trades until it has one']);
    log.info({ lines }, 'Dow removed');
  });
  // v27.79 (owner: "same with eth/usd"): the coin bot's donchian20 1h ETH long of Oct 28 (09:09 → −$20.00 at 11:06 on the
  // $20 cap stop, $8 under the entry while the tested stop was $26 under) replayed like the LINK trades with a $50 cap
  {
    let tries = 0;
    const replay = async (): Promise<void> => {
      const ok = await oneTimeUpgrade('v27.79-eth-cap50', async () => {
        const inst = INSTRUMENTS.find((x) => x.id === 'ETHUSD')!;
        const bars = (await fetchCoinbaseFast(inst, '1m', Date.parse('2026-10-28T09:00:00Z'))).filter((b) => b.t + 60_000 <= Date.now());
        if (bars.length < 120 || bars[0]!.t > Date.parse('2026-10-28T09:10:00Z')) throw new Error(`only ${bars.length} 1-minute ETH candles`);
        const line = await practice.replayBotTrade('cbot', 'donchian20:1h:ETHUSD:1793178000000', 50, bars);
        cryptoLab.logBot([line, 'coin bot: trades are now sized so the tested stop loses at most $50 (the stop is never pulled in), and a strategy whose own live trades lose after 3 of them is paused for 14 days']);
        log.info({ line }, 'ETH trade replayed with a $50 cap');
      });
      if (!ok && ++tries < 10) setTimeout(() => void replay(), 60_000).unref?.();
    };
    setTimeout(() => void replay(), 25_000).unref?.();
  }
  // v27.77 (owner: "do as if it never happened and keep all Kojiro calls in labs for now"): the 02:32 UTC NQ short of the
  // "sell high toward his level" rule (entered 21 points above his newest level — v27.76) struck; Kojiro calls are lab only
  await oneTimeUpgrade('v27.77-strike-kojiro-toward-nq', async () => {
    const pick = (p: { ref?: string }) => p.ref === 'discord_kojiro_levels:signal:NDXUSD:1793154660000';
    const label = 'Kojiro level: NQ short of 02:32 UTC Oct 28 (sold toward his level too early)';
    const lines = [await practice.undoPositions('bot', pick, label), await practice.undoClosed('bot', pick, label)];
    forex.logBot([...lines, 'Kojiro calls are LAB ONLY now: his signals and level setups are recorded and graded, never traded (DISCORD_COPY_LIVE / DISCORD_LEVEL_TRADES = on to trade again)']);
    log.info({ lines }, 'Kojiro toward trade struck');
  });
  // v27.72 (owner: "it got in a weird signal and longed it then insta sold, just lost 90"): tonight's gold buys at his GC
  // levels had a ~$3.3 stop while the round-trip gold fee is ~$4 a unit — they could not win after fees. Struck once;
  // such trades are now refused (level-watch.ts feeTooBig) and the profit lock counts the fee.
  await oneTimeUpgrade('v27.72-strike-gold-levels', async () => {
    const from = Date.parse('2026-10-27T20:00:00Z');
    const to = Date.parse('2026-10-28T06:00:00Z');
    const pick = (p: { ref?: string; openedAt: number }) => !!p.ref?.startsWith('discord_kojiro_levels:signal:XAUUSD:') && p.openedAt >= from && p.openedAt < to;
    const label = 'Kojiro level: gold buys of Oct 28 night (stop smaller than the round-trip fee)';
    const lines = [await practice.undoPositions('bot', pick, label), await practice.undoClosed('bot', pick, label)];
    forex.logBot(lines);
    log.info({ lines }, 'gold level trades struck');
  });
  // v27.71 (owner: "yes revert it … also on the one today, I need it accurate"): every closed index trade that paid the old
  // guessed 0.03% a side gets the difference to Hyperliquid's real 0.009% back (balance, P&L log, record, R ledger)
  await oneTimeUpgrade('v27.71-refund-index-fees', async () => {
    const line = await practice.refundIndexFees('bot', 0.03, VENUE_FEES.indexPct);
    forex.logBot([line]);
    log.info({ line }, 'index fees corrected');
  });
  // v27.69 (owner: "it legit had levels but the bot didn't take em, go in them at the exact time"): his NQ levels of
  // 23:59 UTC Oct 27 (29,835 · 29,804 · 29,782.5) + "Leaning towards bearish" (00:08) + "Break and retest" — the bot
  // read the lean as nothing (bias stayed the morning's bullish → longs only) and had no break-and-retest rule. The bias
  // is saved now; the minutes since his post are replayed with the new rules (shorts only, his levels) and every trade
  // the watcher would have taken is booked as if taken then (still open → it keeps running). Retried while no candles.
  {
    const postedT = Date.parse('2026-10-27T23:59:06Z');
    let tries = 0;
    const replay = async () => {
      const ok = await oneTimeUpgrade('v27.69-kojiro-levels-oct28', async () => {
        const { bars } = await practice.candles('NDXUSD', 'M1', 900);
        const done = bars.filter((b) => b.t + 60_000 <= Date.now());
        if (done.length < 120 || done[done.length - 1]!.t < postedT + 30 * 60_000) throw new Error(`only ${done.length} 1-minute candles so far`);
        const levels = [29835, 29804, 29782.5];
        const lv = (await loadLevels(redis)).NDXUSD;
        const all = [...new Set([...levels, ...(lv?.shortLevels ?? [])])];
        const lines = await replayMissedLevels(redis, practice, 'NDXUSD', 'kojiro', [{ levels, side: -1, t: postedT, dol: null, all }], postedT, done);
        forex.logBot([
          'Kojiro: break-and-retest at his levels added',
          ...(lines.length ? lines.map((l) => `Kojiro level (missed, booked as if taken): ${l}`) : ['Kojiro levels of 23:59 UTC replayed: no setup at them that the bot would have taken']),
        ]);
        log.info({ lines }, 'missed Kojiro level trades replayed');
      });
      if (!ok && ++tries < 10) setTimeout(() => void replay(), 60_000).unref?.();
    };
    setTimeout(() => void replay(), 90_000).unref?.();
  }
  // v20.1 (owner: "revert all current active trades"): every open bot trade is struck as if it never happened, once
  await oneTimeUpgrade('v20.1-revert-open', async () => {
    const line = await practice.undoOpen('bot');
    forex.logBot([line, 'strict mode on: only strategies that passed the unseen exam, 2+ market checks per trade, market entries only, desks study only']);
    log.info({ line }, 'forex bot: open trades struck');
  });
  // v26.5 (owner: "use more risk when you trade for more profit"): the forex bot account moves to Turbo (8% a trade) once
  await oneTimeUpgrade('v26.5-turbo', async () => {
    await practice.setRiskMode('turbo', 'bot');
    forex.logBot(['risk mode set to Turbo (8% of the account a trade, up to 500×) — the owner asked for more risk']);
  });
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
  // v18.10: the checker's plumbing on Bot health (where checkpoints stop, the safety worker, the queues, the RPC)
  const queueCounts = async (q: typeof evaluateQueue | typeof safetyQueue): Promise<QueueCounts | null> => {
    const c = await q.getJobCounts('waiting', 'delayed', 'active', 'failed').catch(() => null);
    return c ? { waiting: c.waiting ?? 0, delayed: c.delayed ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 } : null;
  };
  const checkerStats = async (): Promise<CheckerStats> => {
    const e = evaluator.stats;
    const sf = registry.safetyStats;
    const ep = rpcEndpoints();
    const base: Omit<CheckerStats, 'verdict'> = {
      evaluator: { jobs: e.jobs, evaluated: e.evaluated, alreadyDone: e.alreadyDone, noToken: e.noToken, noView: e.noView, waitSafety: e.waitSafety, safetyAsked: e.safetyAsked, buys: e.buys },
      safety: { done: sf.done, failed: sf.failed, stale: sf.stale, waitSec: Math.round(sf.waitMsAvg / 1000), lastDoneAgoSec: sf.lastDoneAt ? Math.round((Date.now() - sf.lastDoneAt) / 1000) : null },
      queues: { evaluate: await queueCounts(evaluateQueue), safety: await queueCounts(safetyQueue) },
      rpc: { provider: ep.http ? (/helius/i.test(ep.http) ? 'helius' : /flux/i.test(ep.http) ? 'fluxrpc' : 'other') : 'none', configured: !!ep.http },
    };
    return { ...base, verdict: checkerVerdict(base, process.uptime()) };
  };
  setCheckerStatsSource(checkerStats);
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
  const api = await startApi({ liveState, executor, listenerStats: statsOf, startedAt, sellManager, dex, leaders, walletPnl, dips, crowd, lab, taLab, trending, swing: { universe: swingUniverse, trader: swingTrader }, autopsy, aiCoach, timing, shadow, brain, tape: tapeRecorder, walletBook, deployers: deployerBook, selfLoop, tournament, meme: memeReader, forex, fastFx, crypto: cryptoLab, fastCrypto, practice, fxCalendar, fxNews, tradeWatch, weekendReview }).catch((err: Error) => {
    log.error({ err: err.message }, 'dashboard API failed to start — bot keeps running without it');
    return null;
  });
  // v27.30 (owner: "a weekly log"): every Monday after 00:05 UTC, last week's summary per bot goes to the phone, once
  const weekPush = setInterval(async () => {
    const now = new Date();
    if (now.getUTCDay() !== 1 || now.getUTCHours() * 60 + now.getUTCMinutes() < 5) return;
    const lastMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 7 * 86_400_000).toISOString().slice(0, 10);
    for (const acct of ['bot', 'cbot'] as const) {
      try {
        if ((await redis.set(`fx:weekpush:${acct}:${lastMonday}`, '1', 'EX', 14 * 86_400, 'NX')) !== 'OK') continue;
        const w = weeklyLog(await practice.pnlRows(acct), 0).find((x) => x.week === lastMonday) ?? { week: lastMonday, pnlUsd: 0, trades: 0, wins: 0, bestUsd: null, worstUsd: null, byStrategy: [], byPair: [] };
        bus.publish({ type: 'fxTrade', data: { kind: 'week', pair: '', side: 1, pnlUsd: w.pnlUsd, reason: weekText(w), acct } });
      } catch (err) {
        log.warn({ err: (err as Error).message, acct }, 'weekly summary failed');
      }
    }
  }, 10 * 60_000);
  // v27.65 (owner: "don't miss shit again"): the Discord copier reports every 2 minutes; quiet for 15 → phone alert + bot
  // log, once, and again when it is back (state kept in Redis so a restart doesn't re-alert)
  const copierWatch = setInterval(async () => {
    try {
      if (!DISCORD_COPY.on) return;
      const down = copierDown(await loadHeartbeat(redis), Date.now());
      if (down === null) return; // the copier never reported (older version / not started yet)
      const was = (await redis.get(COPIER_HB.alertKey)) === 'down';
      if (down === was) return;
      await redis.set(COPIER_HB.alertKey, down ? 'down' : 'up');
      const text = down
        ? `No sign of life from the Kojiro copier for ${COPIER_HB.staleMs / 60_000}+ minutes — his calls are not being read. Check the discord container (docker compose logs discord).`
        : 'The Kojiro copier is reading his channels again (anything posted while it was away is caught up; calls older than 10 minutes are not opened).';
      forex.logBot([text]);
      bus.publish({ type: 'fxTrade', data: { kind: 'copier', pair: '', side: 1, pnlUsd: 0, reason: text, acct: 'bot', ok: !down } });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'copier watch failed');
    }
  }, 60_000);
  // v27.66: Kojiro's record re-graded every hour (his calls finish, candles arrive); big news → his copies trail tight
  practice.tightNow = (pair, t) => fxCalendar.newsNow(pair, t);
  const kojiroStudy = setInterval(() => void runKojiroStudy(redis).catch((err: Error) => log.warn({ err: err.message }, 'Kojiro study failed')), 3_600_000);
  setTimeout(() => void runKojiroStudy(redis).catch(() => undefined), 5 * 60_000).unref?.();
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
  const watchMinutes: WatchMinute[] = [];
  let stallTripped = false;
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
    // v18.2 / v18.10 checker watchdog (owner: 52 coins checked in 7 hours while the stream ran at 7,500 trades/min): the
    // trade stream flows (launches arrive) but the checker scores (almost) nothing over a 20-minute window → WARN event
    // with the plumbing diagnosis, and a clean exit (Docker brings a fresh process) at most twice in 6 hours — a restart
    // loop fixes nothing, so after that only the warning repeats.
    const launchesNow = (s?.creates ?? 0) - lastCreates;
    const evalNow = evaluator.stats.evaluated - lastEvaluated;
    lastEvaluated = evaluator.stats.evaluated;
    watchMinutes.push({ launches: launchesNow, evaluated: evalNow });
    if (watchMinutes.length > CHECKER_WATCH.windowMin) watchMinutes.splice(0, watchMinutes.length - CHECKER_WATCH.windowMin);
    if (checkerStalled(watchMinutes) && !stallTripped) {
      stallTripped = true;
      watchMinutes.length = 0;
      const diag = await checkerStats().then((c) => c.verdict).catch(() => 'diagnosis unavailable');
      const prev = (await redis.lrange('bot:checkerRestarts', 0, 9).catch(() => [])).map(Number);
      const restart = restartAllowed(prev, Date.now());
      log.error({ launchesNow, diag, restart }, 'coin checker stalled while the stream flows');
      void recordEvent({ level: 'WARN', module: 'evaluator', type: 'checker_stalled', message: `almost no coin scored for ${CHECKER_WATCH.windowMin} min while ${launchesNow} launches/min arrived — ${diag}${restart ? ' — the bot restarted itself' : ' — not restarting again (twice in 6 h already)'}` }).catch(() => undefined);
      if (restart) {
        await redis.multi().lpush('bot:checkerRestarts', String(Date.now())).ltrim('bot:checkerRestarts', 0, 9).exec().catch(() => undefined);
        setTimeout(() => void shutdown('checker stalled'), 2_000);
      } else setTimeout(() => (stallTripped = false), CHECKER_WATCH.windowMin * 60_000).unref?.();
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
    clearInterval(weekPush);
    clearInterval(copierWatch);
    clearInterval(kojiroStudy);
    weekendReview.stop();
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
      levelWatch.stop();
      cryptoLab.stop();
      fastCrypto.stop();
      practice.stop();
      tradeWatch.stop();
      pythLive.stop();
      yahooLive.stop();
      coinbaseLive.stop();
      hyperliquidLive.stop();
      stopLivePush();
      stopFutPush();
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
