/**
 * Daily adjuster — nudges the scorer weights towards whatever actually predicted
 * good outcomes over the last week.
 *
 * Once a day (00:10 UTC) it gathers every resolved outcome (from the outcome
 * tracker) and every closed trade, each with the 0-1 feature vector the scorer
 * saw at decision time. For every feature it measures the separation
 *
 *     mean(feature | good outcome) − mean(feature | bad outcome)
 *
 * A feature that's clearly higher on winners gets a little more weight, one
 * that's higher on losers gets less. Moves are capped per day and weights are
 * kept inside a band, then renormalised to sum to 1, so the scorer can drift
 * towards the data but can never be yanked by one strange day. Each change is
 * stored as a new active WeightSnapshot with a human-readable `changes` list.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { DEFAULT_WEIGHTS, type FeatureName, type Weights } from '../config/default';
import { getConfig, getWeights, refreshConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('daily-adjuster');

export interface OutcomeSample {
  features: Partial<Record<FeatureName, number>>;
  good: boolean;
}

export interface WeightChange {
  feature: FeatureName;
  from: number;
  to: number;
  separation: number;
}

export interface AdjusterLimits {
  maxWeightStepPct: number;
  weightFloor: number;
  weightCeiling: number;
  adjusterMinSamples: number;
}

/** Pure: compute new weights from outcome samples. Returns null when there isn't enough evidence. */
export function adjustWeights(current: Weights, samples: OutcomeSample[], limits: AdjusterLimits): { weights: Weights; changes: WeightChange[]; good: number; bad: number } | null {
  const good = samples.filter((s) => s.good);
  const bad = samples.filter((s) => !s.good);
  if (samples.length < limits.adjusterMinSamples || good.length < 5 || bad.length < 5) return null;

  const names = Object.keys(DEFAULT_WEIGHTS) as FeatureName[];
  const mean = (rows: OutcomeSample[], n: FeatureName) => {
    const vals = rows.map((r) => r.features[n]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const next = { ...current };
  const changes: WeightChange[] = [];
  for (const n of names) {
    const g = mean(good, n);
    const b = mean(bad, n);
    if (g === null || b === null) continue;
    const separation = g - b; // −1..1
    // ±0.5 separation (a very strong signal) saturates the daily step.
    const step = Math.max(-1, Math.min(1, separation * 2)) * (limits.maxWeightStepPct / 100);
    const from = current[n] ?? DEFAULT_WEIGHTS[n];
    const to = Math.max(limits.weightFloor, Math.min(limits.weightCeiling, from * (1 + step)));
    next[n] = to;
    if (Math.abs(to - from) > 1e-6) changes.push({ feature: n, from, to, separation: round4(separation) });
  }

  const total = names.reduce((s, n) => s + next[n], 0) || 1;
  for (const n of names) next[n] = round4(next[n] / total);
  for (const c of changes) c.to = next[c.feature];
  return { weights: next, changes: changes.filter((c) => Math.abs(c.to - c.from) > 1e-6), good: good.length, bad: bad.length };
}

interface StoredEvalFeatures {
  features?: Partial<Record<FeatureName, number>>;
}

export class DailyAdjuster {
  private task: ScheduledTask | null = null;

  constructor(private readonly mode: 'PAPER' | 'LIVE') {}

  start(): void {
    this.task = cron.schedule('10 0 * * *', () => void this.run(), { timezone: 'UTC' });
  }

  stop(): void {
    void this.task?.stop();
  }

  /** Collect last-N-days samples from resolved outcomes and closed trades. */
  async collectSamples(): Promise<OutcomeSample[]> {
    const { learning } = getConfig();
    const since = new Date(Date.now() - learning.adjusterLookbackDays * 24 * 60 * 60_000);
    const [outcomes, positions] = await Promise.all([
      prisma.missedOpportunity.findMany({ where: { createdAt: { gte: since }, evaluationId: { not: null } }, select: { evaluationId: true, outcome: true } }),
      prisma.position.findMany({ where: { mode: this.mode, status: 'CLOSED', closedAt: { gte: since }, evaluationId: { not: null } }, select: { evaluationId: true, realizedPnlSol: true } }),
    ]);
    const ids = new Set<string>();
    for (const o of outcomes) if (o.evaluationId) ids.add(o.evaluationId);
    for (const p of positions) if (p.evaluationId) ids.add(p.evaluationId);
    if (ids.size === 0) return [];
    const evals = await prisma.evaluation.findMany({ where: { id: { in: [...ids] } }, select: { id: true, features: true } });
    const byId = new Map(evals.map((e) => [e.id, (e.features as StoredEvalFeatures | null)?.features ?? null]));

    const samples: OutcomeSample[] = [];
    const tradedIds = new Set(positions.map((p) => p.evaluationId!));
    for (const o of outcomes) {
      // Traded tokens are judged by their realised P&L below, not by the token's path.
      if (!o.evaluationId || tradedIds.has(o.evaluationId)) continue;
      const f = byId.get(o.evaluationId);
      if (f) samples.push({ features: f, good: o.outcome === 'PUMPED' || o.outcome === 'COMPLETED' });
    }
    for (const p of positions) {
      const f = byId.get(p.evaluationId!);
      if (f) samples.push({ features: f, good: p.realizedPnlSol > 0 });
    }
    return samples;
  }

  async run(): Promise<void> {
    try {
      const samples = await this.collectSamples();
      const { learning } = getConfig();
      const { weights: current, version } = getWeights();
      const result = adjustWeights(current, samples, learning);
      if (!result) {
        log.info({ samples: samples.length, need: learning.adjusterMinSamples }, 'daily adjuster: not enough resolved outcomes yet — weights unchanged');
        return;
      }
      if (result.changes.length === 0) {
        log.info({ samples: samples.length }, 'daily adjuster: no feature separation worth acting on');
        return;
      }
      const latest = await prisma.weightSnapshot.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      const nextVersion = (latest?.version ?? version ?? 0) + 1;
      const reason = `daily adjuster: ${samples.length} outcomes (${result.good} good / ${result.bad} bad) over ${learning.adjusterLookbackDays}d`;
      await prisma.$transaction([
        prisma.weightSnapshot.updateMany({ where: { active: true }, data: { active: false } }),
        prisma.weightSnapshot.create({ data: { version: nextVersion, weights: result.weights, changes: JSON.parse(JSON.stringify(result.changes)), reason, active: true } }),
      ]);
      await refreshConfig();
      const summary = result.changes
        .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
        .slice(0, 5)
        .map((c) => `${c.feature} ${c.from.toFixed(3)}→${c.to.toFixed(3)}`)
        .join(', ');
      log.info({ version: nextVersion, changes: result.changes.length }, `🧠 weights v${nextVersion}: ${summary}`);
      await recordEvent({ module: 'learner', type: 'weights_adjusted', message: `Weights v${nextVersion}: ${summary}`, data: { reason, changes: JSON.parse(JSON.stringify(result.changes)) } });
      bus.publish({ type: 'weights_adjusted', data: { message: `Weights v${nextVersion}: ${reason}\n${summary}`, changes: result.changes } });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'daily adjuster failed');
    }
  }
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
