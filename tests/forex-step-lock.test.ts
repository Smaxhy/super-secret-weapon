/** v28.12 (owner: "still going for short profits" → "tight until +1R, then loose"): the step lock trails like the tight
 * lock until the trade is +1R, then with the loose lock's wider gap; the lab uses it only where it tests as well. */
import { describe, expect, it } from 'vitest';
import { lockCfgOf, lockedStop, lockPlan, STEP_LOCK } from '../src/forex/profit-lock';
import { preferStep } from '../src/forex/lab';

const st = (n: number, avgR: number) => ({ n, avgR, winPct: 50, totalR: n * avgR, pf: 1.2, maxDdR: 0 }) as never;

describe('step lock', () => {
  it('tight gap before +1R, the wider gap after', () => {
    // long, entry 100, stop 99 (1R = 1), target 102 (D = 2): tight gap 0.3, wide gap 0.5 from 101
    const plan = lockPlan(1, 100, 99, 102, 0, STEP_LOCK)!;
    expect(plan.gap).toBeCloseTo(0.3);
    expect(plan.tight).toEqual({ from: 101, gap: 0.5 });
    expect(lockedStop(1, plan, 100.8, 99)).toBeCloseTo(100.5); // before +1R: 0.3 behind
    expect(lockedStop(1, plan, 101.6, 100.5)).toBeCloseTo(101.1); // past +1R: 0.5 behind
    // never moves back: best 101.1 (wide gap would give 100.6) keeps the earlier 100.8
    expect(lockedStop(1, plan, 101.1, 100.8)).toBeCloseTo(100.8);
    expect(lockCfgOf('step')).toBe(STEP_LOCK);
  });

  it('the lab uses it only when its first 70% scores at least as well', () => {
    const v = [{ key: 'tight' as const, inSample: st(100, 0.2) }, { key: 'loose' as const, inSample: st(100, 0.15) }];
    expect(preferStep(v, 'tight', st(100, 0.2), false)).toBe('step');
    expect(preferStep(v, 'tight', st(100, 0.19), false)).toBe('tight');
    expect(preferStep(v, 'tight', st(100, 0.195), true)).toBe('step'); // kept through a near-tie
    expect(preferStep(v, 'tight', st(20, 0.5), false)).toBe('tight'); // too few trades
  });
});
