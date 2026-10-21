/** v26.5: bigger trades (wider stop + farther target) and the Turbo risk mode. */
import { describe, expect, it } from 'vitest';
import { applyExit } from '../src/forex/exits';
import { feeR } from '../src/forex/venue-fees';
import { RISK_MODES, isRiskMode } from '../src/forex/practice';
import { INSTRUMENTS, type Signal } from '../src/forex/types';
import type { Ctx } from '../src/forex/ta';

const ctx = { close: [1.1], barMin: 60 } as unknown as Ctx;
const sig: Signal = { side: 1, stop: 1.0985, target: 1.103, maxBars: 24 };
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;

describe('v26.5 bigger trades', () => {
  it('roomy / swing push the stop and target further out, longer hold', () => {
    const r = applyExit(sig, 'roomy', ctx, 0)!;
    expect(r.stop).toBeCloseTo(1.1 - 0.0015 * 1.6, 8);
    expect(r.target).toBeCloseTo(1.1 + 0.003 * 1.6, 8);
    const s = applyExit(sig, 'swing', ctx, 0)!;
    expect(s.stop).toBeCloseTo(1.1 - 0.0015 * 2.2, 8);
    expect(s.target).toBeCloseTo(1.1 + 0.003 * 2.5, 8);
    expect(s.maxBars).toBe(60);
    // a short gets the mirror image
    const sh = applyExit({ side: -1, stop: 1.1015, target: 1.097 }, 'roomy', ctx, 0)!;
    expect(sh.stop).toBeCloseTo(1.1 + 0.0015 * 1.6, 8);
  });
  it('the fee shrinks in R by the wider stop', () => {
    const tight = feeR(EUR, 1.1, 0.0015);
    const wide = feeR(EUR, 1.1, 0.0015 * 2.2);
    expect(wide).toBeCloseTo(tight / 2.2, 8);
  });
  it('turbo is a risk mode', () => {
    expect(isRiskMode('turbo')).toBe(true);
    expect(RISK_MODES.turbo.riskPct).toBe(8);
  });
});
