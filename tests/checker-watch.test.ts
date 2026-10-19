/** v18.10: the coin-checker watchdog trips on a flowing stream with (almost) nothing scored, and never loops restarts. */
import { describe, expect, it } from 'vitest';
import { CHECKER_WATCH, checkerStalled, restartAllowed } from '../src/lib/checker-watch';
import { checkerVerdict } from '../src/lib/bot-health';

const mins = (n: number, launches: number, evaluated: number) => Array.from({ length: n }, () => ({ launches, evaluated }));

describe('checker watchdog', () => {
  it('needs a full window of launches with almost nothing scored', () => {
    expect(checkerStalled(mins(19, 80, 0))).toBe(false); // window not full yet
    expect(checkerStalled(mins(20, 80, 0))).toBe(true);
    expect(checkerStalled([...mins(10, 80, 0), { launches: 80, evaluated: 1 }, ...mins(9, 80, 0)])).toBe(true); // 1 in 20 min = the owner's stall
    expect(checkerStalled([...mins(19, 80, 0), { launches: 80, evaluated: 3 }])).toBe(false);
    expect(checkerStalled([...mins(19, 80, 0), { launches: 2, evaluated: 0 }])).toBe(false); // the stream itself is down
    expect(checkerStalled(mins(20, 80, 5))).toBe(false);
  });

  it('restarts itself at most twice in six hours', () => {
    const now = Date.UTC(2026, 9, 19, 12);
    expect(restartAllowed([], now)).toBe(true);
    expect(restartAllowed([now - 3_600_000], now)).toBe(true);
    expect(restartAllowed([now - 3_600_000, now - 2 * 3_600_000], now)).toBe(false);
    expect(restartAllowed([now - 7 * 3_600_000, now - 8 * 3_600_000], now)).toBe(true);
    expect(CHECKER_WATCH.maxRestarts).toBe(2);
  });

  it('names the bottleneck from the counters', () => {
    const base = { evaluator: { jobs: 1000, evaluated: 0, alreadyDone: 0, noToken: 0, noView: 0, waitSafety: 950, safetyAsked: 400, buys: 0 }, safety: { done: 0, failed: 0, stale: 0, waitSec: 0, lastDoneAgoSec: null }, queues: { evaluate: null, safety: { waiting: 900, delayed: 0, active: 4, failed: 0 } }, rpc: { provider: 'helius', configured: true } };
    expect(checkerVerdict(base, 3600)).toMatch(/safety worker is stuck/);
    expect(checkerVerdict({ ...base, safety: { ...base.safety, failed: 50 } }, 3600)).toMatch(/keeps failing/);
    expect(checkerVerdict({ ...base, safety: { ...base.safety, done: 300, waitSec: 1500 } }, 3600)).toMatch(/backed up/);
    expect(checkerVerdict({ ...base, rpc: { provider: 'none', configured: false } }, 3600)).toMatch(/no RPC/);
    expect(checkerVerdict({ ...base, evaluator: { ...base.evaluator, noToken: 800, waitSafety: 100 } }, 3600)).toMatch(/Postgres/);
    expect(checkerVerdict({ ...base, evaluator: { ...base.evaluator, evaluated: 400, waitSafety: 300 }, safety: { ...base.safety, done: 400, waitSec: 20 } }, 3600)).toMatch(/scoring coins: 400/);
    expect(checkerVerdict({ ...base, evaluator: { ...base.evaluator, jobs: 0, waitSafety: 0 } }, 60)).toMatch(/just started/);
  });
});
