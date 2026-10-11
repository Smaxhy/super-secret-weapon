import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { AiCoach, type AiRule } from '../src/learner/ai-coach';
import { embargoMs, shadowRow } from '../src/learner/learn-rows';

/** Tiny in-memory stand-in for the Redis calls the coach uses. */
function fakeRedis() {
  const h = new Map<string, string>();
  const pipe = () => {
    const ops: Array<() => void> = [];
    const p = {
      hset: (_k: string, id: string, v: string) => (ops.push(() => h.set(id, v)), p),
      exec: async () => (ops.forEach((f) => f()), []),
    };
    return p;
  };
  return { h, redis: { hgetall: async () => Object.fromEntries(h), pipeline: pipe } };
}

const cand = (o: Partial<{ title: string; strategy: string | null; action: 'avoid' | 'prefer'; value: number }> = {}) => ({
  title: o.title ?? 'avoid MIGRATION_MOMENTUM when crowd.buyRatio2m < 1.10',
  why: 'x',
  strategy: o.strategy === undefined ? 'MIGRATION_MOMENTUM' : o.strategy,
  action: o.action ?? ('avoid' as const),
  conditions: [{ feature: 'crowd.buyRatio2m', op: 'lt' as const, value: o.value ?? 1.1 }],
  evidence: { n: 40, avgPct: -14, restAvgPct: 6 },
});

describe('brain: discovered rules join the tested-before-live pipeline', () => {
  it('adds new search rules as testing, skips near-duplicates and respects the cap', async () => {
    const { h, redis } = fakeRedis();
    const coach = new AiCoach(redis as never, () => DEFAULT_CONFIG.aiCoach);
    expect(await coach.addDiscoveredRules([cand(), cand({ value: 1.05 }), cand({ title: 'b', strategy: 'RUNNER' })])).toBe(2);
    const rules = [...h.values()].map((v) => JSON.parse(v) as AiRule);
    expect(rules.every((r) => r.status === 'testing' && r.source === 'search')).toBe(true);
    expect(rules.map((r) => r.strategy).sort()).toEqual(['MIGRATION_MOMENTUM', 'RUNNER']);
    // Already known (even if retired) → not re-added.
    expect(await coach.addDiscoveredRules([cand()])).toBe(0);
    // Cap on open search rules.
    expect(await coach.addDiscoveredRules(Array.from({ length: 8 }, (_, i) => cand({ title: `c${i}`, strategy: `S${i}` })), 3)).toBe(1);
  });
});

describe('learning rows', () => {
  it('weights shadow trades by whether the bot would have taken them', () => {
    const base = { mint: 'm', symbol: 'X', strategy: 'RUNNER' as const, why: '', score: 70, bar: 72, mcUsd: null, ageMin: null, curvePct: null, kols: null, run3m: null, offHigh10m: null, flat: { a: 1 }, openedAtMs: 1, closedAtMs: 2, pnlPct: 5, peakX: 1.2, holdSec: 60, exitReason: 'TP' };
    expect(shadowRow({ ...base, kind: 'refused' }).weight).toBe(0.5);
    expect(shadowRow({ ...base, kind: 'skipped' }).weight).toBe(0.3);
    expect(shadowRow({ ...base, kind: 'near' }).source).toBe('shadow');
  });
  it('waits for long holds to close before using a strategy\'s newest trades', () => {
    expect(embargoMs('SWING')).toBeGreaterThan(embargoMs('CURVE_SNIPE'));
    expect(embargoMs('CURVE_SNIPE')).toBeGreaterThanOrEqual(3_600_000);
  });
});
