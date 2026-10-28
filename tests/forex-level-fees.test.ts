/** v27.72 (Oct 28: gold level buys with a stop smaller than the round-trip fee; "locked" exits that lost after fees). */
import { describe, expect, it } from 'vitest';
import { feeTooBig } from '../src/forex/level-watch';
import { lockPlan, lockPlanNet, PROFIT_LOCK } from '../src/forex/profit-lock';
import { VENUE_FEES } from '../src/forex/venue-fees';

describe('level trades the fee would eat', () => {
  it('refuses a gold level trade whose stop is smaller than the fee, keeps an NQ one', () => {
    VENUE_FEES.on = true;
    expect(feeTooBig('XAUUSD', 4074.8, 4071.34)).toMatch(/venue fee/);
    expect(feeTooBig('NDXUSD', 29831, 29855)).toBeNull();
  });
});

describe('profit lock counts the venue fee', () => {
  it('locks past entry + spread + fee', () => {
    const p = lockPlanNet(1, 100, 98, 104, 0.01, 0.1, PROFIT_LOCK)!;
    expect(p.to).toBeCloseTo(100 + 0.11 + PROFIT_LOCK.keepFrac * 4, 9);
    expect(p.to).toBeGreaterThan(lockPlan(1, 100, 98, 104, 0.01, PROFIT_LOCK)!.to);
  });
  it('a fee past the normal arming price arms later instead of never', () => {
    expect(lockPlan(-1, 100, 101, 98, 0.5, PROFIT_LOCK)).toBeNull();
    const p = lockPlanNet(-1, 100, 101, 98, 0.0, 0.5, PROFIT_LOCK)!;
    expect(p.to).toBeLessThan(100 - 0.5);
    expect(p.at).toBeLessThan(p.to);
  });
  it('no fee = the old lock', () => {
    expect(lockPlanNet(1, 100, 98, 104, 0.01, 0, PROFIT_LOCK)).toEqual(lockPlan(1, 100, 98, 104, 0.01, PROFIT_LOCK));
  });
});
