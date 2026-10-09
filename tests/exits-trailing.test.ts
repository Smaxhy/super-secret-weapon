import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import {
  breakEvenMultiple,
  computeVolatilityPct,
  decideExit,
  INITIALS_MARKER,
  normaliseInsiderSignal,
  priceTrusted,
  trailingStopLevel,
  trailRules,
  type ActivitySample,
  type ExitInput,
} from '../src/executor/sell-manager';

// These tests cover the LEGACY trailing logic (no ladder, break-even from 1.5x). The
// ladder (tight on small moves, wide on big ones) is tested in tests/exits-ladder.test.ts.
const rules = { ...DEFAULT_CONFIG.exit, trailingStopActivateMultiple: 1.25, trail: { ...DEFAULT_CONFIG.exit.trail, ladder: [], breakEvenAfterMultiple: 1.5, confirmTicks: 2, confirmSec: 3, volAdjust: { min: 0.8, max: 1.3 } } };
const now = 50_000_000;
const base: ExitInput = {
  entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
  staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
  top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45,
  resistance: { hit: false, level: 0, touches: 0 },
  sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015,
};
// Before initials: 1.3x tier done, trail armed.
const pre: ExitInput = { ...base, tpTiersHit: [1.3], remainingPct: 75, trailingActive: true, proceedsSol: 0.32 };
// Runner: initials out, 40% left.
const runner: ExitInput = { ...pre, tpTiersHit: [1.3, INITIALS_MARKER], remainingPct: 40, proceedsSol: 1.01 };
const sold = (i: Partial<ExitInput>, from: ExitInput = pre) => decideExit({ ...from, ...i }, rules).sells.map((s) => s.reason);

describe('trailing stop: wick vs real break', () => {
  // pre, peak 1.9x, no vol → 20% trail → stop 1.52x; gap level 1.9 − 1.5 × 0.38 = 1.33x
  const cases: Array<{ name: string; i: Partial<ExitInput>; want: string[] }> = [
    { name: 'above the stop: hold', i: { peakPriceSol: 1.9, priceSol: 1.6 }, want: [] },
    { name: 'first check under the stop (wick?): hold', i: { peakPriceSol: 1.9, priceSol: 1.5 }, want: [] },
    { name: 'second check but only 2s under: hold', i: { peakPriceSol: 1.9, priceSol: 1.5, breachTicks: 1, breachSinceMs: now - 2000 }, want: [] },
    { name: 'second check, 4s under: confirmed → sell', i: { peakPriceSol: 1.9, priceSol: 1.5, breachTicks: 1, breachSinceMs: now - 4000 }, want: ['TRAILING_STOP'] },
    { name: 'gapped far below: sell at once', i: { peakPriceSol: 1.9, priceSol: 1.3 }, want: ['TRAILING_STOP'] },
  ];
  for (const c of cases) it(c.name, () => expect(sold(c.i)).toEqual(c.want));

  it('records the break in progress and clears it when the price recovers', () => {
    const d1 = decideExit({ ...pre, peakPriceSol: 1.9, priceSol: 1.5 }, rules);
    expect(d1.state).toMatchObject({ breachTicks: 1, breachSinceMs: now });
    const d2 = decideExit({ ...pre, peakPriceSol: 1.9, priceSol: 1.7, breachTicks: 1, breachSinceMs: now - 2000, nowMs: now + 2000 }, rules);
    expect(d2.state).toMatchObject({ breachTicks: 0, breachSinceMs: null });
    expect(d2.sells).toEqual([]);
  });
});

