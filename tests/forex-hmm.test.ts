/** v18: the hidden-Markov regime model — fit on known regimes, causal readings, the 'hmm' filter rule. */
import { describe, expect, it } from 'vitest';
import { filterHmm, fitHmm, HMM, hmmBlockReason, hmmRegime, hmmReturns, passHmm } from '../src/forex/hmm';
import { rng } from '../src/forex/stats';

/** returns (bp) that alternate between a calm regime (sd 3) and a wild one (sd 12), deterministic */
function regimes(seed: number, calm = 600, wild = 200, rounds = 4): { x: number[]; wild: boolean[] } {
  const r = rng(seed);
  const z = () => {
    const u = Math.max(1e-12, r());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const x: number[] = [];
  const w: boolean[] = [];
  for (let k = 0; k < rounds; k++) {
    for (let i = 0; i < calm; i++) {
      x.push(3 * z());
      w.push(false);
    }
    for (let i = 0; i < wild; i++) {
      x.push(12 * z());
      w.push(true);
    }
  }
  return { x, wild: w };
}

describe('v18 HMM regime model', () => {
  it('finds the calm and the wild state and reads them causally', () => {
    const { x, wild } = regimes(7);
    const m = fitHmm(x, 2)!;
    expect(m).not.toBeNull();
    expect(m.sigma[m.hi]!).toBeGreaterThan(8);
    expect(m.sigma[m.lo]!).toBeLessThan(5);
    expect(m.A[m.hi]![m.hi]!).toBeGreaterThan(0.9); // regimes persist
    const post = filterHmm(m, x);
    let inWild = 0;
    let inCalm = 0;
    let nw = 0;
    let nc = 0;
    for (let t = 20; t < x.length; t++) {
      if (wild[t]) {
        inWild += post[m.hi]![t]!;
        nw++;
      } else {
        inCalm += post[m.hi]![t]!;
        nc++;
      }
    }
    expect(inWild / nw).toBeGreaterThan(0.7);
    expect(inCalm / nc).toBeLessThan(0.25);
    // causal: the reading at t is the same whether or not later bars exist
    const cut = 1_000;
    const prefix = filterHmm(m, x.slice(0, cut));
    for (let t = 0; t < cut; t += 97) expect(prefix[m.hi]![t]!).toBeCloseTo(post[m.hi]![t]!, 12);
    // deterministic
    expect(fitHmm(x, 2)!.logLik).toBe(m.logLik);
  });

  it('three states order themselves by volatility; a flat or short series gives no model', () => {
    const { x } = regimes(11, 500, 250, 5);
    const m = fitHmm(x, 3)!;
    expect(m.k).toBe(3);
    expect(m.sigma[m.hi]!).toBeGreaterThan(m.sigma[m.lo]!);
    expect(fitHmm(new Array(1_000).fill(0))).toBeNull();
    expect(fitHmm(x.slice(0, 100))).toBeNull();
  });

  it('hmmRegime fits on the first part only and reads every bar; huge outliers do not break it', () => {
    const { x } = regimes(5);
    const close: number[] = [1.1];
    for (const r of x) close.push(close[close.length - 1]! * Math.exp(r / 1e4));
    const fitN = Math.floor(close.length * 0.7);
    const reg = hmmRegime(close, fitN, 3)!;
    expect(reg.fitBars).toBe(fitN);
    expect(Number.isNaN(reg.pHigh[0]!)).toBe(true);
    expect(reg.pHigh.length).toBe(close.length);
    for (let i = 1; i < close.length; i += 211) {
      expect(reg.pHigh[i]!).toBeGreaterThanOrEqual(0);
      expect(reg.pHigh[i]!).toBeLessThanOrEqual(1);
      expect(reg.pLow[i]! + reg.pHigh[i]!).toBeLessThanOrEqual(1.000001);
    }
    // the model only saw the fit window: refitting on a longer close series with the same fitBars is identical
    const longer = [...close, ...close.slice(1, 300)];
    expect(hmmRegime(longer, fitN, 3)!.model.logLik).toBe(reg.model.logLik);
    // an absurd print (a 20% hourly move) is read as wild, not as a crash of the numbers
    const spiked = [...close];
    spiked[fitN + 50] = spiked[fitN + 49]! * 1.2;
    const sp = hmmRegime(spiked, fitN, 3)!;
    expect(sp.pHigh[fitN + 50]!).toBeGreaterThan(0.9);
    expect(Number.isFinite(sp.pHigh[fitN + 51]!)).toBe(true);
    expect(hmmReturns([1, 1.001, 1.001])[1]!).toBeCloseTo(1e4 * Math.log(1.001), 9);
  });

  it("the filter's rule: wild → nothing; fades need quiet; trend rules need movement; missing → pass", () => {
    expect(passHmm(undefined, undefined, 'trend')).toBe(true);
    expect(passHmm(NaN, 0.5, 'trend')).toBe(true);
    expect(passHmm(0.7, 0.1, 'trend')).toBe(false);
    expect(passHmm(0.7, 0.1, 'neutral')).toBe(false);
    expect(passHmm(0.2, 0.5, 'revert')).toBe(true);
    expect(passHmm(0.2, 0.2, 'revert')).toBe(false);
    expect(passHmm(0.1, 0.9, 'trend')).toBe(false);
    expect(passHmm(0.1, 0.5, 'trend')).toBe(true);
    expect(passHmm(0.1, 0.9, 'pullback')).toBe(true);
    expect(hmmBlockReason(0.7, 0.1, 'trend')).toMatch(/wild/);
    expect(hmmBlockReason(0.2, 0.2, 'revert')).toMatch(/quiet market/);
    expect(hmmBlockReason(0.1, 0.9, 'trend')).toMatch(/dead-quiet/);
    expect(hmmBlockReason(0.1, 0.5, 'trend')).toBeNull();
    expect(HMM.crisis).toBe(0.6);
  });
});
