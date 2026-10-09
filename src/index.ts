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
import { env, rpcEndpoints } from './config/env';
import { ensureTimescale } from './db/timescale';
import { SafetyChecker } from './evaluator/safety-checker';
import { ObservationLogger } from './learner/observation-logger';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeQueues } from './lib/queues';
import { closeRedis, redis } from './lib/redis';
import { rpcLimiter } from './lib/solana';
import { LiveState } from './scanner/live-state';
import { PumpFunListener } from './scanner/pumpfun-listener';
import { TokenRegistry } from './scanner/token-registry';

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

  // 2. Redis
  await redis.ping();
  log.info('redis connected');
  const liveState = new LiveState(redis);
  await liveState.restore();

  // 3. Workers
  const observations = env.ENABLE_OBSERVATIONS ? new ObservationLogger(liveState) : null;
  observations?.start();
  const safety = env.ENABLE_SAFETY_CHECKS ? new SafetyChecker(liveState) : null;
  const registry = new TokenRegistry(liveState, observations, safety);
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

  // Heartbeat line every minute so you can see it's alive at a glance.
  let lastCreates = 0;
  let lastTrades = 0;
  const statsTimer = setInterval(() => {
    const s = listener?.stats;
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
      },
      '📊 stats',
    );
    lastCreates = s?.creates ?? 0;
    lastTrades = s?.trades ?? 0;
  }, 60_000);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down…');
    clearInterval(statsTimer);
    const force = setTimeout(() => process.exit(1), 15_000); // don't hang forever
    try {
      await listener?.stop();
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
