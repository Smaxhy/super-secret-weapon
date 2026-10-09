/**
 * Outcome labeller — closes the learning loop.
 *
 * After an evaluation is stored we sample its price window (best / worst
 * price since, tracked in Redis on every trade) at a series of "peeks"
 * during the next hour (1, 3, 6 … 60 min). That tells us not just HOW HIGH
 * it went but whether it got there BEFORE dumping. The final peek writes the
 * label (see labels.ts):
 *   WIN  = reached 1.8× before ever dropping to 0.7× (you could have banked it)
 *   LOSS = everything else
 * plus time-to-peak and max drawdown, stored on the evaluation as
 * `features.outcome`. outcomeMax / outcomeMin keep their meaning (multiples).
 *
 * When a position we opened fully closes, its realised P&L (after every fee)
 * is stored as `features.tradeResult` — that beats the price guess for
 * learning. Suspicious price data and anything before the last paper reset
 * are excluded from all learning.
 *
 * Every (non-excluded) label also updates the Bayesian beliefs, the keyword
 * learner and the missed-opportunity log.
 */
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { bus, type BusEvent } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { outcomeQueue, QUEUE_NAMES, type OutcomeJob } from '../lib/queues';
import { bullConnection, redis as defaultRedis } from '../lib/redis';
import type { LiveState } from '../scanner/live-state';
import { patternsOf, updateBeliefs, type StoredFeatures } from './bayesian-updater';
import { hadSuspiciousFill, labelOptions, syncResetMarker } from './learning-data';

import { recordKeywordOutcome } from './keyword-learner';
import { learnFromLabel } from './wallet-reputation';
import { emptyPath, labelFromPath, PEEK_MINUTES, resolveLabel, tradeOutcome, updatePath, type LabelOptions, type PathState, type PriceOutcome, type TradeOutcome } from './labels';
import { recordIfMissed } from './missed-opportunity';

export { hadSuspiciousFill, labelOptions, syncResetMarker } from './learning-data';

const log = moduleLogger('outcome-labeler');
export const OUTCOME_WINDOW_MS = 60 * 60_000;
/** Default win multiple (the live value is `learning.winMultiple` in config). */
export const WIN_MULTIPLE = DEFAULT_CONFIG.learning.winMultiple;

const pathKey = (evaluationId: string) => `outcome:path:${evaluationId}`;

export class OutcomeLabeler {
  private worker: Worker<OutcomeJob> | null = null;
  private busListener: ((e: BusEvent) => void) | null = null;
  readonly stats = { labeled: 0, wins: 0, losses: 0, excluded: 0, tradeResults: 0 };
  /** Called after a closed position's result is stored (index.ts wires the weight adjuster here). */
  afterTradeClosed: (() => void) | null = null;

  constructor(
    private readonly liveState: LiveState,
    private readonly redis: Redis = defaultRedis,
  ) {}

  get labeled(): number {
    return this.stats.labeled;
  }

  /** Call right after storing an evaluation. */
  async startWindow(mint: string, evaluationId: string, priceSol: number): Promise<void> {
    await this.liveState.startOutcomeWindow(mint, evaluationId, priceSol);
    await outcomeQueue.add('peek-0', { mint, evaluationId }, { jobId: `outcome-${evaluationId}-p0`, delay: PEEK_MINUTES[0] * 60_000 });
  }

  start(): void {
    this.worker = new Worker<OutcomeJob>(QUEUE_NAMES.outcome, (job) => this.process(job), { connection: bullConnection(), concurrency: 4 });
    this.worker.on('failed', (job, err) => log.warn({ mint: job?.data.mint, err: err.message }, 'labelling failed'));
    // A position fully closed → store its real result on the evaluation that opened it.
    this.busListener = (e) => {
      if (e.type !== 'trade' || e.data.side !== 'SELL' || !e.data.closed) return;
      void this.onTradeClosed(e.data.mint)
        .then((ok) => ok && this.afterTradeClosed?.())
        .catch((err: Error) => log.warn({ mint: e.data.mint, err: err.message }, 'trade result labelling failed'));
    };
    bus.on('event', this.busListener);
  }

  async stop(): Promise<void> {
    if (this.busListener) bus.off('event', this.busListener);
    await this.worker?.close();
  }

  private async process(job: Job<OutcomeJob>): Promise<void> {
    const { mint, evaluationId } = job.data;
    // Jobs queued before this version were a single 'label' job at +1h (no path → coarse label).
    const stage = job.name === 'label' ? PEEK_MINUTES.length - 1 : Number(job.name.replace('peek-', ''));
    if (!Number.isInteger(stage) || stage < 0 || stage >= PEEK_MINUTES.length) return;
    const coarse = job.name === 'label';

    // A newer evaluation of the same token restarted the window → this one can't be labelled fairly.
    const w = await this.liveState.readOutcomeWindow(mint, evaluationId);
    if (!w || !(w.base > 0)) {
      await this.redis.del(pathKey(evaluationId));
      return;
    }
    const maxM = Math.max(w.max, w.current) / w.base;
    const minM = Math.min(w.min || w.base, w.current) / w.base;
    const opts = labelOptions();
    const raw = await this.redis.get(pathKey(evaluationId));
    const prev = raw ? (JSON.parse(raw) as PathState) : emptyPath();
    const minute = PEEK_MINUTES[stage] ?? 60;
    const path = updatePath(prev, maxM, minM, minute, opts);

    const nextMinute = PEEK_MINUTES[stage + 1];
    if (nextMinute !== undefined) {
      await this.redis.set(pathKey(evaluationId), JSON.stringify(path), 'EX', 2 * 3600);
      const next = stage + 1;
      await outcomeQueue.add(`peek-${next}`, { mint, evaluationId }, { jobId: `outcome-${evaluationId}-p${next}`, delay: (nextMinute - minute) * 60_000 });
      return;
    }
    await this.redis.del(pathKey(evaluationId));
    await this.label(mint, evaluationId, path, opts, coarse);
  }

