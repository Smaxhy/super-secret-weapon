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
import { startApi } from './api/server';
import { env, rpcEndpoints } from './config/env';
import { bus } from './lib/bus';
import { startConfigRefresh, stopConfigRefresh } from './config/runtime-config';
import { runConfigMigrations } from './config/migrations';
import { startCalibration, stopCalibration } from './learner/score-calibration';
import { screenEntry } from './executor/rug-screen';
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
import { TradeCoach } from './learner/trade-coach';
import { SwingWatcher } from './executor/swing-watcher';
import { ObservationLogger } from './learner/observation-logger';
import { requestAdjustment, scheduleDailyAdjuster } from './learner/daily-adjuster';
import { startBeliefCache, stopBeliefCache } from './learner/bayesian-updater';
import { OutcomeLabeler } from './learner/outcome-labeler';
import { startRegimeDetector } from './learner/regime-detector';
import { logger } from './lib/logger';
import { installProcessGuards } from './lib/process-guard';
import { recordError, recordExit, recordStart } from './lib/bot-health';
import { prisma } from './lib/prisma';
import { closeQueues } from './lib/queues';
import { closeRedis, redis } from './lib/redis';
import { rpcLimiter } from './lib/solana';
import { LiveState } from './scanner/live-state';
import { PumpFunListener, type ListenerStats } from './scanner/pumpfun-listener';
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
  await startConfigRefresh();

  // 2. Redis
  await redis.ping();
  log.info('redis connected');
  const { lastExit } = await recordStart(redis);
  if (lastExit) log.info({ lastExit }, 'previous run ended');
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
  trader.screen = (req) => screenEntry(req, { liveState, redis, crowd });
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
  // Exits react to every trade on a coin we hold (not just the 1s tick); real trade highs count as peaks.
  sellManager.crowd = crowd;
  registry.onTradeApplied.push((mint) => sellManager.onTrade(mint));
  registry.startSafetyWorker();
  // Copy trading: watch the wallets you added on the dashboard.
  const whales = new WhaleTracker(redis, liveState, evaluator);
  whales.onAdopt = (ev) => registry.adopt(ev);
  // Several KOLs (Cupsey, Cented…) bought the same coin → check it now.
  whales.onKolCluster = (mint, kols) => {
    const why = `kols:${kols}`;
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

  const startLogs = (url: string, fetchMissingCreates: boolean) => {
    const l = new PumpFunListener(url, fetchMissingCreates);
    l.on('event', registry.handle);
    l.on('event', whales.onEvent);
    l.start();
    sources.push(l);
    logsRef = l;
  };

  if (!env.ENABLE_SCANNER) {
    log.warn('scanner disabled (ENABLE_SCANNER=false)');
  } else if (env.DATA_SOURCE === 'hybrid') {
    // Launches + migrations from PumpPortal, every trade from Solana's public node. Both free.
    startPortal(false);
    startLogs(env.TRADES_WS_URL, false);
    log.info({ trades: env.TRADES_WS_URL.replace(/api-key=[^&]+/, 'api-key=***') }, 'data source: hybrid (PumpPortal launches + free trade stream)');
  } else if (env.DATA_SOURCE === 'pumpportal') {
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
    const a = (logsRef as PumpFunListener | null)?.stats;
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
  const api = await startApi({ liveState, executor, listenerStats: statsOf, startedAt, sellManager, dex, leaders, walletPnl }).catch((err: Error) => {
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
    lastCreates = s?.creates ?? 0;
    lastAmm = s?.ammTrades ?? 0;
    lastTrades = s?.trades ?? 0;
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
