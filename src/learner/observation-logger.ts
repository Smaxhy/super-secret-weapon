/**
 * Observation logger — snapshots EVERY Pump.fun token over its first 24h.
 *
 * When a token launches we schedule 7 delayed jobs (creation, 1m, 5m, 15m,
 * 1h, 6h, 24h). Each job reads the token's live state from Redis, computes
 * holder count / price / curve % / etc., and inserts one row into the
 * TokenSnapshot hypertable. Those rows are the training data for the ML model.
 *
 * Tokens that died still get their later snapshots — "this went to zero" is
 * exactly the kind of outcome the model needs to learn from.
 */
import { Worker, type Job } from 'bullmq';
import { SNAPSHOT_SCHEDULE } from '../config/default';
import type { ObservationSnapshot, SnapshotInterval } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { observationQueue, QUEUE_NAMES, type ObservationJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import { deriveMetrics, type LiveState, type LiveTokenView } from '../scanner/live-state';

const log = moduleLogger('observation-logger');

/** After this long with no trades, a token still on the curve is considered dead. */
const DEAD_AFTER_MS = 60 * 60_000;

/** Build a snapshot from live state. Pure — exported for tests. */
export function buildSnapshot(view: LiveTokenView, interval: SnapshotInterval, now = Date.now()): ObservationSnapshot {
  const m = deriveMetrics(view);
  return {
    mint: view.mint,
    interval,
    takenAt: new Date(now),
    ageSeconds: Math.max(0, Math.round((now - view.createdAtMs) / 1000)),
    holderCount: m.holderCount,
    uniqueWallets: view.uniqueWallets,
    bondingCurvePct: round(m.bondingCurvePct, 4),
    volumeSol: round(m.volumeSol, 6),
    buyCount: view.buys,
    sellCount: view.sells,
    buySellRatio: round(m.buySellRatio, 4),
    devHoldingPct: round(m.devHoldingPct, 4),
    top10HolderPct: round(m.top10HolderPct, 4),
    priceSol: m.priceSol,
    marketCapSol: round(m.marketCapSol, 6),
    isComplete: view.complete,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export class ObservationLogger {
  private worker: Worker<ObservationJob> | null = null;
  snapshotsWritten = 0;

  constructor(private readonly liveState: LiveState) {}

  /** Queue all 7 snapshots for a new token. Job ids make this safe to call twice. */
  async scheduleFor(mint: string, createdAtMs: number): Promise<void> {
    const now = Date.now();
    await observationQueue.addBulk(
      SNAPSHOT_SCHEDULE.map(({ interval, delayMs }) => ({
        name: interval,
        data: { mint, interval },
        opts: {
          jobId: `${mint}-${interval}`,
          // Count from on-chain creation time, not from when we noticed it.
          delay: Math.max(0, createdAtMs + delayMs - now),
        },
      })),
    );
  }

  start(concurrency = 10): void {
    this.worker = new Worker<ObservationJob>(QUEUE_NAMES.observations, (job) => this.process(job), {
      connection: bullConnection(),
      concurrency,
    });
    this.worker.on('failed', (job, err) =>
      log.warn({ mint: job?.data.mint, interval: job?.data.interval, err: err.message }, 'snapshot job failed'),
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<ObservationJob>): Promise<void> {
    const { mint, interval } = job.data;

    // Idempotency: a retried job must not write a second row.
    const existing = await prisma.tokenSnapshot.findFirst({ where: { mint, interval }, select: { id: true } });
    if (existing) return;

    const view = await this.liveState.read(mint);
    if (!view) {
      log.debug({ mint, interval }, 'no live state (expired or never tracked) — skipping snapshot');
      return;
    }

    const snap = buildSnapshot(view, interval);
    await prisma.tokenSnapshot.create({ data: snap });
    this.snapshotsWritten++;

    // Keep the Token row's summary columns fresh for the dashboard.
    const token = await prisma.token.findUnique({ where: { mint }, select: { peakMarketCapSol: true, status: true } });
    const stale = view.lastTradeAtMs === null || Date.now() - view.lastTradeAtMs > DEAD_AFTER_MS;
    await prisma.token.update({
      where: { mint },
      data: {
        lastPriceSol: snap.priceSol,
        lastHolderCount: snap.holderCount,
        peakMarketCapSol: Math.max(token?.peakMarketCapSol ?? 0, snap.marketCapSol),
        ...(token?.status === 'ACTIVE' && !view.complete && stale && interval !== 'CREATION' ? { status: 'DEAD' as const } : {}),
      },
    });

    log.debug({ mint, interval, holders: snap.holderCount, mcSol: snap.marketCapSol, curvePct: snap.bondingCurvePct }, 'snapshot');

    // Last snapshot done → free the Redis memory for this token.
    if (interval === 'H24') await this.liveState.forget(mint);
  }
}