  private async label(mint: string, evaluationId: string, path: PathState, opts: LabelOptions, coarse: boolean): Promise<void> {
    const ev = await prisma.evaluation.findUnique({
      where: { id: evaluationId },
      select: { decision: true, combinedScore: true, features: true, strategy: true, createdAt: true, token: { select: { name: true, symbol: true, description: true } } },
    });
    if (!ev) return;
    const since = await syncResetMarker(this.redis);
    const outcome: PriceOutcome = labelFromPath(path, opts, coarse);
    if (!outcome.excluded && since && ev.createdAt < since) outcome.excluded = 'before_reset';
    if (!outcome.excluded && (await hadSuspiciousFill(mint, new Date(ev.createdAt.getTime() - OUTCOME_WINDOW_MS)))) outcome.excluded = 'suspicious_fill';

    const feats = (ev.features ?? {}) as StoredFeatures & { tradeResult?: TradeOutcome; [k: string]: unknown };
    await prisma.evaluation.update({
      where: { id: evaluationId },
      data: {
        // Excluded rows keep max/min empty so regime / hit-rate stats don't count bad data either.
        outcomeMax: outcome.excluded ? null : path.max,
        outcomeMin: outcome.excluded ? null : path.min,
        outcomeLabeledAt: new Date(),
        features: { ...feats, outcome } as unknown as Prisma.InputJsonValue,
      },
    });
    this.stats.labeled++;
    if (outcome.excluded) {
      this.stats.excluded++;
      log.debug({ mint, reason: outcome.excluded }, 'outcome excluded from learning');
      return;
    }

    const res = resolveLabel(
      { outcome, tradeResult: feats.tradeResult ?? null, outcomeMax: path.max, outcomeMin: path.min, createdAt: ev.createdAt, mint },
      { ...opts, since, suspiciousMints: new Set() },
    );
    if ('excluded' in res) {
      this.stats.excluded++;
      return;
    }
    if (res.win) this.stats.wins++;
    else this.stats.losses++;
    const ownBuy = ev.decision === 'BUY';
    const lc = getConfig().learning ?? DEFAULT_CONFIG.learning;
    await updateBeliefs(patternsOf(feats, ev.strategy), res.win);
    // Who was buying when we scored it? Credit / debit those wallets (smart-wallet learning).
    await learnFromLabel(this.redis, evaluationId, res.win);
    if (ev.token) {
      await recordKeywordOutcome(this.redis, { name: ev.token.name, symbol: ev.token.symbol, description: ev.token.description }, res.win, ownBuy ? lc.ownBuyWeight : 1).catch((err: Error) =>
        log.warn({ mint, err: err.message }, 'keyword learning failed'),
      );
    }
    await recordIfMissed({ mint, evaluationId, decision: ev.decision, score: ev.combinedScore, max: path.max, min: path.min });
    log.debug({ mint, decision: ev.decision, win: res.win, source: res.source, max: +path.max.toFixed(2), min: +path.min.toFixed(2), ttp: outcome.timeToPeakMin }, 'labelled');
  }

  /** Store the realised result of the latest closed position on this mint. true = stored. */
  async onTradeClosed(mint: string): Promise<boolean> {
    const p = await prisma.position.findFirst({
      where: { mint, status: 'CLOSED', evaluationId: { not: null } },
      orderBy: { closedAt: 'desc' },
      select: { evaluationId: true, realizedPnlSol: true, sizeSol: true, peakPriceSol: true, entryPriceSol: true, openedAt: true, closedAt: true },
    });
    if (!p?.evaluationId || !p.closedAt) return false;
    const suspicious = await hadSuspiciousFill(mint, new Date(p.openedAt.getTime() - 60_000), new Date(p.closedAt.getTime() + 60_000));
    const t = tradeOutcome(
      { realizedPnlSol: p.realizedPnlSol, sizeSol: p.sizeSol, peakMultiple: p.entryPriceSol > 0 ? p.peakPriceSol / p.entryPriceSol : null, closedAt: p.closedAt, suspicious },
      labelOptions(),
    );
    const ev = await prisma.evaluation.findUnique({ where: { id: p.evaluationId }, select: { features: true } });
    if (!ev) return false;
    await prisma.evaluation.update({
      where: { id: p.evaluationId },
      data: { features: { ...((ev.features ?? {}) as object), tradeResult: t } as unknown as Prisma.InputJsonValue },
    });
    this.stats.tradeResults++;
    log.debug({ mint, win: t.win, pnlPct: t.pnlPct, excluded: t.excluded }, 'trade result stored for learning');
    return true;
  }
}
