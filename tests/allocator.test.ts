import { describe, expect, it, vi } from 'vitest';
import { allocate, Allocator, posteriorFor, prng, rescaleWithBounds, winsorLimits, type LearnRow } from '../src/learner/allocator';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const BASE = { CURVE_SNIPE: 0.2, MIGRATION_MOMENTUM: 0.3, SOON: 0.05, SMART_MONEY_COPY: 0.1, SWING: 0.15, RUNNER: 0.2 };

const rnd = prng(42);
/** n trades around `mean` (± spread), spread over the last `days` days (ending `endDaysAgo` ago). */
function trades(strategy: string, n: number, mean: number, spread = 6, days = 3, endDaysAgo = 0, weight = 1): LearnRow[] {
  return Array.from({ length: n }, (_, i) => ({
    flat: {},
    strategy,
    atMs: NOW - endDaysAgo * DAY - (i / Math.max(1, n)) * days * DAY,
    pnlPct: mean + (rnd() * 2 - 1) * spread,
    peakX: 1 + Math.max(0, mean) / 100,
    weight,
    source: 'real' as const,
  }));
}

const by = (r: ReturnType<typeof allocate>, s: string) => r.strategies.find((x) => x.strategy === s)!;
const sum = (r: ReturnType<typeof allocate>) => r.strategies.reduce((a, s) => a + s.fraction, 0);
const baseSum = Object.values(BASE).reduce((a, b) => a + b, 0);

