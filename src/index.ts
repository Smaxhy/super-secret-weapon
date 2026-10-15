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
import { MoonshotLab } from './learner/moonshot';
import { OutcomeTracker } from './learner/outcome-tracker';
import { ExitTuner } from './learner/exit-tuner';
import { TapeArchiver } from './learner/tape-archiver';
import { Brain } from './learner/brain';
import { startPushNotifier } from './lib/push';
import { LossAutopsy } from './learner/loss-autopsy';
import { MigratedScanner } from './scanner/migrated-scanner';
import { RunningCoins } from './scanner/running-coins';
import { priceShape } from './evaluator/price-shape';
import { AiCoach } from './learner/ai-coach';
import { Evaluator } from './evaluator/evaluator';
import { WalletAnalyzer } from './evaluator/wallet-analyzer';
import { PaperExecutor } from './executor/paper-trader';
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
import { DipWatcher } from './executor/dip-watcher';
import { StrategyLab } from './learner/strategy-lab';
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
import { recordError, recordExit, recordStart } from './lib/bot-health';
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
import { resetPaperStats } from './api/paper-reset';
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

  // Phase 2: scoring + execution. LIVE execution arrives in Phase 4.
  if (env.TRADING_MODE === 'LIVE') log.warn('TRADING_MODE=LIVE but live execution is not built yet (Phase 4) — running PAPER');
  const executor = new PaperExecutor(liveState);
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
  evaluator.ta = taLab;
  registry.onTradeApplied.push((mint) => taLab.onTrade(mint));
  taLab.start();
  // Trending tabs (pump.fun live / KOTH / for-you / runners, GeckoTerminal, DexScreener narratives):
  // a coin newly on a list is checked at once (never bought just for that) and paper-tested by the lab.
  const trendFeeds = new TrendingFeeds();
  const trending = new TrendingHub(trendFeeds);
  evaluator.trending = trending;
  // Moonshot TEST mode: migrated coins where huge real buying + KOLs + trending all line up → two pretend trades
  // (moonshot exits vs normal exits). No paper money until moonshot.live is switched on.
  const moonshot = new MoonshotLab(
    redis,
    crowd,
    (mint) => {
      const i = trending.info(mint);
      return { lists: i ? new Set([...i.sources, ...i.recentSources]).size : 0, dex: !!dex.trendingInfo(mint) };
    },
    async (mint) => (await prisma.token.findUnique({ where: { mint }, select: { symbol: true } }))?.symbol ?? mint.slice(0, 6),
  );
  registry.onTradeApplied.push((mint) => moonshot.onTrade(mint));
  moonshot.start();
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
  const spikeTimer = startSpikeWatcher(liveState, evaluator);
  // Saves each open position's price every 5s (Redis) for the dashboard chart.
  startPositionHistory();
  const xTimer = startXWatcher(redis, (word, mints) => {
    for (const m of mints) void evaluator.checkNow(m, 'CURVE_SNIPE', `x:${word}`);
  });

  // 5. Dashboard API + WebSocket
  const startedAt = Date.now();
  const api = await startApi({ liveState, executor, listenerStats: statsOf, startedAt, sellManager, dex, leaders, walletPnl, dips, crowd, lab, taLab, trending, swing: { universe: swingUniverse, trader: swingTrader }, autopsy, aiCoach, timing, shadow, brain, moonshot }).catch((err: Error) => {
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
      dips.stop();
      lab.stop();
      shadow.stop();
      moonshot.stop();
      brain.stop();
      stopPush();
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
