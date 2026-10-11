import { describe, expect, it } from 'vitest';
import { bhQValues, PolicySearch, searchPolicies, searchPoliciesAsync, twoSidedP, weightedQuantile, type LearnRow } from '../src/learner/policy-search';

/** Small seeded PRNG (sfc32) so the noise tests are deterministic. */
function rng(seed: number) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  return next;
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

/** Fat-tailed noisy result: mostly stops around −14, some small wins, a few big ones. */
const noisyPnl = (r: () => number) => {
  const u = r();
  if (u < 0.5) return -14 + gauss(r) * 3;
  if (u < 0.9) return 8 + gauss(r) * 8;
  return 40 + r() * 120;
};

const T0 = 1_760_000_000_000;
const row = (i: number, o: Partial<LearnRow>): LearnRow => ({
  flat: {}, strategy: 'MIGRATION_MOMENTUM', atMs: T0 + i * 60_000, pnlPct: 0, peakX: 1, weight: 1, source: 'real', ...o,
});

function noiseFeatures(r: () => number, k: number, missingShare = 0.2): Record<string, number> {
  const f: Record<string, number> = {};
  for (let j = 0; j < k; j++) if (r() > missingShare) f[`noise.f${j}`] = gauss(r) * 10 + j;
  return f;
}

describe('policy search: rules from data with honest statistics', () => {
  it('stat helpers behave', () => {
    expect(twoSidedP(0, 30)).toBeCloseTo(1, 5);
    expect(twoSidedP(1.96, 1e9)).toBeCloseTo(0.05, 2);
    expect(twoSidedP(2.042, 30)).toBeCloseTo(0.05, 2);
    expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2);
    const q = bhQValues([0.01, 0.04, 0.03, 0.5]);
    expect(q[0]).toBeCloseTo(0.04, 6);
    expect(q[3]).toBeCloseTo(0.5, 6);
  });

  it('finds a planted losing pattern as an avoid rule with the right threshold and q < 0.1', () => {
    const r = rng(1);
    const rows = Array.from({ length: 600 }, (_, i) => {
      const br = 0.5 + r() * 1.5; // 0.5 … 2.0
      const pnl = br < 1 ? -15 + gauss(r) * 4 : 10 + gauss(r) * 12;
      return row(i, { flat: { 'crowd.buyRatio2m': br, ...noiseFeatures(r, 10) }, pnlPct: pnl, strategy: i % 2 ? 'MIGRATION_MOMENTUM' : 'RUNNER' });
    });
    const res = searchPolicies(rows);
    const avoid = res.rules.find((x) => x.action === 'avoid' && x.conditions.length === 1 && x.conditions[0]!.feature === 'crowd.buyRatio2m');
    expect(avoid).toBeDefined();
    expect(avoid!.conditions[0]!.op).toBe('lt');
    expect(avoid!.conditions[0]!.value).toBeGreaterThan(0.75);
    expect(avoid!.conditions[0]!.value).toBeLessThan(1.25);
    expect(avoid!.evidence.qValue).toBeLessThan(0.1);
    expect(avoid!.evidence.avgPct).toBeLessThan(-5);
    expect(avoid!.evidence.holdoutAvgPct).toBeLessThan(avoid!.evidence.holdoutRestAvgPct);
    expect(avoid!.title).toMatch(/^avoid .* when crowd\.buyRatio2m < /);
    expect(res.tested).toBeGreaterThan(100);
    expect(res.rules.length).toBeLessThanOrEqual(6);
    expect(res.rules.every((x) => !x.conditions.some((c) => c.feature.startsWith('noise.')) || x.conditions.length > 1)).toBe(true);
  });

  it('pure noise over 60 features gives NO rules (false-discovery control)', () => {
    for (const seed of [7, 42, 2026]) {
      const r = rng(seed);
      const strategies = ['CURVE_SNIPE', 'MIGRATION_MOMENTUM', 'RUNNER'];
      const rows = Array.from({ length: 1500 }, (_, i) => row(i, { flat: noiseFeatures(r, 60), pnlPct: noisyPnl(r), strategy: strategies[i % 3]!, weight: r() < 0.3 ? 0.5 : 1, source: 'real' }));
      const res = searchPolicies(rows);
      expect(res.tested).toBeGreaterThan(1000);
      expect(res.rules).toEqual([]);
    }
  });

  it('one huge outlier does not create a prefer rule', () => {
    const r = rng(3);
    const rows = Array.from({ length: 400 }, (_, i) => row(i, { flat: { 'shape.run3m': r() * 100 }, pnlPct: -2 + gauss(r) * 6 }));
    // The best trade of all time sits in the top decile of run3m — and in the holdout too.
    rows[100]!.flat['shape.run3m'] = 99;
    rows[100]!.pnlPct = 500;
    rows[350]!.flat['shape.run3m'] = 98;
    rows[350]!.pnlPct = 400;
    const res = searchPolicies(rows);
    expect(res.rules.filter((x) => x.action === 'prefer')).toEqual([]);
  });

  it('an effect only in old data and reversed in new data is rejected by the holdout', () => {
    const r = rng(5);
    const rows = Array.from({ length: 600 }, (_, i) => {
      const x = r();
      const old = i < 420; // oldest 70%
      const bad = old ? x < 0.4 : x >= 0.4;
      return row(i, { flat: { 'market.liquidityUsd': x * 50_000 }, pnlPct: bad ? -15 + gauss(r) * 4 : 10 + gauss(r) * 10 });
    });
    const res = searchPolicies(rows);
    expect(res.rules.filter((x) => x.conditions.some((c) => c.feature === 'market.liquidityUsd'))).toEqual([]);
    // Same data without the reversal → found (so the rejection above really is the holdout's doing).
    const steady = rows.map((rw, i) => (i >= 420 ? { ...rw, pnlPct: rw.flat['market.liquidityUsd']! < 20_000 ? -15 : 10 } : rw));
    expect(searchPolicies(steady).rules.some((x) => x.action === 'avoid' && x.conditions[0]!.feature === 'market.liquidityUsd')).toBe(true);
  });

  it('missing features never match (missing is not 0)', () => {
    const r = rng(9);
    const rows = Array.from({ length: 500 }, (_, i) => {
      const has = r() < 0.6;
      const v = 0.5 + r();
      const pnl = has && v < 0.9 ? -16 + gauss(r) * 3 : 9 + gauss(r) * 10;
      return row(i, { flat: has ? { 'kol.count': v } : {}, pnlPct: pnl });
    });
    const res = searchPolicies(rows);
    const avoid = res.rules.find((x) => x.action === 'avoid' && x.conditions[0]!.feature === 'kol.count');
    expect(avoid).toBeDefined();
    expect(avoid!.conditions[0]!.op).toBe('lt');
  });

  it('is fast enough: 5,000 rows × 60 features well under 2 s', async () => {
    const r = rng(11);
    const strategies = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING', 'RUNNER'];
    const rows = Array.from({ length: 5000 }, (_, i) => row(i, { flat: { ...noiseFeatures(r, 58), 'entry.score': 60 + r() * 30, 'entry.hourUtc': Math.floor(r() * 24) }, pnlPct: noisyPnl(r), strategy: strategies[i % 6]! }));
    const t = Date.now();
    const res = await searchPoliciesAsync(rows);
    expect(Date.now() - t).toBeLessThan(4000); // loose for CI; typically well under 2 s
    expect(res.tested).toBeGreaterThan(5000);
  });

  it('runner class keeps the last result', async () => {
    const r = rng(13);
    const rows = Array.from({ length: 300 }, (_, i) => {
      const v = r();
      return row(i, { flat: { 'shape.offHigh10m': v * 30 }, pnlPct: v < 0.3 ? -15 + gauss(r) * 3 : 10 + gauss(r) * 8 });
    });
    const ps = new PolicySearch(async () => rows);
    expect(ps.last()).toBeNull();
    const res = await ps.run();
    expect(res).not.toBeNull();
    expect(ps.last()!.rules.length).toBeGreaterThan(0);
    expect(ps.last()!.rules[0]!.why).toMatch(/averaged/);
  });
});

