/**
 * Process-level safety net (wired in src/index.ts).
 *
 * A dropped network connection, a reset socket or a timed-out RPC call that
 * slips through as an uncaught exception used to kill the whole bot (Docker
 * then restarted it → dashboard showed "Offline" for ~30-60s). Those errors
 * are recoverable: every listener reconnects by itself. So:
 *   - recoverable errors are logged and the bot keeps running,
 *   - anything else (a real bug, unknown state) still exits so Docker restarts
 *     it cleanly,
 *   - a burst of recoverable errors (> MAX_RECOVERABLE_PER_MIN) also exits —
 *     something is badly wrong and a restart is the safer choice.
 *
 * Also measures event-loop lag (exposed on /api/health) so slow, blocking
 * work in hot paths shows up instead of looking like random disconnects.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const RECOVERABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_SOCKET_CLOSED',
  'WS_ERR_INVALID_CLOSE_CODE',
  'WS_ERR_UNEXPECTED_RSV_1',
]);
const RECOVERABLE_MESSAGES = [
  /socket hang up/i,
  /websocket (is )?not open/i,
  /websocket was closed/i,
  /connection (is )?closed/i,
  /read ECONNRESET/i,
  /fetch failed/i,
  /network (error|timeout)/i,
  /timed? ?out/i,
  /\b429\b|too many requests/i,
  /Connection is closed/i, // ioredis
  /Can't reach database server/i, // prisma P1001
  /Server has closed the connection/i, // prisma P1017
];

export const MAX_RECOVERABLE_PER_MIN = 30;

/** True for errors the bot can safely survive (network/socket blips). */
export function isRecoverableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errorCode?: unknown };
  if (typeof e.code === 'string' && RECOVERABLE_CODES.has(e.code)) return true;
  if (e.errorCode === 'P1001' || e.errorCode === 'P1017' || e.code === 'P1001' || e.code === 'P1017') return true;
  if (typeof e.message === 'string' && RECOVERABLE_MESSAGES.some((r) => r.test(e.message as string))) return true;
  if (e.cause && e.cause !== err) return isRecoverableError(e.cause);
  return false;
}

/** Counts recoverable errors in a sliding 60s window. */
export class ErrorBudget {
  private times: number[] = [];
  constructor(private readonly maxPerMinute = MAX_RECOVERABLE_PER_MIN) {}
  /** Record one error; returns false once the budget is exhausted. */
  hit(now = Date.now()): boolean {
    this.times = this.times.filter((t) => now - t < 60_000);
    this.times.push(now);
    return this.times.length <= this.maxPerMinute;
  }
}

interface MinimalLogger {
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Decide what to do with an uncaught exception: 'continue' or 'exit'.
 * Network blips are always survivable (within the budget). A real bug in one
 * event handler shouldn't take the whole bot (and the dashboard) down either:
 * it's logged and the bot keeps running, unless they keep coming
 * (`fatalBudget`, default 5 per minute) — then a clean restart is safer.
 */
export function triageUncaught(err: unknown, budget: ErrorBudget, now = Date.now(), fatalBudget?: ErrorBudget): 'continue' | 'exit' {
  if (!isRecoverableError(err)) return fatalBudget ? (fatalBudget.hit(now) ? 'continue' : 'exit') : 'exit';
  return budget.hit(now) ? 'continue' : 'exit';
}

export interface GuardHooks {
  /** A serious error happened (logged to the dashboard's health panel). */
  onError?: (message: string) => void | Promise<void>;
  /** About to exit because of `reason`. */
  onFatal?: (reason: string) => void | Promise<void>;
}

/** Install unhandledRejection / uncaughtException handlers. `exit` is injectable for tests. */
export function installProcessGuards(log: MinimalLogger, exit: (code: number) => void = (c) => process.exit(c), hooks: GuardHooks = {}): void {
  const budget = new ErrorBudget();
  const fatalBudget = new ErrorBudget(5);
  process.on('unhandledRejection', (reason) => {
    // A stray rejected promise is logged, never fatal.
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error({ reason: msg, recoverable: isRecoverableError(reason) }, 'unhandled promise rejection');
    if (!isRecoverableError(reason)) void hooks.onError?.(`unhandled rejection: ${msg}`);
  });
  process.on('uncaughtException', (err) => {
    const action = triageUncaught(err, budget, Date.now(), fatalBudget);
    if (action === 'continue') {
      if (isRecoverableError(err)) log.warn({ err: err.message, code: (err as { code?: string }).code }, 'recoverable uncaught exception — continuing');
      else {
        log.error({ err: err.message, stack: err.stack }, 'uncaught exception — continuing (bug logged)');
        void hooks.onError?.(`uncaught: ${err.message}`);
      }
      return;
    }
    // Too many in a row: log and exit; Docker's restart policy brings us back cleanly.
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception — exiting');
    void Promise.resolve(hooks.onFatal?.(`crashed: ${err.message}`)).finally(() => exit(1));
  });
  startLagMonitor();
}

let histogram: IntervalHistogram | null = null;

export function startLagMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  // Reset every minute so the number reflects recent behaviour.
  setInterval(() => histogram?.reset(), 60_000).unref();
}

/** p99 event-loop delay over the last minute, in ms (null until started). */
export function eventLoopLagMs(): number | null {
  if (!histogram) return null;
  const v = histogram.percentile(99) / 1e6;
  return Number.isFinite(v) ? Math.round(v) : null;
}
