/**
 * Small DB/Redis helpers shared by the labeller, the weight adjuster and the API
 * (kept apart so importing them doesn't open BullMQ queues).
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis as defaultRedis } from '../lib/redis';
import { clearBeliefs } from './bayesian-updater';
import { learningSince, type LabelOptions } from './labels';

const log = moduleLogger('learning-data');

/** When the beliefs were last wiped because of a paper reset. */
const BELIEFS_SINCE_KEY = 'learning:beliefsSince';

export function labelOptions(): LabelOptions {
  const l = getConfig().learning ?? DEFAULT_CONFIG.learning;
  return { winMultiple: l.winMultiple, drawdownLossMultiple: l.drawdownLossMultiple, maxPlausibleMultiple: l.maxPlausibleMultiple };
}

/** Did a paper fill on this mint get flagged as suspicious in [from, to]? */
export async function hadSuspiciousFill(mint: string, from: Date, to: Date = new Date()): Promise<boolean> {
  const hit = await prisma.botEvent.findFirst({ where: { type: 'suspicious_fill', mint, createdAt: { gte: from, lte: to } }, select: { id: true } });
  return !!hit;
}

/**
 * After a paper reset, wipe the Bayesian beliefs once so nothing learnt from
 * the old data keeps steering the scorer. Returns the learning start date.
 */
export async function syncResetMarker(r: Redis = defaultRedis): Promise<Date | null> {
  const since = await learningSince(r);
  if (!since) return null;
  try {
    const done = await r.get(BELIEFS_SINCE_KEY);
    if (done !== since.toISOString()) {
      const n = await clearBeliefs();
      await r.set(BELIEFS_SINCE_KEY, since.toISOString());
      log.warn({ since: since.toISOString(), cleared: n }, 'paper reset detected — learned pattern odds start fresh');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'reset marker sync failed');
  }
  return since;
}
