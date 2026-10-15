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

/** Worth another snapshot: graduated, or traded in the last 10 min with ≥ 10 holders. Pure. */
export function stillAlive(v: Pick<LiveTokenView, 'complete' | 'lastTradeAtMs' | 'balances'>, now: number): boolean {
  if (v.complete) return true;
  return v.lastTradeAtMs !== null && now - v.lastTradeAtMs <= 10 * 60_000 && v.balances.size >= 10;
}

/** Snapshots scheduled one after the other, only while the coin is alive. */
const CHAINED = new Set<SnapshotInterval>(['H1', 'H6', 'H24']);
/** The snapshot to schedule after `interval` (M15 → H1 → H6 → H24), or null. Pure. */
export function nextChained(interval: SnapshotInterval): { interval: SnapshotInterval; delayMs: number } | null {
  const order: SnapshotInterval[] = ['M15', 'H1', 'H6', 'H24'];
  const i = order.indexOf(interval);
  const n = i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
  return n ? (SNAPSHOT_SCHEDULE.find((x) => x.interval === n) ?? null) : null;
}

/**
 * One-time cleanup (v10.32): remove the long-delayed 1 h / 6 h / 24 h snapshot jobs queued under the old schedule (tens of
 * thousands, mostly for dead coins). Runs in the background in pages so the bot keeps working; returns how many it removed.
 */
export async function removeParkedSnapshotJobs(pageSize = 500): Promise<number> {
  let removed = 0;
  for (let start = 0; ; ) {
    const jobs = await observationQueue.getJobs(['delayed'], start, start + pageSize - 1, true);
    if (!jobs.length) break;
    let here = 0;
    for (const j of jobs) {
      if (j && CHAINED.has(j.data.interval)) {
        await j.remove().catch(() => undefined);
        here++;
      }
    }
    removed += here;
    // Removed jobs shift the list: only move on past the ones that stayed.
    start += jobs.length - here;
    await new Promise((r) => setTimeout(r, 50));
  }
  return removed;
}

export class ObservationLogger {
  private worker: Worker<ObservationJob> | null = null;
  snapshotsWritten = 0;

  constructor(private readonly liveState: LiveState) {}

  /**
   * Queue the early snapshots (creation … 15 min) for a new token. The 1 h / 6 h / 24 h ones are chained: each is only
   * scheduled when the previous snapshot finds the coin still alive (v10.32 — 25–40k launches a day each parked three
   * long delayed jobs in Redis for ~24 h, ≈ 66k keys, almost all for coins that died in minutes). Job ids keep it idempotent.
   */
  async scheduleFor(mint: string, createdAtMs: number): Promise<void> {
    const now = Date.now();
    await observationQueue.addBulk(
      SNAPSHOT_SCHEDULE.filter((x) => !CHAINED.has(x.interval)).map(({ interval, delayMs }) => ({
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
    // Still alive (traded recently, or graduated)? → schedule the next long snapshot; dead coins get no more.
    const next = nextChained(interval);
    if (next && stillAlive(view, Date.now())) {
      const delay = Math.max(0, view.createdAtMs + next.delayMs - Date.now());
      await observationQueue.add(next.interval, { mint, interval: next.interval }, { jobId: `${mint}-${next.interval}`, delay });
    }
  }
}
