/**
 * v18.10 coin-checker watchdog (pure). The v18.2 version only tripped on 20 minutes with ZERO scored coins; the owner's
 * stall scored 52 coins in 7 hours (one every few minutes), which never tripped it. This one looks at a rolling window:
 * the stream keeps delivering launches while the checker scores next to nothing → stalled.
 */
export interface WatchMinute {
  launches: number;
  evaluated: number;
}

export const CHECKER_WATCH = {
  windowMin: 20,
  /** every minute of the window must bring at least this many launches (the stream is up) */
  minLaunchesPerMin: 10,
  /** … while the whole window scored at most this many coins */
  maxEvaluated: 2,
  /** self-restarts allowed per `restartWindowMs` — past that, only the warning (a restart loop fixes nothing) */
  maxRestarts: 2,
  restartWindowMs: 6 * 3_600_000,
};

/** Stalled = a full window of a flowing stream with (almost) nothing scored. */
export function checkerStalled(minutes: readonly WatchMinute[], cfg = CHECKER_WATCH): boolean {
  if (minutes.length < cfg.windowMin) return false;
  const w = minutes.slice(-cfg.windowMin);
  if (w.some((m) => m.launches < cfg.minLaunchesPerMin)) return false;
  return w.reduce((n, m) => n + m.evaluated, 0) <= cfg.maxEvaluated;
}

/** May the bot restart itself now, given when it did so before? */
export function restartAllowed(previousRestarts: readonly number[], now: number, cfg = CHECKER_WATCH): boolean {
  return previousRestarts.filter((t) => now - t < cfg.restartWindowMs).length < cfg.maxRestarts;
}
