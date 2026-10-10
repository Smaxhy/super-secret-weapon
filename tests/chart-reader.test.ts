import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { addToCandles, analyzeChart, resample, rsi, type Candle } from '../src/evaluator/chart-reader';
import { dipDecision, type DipWatch } from '../src/executor/dip-watcher';
import { BLOWOFF_MARKER, decideExit, type ExitInput } from '../src/executor/sell-manager';

const cfg = DEFAULT_CONFIG.chart;
const NOW = 1_000_000_000_000;
/** One 15s candle per price, the last one ending at NOW. */
function series(prices: number[], vol: (i: number) => number = () => 1): Candle[] {
  const n = prices.length;
  return prices.map((p, i) => {
    const prev = prices[i - 1] ?? p;
    return { t: NOW - (n - 1 - i) * 15_000, o: prev, h: Math.max(p, prev) * 1.002, l: Math.min(p, prev) * 0.998, c: p, v: vol(i), bv: vol(i) * 0.6, sv: vol(i) * 0.4, n: 5 };
  });
}
const ramp = (from: number, to: number, steps: number) => Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / Math.max(1, steps - 1));

describe('chart basics', () => {
  it('RSI: straight up = 100, flat chop ≈ 50', () => {
    expect(rsi(ramp(1, 2, 20))).toBe(100);
    const chop = Array.from({ length: 30 }, (_, i) => (i % 2 ? 1.01 : 1));
    expect(rsi(chop)!).toBeGreaterThan(40);
    expect(rsi(chop)!).toBeLessThan(60);
    expect(rsi([1, 2])).toBeNull();
  });
  it('builds 15s candles from trades and resamples them', () => {
    const c: Candle[] = [];
    addToCandles(c, 0, 1, 1, true);
    addToCandles(c, 5_000, 1.2, 2, true);
    addToCandles(c, 10_000, 0.9, 1, false);
    addToCandles(c, 16_000, 1.1, 1, true);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ o: 1, h: 1.2, l: 0.9, c: 0.9, v: 4, bv: 3, sv: 1, n: 3 });
    expect(resample(c, 30_000)).toHaveLength(1);
  });
  it('not enough chart → neutral', () => {
    expect(analyzeChart(series([1, 1.1, 1.2]), NOW, cfg).verdict).toBe('neutral');
  });
});

describe('entry verdicts', () => {
  it('a vertical pump is NOT bought — wait for a dip into a zone below the price', () => {
    const r = analyzeChart(series([...ramp(1, 1.2, 30), ...ramp(1.25, 2.2, 10)]), NOW, cfg);
    expect(r.verdict).toBe('wait_dip');
    expect(r.zone).not.toBeNull();
    expect(r.zone!.hi).toBeLessThan(r.price);
    expect(r.zone!.hi).toBeLessThanOrEqual(r.recentHigh * 0.9 + 1e-9);
    expect(r.summary).toContain('waiting for a dip');
  });
  it('the buy zone is a 38–62% retrace of the run-up (not a 40% crash)', () => {
    const r = analyzeChart(series([...ramp(1, 1.2, 30), ...ramp(1.25, 2.2, 10)]), NOW, cfg);
    const offHi = (1 - r.zone!.hi / r.recentHigh) * 100;
    const offLo = (1 - r.zone!.lo / r.recentHigh) * 100;
    expect(offHi).toBeGreaterThan(12);
    expect(offHi).toBeLessThan(25);
    expect(offLo).toBeGreaterThan(offHi);
    expect(offLo).toBeLessThan(38);
  });
  it('a healthy dip that is bouncing in an uptrend is the buy', () => {
    const r = analyzeChart(series([...ramp(1, 1.6, 30), ...ramp(1.6, 1.38, 6), ...ramp(1.38, 1.45, 3)]), NOW, cfg);
    expect(r.pullbackPct).toBeGreaterThan(10);
    expect(r.bouncePct).toBeGreaterThan(2);
    expect(r.verdict).toBe('buy_now');
  });
  it('a downtrend under VWAP with lower highs is avoided', () => {
    const zigzagDown = Array.from({ length: 40 }, (_, i) => 2 * Math.pow(0.985, i) * (i % 4 === 0 ? 1.02 : 1));
    const r = analyzeChart(series(zigzagDown), NOW, cfg);
    expect(r.trend).toBe('down');
    expect(r.verdict).toBe('avoid');
  });
});

