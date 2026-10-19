/**
 * Bot health — so "it keeps going offline" has an answer on the dashboard.
 *
 * Records every start, every clean stop and every fatal error in Redis:
 *   bot:running    set while the process runs; still there at the next start
 *                  → the previous run died without shutting down (killed —
 *                  usually out of memory — or crashed hard)
 *   bot:lastExit   { at, reason } of the previous run
 *   bot:starts     start times (last 50)
 *   bot:crashes    start times that followed a run that died without shutting down (last 50)
 *   bot:errors     last 20 serious errors
 * `healthSnapshot()` adds memory, Redis memory and event-loop lag for /api/health.
 */
import type { TapeStats } from '../learner/tape-recorder';
import { usageSnapshot, type UsageSnapshot } from './usage-budget';
import type { WalletBookStats } from '../learner/wallet-book';
import type { DeployerStats } from '../learner/deployer-book';
import { readSimStats } from '../executor/live/dry-run';
import { liveStatus } from '../executor/live/live-mode';
import type { Redis } from 'ioredis';
import { eventLoopLagMs } from './process-guard';
import { blockerSnapshot, type BlockerSnapshot } from './entry-blockers';
import { getConfig } from '../config/runtime-config';

/** Which strategies are switched on (Controls); null when the config isn't loaded (tests). */
function enabledStrategies(): Record<string, boolean> | undefined {
  try {
    return { ...getConfig().trading.enabledStrategies };
  } catch {
    return undefined;
  }
}

const K_RUNNING = 'bot:running';
const K_LAST_EXIT = 'bot:lastExit';
const K_STARTS = 'bot:starts';
const K_ERRORS = 'bot:errors';
const K_CRASHES = 'bot:crashes';

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
    await redis.multi().set(K_LAST_EXIT, JSON.stringify(lastExit)).lpush(K_CRASHES, String(now)).ltrim(K_CRASHES, 0, 49).exec();
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
  /** Restarts after a crash / kill (updates and clean stops not counted). */
  crashes24h: number | null;
  lastExit: { at: string; reason: string } | null;
  recentErrors: Array<{ at: string; message: string }>;
  memory: { rssMb: number; heapMb: number };
  redisMemoryMb: number | null;
  /** Why it is (not) buying right now. */
  trading: BlockerSnapshot;
  /** v11.5: the tape recorder (trades recorded per minute, days on disk). */
  tape?: TapeStats | null;
  /** v11.6: the wallet book (wallets known, proven, dumpers). */
  walletBook?: WalletBookStats | null;
  /** v11.7: requests per provider today vs the owner's budgets. */
  usage?: UsageSnapshot | null;
  /** v11.10: the deployer book (creators known, proven, serial, ruggers). */
  deployers?: DeployerStats | null;
  /** v11.14: live path — mode, and how the paper dry run's simulations of the real transactions went. */
  live?: { mode: 'PAPER' | 'LIVE'; wallet: string | null; simulated: number; okPct: number | null; errors: number; blockers: string[] } | null;
  /** v11.16: AI meme reader — reads today and their cost. */
  meme?: { enabled: boolean; hasKey: boolean; today: number; spentTodayUsd: number; budgetUsd: number } | null;
  /** v18.10: the coin checker's plumbing — where checkpoints stop, the safety worker, the queues, the RPC in use. */
  checker?: CheckerStats | null;
}

export interface QueueCounts {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
}
export interface CheckerStats {
  evaluator: { jobs: number; evaluated: number; alreadyDone: number; noToken: number; noView: number; waitSafety: number; safetyAsked: number; buys: number };
  safety: { done: number; failed: number; stale: number; waitSec: number; lastDoneAgoSec: number | null };
  queues: { evaluate: QueueCounts | null; safety: QueueCounts | null };
  rpc: { provider: string; configured: boolean };
  /** one line: what is (not) flowing, in plain words */
  verdict: string;
}

