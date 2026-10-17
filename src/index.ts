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
import { Evaluator } from './evaluator/evaluator';
import { WalletAnalyzer } from './evaluator/wallet-analyzer';
import { PaperExecutor } from './executor/paper-trader';
import { SellManager } from './executor/sell-manager';
import { Trader } from './executor/trader';
import { ensureTimescale } from './db/timescale';
import { SafetyChecker } from './evaluator/safety-checker';
import { BeliefStore } from './learner/bayesian-updater';
import { DailyAdjuster } from './learner/daily-adjuster';
import { OutcomeTracker } from './learner/missed-opportunity';
import { ObservationLogger } from './learner/observation-logger';
import { getRegime, RegimeDetector } from './learner/regime-detector';
import { TapeArchiver } from './learner/tape-archiver';
import { obsidianSync } from './integrations/obsidian-sync';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeQueues } from './lib/queues';
import { closeRedis, redis } from './lib/redis';
import { rpcLimiter } from './lib/solana';
import { WalletScorer } from './learner/wallet-scorer';
import { LiveState } from './scanner/live-state';
import { migrationDetector } from './scanner/migration-detector';
import { PumpFunListener } from './scanner/pumpfun-listener';
import { TokenRegistry } from './scanner/token-registry';
import { whaleTracker } from './scanner/whale-tracker';

const log = logger.child({ module: 'main' });

// A stray rejected promise should be logged, not crash the bot.
process.on('unhandledRejection', (reason) => {
  log.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled promise rejection');
});
// A truly unexpected exception leaves the process in an unknown state:
// log it and exit; Docker's restart policy brings us back cleanly.
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception — exiting');
  process.exit(1);
});

async function main(): Promise<void> {
  log.info({ mode: env.TRADING_MODE, env: env.NODE_ENV }, '🚀 Pump.fun bot starting');

  // 1. Database
  await prisma.$connect();
  log.info('postgres connected');
  await ensureTimescale();
  await startConfigRefresh();

  // 2. Redis
  await redis.ping();
  log.info('redis connected');
  const liveState = new LiveState(redis);
  await liveState.restore();

  // 3. Workers
  const observations = env.ENABLE_OBSERVATIONS ? new ObservationLogger(liveState) : null;
  observations?.start();
  const safety = env.ENABLE_SAFETY_CHECKS ? new SafetyChecker(liveState) : null;

  // Phase 2: scoring + execution. LIVE execution arrives in Phase 4.
  if (env.TRADING_MODE === 'LIVE') log.warn('TRADING_MODE=LIVE but live execution is not built yet (Phase 4) — running PAPER');
  const executor = new PaperExecutor(liveState);

  // Learning engine: market regime, pattern beliefs, outcome tracking, nightly weight tuning.
  const regime = new RegimeDetector(executor.mode);
  regime.start();
  const beliefs = new BeliefStore();
  await beliefs.start();
  const outcomes = new OutcomeTracker(beliefs);
  const tapes = new TapeArchiver();
  observations?.addListener(outcomes.onSnapshot);
  observations?.addListener(tapes.onSnapshot);
  const adjuster = new DailyAdjuster(executor.mode);
  adjuster.start();

  // Obsidian vault integration (optional — runs only if OBSIDIAN_VAULT_PATH is set)
  await obsidianSync.start();

  // Smart-money wallet tracking + scoring
  await whaleTracker.start();
  const walletScorer = new WalletScorer();
  walletScorer.start();

  // Migration detector — watches for post-completion pool creation
  migrationDetector.start();

  const trader = new Trader(executor);
  const sellManager = new SellManager(executor, liveState);
  sellManager.start();
  const evaluator = new Evaluator(redis, liveState, new WalletAnalyzer(redis), trader, beliefs);
  evaluator.start();

  const registry = new TokenRegistry(liveState, observations, safety, evaluator);
  registry.startSafetyWorker();

  // 4. Listener
  const { ws } = rpcEndpoints();
  let listener: PumpFunListener | null = null;
  if (!env.ENABLE_SCANNER) {
    log.warn('scanner disabled (ENABLE_SCANNER=false)');
  } else if (!ws) {
    log.error('no WebSocket endpoint — set HELIUS_API_KEY in .env. Scanner not started.');
  } else {
    listener = new PumpFunListener(ws);
    listener.on('event', registry.handle);
    listener.start();
  }

  // 5. Dashboard API + WebSocket
  const startedAt = Date.now();
  const api = await startApi({ liveState, executor, listenerStats: () => listener?.stats ?? null, startedAt }).catch((err: Error) => {
    log.error({ err: err.message }, 'dashboard API failed to start — bot keeps running without it');
    return null;
  });
  const pushTimer = setInterval(() => {
    const s = listener?.stats;
    bus.publish({ type: 'stats', data: { connected: s?.connected ?? false, launches: s?.creates ?? 0, trades: s?.trades ?? 0, tracked: liveState.trackedCount, uptimeSec: Math.round((Date.now() - startedAt) / 1000) } });
  }, 5_000);

  // Heartbeat line every minute so you can see it's alive at a glance.
  let lastCreates = 0;
  let lastTrades = 0;
  const statsTimer = setInterval(async () => {
    const s = listener?.stats;
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
        evaluated: evaluator.stats.evaluated,
        buySignals: evaluator.stats.buys,
        timingWaits: evaluator.stats.timingWaits,
        walletLookups: evaluator.stats.walletLookups,
        outcomesResolved: outcomes.stats.resolved,
        missed: outcomes.stats.missed,
        regime: getRegime(),
        openPositions,
        [`${executor.mode.toLowerCase()}BalanceSol`]: +balance.toFixed(4),
      },
      '📊 stats',
    );
    lastCreates = s?.creates ?? 0;
    lastTrades = s?.trades ?? 0;

    // Sync dashboard to Obsidian vault
    if (obsidianSync.isEnabled()) {
      obsidianSync.updateDashboard({
        balance: isNaN(balance) ? 0 : balance,
        openPositions,
        todayPnl: 0, // TODO: pull from daily stats once wired
        todayTrades: evaluator.stats.buys,
        regime: getRegime(),
        uptime: `${Math.round((Date.now() - startedAt) / 60_000)}m`,
      }).catch(() => { /* non-critical */ });
    }
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
      await listener?.stop();
      await evaluator.stop();
      await sellManager.stop();
      adjuster.stop();
      walletScorer.stop();
      whaleTracker.stop();
      migrationDetector.stop();
      regime.stop();
      beliefs.stop();
      stopConfigRefresh();
      await registry.stop();
      await observations?.stop();
      await closeQueues();
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