describe('trailing stop: volatile vs calm', () => {
  // pre, peak 1.9x, price 1.65x = 13.2% off the peak (not a gap for either)
  const cases: Array<{ name: string; vol: number | null; trailPct: number; sells: boolean }> = [
    { name: 'calm chart (2%): tight 10% trail → confirmed break sells', vol: 2, trailPct: 10, sells: true },
    { name: 'normal chart (5%): 12.5% trail → sells', vol: 5, trailPct: 12.5, sells: true },
    { name: 'wild chart (8%): trail widens to the 20% cap → holds', vol: 8, trailPct: 20, sells: false },
    { name: 'no vol data: classic 20% → holds', vol: null, trailPct: 20, sells: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const lvl = trailingStopLevel({ entryPriceSol: 1, peakPriceSol: 1.9, trailingActive: true, initialsOut: false, volatilityPct: c.vol, sizeSol: 1, costSol: 1.0015, remainingPct: 75, txFeeSol: 0.0015 }, rules)!;
      expect(lvl.trailPct).toBe(c.trailPct);
      const got = sold({ peakPriceSol: 1.9, priceSol: 1.65, volatilityPct: c.vol, breachTicks: 1, breachSinceMs: now - 4000 });
      expect(got).toEqual(c.sells ? ['TRAILING_STOP'] : []);
    });
  }
});

describe('runner trail tightens as profit grows', () => {
  // Very wild chart (vol 20% → 3 × 20 = 60%, clamped to 35%) so only the profit caps decide.
  const cases: Array<{ peakX: number; trailPct: number }> = [
    { peakX: 2.5, trailPct: 35 },
    { peakX: 3, trailPct: 30 },
    { peakX: 5, trailPct: 25 },
    { peakX: 10, trailPct: 20 },
  ];
  for (const c of cases) {
    it(`peak ${c.peakX}x → ${c.trailPct}% trail`, () => {
      const lvl = trailingStopLevel({ entryPriceSol: 1, peakPriceSol: c.peakX, trailingActive: true, initialsOut: true, volatilityPct: 20, sizeSol: 1, costSol: 1.0015, remainingPct: 40, txFeeSol: 0.0015 }, rules)!;
      expect(lvl.phase).toBe('runner');
      expect(lvl.trailPct).toBe(c.trailPct);
      expect(lvl.stopPriceSol).toBeCloseTo(c.peakX * (1 - c.trailPct / 100), 9);
    });
  }
  it('a 27% pullback holds a 3x runner on a wild chart but sells a 6x runner (confirmed)', () => {
    const at = (peak: number) => sold({ peakPriceSol: peak, priceSol: peak * 0.73, volatilityPct: 20, breachTicks: 1, breachSinceMs: now - 4000 }, runner);
    expect(at(3)).toEqual([]);
    expect(at(6)).toEqual(['TRAILING_STOP']);
  });
});

describe('break-even floor after 1.5x', () => {
  it('break-even multiple covers cost + % fees + the sell tx fee', () => {
    const be = breakEvenMultiple({ sizeSol: 1, costSol: 1.0015, remainingPct: 75, txFeeSol: 0.0015 }, rules.initials.feeBufferPct);
    expect(be).toBeCloseTo(1.0015 / 0.96 + 0.0015 / 0.75, 9);
  });
  it('no floor before 1.5x; floor once 1.5x was seen and the trail is wide', () => {
    const p = { entryPriceSol: 1, trailingActive: true, initialsOut: false, volatilityPct: null, sizeSol: 1, costSol: 1.0015, remainingPct: 75, txFeeSol: 0.0015 };
    expect(trailingStopLevel({ ...p, peakPriceSol: 1.4 }, rules)!.floorPriceSol).toBeNull();
    const custom = { ...rules, trailingStopPct: 40, trailingTightening: [] };
    const lvl = trailingStopLevel({ ...p, peakPriceSol: 1.6 }, custom)!;
    expect(lvl.floorPriceSol).toBeGreaterThan(lvl.trailPriceSol); // 1.6 × 0.6 = 0.96 < ~1.045
    expect(lvl.stopPriceSol).toBe(lvl.floorPriceSol);
  });
});

