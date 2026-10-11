import { describe, expect, it } from 'vitest';
import { entryStyleBlock, entryStyles, pullbackZone } from '../src/learner/entry-style';
import type { ClosedTrade } from '../src/learner/loss-autopsy';
import { diffByStrategy } from '../src/lib/change-log';

const t = (o: Partial<ClosedTrade>): ClosedTrade => ({ strategy: 'RUNNER', mcUsd: 20_000, ageMin: 5, curvePct: 60, score: 70, hourUtc: 12, pnlSol: 0, pnlPct: 0, sizeSol: 0.1, exitReason: 'STOP_LOSS', peakMultiple: 1, heldMin: 3, explore: false, ...o });

describe('entry style: the bot changes HOW it buys', () => {
  it('chasing and buying the top keep losing → waits for a pullback, no chasing', () => {
    const chasers = Array.from({ length: 14 }, (_, i) => t({ run3m: 60 + i, offHigh10m: 1, pnlPct: -14 + (i % 3), peakMultiple: 1.01 }));
    const calm = Array.from({ length: 14 }, (_, i) => t({ run3m: 8, offHigh10m: 14, pnlPct: i % 3 === 0 ? -10 : 18, peakMultiple: 1.3 }));
    const [s] = entryStyles([...chasers, ...calm], 15);
    expect(s!.strategy).toBe('RUNNER');
    expect(s!.maxRun3mPct).toBe(50);
    expect(s!.minOffHighPct).toBeGreaterThanOrEqual(3);
    expect(entryStyleBlock(s, { offHigh10m: 1, run3m: 70 })).toMatch(/chases/);
    expect(entryStyleBlock(s, { offHigh10m: 15, run3m: 5 })).toBeNull();
  });
  it('losers that never went up → only buys after a pullback', () => {
    const bad = Array.from({ length: 20 }, () => t({ strategy: 'SOON', pnlPct: -15, peakMultiple: 1.01 }));
    const [s] = entryStyles(bad, 15);
    expect(s!.minOffHighPct).toBe(6);
    expect(entryStyleBlock(s, { offHigh10m: 2, run3m: 5 })).toMatch(/under the 10-min high/);
  });
  it('a strategy that works keeps buying normally; too few trades = no change', () => {
    const good = Array.from({ length: 20 }, (_, i) => t({ strategy: 'SWING', pnlPct: i % 4 === 0 ? -8 : 15, peakMultiple: 1.2 }));
    expect(entryStyles(good, 15)).toEqual([]);
    expect(entryStyles(good.slice(0, 5).map((x) => ({ ...x, pnlPct: -20 })), 15)).toEqual([]);
  });
  it('the dip zone sits under the high', () => {
    const z = pullbackZone(1, 6);
    expect(z.hi).toBeCloseTo(0.94);
    expect(z.lo).toBeLessThan(z.hi);
  });
  it('change log lists only what changed', () => {
    const d = diffByStrategy([{ strategy: 'A', v: 1 }, { strategy: 'B', v: 1 }], [{ strategy: 'A', v: 1 }, { strategy: 'B', v: 2 }], (x) => String(x?.v ?? 'none'));
    expect(d).toEqual([{ strategy: 'B', from: '1', to: '2' }]);
  });
});
