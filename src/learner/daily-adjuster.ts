/**
 * Weight adjuster — nudges the scorer's feature weights toward what actually
 * predicted winners.
 *
 * When: every 20 minutes (config `learning.adjustEveryMinutes`), AND shortly
 * after any position fully closes (debounced: at most once per
 * `learning.minMinutesBetweenAdjustments`), plus the dashboard button.
 *
 * Data: labelled evaluations from the last 7 days, never before the last paper
 * reset, with bad data (suspicious fills, implausible pumps) excluded. A label
 * is the realised trade result when we bought, else the risk-aware price label
 * (labels.ts). Recent outcomes count more (half-life 24h), our own buys 3×.
 *
 * Safeguard: the newest N labelled evaluations are held out. The new weights
 * must rank them at least as well (AUC) as the current ones, otherwise the step
 * is rejected. Accepted versions are saved as WeightSnapshot (roll-back-able);
 * every attempt (accepted or rejected) is kept in Redis for the dashboard.
 *
 * Maths: weight-tuning.ts.
 */
import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, type FeatureName } from '../config/default';
import { getConfig, getWeights, refreshConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis as defaultRedis } from '../lib/redis';
import { resolveLabel, type ExcludeReason, type PriceOutcome, type TradeOutcome } from './labels';
import { labelOptions, syncResetMarker } from './learning-data';
import { adjustWeights, holdoutCheck, nextCronAt, tuningOptions, type TuningSample } from './weight-tuning';

export { adjustWeights, type WeightChange } from './weight-tuning';

const log = moduleLogger('weight-adjuster');

export const STEPS_KEY = 'learning:steps';
export const LAST_ADJUST_KEY = 'learning:lastAdjustAt';
const MAX_STEPS_KEPT = 50;

export type AdjustTrigger = 'scheduled' | 'manual' | 'trade_closed';

/** One adjustment attempt, as shown on the Learning page. */
export interface AdjustmentStep {
  at: string;
  trigger: AdjustTrigger;
  accepted: boolean;
  /** WeightSnapshot version created (accepted only). */
  version: number | null;
  aucBefore: number | null;
  aucAfter: number | null;
  holdoutNote: string | null;
  train: number;
  holdout: number;
  wins: number;
  losses: number;
  excluded: number;
  evidence: number;
  changes: Array<{ feature: FeatureName; from: number; to: number }>;
  message: string;
}

let running = false;
let lastRunAt = 0;
let pending: NodeJS.Timeout | null = null;
let pendingAt: number | null = null;

const learningCfg = () => getConfig().learning ?? DEFAULT_CONFIG.learning;

/** Row shape read with raw SQL (only the small JSON parts, not the whole features blob). */
interface Row {
  mint: string;
  decision: string;
  createdAt: Date;
  outcomeMax: number | null;
  outcomeMin: number | null;
  f: Partial<Record<FeatureName, number>> | null;
  o: Partial<PriceOutcome> | null;
  t: Partial<TradeOutcome> | null;
}

export interface LabelledSet {
  /** Newest first. */
  samples: TuningSample[];
  wins: number;
  losses: number;
  excluded: number;
  excludedBy: Partial<Record<ExcludeReason, number>>;
  fromTrades: number;
  since: Date;
}

