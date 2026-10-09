/**
 * Daily adjuster — every night (00:05 UTC) nudge the scorer's feature weights
 * toward what actually predicted winners.
 *
 * For each feature we compare its average value (0-1) on labelled winners
 * (reached 1.8× within an hour) vs losers over the last 7 days. A feature
 * that's clearly higher on winners gets up to +5% weight, clearly lower up to
 * −5%. Small nudges, bounded (0.4×–2.5× the default), renormalised to sum 1,
 * and every version is saved (WeightSnapshot) so you can see what changed
 * and why — or roll back.
 */
import cron from 'node-cron';
import { DEFAULT_WEIGHTS, type FeatureName, type Weights } from '../config/default';
import { getWeights, refreshConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { WIN_MULTIPLE } from './outcome-labeler';

const log = moduleLogger('daily-adjuster');

const MIN_SAMPLES = 100;
const MIN_WINS = 10;
const MAX_STEP = 0.05;
/** How strongly a winner/loser difference turns into a weight change. */
const SENSITIVITY = 0.5;

export interface WeightChange {
  feature: FeatureName;
  from: number;
  to: number;
  winnersAvg: number;
  losersAvg: number;
}

/** Pure: compute new weights from labelled samples. Exported for tests. */
export function adjustWeights(
  current: Weights,
  samples: Array<{ features: Partial<Record<FeatureName, number>>; win: boolean }>,
  defaults: Weights = { ...DEFAULT_WEIGHTS },
): { weights: Weights; changes: WeightChange[]; wins: number; total: number } | null {
  const wins = samples.filter((s) => s.win);
  const losses = samples.filter((s) => !s.win);
  if (samples.length < MIN_SAMPLES || wins.length < MIN_WINS || losses.length < MIN_WINS) return null;

  const avg = (list: typeof samples, f: FeatureName) => list.reduce((s, x) => s + (x.features[f] ?? 0.5), 0) / list.length;
  const raw = {} as Weights;
  const stats = {} as Record<FeatureName, { w: number; l: number }>;
  for (const f of Object.keys(current) as FeatureName[]) {
    const w = avg(wins, f);
    const l = avg(losses, f);
    stats[f] = { w, l };
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, (w - l) * SENSITIVITY));
    const bounded = Math.max(defaults[f] * 0.4, Math.min(defaults[f] * 2.5, current[f] * (1 + step)));
    raw[f] = bounded;
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const weights = {} as Weights;
  const changes: WeightChange[] = [];
  for (const f of Object.keys(raw) as FeatureName[]) {
    weights[f] = Math.round((raw[f] / total) * 10_000) / 10_000;
    if (Math.abs(weights[f] - current[f]) >= 0.0005) changes.push({ feature: f, from: current[f], to: weights[f], winnersAvg: stats[f].w, losersAvg: stats[f].l });
  }
  changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return { weights, changes, wins: wins.length, total: samples.length };
}

/** Run one adjustment now (cron or dashboard button). */
export async function runDailyAdjustment(trigger: 'nightly' | 'manual'): Promise<{ ok: boolean; message: string }> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const rows = await prisma.evaluation.findMany({
    where: { outcomeLabeledAt: { not: null }, createdAt: { gte: since } },
    select: { features: true, outcomeMax: true },
    orderBy: { createdAt: 'desc' },
    take: 20_000,
  });
  const samples = rows.map((r) => ({
    features: ((r.features as { features?: Partial<Record<FeatureName, number>> })?.features ?? {}) as Partial<Record<FeatureName, number>>,
    win: (r.outcomeMax ?? 0) >= WIN_MULTIPLE,
  }));
  const { weights: current, version } = getWeights();
  const result = adjustWeights(current, samples);
  if (!result) {
    const msg = `Not enough labelled data yet (${samples.length} samples, ${samples.filter((s) => s.win).length} winners; need ${MIN_SAMPLES}+ with ${MIN_WINS}+ winners and losers)`;
    log.info(msg);
    return { ok: false, message: msg };
  }

  const nextVersion = (await prisma.weightSnapshot.aggregate({ _max: { version: true } }))._max.version ?? 0;
  await prisma.$transaction([
    prisma.weightSnapshot.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.weightSnapshot.create({
      data: {
        version: nextVersion + 1,
        weights: result.weights,
        changes: result.changes as unknown as object,
        reason: `${trigger}: ${result.total} labelled tokens, ${result.wins} reached ${WIN_MULTIPLE}× (previous v${version ?? 0})`,
        active: true,
      },
    }),
  ]);
  await refreshConfig();
  const top = result.changes.slice(0, 3).map((c) => `${c.feature} ${c.to > c.from ? '↑' : '↓'}`).join(', ');
  const msg = `Weights v${nextVersion + 1}: ${result.changes.length} changed${top ? ` (${top})` : ''}`;
  log.info(msg);
  void recordEvent({ module: 'learner', type: 'weights_adjusted', message: msg, data: { version: nextVersion + 1 } });
  return { ok: true, message: msg };
}

export function scheduleDailyAdjuster(): ReturnType<typeof cron.schedule> {
  return cron.schedule('5 0 * * *', () => void runDailyAdjustment('nightly').catch((err: Error) => log.error({ err: err.message }, 'nightly adjustment failed')), { timezone: 'UTC' });
}
