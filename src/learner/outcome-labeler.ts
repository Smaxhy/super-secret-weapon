/**
 * Outcome labeller — closes the learning loop.
 *
 * One hour after an evaluation is stored, look at the best and worst price
 * the token reached since (tracked in Redis on every trade) and write that
 * onto the evaluation: outcomeMax / outcomeMin as multiples of the price at
 * evaluation time. "Win" = it reached 1.8× (our first take-profit).
 *
 * Every label also updates the Bayesian beliefs and the missed-opportunity log.
 */
import { Worker, type Job } from 'bullmq';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { outcomeQueue, QUEUE_NAMES, type OutcomeJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import type { LiveState } from '../scanner/live-state';
import { patternsOf, updateBeliefs, type StoredFeatures } from './bayesian-updater';
import { recordIfMissed } from './missed-opportunity';

const log = moduleLogger('outcome-labeler');
export const OUTCOME_WINDOW_MS = 60 * 60_000;
export const WIN_MULTIPLE = 1.8;

export class OutcomeLabeler {
  private worker: Worker<OutcomeJob> | null = null;
  labeled = 0;

  constructor(private readonly liveState: LiveState) {}

  /** Call right after storing an evaluation. */
  async startWindow(mint: string, evaluationId: string, priceSol: number): Promise<void> {
    await this.liveState.startOutcomeWindow(mint, evaluationId, priceSol);
    await outcomeQueue.add('label', { mint, evaluationId }, { jobId: `outcome-${evaluationId}`, delay: OUTCOME_WINDOW_MS });
  }

  start(): void {
    this.worker = new Worker<OutcomeJob>(QUEUE_NAMES.outcome, (job) => this.process(job), { connection: bullConnection(), concurrency: 4 });
    this.worker.on('failed', (job, err) => log.warn({ mint: job?.data.mint, err: err.message }, 'labelling failed'));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<OutcomeJob>): Promise<void> {
    const { mint, evaluationId } = job.data;
    // A newer evaluation of the same token restarted the window → this one can't be labelled fairly.
    const w = await this.liveState.readOutcomeWindow(mint, evaluationId);
    if (!w || !(w.base > 0)) return;
    const max = Math.max(w.max, w.current) / w.base;
    const min = Math.min(w.min || w.base, w.current) / w.base;

    const ev = await prisma.evaluation.update({
      where: { id: evaluationId },
      data: { outcomeMax: max, outcomeMin: min, outcomeLabeledAt: new Date() },
      select: { decision: true, combinedScore: true, features: true, strategy: true },
    });
    this.labeled++;
    const win = max >= WIN_MULTIPLE;
    await updateBeliefs(patternsOf(ev.features as StoredFeatures, ev.strategy), win);
    await recordIfMissed({ mint, evaluationId, decision: ev.decision, score: ev.combinedScore, max, min });
    log.debug({ mint, decision: ev.decision, max: +max.toFixed(2), min: +min.toFixed(2) }, 'labelled');
  }
}
