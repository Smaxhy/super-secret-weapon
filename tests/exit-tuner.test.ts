import { describe, expect, it } from 'vitest';
import { afterExit, judgeTimers, timerOf, type ExitAfter } from '../src/learner/exit-tuner';

const C = { minExits: 5, ranAfterPct: 40, deadAfterPct: 15 };
const row = (o: Partial<ExitAfter>): ExitAfter => ({ id: 'x', strategy: 'MIGRATION_MOMENTUM', timer: 'stale', closedAtMs: 0, exitPriceSol: 1, pnlPct: 0, maxAfterX: 1, minAfterX: 1, endX: 1, trades: 10, ...o });

describe('exit tuner', () => {
  it('reads which timer closed the trade', () => {
    expect(timerOf('STALE: no follow-through: 10.2 min in, best 1.05x')).toBe('timeStop');
    expect(timerOf('stalled: no new high for 6.0 min')).toBe('stall');
    expect(timerOf('no movement for 60m')).toBe('stale');
    expect(timerOf('max hold 240m reached at 1.10x')).toBe('maxHold');
    expect(timerOf('TRAILING_STOP')).toBeNull();
  });
  it('measures what the price did after the sell', () => {
    const t = (sec: number, px: number) => ({ t: sec * 1000, w: 'w', buy: true, sol: 1, tok: 1, px, pp: px });
    expect(afterExit([t(5, 1), t(10, 1)], 0, 1, 60_000)).toBeNull();
    expect(afterExit([t(-5, 9), t(5, 1.1), t(10, 1.5), t(20, 0.9), t(30, 1.2), t(90, 5)], 0, 1, 60_000)).toEqual({ maxAfterX: 1.5, minAfterX: 0.9, endX: 1.2, trades: 4 });
  });
  it('waits longer when coins keep running after we sell, sooner when they die', () => {
    const ran = Array.from({ length: 10 }, (_, i) => row({ maxAfterX: i < 5 ? 1.4 : 1.05, endX: 1.1 }));
    expect(judgeTimers(ran, C)[0]).toMatchObject({ action: 'longer', ranPct: 50 });
    const dead = Array.from({ length: 10 }, () => row({ timer: 'timeStop', maxAfterX: 1.05, endX: 0.8 }));
    expect(judgeTimers(dead, C)[0]).toMatchObject({ action: 'shorter' });
    expect(judgeTimers(ran.slice(0, 3), C)[0]!.action).toBe('keep');
  });
});
