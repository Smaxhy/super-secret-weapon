/**
 * "What the bot changed" — every adjustment the learners make to how it trades, in plain words, so the owner
 * can see the bot acting on what it found (Redis list `changes:log`, newest first, last 200).
 */
import { redis } from './redis';
import { moduleLogger } from './logger';

const log = moduleLogger('changes');
const KEY = 'changes:log';

export interface Change {
  at: string;
  /** autopsy | entry-style | ai-coach | strategy-lab | … */
  source: string;
  strategy: string | null;
  what: string;
  why: string;
}

export async function recordChange(c: Omit<Change, 'at'>, now = Date.now()): Promise<void> {
  const row: Change = { at: new Date(now).toISOString(), ...c };
  log.info({ source: c.source, strategy: c.strategy }, `🔧 ${c.what} — ${c.why}`);
  try {
    await redis.multi().lpush(KEY, JSON.stringify(row)).ltrim(KEY, 0, 199).exec();
  } catch {
    /* best effort */
  }
}

export async function recentChanges(limit = 50): Promise<Change[]> {
  const raw = await redis.lrange(KEY, 0, Math.max(0, limit - 1));
  return raw.flatMap((x) => {
    try {
      return [JSON.parse(x) as Change];
    } catch {
      return [];
    }
  });
}

/** Pure: what changed between two per-strategy setting lists (keyed by strategy), as readable lines. */
export function diffByStrategy<T extends { strategy: string }>(
  before: readonly T[],
  after: readonly T[],
  describe: (x: T | undefined) => string,
): Array<{ strategy: string; from: string; to: string }> {
  const keys = new Set([...before.map((x) => x.strategy), ...after.map((x) => x.strategy)]);
  const out: Array<{ strategy: string; from: string; to: string }> = [];
  for (const k of keys) {
    const a = describe(before.find((x) => x.strategy === k));
    const b = describe(after.find((x) => x.strategy === k));
    if (a !== b) out.push({ strategy: k, from: a, to: b });
  }
  return out;
}