describe('policy search: review fixes', () => {
  it('holdout must meet the absolute condition: a prefer rule whose newest matched trades lose is rejected', () => {
    const r = rng(21);
    const rows = Array.from({ length: 600 }, (_, i) => {
      const x = r();
      const old = i < 420;
      // Old: x > 0.6 → +12 vs −8 (prefer). New: matched −6, rest −20 → same sign, ≥ half the size, but the matched still lose.
      const pnl = old ? (x > 0.6 ? 12 + gauss(r) * 4 : -8 + gauss(r) * 8) : x > 0.6 ? -6 + gauss(r) * 3 : -20 + gauss(r) * 2;
      return row(i, { flat: { 'crowd.buyRatio2m': x }, pnlPct: pnl });
    });
    const res = searchPolicies(rows);
    expect(res.rules.filter((x) => x.action === 'prefer')).toEqual([]);
    // Control: holdout matched really profitable → found.
    const ok = rows.map((rw, i) => (i >= 420 && rw.flat['crowd.buyRatio2m']! > 0.6 ? { ...rw, pnlPct: 12 + gauss(r) * 4 } : rw));
    expect(searchPolicies(ok).rules.some((x) => x.action === 'prefer' && x.conditions[0]!.feature === 'crowd.buyRatio2m')).toBe(true);
  });

  it('holdout needs enough matched trades (effective n ≥ 10)', () => {
    const r = rng(23);
    const rows = Array.from({ length: 600 }, (_, i) => {
      const old = i < 420;
      // Old: 30% have v < 1 and lose. New: only 7 rows match (still losing).
      const bad = old ? r() < 0.3 : i % 25 === 0;
      const v = bad ? r() * 0.9 : 1.1 + r();
      return row(i, { flat: { 'kol.count': v }, pnlPct: bad ? -16 + gauss(r) * 3 : 10 + gauss(r) * 8 });
    });
    expect(searchPolicies(rows).rules.filter((x) => x.action === 'avoid' && x.conditions.some((c) => c.feature === 'kol.count'))).toEqual([]);
  });

  it('a rule and its exact complement are not both kept', () => {
    const r = rng(25);
    const rows = Array.from({ length: 800 }, (_, i) => {
      const x = r();
      return row(i, { flat: { 'shape.run3m': x }, pnlPct: x < 0.5 ? -15 + gauss(r) * 4 : 15 + gauss(r) * 4 });
    });
    const res = searchPolicies(rows);
    const single = res.rules.filter((x) => x.conditions.length === 1 && x.conditions[0]!.feature === 'shape.run3m' && x.strategy === null);
    expect(single.length).toBeGreaterThan(0);
    for (const a of single)
      for (const b of single)
        if (a !== b && a.action !== b.action) {
          const ca = a.conditions[0]!;
          const cb = b.conditions[0]!;
          const close = Math.abs(ca.value - cb.value) <= 0.1 * Math.max(Math.abs(ca.value), Math.abs(cb.value));
          expect(ca.op !== cb.op && close).toBe(false);
        }
  });

  it('async search keeps the event loop responsive (max gap < 150 ms) and finishes in time on 5,000 × 60', async () => {
    const r = rng(27);
    const strategies = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING', 'RUNNER'];
    const rows = Array.from({ length: 5000 }, (_, i) => row(i, { flat: { ...noiseFeatures(r, 58), 'entry.score': 60 + r() * 30, 'entry.hourUtc': Math.floor(r() * 24) }, pnlPct: noisyPnl(r), strategy: strategies[i % 6]! }));
    let maxGap = 0;
    let last = performance.now();
    let done = false;
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (!done) setImmediate(tick);
    };
    setImmediate(tick);
    const t = performance.now();
    await searchPoliciesAsync(rows);
    const total = performance.now() - t;
    done = true;
    expect(maxGap).toBeLessThan(150);
    expect(total).toBeLessThan(4000); // loose for loaded CI boxes; ~1.1 s standalone
  });
});
