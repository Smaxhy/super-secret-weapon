import { describe, it, expect } from 'vitest';
import { mcAgeStopMultiplier, DEFAULT_ADAPTIVE_STOP } from '../src/executor/adaptive-stop';

const cfg = DEFAULT_ADAPTIVE_STOP;
// mcBands: [<$10k → 1.3, <$50k → 1.1, <$200k → 1.0], above all → 0.85
// ageBands: [<2 min → 1.2]

describe('mcAgeStopMultiplier', () => {
  it('returns 1 when both inputs null', () => {
    expect(mcAgeStopMultiplier(null, null, cfg)).toBe(1);
  });

  it('tiny coin (<$10k) gets wider stop (×1.3)', () => {
    expect(mcAgeStopMultiplier(5_000, null, cfg)).toBeCloseTo(1.3);
  });

  it('small coin ($10k–$50k) gets slightly wider (×1.1)', () => {
    expect(mcAgeStopMultiplier(30_000, null, cfg)).toBeCloseTo(1.1);
  });

  it('medium coin ($50k–$200k) gets neutral (×1.0)', () => {
    expect(mcAgeStopMultiplier(100_000, null, cfg)).toBeCloseTo(1.0);
  });

  it('large coin (>$200k) gets tighter stop (×0.85)', () => {
    expect(mcAgeStopMultiplier(500_000, null, cfg)).toBeCloseTo(0.85);
  });

  it('very fresh coin (<2 min) gets wider stop (×1.2)', () => {
    expect(mcAgeStopMultiplier(null, 1, cfg)).toBeCloseTo(1.2);
  });

  it('older coin (>2 min) gets no age adjustment', () => {
    expect(mcAgeStopMultiplier(null, 5, cfg)).toBeCloseTo(1.0);
  });

  it('tiny + fresh stacks: $5k MC, 1 min old → 1.3 × 1.2 = 1.56', () => {
    expect(mcAgeStopMultiplier(5_000, 1, cfg)).toBeCloseTo(1.56);
  });

  it('large + fresh: $500k, 1 min old → 0.85 × 1.2 = 1.02', () => {
    expect(mcAgeStopMultiplier(500_000, 1, cfg)).toBeCloseTo(1.02);
  });

  it('clamped to max 1.8', () => {
    // Use extreme bands
    const extreme = {
      mcBands: [{ maxMcUsd: 1000, factor: 2.0 }] as const,
      ageBands: [{ maxAgeMin: 1, factor: 2.0 }] as const,
    };
    // 2.0 × 2.0 = 4.0 → clamped to 1.8
    expect(mcAgeStopMultiplier(500, 0.5, extreme)).toBe(1.8);
  });

  it('clamped to min 0.5', () => {
    const extreme = {
      mcBands: [{ maxMcUsd: 1000, factor: 0.3 }] as const,
      ageBands: [{ maxAgeMin: 1, factor: 0.3 }] as const,
    };
    // 0.3 × 0.3 = 0.09 → clamped to 0.5
    expect(mcAgeStopMultiplier(500, 0.5, extreme)).toBe(0.5);
  });

  it('empty bands = neutral', () => {
    const empty = { mcBands: [] as const, ageBands: [] as const };
    expect(mcAgeStopMultiplier(5_000, 1, empty)).toBe(1);
  });

  it('MC at exact band boundary ($10k) matches the band', () => {
    expect(mcAgeStopMultiplier(10_000, null, cfg)).toBeCloseTo(1.3);
  });

  it('age at exact band boundary (2 min) matches the band', () => {
    expect(mcAgeStopMultiplier(null, 2, cfg)).toBeCloseTo(1.2);
  });
});
