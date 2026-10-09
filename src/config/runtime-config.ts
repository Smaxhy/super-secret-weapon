/**
 * Runtime config: DEFAULT_CONFIG overlaid with whatever is stored in the
 * BotConfig table. The dashboard (Phase 5) edits the table; the bot picks up
 * changes within REFRESH_MS without restarting.
 *
 * `getConfig()` is synchronous (returns the cached copy) so hot paths never
 * wait on the database.
 */
import type { Prisma } from '@prisma/client';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS, type BotConfigShape, type Weights } from './default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('runtime-config');
const REFRESH_MS = 30_000;

type Section = keyof BotConfigShape;

let current: BotConfigShape = DEFAULT_CONFIG;
let weights: Weights = { ...DEFAULT_WEIGHTS };
let weightsVersion: number | null = null;
let timer: NodeJS.Timeout | null = null;

export function getConfig(): BotConfigShape {
  return current;
}

export function getWeights(): { weights: Weights; version: number | null } {
  return { weights, version: weightsVersion };
}

/** Load from DB now. Failures keep the previous values (never throws). */
export async function refreshConfig(): Promise<void> {
  try {
    const rows = await prisma.botConfig.findMany();
    const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
    for (const row of rows) {
      if (row.key.startsWith('_')) continue; // bookkeeping rows (e.g. _version)
      const def = (DEFAULT_CONFIG as Record<string, unknown>)[row.key];
      // Deep-merge each section so newly added default fields (also nested ones,
      // e.g. a new strategy in `allocation`) still appear. Arrays are replaced.
      merged[row.key] = def !== undefined ? deepMerge(def, row.value) : row.value;
    }
    current = merged as BotConfigShape;

    const active = await prisma.weightSnapshot.findFirst({ where: { active: true }, orderBy: { version: 'desc' } });
    if (active) {
      weights = { ...DEFAULT_WEIGHTS, ...(active.weights as Partial<Weights>) };
      weightsVersion = active.version;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'config refresh failed — keeping previous values');
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Stored values win; objects merge key by key (recursively) so new default keys show up. */
export function deepMerge(def: unknown, stored: unknown): unknown {
  if (!isPlainObject(def) || !isPlainObject(stored)) return stored === undefined ? def : stored;
  const out: Record<string, unknown> = { ...def };
  for (const [k, v] of Object.entries(stored)) out[k] = k in def ? deepMerge(def[k], v) : v;
  return out;
}

/** Merge `patch` into one config section and persist it. */
export async function updateConfigSection<K extends Section>(key: K, patch: Partial<BotConfigShape[K]>): Promise<void> {
  const value = { ...(current[key] as object), ...(patch as object) } as Prisma.InputJsonValue;
  await prisma.botConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  current = { ...current, [key]: value } as BotConfigShape;
}

export async function startConfigRefresh(): Promise<void> {
  await refreshConfig();
  timer = setInterval(() => void refreshConfig(), REFRESH_MS);
}

export function stopConfigRefresh(): void {
  if (timer) clearInterval(timer);
}
