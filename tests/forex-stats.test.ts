/** v18: honest statistics — deflated Sharpe, PBO by CSCV, Reality Check / SPA — on known data. */
import { describe, expect, it } from 'vitest';
import { bucketSums, deflatedSharpe, expectedMaxSharpe, minTrackRecord, moments, normCdf, normInv, pbo, psr, realityCheck, rng, sharpe, sharpeSe, varianceOf } from '../src/forex/stats';

/** seeded normal draws (Box-Muller) */
function normals(n: number, mean: number, sd: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = Math.max(1e-12, r());
    const v = r();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    out.push(mean + sd * z);
  }
  return out;
}

describe('v18 normal distribution helpers', () => {
  it('Φ and Φ⁻¹ agree and hit the textbook values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normCdf(-2.326348)).toBeCloseTo(0.01, 4);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(normInv(0.5)).toBeCloseTo(0, 6);
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 4);
    for (const p of [0.01, 0.1, 0.3, 0.6, 0.9, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
  });
});

describe('v18 Sharpe statistics', () => {
  it('moments and the Sharpe standard error (normal data: √((1 + SR²/2)/(n−1)))', () => {
    const m = moments([1, 2, 3, 4, 5]);
    expect(m.mean).toBe(3);
    expect(m.sd).toBeCloseTo(Math.sqrt(2.5), 9);
    expect(m.skew).toBeCloseTo(0, 9);
    expect(sharpe([1, 2, 3, 4, 5])).toBeCloseTo(3 / Math.sqrt(2.5), 9);
    expect(sharpeSe(0.2, 101, 0, 3)).toBeCloseTo(Math.sqrt((1 + 0.02) / 100), 9);
    // fat tails widen it, negative skew widens it further
    expect(sharpeSe(0.2, 101, 0, 6)).toBeGreaterThan(sharpeSe(0.2, 101, 0, 3));
    expect(sharpeSe(0.2, 101, -1, 3)).toBeGreaterThan(sharpeSe(0.2, 101, 0, 3));
  });

  it('the expected best of N noise trials grows with N and their spread', () => {
    expect(expectedMaxSharpe(1, 0.1)).toBe(0);
    const e10 = expectedMaxSharpe(10, 0.04);
    const e300 = expectedMaxSharpe(300, 0.04);
    expect(e10).toBeGreaterThan(0.2);
    expect(e300).toBeGreaterThan(e10);
    expect(expectedMaxSharpe(300, 0.16)).toBeCloseTo(2 * e300, 9);
  });

  it('a real edge keeps a high deflated Sharpe; the lucky best of 300 noise trials does not', () => {
    const real = normals(400, 0.3, 1, 1);
    const d = deflatedSharpe(real, { n: 300, varSr: 0.0025 });
    expect(d.sr).toBeGreaterThan(0.2);
    expect(d.psr0).toBeGreaterThan(0.99);
    expect(d.dsr).toBeGreaterThan(0.95);
    // 300 noise series of 400 draws: the best one's plain PSR looks great, its deflated one does not
    const trials = Array.from({ length: 300 }, (_, k) => normals(400, 0, 1, 100 + k));
    const srs = trials.map(sharpe);
    const best = trials[srs.indexOf(Math.max(...srs))]!;
    const v = varianceOf(srs);
    const lucky = deflatedSharpe(best, { n: 300, varSr: v });
    expect(lucky.psr0).toBeGreaterThan(0.95);
    expect(lucky.dsr).toBeLessThan(0.7);
    expect(psr(0.1, 50, 0, 3)).toBeGreaterThan(0.5);
  });

  it('minimum track record length: more observations for a smaller edge, infinite when there is none', () => {
    expect(minTrackRecord(0.1, 0, 3)).toBeGreaterThan(minTrackRecord(0.3, 0, 3));
    expect(minTrackRecord(0.3, 0, 3, 0, 0.05)).toBeCloseTo(1 + (1 + 0.045) * Math.pow(1.644854 / 0.3, 2), 1);
    expect(minTrackRecord(0.1, 0, 3, 0.2)).toBe(Infinity);
  });
});

describe('v18 probability of backtest overfitting (CSCV)', () => {
  it('pure noise selection → PBO near ½; one real edge among the trials → low PBO', () => {
    const noise = Array.from({ length: 20 }, (_, k) => normals(160, 0, 1, 500 + k));
    const p = pbo(noise, 16)!;
    expect(p.combos).toBe(12_870);
    expect(p.trials).toBe(20);
    expect(p.pbo).toBeGreaterThan(0.3);
    expect(p.pbo).toBeLessThan(0.7);
    const withEdge = [normals(160, 0.5, 1, 999), ...noise];
    const q = pbo(withEdge, 16)!;
    expect(q.pbo).toBeLessThan(0.15);
    expect(q.pLossOos).toBeLessThan(0.15);
    expect(q.logit.median).toBeGreaterThan(0);
    // too short for 16 blocks of 4 → null; one trial → null
    expect(pbo(noise.map((x) => x.slice(0, 40)), 16)).toBeNull();
    expect(pbo([noise[0]!])).toBeNull();
  });
});

describe('v18 Reality Check / SPA', () => {
  it('noise rows do not beat the benchmark once every row is counted; a real edge does', () => {
    const noise = Array.from({ length: 30 }, (_, k) => normals(156, 0, 1, 700 + k));
    const rc = realityCheck(noise, { draws: 400, seed: 3 })!;
    expect(rc.trials).toBe(30);
    expect(rc.pRc).toBeGreaterThan(0.1);
    expect(rc.pSpa).toBeGreaterThan(0.1);
    const edge = [normals(156, 0.6, 1, 42), ...noise];
    const e = realityCheck(edge, { draws: 400, seed: 3 })!;
    expect(e.best).toBe(0);
    expect(e.pRc).toBeLessThan(0.05);
    expect(e.pSpa).toBeLessThan(0.05);
    expect(realityCheck([normals(10, 0, 1, 1)])).toBeNull();
  });

  it('bucket sums put each event in its period', () => {
    const b = bucketSums([{ t: 5, v: 1 }, { t: 15, v: 2 }, { t: 19, v: 3 }, { t: 99, v: 9 }], 0, 30, 10);
    expect([...b]).toEqual([1, 5, 0]);
  });
});