/** v18.10 pure: why the checker scores (almost) nothing, from its own counters. */
export function checkerVerdict(c: Omit<CheckerStats, 'verdict'>, uptimeSec: number): string {
  const e = c.evaluator;
  const sq = c.queues.safety;
  if (!c.rpc.configured) return 'no RPC endpoint configured — safety checks cannot run, so no coin is ever scored';
  if (e.jobs === 0) return uptimeSec < 300 ? 'just started — the first checkpoints come in a minute or two' : 'no checkpoints are being processed — the evaluate queue worker is not running';
  if (e.evaluated === 0 && e.noToken > e.jobs * 0.5) return 'coins are checked before their database row exists — Postgres writes are behind';
  const waitShare = e.jobs ? e.waitSafety / e.jobs : 0;
  if (waitShare > 0.8 && c.safety.done === 0 && c.safety.failed > 0) return `every checkpoint is still waiting for a safety check and the safety worker keeps failing (${c.safety.failed} failed) — RPC trouble`;
  if (waitShare > 0.8 && c.safety.done === 0 && uptimeSec > 300) return `every checkpoint is still waiting for a safety check and none has finished${sq ? ` (${sq.waiting + sq.delayed} queued, ${sq.active} running)` : ''} — the safety worker is stuck`;
  if (waitShare > 0.8 && c.safety.waitSec > 600) return `safety checks arrive too late (a job waits ${Math.round(c.safety.waitSec / 60)} min in the queue; the coin's checkpoints are over by then) — the safety queue is backed up`;
  if (e.evaluated === 0 && e.noView > e.jobs * 0.5) return 'coins are forgotten before their checkpoint — the live state drops them (memory pressure?)';
  if (e.evaluated > 0) return `scoring coins: ${e.evaluated} scored of ${e.jobs} checkpoints (${Math.round(waitShare * 100)}% still waiting for their safety check)`;
  return 'checkpoints run but nothing gets scored — see the counters';
}

let checkerSource: (() => Promise<CheckerStats>) | null = null;
/** index.ts: the coin checker's plumbing counters (v18.10). */
export function setCheckerStatsSource(fn: (() => Promise<CheckerStats>) | null): void {
  checkerSource = fn;
}
let tapeSource: (() => TapeStats) | null = null;
/** index.ts: where the Bot health panel reads the tape recorder's stats from. */
export function setTapeStatsSource(fn: (() => TapeStats) | null): void {
  tapeSource = fn;
}
let walletBookSource: (() => WalletBookStats) | null = null;
/** index.ts: where the Bot health panel reads the wallet book's counts from. */
export function setWalletBookStatsSource(fn: (() => WalletBookStats) | null): void {
  walletBookSource = fn;
}
let memeSource: (() => Promise<NonNullable<HealthSnapshot['meme']>>) | null = null;
/** index.ts: where the Bot health panel reads the meme reader's counts from. */
export function setMemeStatsSource(fn: (() => Promise<NonNullable<HealthSnapshot['meme']>>) | null): void {
  memeSource = fn;
}
let deployerSource: (() => DeployerStats) | null = null;
/** index.ts: where the Bot health panel reads the deployer book's counts from. */
export function setDeployerStatsSource(fn: (() => DeployerStats) | null): void {
  deployerSource = fn;
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
    crashes24h: null,
    lastExit: null,
    recentErrors: [],
    memory: { rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6) },
    redisMemoryMb: null,
    trading: blockerSnapshot(now, enabledStrategies()),
    tape: tapeSource?.() ?? null,
    walletBook: walletBookSource?.() ?? null,
    usage: usageSnapshot(),
    deployers: deployerSource?.() ?? null,
  };
  if (memeSource) base.meme = await memeSource().catch(() => null);
  if (checkerSource) base.checker = await checkerSource().catch(() => null);
  if (!redisRef) return base;
  try {
    const st = liveStatus();
    if (st) {
      const sim = await readSimStats(redisRef);
      base.live = { mode: st.activeMode, wallet: st.wallet, simulated: sim.n, okPct: sim.okPct, errors: sim.error, blockers: st.blockers };
    }
    const [starts, last, errors, info, crashes] = await Promise.all([redisRef.lrange(K_STARTS, 0, 49), redisRef.get(K_LAST_EXIT), redisRef.lrange(K_ERRORS, 0, 4), redisRef.info('memory'), redisRef.lrange(K_CRASHES, 0, 49)]);
    // Starts in the last 24h, not counting the current run.
    base.restarts24h = Math.max(0, starts.filter((s) => now - Number(s) < 86_400_000).length - 1);
    base.crashes24h = crashes.filter((s) => now - Number(s) < 86_400_000).length;
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

/**
 * "Update now" button. The VPS auto-updater (scripts/auto-update.sh, every minute) picks up
 * `update:request` and writes what it did to `update:status`.
 */
export interface UpdateStatus {
  running: string;
  requested: string | null;
  last: { at: string; state: 'up_to_date' | 'updating' | 'done' | 'failed'; message: string; deployed: string; remote: string } | null;
}

export async function updateStatus(): Promise<UpdateStatus> {
  const base: UpdateStatus = { running: BOT_VERSION, requested: null, last: null };
  if (!redisRef) return base;
  try {
    const [req, last] = await Promise.all([redisRef.get('update:request'), redisRef.get('update:status')]);
    base.requested = req;
    base.last = parse(last);
  } catch {
    /* best effort */
  }
  return base;
}

export async function requestUpdate(force: boolean): Promise<void> {
  if (!redisRef) throw new Error('not ready yet');
  // Expires if the updater isn't running (cron missing) so a stale request never fires hours later.
  await redisRef.set('update:request', force ? 'force' : 'normal', 'EX', 600);
}