describe('peak tracking from real trades', () => {
  it('a suspicious price does not raise the peak', () => {
    expect(decideExit({ ...pre, peakPriceSol: 1.5, priceSol: 3, priceTrusted: false }, rules).state.peakPriceSol).toBe(1.5);
  });
  it('a one-check spike only counts up to the previous price', () => {
    expect(decideExit({ ...pre, peakPriceSol: 1.5, prevPriceSol: 1.6, priceSol: 2.2 }, rules).state.peakPriceSol).toBe(1.6);
    expect(decideExit({ ...pre, peakPriceSol: 1.5, prevPriceSol: 2.1, priceSol: 2.2 }, rules).state.peakPriceSol).toBe(2.1);
  });
  it('priceTrusted compares with the last real trade', () => {
    expect(priceTrusted(1.1, 1, 25)).toBe(true);
    expect(priceTrusted(1.4, 1, 25)).toBe(false);
    expect(priceTrusted(1.4, null, 25)).toBe(true);
    expect(priceTrusted(0, 1, 25)).toBe(false);
  });
});

describe('insider dump → rug exit', () => {
  it('normalises the rug agent signal', () => {
    expect(normaliseInsiderSignal({ dumping: true, reason: 'insiders sold 60%' })).toEqual({ hit: true, detail: 'insiders sold 60%' });
    expect(normaliseInsiderSignal({ dumping: false, reason: 'x' })).toBeNull();
    expect(normaliseInsiderSignal(null)).toBeNull();
  });
  it('exits everything immediately, even a runner in profit', () => {
    const d = decideExit({ ...runner, peakPriceSol: 3, priceSol: 3, insiderDump: { hit: true, detail: 'insiders sold 60%' } }, rules);
    expect(d.sells).toEqual([{ pct: 40, reason: 'RUG_DETECTED', detail: 'insiders sold 60%' }]);
  });
});

describe('robust volatility', () => {
  const at = (prices: number[], every = 2000): ActivitySample[] => prices.map((p, k) => ({ t: k * every, buys: 0, sells: 0, holders: 0, priceSol: p }));
  it('a single outlier print barely moves it', () => {
    const calm = Array.from({ length: 120 }, (_, k) => 1 + 0.01 * Math.sin(k / 3));
    const spiked = [...calm];
    spiked[60] = 3; // one bad print
    const a = computeVolatilityPct(at(calm), 238_000, 240_000, 15_000)!;
    const b = computeVolatilityPct(at(spiked), 238_000, 240_000, 15_000)!;
    expect(Math.abs(b - a)).toBeLessThan(0.5);
  });
  it('untrusted samples are ignored', () => {
    const s = at(Array.from({ length: 120 }, () => 1));
    s[50] = { ...s[50]!, priceSol: 2, trusted: false };
    s[51] = { ...s[51]!, priceSol: 2, trusted: false };
    expect(computeVolatilityPct(s, 238_000, 240_000, 15_000)).toBe(0);
  });
  it('real chop reads higher than calm', () => {
    const calm = at(Array.from({ length: 120 }, (_, k) => 1 + 0.01 * Math.sin(k / 3)));
    const wild = at(Array.from({ length: 120 }, (_, k) => 1 + 0.2 * Math.sin(k / 3)));
    expect(computeVolatilityPct(wild, 238_000)!).toBeGreaterThan(computeVolatilityPct(calm, 238_000)! * 5);
  });
});

describe('older saved exit configs', () => {
  it('fall back to the default trail settings', () => {
    const { trail: _drop, ...old } = rules;
    expect(trailRules(old as typeof rules)).toEqual(DEFAULT_CONFIG.exit.trail);
    const oldRules = old as typeof rules;
    // Defaults: ~10.6% trail at a 1.9x peak, sells the moment it breaks.
    expect(decideExit({ ...pre, peakPriceSol: 1.9, priceSol: 1.65 }, oldRules).sells.map((s) => s.reason)).toEqual(['TRAILING_STOP']);
    expect(decideExit({ ...pre, peakPriceSol: 1.9, priceSol: 1.75 }, oldRules).sells).toEqual([]);
  });
});