/** Load + resolve every usable label in the learning window. Shared with the API's label stats. */
export async function loadLabelled(r: Redis = defaultRedis, withFeatures = true): Promise<LabelledSet> {
  const l = learningCfg();
  const resetAt = await syncResetMarker(r);
  const windowStart = new Date(Date.now() - l.lookbackDays * 24 * 3600_000);
  const since = resetAt && resetAt > windowStart ? resetAt : windowStart;
  const rows = withFeatures
    ? await prisma.$queryRaw<Row[]>`
        SELECT mint, decision::text AS decision, "createdAt", "outcomeMax", "outcomeMin",
               features->'features' AS f, features->'outcome' AS o, features->'tradeResult' AS t
        FROM "Evaluation"
        WHERE "outcomeLabeledAt" IS NOT NULL AND "createdAt" >= ${since}
          AND (strategy IS NULL OR strategy::text <> 'SWING')
        ORDER BY "createdAt" DESC LIMIT 20000`
    : await prisma.$queryRaw<Row[]>`
        SELECT mint, decision::text AS decision, "createdAt", "outcomeMax", "outcomeMin",
               NULL::jsonb AS f, features->'outcome' AS o, features->'tradeResult' AS t
        FROM "Evaluation"
        WHERE "outcomeLabeledAt" IS NOT NULL AND "createdAt" >= ${since}
        ORDER BY "createdAt" DESC LIMIT 20000`;
  const suspicious = await prisma.botEvent.findMany({
    where: { type: 'suspicious_fill', createdAt: { gte: new Date(since.getTime() - 3600_000) }, mint: { not: null } },
    select: { mint: true },
    distinct: ['mint'],
  });
  const ctx = { ...labelOptions(), since: resetAt, suspiciousMints: new Set(suspicious.map((s) => s.mint!)) };
  const now = Date.now();
  const out: LabelledSet = { samples: [], wins: 0, losses: 0, excluded: 0, excludedBy: {}, fromTrades: 0, since };
  for (const row of rows) {
    const res = resolveLabel({ outcome: row.o, tradeResult: row.t, outcomeMax: row.outcomeMax, outcomeMin: row.outcomeMin, createdAt: new Date(row.createdAt), mint: row.mint }, ctx);
    if ('excluded' in res) {
      out.excluded++;
      out.excludedBy[res.excluded] = (out.excludedBy[res.excluded] ?? 0) + 1;
      continue;
    }
    if (res.win) out.wins++;
    else out.losses++;
    if (res.source === 'trade') out.fromTrades++;
    out.samples.push({
      features: row.f ?? {},
      win: res.win,
      ownBuy: row.decision === 'BUY',
      ageHours: (now - new Date(row.createdAt).getTime()) / 3600_000,
    });
  }
  return out;
}

async function pushStep(r: Redis, step: AdjustmentStep): Promise<void> {
  try {
    await r.lpush(STEPS_KEY, JSON.stringify(step));
    await r.ltrim(STEPS_KEY, 0, MAX_STEPS_KEPT - 1);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not store adjustment step');
  }
}

export async function recentSteps(r: Redis = defaultRedis, limit = 20): Promise<AdjustmentStep[]> {
  try {
    return (await r.lrange(STEPS_KEY, 0, limit - 1)).map((s) => JSON.parse(s) as AdjustmentStep);
  } catch {
    return [];
  }
}

