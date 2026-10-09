import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, type FeatureName } from '../src/config/default';
import { adjustWeights, auc, effectiveN, holdoutCheck, nextCronAt, sampleWeight, tuningOptions, type TuningSample } from '../src/learner/weight-tuning';
import { learnedOddsAdjustment, withOdds, type PatternBelief } from '../src/evaluator/scorer';
import { oddsSentence } from '../src/learner/explain';

const s = (holders: number, win: boolean, extra: Partial<TuningSample> = {}): TuningSample => ({ features: { holders } as Partial<Record<FeatureName, number>>, win, ...extra });
const many = (n: number, f: () => TuningSample) => Array.from({ length: n }, f);

describe('weight tuning', () => {
  const o = tuningOptions();
  it('recency halves weight every half-life and own buys count 3x', () => {
    expect(sampleWeight(s(1, true, { ageHours: 24 }), o)).toBeCloseTo(0.5);
    expect(sampleWeight(s(1, true, { ownBuy: true, ageHours: 0 }), o)).toBe(3);
  });
  it('effective sample size', () => {
    expect(effectiveN([1, 1, 1, 1])).toBe(4);
    expect(effectiveN([10, 0.01])).toBeLessThan(1.1);
  });
  it('step is capped at 4% and weights stay normalised', () => {
    const r = adjustWeights({ ...DEFAULT_WEIGHTS }, [...many(300, () => s(0.95, true)), ...many(300, () => s(0.1, false))])!;
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    const rawHolders = r.weights.holders / DEFAULT_WEIGHTS.holders;
    // +4% before normalisation, which pulls everything else down a bit.
    expect(rawHolders).toBeGreaterThan(1);
    expect(rawHolders).toBeLessThan(1.045);
    expect(r.evidence).toBe(1);
  });
  it('less evidence → smaller step', () => {
    const small = adjustWeights({ ...DEFAULT_WEIGHTS }, [...many(12, () => s(0.6, true)), ...many(100, () => s(0.5, false))])!;
    const big = adjustWeights({ ...DEFAULT_WEIGHTS }, [...many(300, () => s(0.6, true)), ...many(300, () => s(0.5, false))])!;
    expect(small.evidence).toBeLessThan(big.evidence);
    expect(small.weights.holders - DEFAULT_WEIGHTS.holders).toBeLessThan(big.weights.holders - DEFAULT_WEIGHTS.holders);
  });
  it('cuts loser features faster than it raises winner features', () => {
    const up = adjustWeights({ ...DEFAULT_WEIGHTS }, [...many(200, () => s(0.55, true)), ...many(200, () => s(0.5, false))])!;
    const down = adjustWeights({ ...DEFAULT_WEIGHTS }, [...many(200, () => s(0.5, true)), ...many(200, () => s(0.55, false))])!;
    // Compare the raw (pre-normalisation) ratio vs the normalised others (all others unchanged → ratio vs safety).
    const rel = (w: typeof up.weights) => w.holders / DEFAULT_WEIGHTS.holders / (w.safety / DEFAULT_WEIGHTS.safety) - 1;
    expect(Math.abs(rel(down.weights))).toBeGreaterThan(Math.abs(rel(up.weights)) * 1.3);
  });
  it('respects per-weight bounds', () => {
    let w = { ...DEFAULT_WEIGHTS } as Record<FeatureName, number>;
    const data = [...many(300, () => s(0.0, true)), ...many(300, () => s(1, false))];
    for (let i = 0; i < 200; i++) w = adjustWeights(w, data)!.weights;
    expect(w.holders).toBeGreaterThan(DEFAULT_WEIGHTS.holders * 0.35);
  });
});

