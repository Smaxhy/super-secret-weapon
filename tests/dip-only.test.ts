import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { dipOnlyApplies, dipOnlyHigh } from '../src/executor/dip-watcher';
import { pullbackZone } from '../src/learner/entry-style';

const base = { enabled: true, minMcUsd: 15_000, dipEntry: false, swing: false };

describe('dip-only entries above $15k MC (v10.24)', () => {
  it('is on by default at $15k', () => {
    expect(DEFAULT_CONFIG.chart.dip.dipOnly.enabled).toBe(true);
    expect(DEFAULT_CONFIG.chart.dip.noWaitBelowMcUsd).toBe(15_000);
  });
  it('waits for a dip at/above $15k, buys straight away under it', () => {
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000 })).toBe(true);
    expect(dipOnlyApplies({ ...base, mcUsd: 15_000 })).toBe(true);
    expect(dipOnlyApplies({ ...base, mcUsd: 9_000 })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: null })).toBe(false);
  });
  it('dip re-checks, swing re-entries and the off switch buy normally', () => {
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, dipEntry: true })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, swing: true })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, enabled: false })).toBe(false);
  });
  it('measures the pullback from the recent high, never below the price', () => {
    expect(dipOnlyHigh(1, 1.25, null)).toBe(1.25);
    expect(dipOnlyHigh(1, null, 20)).toBeCloseTo(1.25);
    expect(dipOnlyHigh(1, null, null)).toBe(1);
    expect(dipOnlyHigh(1, 0.8, null)).toBe(1);
    const z = pullbackZone(1, 15);
    expect(z.hi).toBeCloseTo(0.85);
    expect(z.lo).toBeCloseTo(0.65);
  });
});