/** Run one adjustment now. */
export async function runAdjustment(trigger: AdjustTrigger, r: Redis = defaultRedis): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'An adjustment is already running' };
  running = true;
  lastRunAt = Date.now();
  try {
    await r.set(LAST_ADJUST_KEY, new Date(lastRunAt).toISOString()).catch(() => undefined);
    const l = learningCfg();
    const o = tuningOptions(l);
    const set = await loadLabelled(r);
    // Newest N held out for the safety check (at most a quarter of the data).
    const h = Math.min(l.holdoutSize, Math.floor(set.samples.length * 0.25));
    const holdout = set.samples.slice(0, h);
    const train = set.samples.slice(h);
    const { weights: current, version } = getWeights();
    const result = adjustWeights(current, train, undefined, o);
    if (!result) {
      const msg = `Not enough clean labelled data yet (${train.length} to train on: ${train.filter((s) => s.win).length} wins; need ${o.minSamples}+ with ${o.minPerClass}+ wins and losses; ${set.excluded} excluded)`;
      log.info(msg);
      return { ok: false, message: msg };
    }
    const verdict = holdoutCheck(current, result.weights, holdout, l.minHoldoutPerClass);
    const step: AdjustmentStep = {
      at: new Date().toISOString(),
      trigger,
      accepted: verdict.accepted && result.changes.length > 0,
      version: null,
      aucBefore: verdict.aucBefore,
      aucAfter: verdict.aucAfter,
      holdoutNote: verdict.skipped ?? null,
      train: train.length,
      holdout: holdout.length,
      wins: set.wins,
      losses: set.losses,
      excluded: set.excluded,
      evidence: result.evidence,
      changes: result.changes.slice(0, 8).map((c) => ({ feature: c.feature, from: c.from, to: c.to })),
      message: '',
    };
    const aucTxt = verdict.aucBefore !== null ? `AUC ${verdict.aucBefore.toFixed(3)} → ${verdict.aucAfter?.toFixed(3)}` : 'no holdout check';

    if (!verdict.accepted) {
      step.message = `Rejected: new weights ranked the newest ${holdout.length} tokens worse (${aucTxt})`;
      log.info(step.message);
      await pushStep(r, step);
      return { ok: false, message: step.message };
    }
    if (!result.changes.length) {
      step.message = `No meaningful change (${aucTxt})`;
      await pushStep(r, step);
      return { ok: true, message: step.message };
    }

    const nextVersion = ((await prisma.weightSnapshot.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
    await prisma.$transaction([
      prisma.weightSnapshot.updateMany({ where: { active: true }, data: { active: false } }),
      prisma.weightSnapshot.create({
        data: {
          version: nextVersion,
          weights: result.weights,
          changes: result.changes as unknown as object,
          reason: `${trigger}: ${train.length} clean labels (${set.wins} wins / ${set.losses} losses, ${set.fromTrades} from real trades, ${set.excluded} excluded), evidence ${(result.evidence * 100).toFixed(0)}%, ${aucTxt} (previous v${version ?? 0})`,
          active: true,
        },
      }),
    ]);
    await refreshConfig();
    const top = result.changes.slice(0, 3).map((c) => `${c.feature} ${c.to > c.from ? '↑' : '↓'}`).join(', ');
    step.version = nextVersion;
    step.message = `Weights v${nextVersion}: ${result.changes.length} changed${top ? ` (${top})` : ''}, ${aucTxt}`;
    log.info(step.message);
    await pushStep(r, step);
    void recordEvent({ module: 'learner', type: 'weights_adjusted', message: step.message, data: { version: nextVersion, trigger, aucBefore: verdict.aucBefore, aucAfter: verdict.aucAfter } });
    return { ok: true, message: step.message };
  } finally {
    running = false;
  }
}

/** Back-compat name (dashboard button / older callers). */
export const runDailyAdjustment = (trigger: 'scheduled' | 'manual') => runAdjustment(trigger);

/**
 * A position just closed → adjust soon, but at most once per
 * `minMinutesBetweenAdjustments` (several closes in a row → one run).
 */
export function requestAdjustment(trigger: AdjustTrigger = 'trade_closed'): void {
  if (pending) return;
  const gap = learningCfg().minMinutesBetweenAdjustments * 60_000;
  const delay = Math.max(5_000, lastRunAt + gap - Date.now());
  pendingAt = Date.now() + delay;
  pending = setTimeout(() => {
    pending = null;
    pendingAt = null;
    void runAdjustment(trigger).catch((err: Error) => log.error({ err: err.message }, 'adjustment failed'));
  }, delay);
  pending.unref?.();
}

/** For the API: last run (persisted) and when the next one is due. */
export async function adjusterTimes(r: Redis = defaultRedis): Promise<{ lastAdjustAt: string | null; nextAdjustAt: string; pendingAfterTrade: boolean }> {
  let last: string | null = lastRunAt ? new Date(lastRunAt).toISOString() : null;
  if (!last) last = await r.get(LAST_ADJUST_KEY).catch(() => null);
  const cronNext = nextCronAt(Date.now(), learningCfg().adjustEveryMinutes);
  const next = pendingAt !== null ? Math.min(pendingAt, cronNext) : cronNext;
  return { lastAdjustAt: last, nextAdjustAt: new Date(next).toISOString(), pendingAfterTrade: pendingAt !== null };
}

export function scheduleDailyAdjuster(r: Redis = defaultRedis): { stop(): void } {
  void r
    .get(LAST_ADJUST_KEY)
    .then((v) => {
      const t = v ? Date.parse(v) : NaN;
      if (Number.isFinite(t) && !lastRunAt) lastRunAt = t;
    })
    .catch(() => undefined);
  const every = Math.max(1, Math.min(59, Math.floor(learningCfg().adjustEveryMinutes)));
  const task = cron.schedule(
    `*/${every} * * * *`,
    () => {
      // A trade-close run just happened → skip this tick.
      if (Date.now() - lastRunAt < learningCfg().minMinutesBetweenAdjustments * 60_000) return;
      void runAdjustment('scheduled', r).catch((err: Error) => log.error({ err: err.message }, 'scheduled adjustment failed'));
    },
    { timezone: 'UTC' },
  );
  return {
    stop() {
      void task.stop();
      if (pending) clearTimeout(pending);
      pending = null;
      pendingAt = null;
    },
  };
}