describe('sell-side reading', () => {
  it('spots a blow-off top: vertical run on a volume climax getting rejected', () => {
    const prices = [...ramp(1, 1.1, 30), ...ramp(1.12, 1.9, 8)];
    const c = series(prices, (i) => (i >= prices.length - 2 ? 12 : 1));
    // last candle: long upper wick (rejected)
    const last = c[c.length - 1]!;
    last.h = last.c * 1.15;
    const r = analyzeChart(c, NOW, cfg);
    expect(r.blowOff).toBe(true);
  });
  it('sells half of what is left into a blow-off, once', () => {
    const now = 5_000_000;
    const base: ExitInput = {
      entryPriceSol: 1, peakPriceSol: 1.6, remainingPct: 75, tpTiersHit: [1.3], trailingActive: true, refPriceSol: 1, lastMoveAtMs: now, staleMinutes: 30, priceSol: 1.6,
      migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3, top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false,
      risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45, resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1, proceedsSol: 0.32, volatilityPct: null, txFeeSol: 0,
      smartSell: { blowOff: true, divergence: false, summary: 'test', minMultiple: 1.4, blowOffSellPct: 50, divergenceSellPct: 30 },
    };
    const d = decideExit(base, DEFAULT_CONFIG.exit);
    expect(d.sells[0]).toMatchObject({ pct: 37.5, reason: 'TAKE_PROFIT' });
    expect(d.sells[0]!.detail).toContain('blow-off');
    expect(d.state.tpTiersHit).toContain(BLOWOFF_MARKER);
    expect(decideExit({ ...base, tpTiersHit: d.state.tpTiersHit }, DEFAULT_CONFIG.exit).sells.filter((s) => s.detail.includes('blow-off'))).toEqual([]);
    expect(decideExit({ ...base, priceSol: 1.3, peakPriceSol: 1.3 }, DEFAULT_CONFIG.exit).sells.filter((s) => s.detail.includes('blow-off'))).toEqual([]); // below 1.4x
  });
});

describe('dip watcher', () => {
  const rules = DEFAULT_CONFIG.chart.dip;
  const w = (): DipWatch => ({ mint: 'm', symbol: 'S', strategy: 'SOON', zone: { lo: 0.8, hi: 0.9 }, signalPrice: 1, startedAt: 0, expiresAt: 600_000, lowest: null, why: '' });
  it('buys the dip only after it bounces with buyers in control', () => {
    const x = w();
    expect(dipDecision(x, 0.97, 2, 1000, rules).action).toBe('wait');
    expect(dipDecision(x, 0.86, 2, 2000, rules).action).toBe('wait'); // in the zone
    expect(dipDecision(x, 0.84, 2, 3000, rules).action).toBe('wait'); // lower low
    expect(dipDecision(x, 0.87, 0.8, 4000, rules).action).toBe('wait'); // bounced but sellers in control
    const d = dipDecision(x, 0.87, 1.5, 5000, rules);
    expect(d.action).toBe('buy');
    expect(d.why).toContain('bounced');
  });
  it('gives up when it runs away, breaks down or takes too long', () => {
    expect(dipDecision(w(), 1.45, 2, 1000, rules).action).toBe('drop');
    expect(dipDecision(w(), 0.7, 2, 1000, rules).why).toContain('broke down');
    expect(dipDecision(w(), 0.95, 2, 700_000, rules).why).toContain('no dip');
  });
});
