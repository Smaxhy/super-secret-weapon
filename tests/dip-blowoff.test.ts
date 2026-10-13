import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { dipDecision, type DipWatch } from '../src/executor/dip-watcher';

const C = DEFAULT_CONFIG.chart.dip;
const T = 1_760_000_000_000;
const watch = (): DipWatch => ({ mint: 'm', symbol: 'X', strategy: 'RUNNER', zone: { lo: 0.6, hi: 0.88 }, signalPrice: 1, high: 1, startedAt: T, expiresAt: T + 600_000, lowest: null, why: '' });

describe('blow-off guard on dip entries', () => {
  it('a normal run: a 12% dip + bounce is an entry', () => {
    const w = watch();
    dipDecision(w, 0.88, 2, T + 1000, C, 0.7); // +43% run
    expect(dipDecision(w, 0.92, 2, T + 3000, C, 0.7).action).toBe('buy');
  });
  it('after a +150% run, a shallow dip near the top is NOT an entry', () => {
    const w = watch();
    dipDecision(w, 0.86, 2, T + 1000, C, 0.4); // +150% run, 14% dip
    expect(dipDecision(w, 0.9, 2, T + 60_000, C, 0.4)).toMatchObject({ action: 'wait' });
  });
  it('after a +150% run, a deep dip whose low held is an entry', () => {
    const w = watch();
    dipDecision(w, 0.62, 2, T + 1000, C, 0.4); // 38% dip
    expect(dipDecision(w, 0.66, 2, T + 10_000, C, 0.4).action).toBe('wait'); // low not held long enough
    expect(dipDecision(w, 0.66, 2, T + 60_000, C, 0.4).action).toBe('buy');
  });
  it('a 6x blow-off in 15 min → stop waiting', () => {
    expect(dipDecision(watch(), 0.8, 2, T + 1000, C, 0.15).action).toBe('drop');
  });
});