describe('holdout AUC safeguard', () => {
  it('auc basics', () => {
    expect(auc([1, 2, 3, 4], [false, false, true, true])).toBe(1);
    expect(auc([1, 2, 3, 4], [true, true, false, false])).toBe(0);
    expect(auc([1, 1], [true, false])).toBe(0.5);
    expect(auc([1, 2], [true, true])).toBeNull();
  });
  const holdout = [...many(20, () => s(0.9, true)), ...many(20, () => s(0.2, false))];
  it('accepts weights that rank the holdout at least as well', () => {
    const better = { ...DEFAULT_WEIGHTS, holders: 0.2 };
    const v = holdoutCheck({ ...DEFAULT_WEIGHTS }, better, holdout, 5);
    expect(v.accepted).toBe(true);
    expect(v.aucAfter).toBeGreaterThanOrEqual(v.aucBefore!);
  });
  it('rejects weights that rank it worse', () => {
    // Mixed holdout where holders helps a bit; zeroing holders makes ranking worse.
    const mixed = [...many(10, () => ({ features: { holders: 0.9, snipers: 0.2 }, win: true })), ...many(10, () => ({ features: { holders: 0.2, snipers: 0.8 }, win: false }))] as TuningSample[];
    const worse = { ...DEFAULT_WEIGHTS, holders: 0 };
    const v = holdoutCheck({ ...DEFAULT_WEIGHTS }, worse, mixed, 5);
    expect(v.aucAfter!).toBeLessThan(v.aucBefore!);
    expect(v.accepted).toBe(false);
  });
  it('skips the check when the holdout lacks one class', () => {
    expect(holdoutCheck({ ...DEFAULT_WEIGHTS }, { ...DEFAULT_WEIGHTS }, many(20, () => s(1, true)), 5)).toMatchObject({ accepted: true, aucBefore: null });
  });
});

describe('schedule', () => {
  it('next */20 tick', () => {
    expect(new Date(nextCronAt(Date.parse('2026-10-09T10:07:30Z'), 20)).toISOString()).toBe('2026-10-09T10:20:00.000Z');
    expect(new Date(nextCronAt(Date.parse('2026-10-09T10:40:00Z'), 20)).toISOString()).toBe('2026-10-09T11:00:00.000Z');
    expect(new Date(nextCronAt(Date.parse('2026-10-09T23:55:00Z'), 20)).toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });
});

describe('learned odds in scoring', () => {
  const opts = { minSamples: 15, priorStrength: 20, maxPoints: 8, pointsPerLogit: 6 };
  const b = (pattern: string, wins: number, losses: number): PatternBelief => ({ pattern, alpha: 1 + wins, beta: 1 + losses, observations: wins + losses });
  const prior = b('all', 300, 700); // 30%
  it('ignores patterns with too few samples', () => {
    expect(learnedOddsAdjustment(['A'], new Map([['A', b('A', 5, 5)]]), prior, opts)).toBeNull();
  });
  it('boosts patterns that win more than average, shrunk toward the prior', () => {
    const r = learnedOddsAdjustment(['A'], new Map([['A', b('A', 20, 10)]]), prior, opts)!;
    expect(r.points).toBeGreaterThan(0);
    expect(r.winRate).toBeLessThan(20 / 30); // shrunk
    expect(r.winRate).toBeGreaterThan(0.3);
    expect(r.n).toBe(30);
  });
  it('penalises losers and caps at ±8 points', () => {
    const r = learnedOddsAdjustment(['A'], new Map([['A', b('A', 0, 2000)]]), prior, opts)!;
    expect(r.points).toBe(-8);
    const up = learnedOddsAdjustment(['A'], new Map([['A', b('A', 2000, 0)]]), prior, opts)!;
    expect(up.points).toBe(8);
  });
  it('withOdds keeps the score within 0-100', () => {
    expect(withOdds({ score: 97, contributions: {} as never }, { points: 8 } as never).score).toBe(100);
    expect(withOdds({ score: 50, contributions: {} as never }, null).score).toBe(50);
  });
  it('explains the odds in one sentence', () => {
    expect(oddsSentence({ winRate: 0.42, priorRate: 0.3, n: 31, points: 3.2 })).toBe('Learned odds: similar coins won 42% (n=31) vs 30% overall (+3.2 pts).');
  });
});