describe('allocator: budget flows to what works', () => {
  const rows = [...trades('MIGRATION_MOMENTUM', 60, 15), ...trades('RUNNER', 60, -14), ...trades('SWING', 40, 1, 15), ...trades('SOON', 5, 40)];
  const r = allocate(rows, BASE, NOW);

  it('a clear winner gets more, a clear loser less', () => {
    expect(by(r, 'MIGRATION_MOMENTUM').multiplier).toBeGreaterThan(1.2);
    expect(by(r, 'MIGRATION_MOMENTUM').pBest).toBeGreaterThan(0.5); // SOON (5 lucky trades) still has a real chance
    expect(by(r, 'RUNNER').pBest).toBeLessThan(0.01);
    expect(by(r, 'MIGRATION_MOMENTUM').meanPct).toBeGreaterThan(8);
    expect(by(r, 'RUNNER').multiplier).toBeLessThan(0.8);
    expect(by(r, 'RUNNER').upperPct).toBeLessThan(0);
    expect(by(r, 'MIGRATION_MOMENTUM').why).toMatch(/^MIGRATION_MOMENTUM: 60 trades, likely \+\d+\.\d% a trade \(.+….+\) → \d\.\d\d× budget/);
  });

  it('too few trades keep 1x, no data keeps 1x', () => {
    expect(by(r, 'SOON').multiplier).toBe(1);
    expect(by(r, 'SOON').fraction).toBeCloseTo(BASE.SOON, 10);
    expect(by(r, 'SOON').why).toMatch(/not enough evidence/);
    expect(by(r, 'CURVE_SNIPE').multiplier).toBe(1);
  });

  it('keeps the total budget (or reports what it held back) and the floor / cap', () => {
    expect(sum(r) + r.reserved).toBeCloseTo(baseSum, 6);
    expect(sum(r)).toBeLessThanOrEqual(baseSum + 1e-9);
    for (const s of r.strategies) {
      expect(s.multiplier).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(s.multiplier).toBeLessThanOrEqual(1.6 + 1e-9);
    }
    // Even a catastrophically losing strategy keeps half its budget.
    const r2 = allocate([...trades('RUNNER', 200, -19, 1), ...trades('MIGRATION_MOMENTUM', 200, 30, 5)], BASE, NOW);
    expect(by(r2, 'RUNNER').fraction).toBeGreaterThanOrEqual(0.3 * BASE.RUNNER - 1e-12);
    expect(sum(r2) + r2.reserved).toBeCloseTo(baseSum, 6);
  });

  it('is deterministic for the same input', () => {
    const a = allocate(rows, BASE, NOW);
    const b = allocate(rows, BASE, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('recency: old wins + recent losses → below 1x', () => {
    const rows3 = [
      ...trades('RUNNER', 50, 20, 6, 5, 30), // a month ago it was great
      ...trades('RUNNER', 30, -12, 6, 3, 0), // lately it loses
      ...trades('MIGRATION_MOMENTUM', 40, 2, 12),
    ];
    const r3 = allocate(rows3, BASE, NOW);
    expect(by(r3, 'RUNNER').n).toBe(80);
    expect(by(r3, 'RUNNER').effN).toBeLessThan(40);
    expect(by(r3, 'RUNNER').multiplier).toBeLessThan(1);
  });

  it('shadow rows count less; one huge outlier is winsorised', () => {
    const shadow = allocate([...trades('SWING', 15, 10, 4, 1, 0, 0.5), ...trades('RUNNER', 30, 0)], BASE, NOW);
    expect(by(shadow, 'SWING').effN).toBeLessThan(8);
    expect(by(shadow, 'SWING').multiplier).toBe(1);
    const mixed = [...trades('RUNNER', 99, -10, 3), { ...trades('RUNNER', 1, 5000)[0]! }, ...trades('SWING', 50, 0, 3)];
    const w = allocate(mixed, BASE, NOW);
    expect(by(w, 'RUNNER').meanPct).toBeLessThan(0);
  });

  it('a lone 1.6x cap can push the others down via renormalisation', () => {
    const r4 = allocate([...trades('SWING', 80, 25), ...trades('CURVE_SNIPE', 80, 0, 10), ...trades('RUNNER', 80, -1, 10)], BASE, NOW);
    expect(by(r4, 'SWING').multiplier).toBeGreaterThan(1.2);
    expect(sum(r4) + r4.reserved).toBeCloseTo(baseSum, 6);
  });

  // Regression: rank-only pBest + renormalising back to the base total gave two near-identical losers 1.35x / 0.65x.
  it('two equally losing strategies: both below 1x, roughly equal, budget held back', () => {
    const r5 = allocate([...trades('RUNNER', 80, -20, 6), ...trades('MIGRATION_MOMENTUM', 80, -21, 6)], BASE, NOW);
    const a = by(r5, 'RUNNER').multiplier;
    const b = by(r5, 'MIGRATION_MOMENTUM').multiplier;
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(1);
    expect(Math.abs(a - b)).toBeLessThan(0.15);
    expect(a).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(r5.reserved).toBeGreaterThan(0.1);
    expect(sum(r5) + r5.reserved).toBeCloseTo(baseSum, 6);
    // Total for the eligible ones shrinks to ≥ 60% of their base, never more than base.
    const elig = by(r5, 'RUNNER').fraction + by(r5, 'MIGRATION_MOMENTUM').fraction;
    expect(elig).toBeGreaterThanOrEqual(0.4 * (BASE.RUNNER + BASE.MIGRATION_MOMENTUM) - 1e-9);
    expect(by(r5, 'RUNNER').why).toMatch(/held back/);
    // Ineligible strategies are untouched.
    expect(by(r5, 'SWING').fraction).toBeCloseTo(BASE.SWING, 12);
  });

  it('one clear winner + one clear loser: winner > 1.2x, loser < 0.8x', () => {
    const r6 = allocate([...trades('MIGRATION_MOMENTUM', 80, 20, 6), ...trades('RUNNER', 80, -20, 6)], BASE, NOW);
    expect(by(r6, 'MIGRATION_MOMENTUM').multiplier).toBeGreaterThan(1.2);
    expect(by(r6, 'RUNNER').multiplier).toBeLessThan(0.8);
    expect(r6.reserved).toBeLessThan(0.15);
  });

  it('all strategies without enough evidence: all 1x, nothing held back', () => {
    const r7 = allocate([...trades('RUNNER', 4, -30), ...trades('SWING', 3, -25)], BASE, NOW);
    for (const s of r7.strategies) expect(s.multiplier).toBe(1);
    expect(r7.reserved).toBe(0);
    expect(sum(r7)).toBeCloseTo(baseSum, 12);
    expect(allocate([], BASE, NOW).strategies.every((s) => s.multiplier === 1)).toBe(true);
  });
});

describe('allocator: building blocks', () => {
  it('posterior is sceptical with few trades', () => {
    const p = posteriorFor([{ x: 30, w: 1 }, { x: 30, w: 1 }], -2, 10, 400);
    expect(p.mu).toBeCloseTo((10 * -2 + 2 * 30) / 12, 9);
    expect(posteriorFor([], -2, 10, 400).mu).toBe(-2);
  });
  it('winsor limits and bounded rescale', () => {
    const { lo, hi } = winsorLimits([...Array.from({ length: 98 }, () => 0), -100, 1000], 2);
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeLessThan(1000);
    const f = rescaleWithBounds([0.6, 0.1], [0.15, 0.1], [0.48, 0.32], 0.5);
    expect(f[0]! + f[1]!).toBeCloseTo(0.5, 9);
    expect(f[1]).toBeGreaterThanOrEqual(0.1);
  });
  it('runs fast on 5,000 rows', () => {
    const big = Object.keys(BASE).flatMap((s, i) => trades(s, 850, i * 2 - 5, 20, 14));
    const t = performance.now();
    allocate(big, BASE, NOW);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('Allocator class', () => {
  it('refreshes, caches multipliers, stores and restores', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
    };
    const rows = [...trades('MIGRATION_MOMENTUM', 60, 15), ...trades('RUNNER', 60, -14)];
    const a = new Allocator(redis as never, async () => rows, () => BASE);
    expect(a.multiplierFor('RUNNER')).toBe(1);
    await a.refresh(NOW);
    expect(a.multiplierFor('MIGRATION_MOMENTUM')).toBeGreaterThan(1.2);
    expect(a.multiplierFor('UNKNOWN')).toBe(1);
    expect(store.has('alloc:last')).toBe(true);
    const b = new Allocator(redis as never, async () => [], () => BASE);
    await b.restore();
    expect(b.multiplierFor('RUNNER')).toBeLessThan(0.8);
    expect(b.snapshot()?.strategies.length).toBe(6);
  });
});
