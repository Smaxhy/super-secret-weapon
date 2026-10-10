/**
 * Bot health — so "it keeps going offline" has an answer on the dashboard.
 *
 * Records every start, every clean stop and every fatal error in Redis:
 *   bot:running    set while the process runs; still there at the next start
 *                  → the previous run died without shutting down (killed —
 *                  usually out of memory — or crashed hard)
 *   bot:lastExit   { at, reason } of the previous run
 *   bot:starts     start times (last 50)
 *   bot:errors     last 20 serious errors
 * `healthSnapshot()` adds memory, Redis memory and event-loop lag for /api/health.
 */
import type { Redis } from 'ioredis';
import { eventLoopLagMs } from './process-guard';
import { blockerSnapshot, type BlockerSnapshot } from './entry-blockers';

const K_RUNNING = 'bot:running';
const K_LAST_EXIT = 'bot:lastExit';
const K_STARTS = 'bot:starts';
const K_ERRORS = 'bot:errors';

/** Git commit baked into the Docker image (scripts/auto-update.sh passes it). */
export const BOT_VERSION = (process.env.GIT_SHA ?? '').slice(0, 7) || 'dev';

let redisRef: Redis | null = null;
/** Process start (same value the WebSocket 'hello' reports). */
const startedAt = Date.now() - Math.round(process.uptime() * 1000);

export async function recordStart(redis: Redis, now = Date.now()): Promise<{ lastExit: { at: string; reason: string } | null }> {
  redisRef = redis;
  const prevRunning = await redis.get(K_RUNNING);
  let lastExit = parse<{ at: string; reason: string }>(await redis.get(K_LAST_EXIT));
  if (prevRunning) {
    // The previous run never reached its shutdown handler.
    lastExit = { at: new Date(now).toISOString(), reason: 'killed or crashed without shutting down (often: out of memory)' };
    await redis.set(K_LAST_EXIT, JSON.stringify(lastExit));
  }
  await redis.multi().set(K_RUNNING, String(now)).lpush(K_STARTS, String(now)).ltrim(K_STARTS, 0, 49).exec();
  return { lastExit };
}

export async function recordExit(reason: string): Promise<void> {
  if (!redisRef) return;
  try {
    await redisRef.multi().set(K_LAST_EXIT, JSON.stringify({ at: new Date().toISOString(), reason })).del(K_RUNNING).exec();
  } catch {
    /* shutting down anyway */
  }
}

export async function recordError(message: string): Promise<void> {
  if (!redisRef) return;
  try {
    await redisRef.multi().lpush(K_ERRORS, JSON.stringify({ at: new Date().toISOString(), message: message.slice(0, 300) })).ltrim(K_ERRORS, 0, 19).exec();
  } catch {
    /* ignore */
  }
}

export interface HealthSnapshot {
  ok: true;
  version: string;
  startedAt: string;
  uptimeSec: number;
  eventLoopLagMs: number | null;
  restarts24h: number | null;
  lastExit: { at: string; reason: string } | null;
  recentErrors: Array<{ at: string; message: string }>;
  memory: { rssMb: number; heapMb: number };
  redisMemoryMb: number | null;
  /** Why it is (not) buying right now. */
  trading: BlockerSnapshot;
}

export async function healthSnapshot(now = Date.now()): Promise<HealthSnapshot> {
  const mem = process.memoryUsage();
  const base: HealthSnapshot = {
    ok: true,
    version: BOT_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    eventLoopLagMs: eventLoopLagMs(),
    restarts24h: null,
    lastExit: null,
    recentErrors: [],
    memory: { rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6) },
    redisMemoryMb: null,
    trading: blockerSnapshot(now),
  };
  if (!redisRef) return base;
  try {
    const [starts, last, errors, info] = await Promise.all([redisRef.lrange(K_STARTS, 0, 49), redisRef.get(K_LAST_EXIT), redisRef.lrange(K_ERRORS, 0, 4), redisRef.info('memory')]);
    // Starts in the last 24h, not counting the current run.
    base.restarts24h = Math.max(0, starts.filter((s) => now - Number(s) < 86_400_000).length - 1);
    base.lastExit = parse(last);
    base.recentErrors = errors.flatMap((e) => {
      const v = parse<{ at: string; message: string }>(e);
      return v ? [v] : [];
    });
    const m = /used_memory:(\d+)/.exec(info);
    base.redisMemoryMb = m ? Math.round(Number(m[1]) / 1e6) : null;
  } catch {
    /* best effort */
  }
  return base;
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
