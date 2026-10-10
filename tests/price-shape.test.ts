import { describe, expect, it } from 'vitest';
import { afterEntry, priceShape, staircase } from '../src/evaluator/price-shape';
import type { Candle } from '../src/evaluator/chart-reader';

const NOW = 1_760_000_000_000;
const candle = (i: number, o: number, c: number, v = 1, bv = 0.6): Candle => ({ t: NOW - (40 - i) * 15_000, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v, bv: v * bv, sv: v * (1 - bv), n: 5 });

describe('price shape before a buy', () => {
  it('sees a vertical spike bought at the top', () => {
    const flat = Array.from({ length: 34 }, (_, i) => candle(i, 1, 1));
    const spike = [candle(34, 1, 1.2, 3), candle(35, 1.2, 1.45, 4), candle(36, 1.45, 1.7, 5), candle(37, 1.7, 1.9, 6), candle(38, 1.9, 2.0, 6), candle(39, 2.0, 2.1, 7)];
    const s = priceShape([...flat, ...spike], NOW)!;
    expect(s.run3m).toBeGreaterThan(80);
    expect(s.spikes10m).toBeGreaterThanOrEqual(3);
    expect(s.greenStreak).toBe(6);
    expect(s.offHigh10m).toBeLessThan(3);
    expect(s.volAccel).toBeGreaterThan(2);
  });
  it('sees a pullback after a run', () => {
    const cs = [...Array.from({ length: 20 }, (_, i) => candle(i, 1 + i * 0.05, 1 + (i + 1) * 0.05)), ...Array.from({ length: 20 }, (_, i) => candle(20 + i, 2.05 - i * 0.02, 2.03 - i * 0.02, 1, 0.45))];
    const s = priceShape(cs, NOW)!;
    expect(s.offHigh10m).toBeGreaterThan(15);
    expect(s.run1m).toBeLessThan(0);
    expect(priceShape(cs.slice(0, 2), NOW)).toBeNull();
  });
  it('what happened after the buy (bought the top vs good entry)', () => {
    const t0 = NOW;
    const top = afterEntry([{ t: t0 + 5_000, priceSol: 1 }, { t: t0 + 30_000, priceSol: 0.84 }, { t: t0 + 200_000, priceSol: 0.8 }], 1, t0)!;
    expect(top).toMatchObject({ min1m: 0.84, peak: 1, secToPeak: 5 });
    const good = afterEntry([{ t: t0 + 10_000, priceSol: 1.1 }, { t: t0 + 120_000, priceSol: 1.5 }], 1, t0)!;
    expect(good).toMatchObject({ max5m: 1.5, peak: 1.5, secToPeak: 120 });
    expect(afterEntry([], 1, t0)).toBeNull();
  });
});

describe('staircase charts (owner: avoid them)', () => {
  // 15 s candles: each minute = 4 candles; build per-minute steps.
  const stairs = (steps: number[], wick = 0.002) => {
    const out: Candle[] = [];
    let p = 1;
    steps.forEach((st, m) => {
      for (let q = 0; q < 4; q++) {
        const o = p;
        const c = p * (1 + st / 4);
        out.push({ t: NOW - (steps.length - m) * 60_000 + q * 15_000, o, h: c * (1 + wick), l: o * (1 - wick), c, v: 0.5, bv: 0.5, sv: 0, n: 2 });
        p = c;
      }
    });
    return out;
  };
  const few = (n: number) => Array.from({ length: 30 }, (_, i) => ({ t: NOW - 500_000 + i * 15_000, w: `w${i % n}`, buy: true, sol: 0.4 }));
  const many = Array.from({ length: 80 }, (_, i) => ({ t: NOW - 500_000 + i * 6_000, w: `w${i}`, buy: i % 3 !== 0, sol: 0.3 + (i % 7) * 0.2 }));
  it('flags even, wickless green steps bought by a few wallets', () => {
    const s = staircase(stairs([0.06, 0.07, 0.06, 0.065, 0.06, 0.07, 0.06, 0.065]), few(3), NOW);
    expect(s.hit).toBe(true);
    expect(s.why).toMatch(/staircase chart/);
  });
  it('leaves messy real demand alone', () => {
    const messy = stairs([0.02, 0.15, -0.01, 0.3, 0.01, 0.12, 0.05, 0.2], 0.08);
    expect(staircase(messy, many, NOW).hit).toBe(false);
    // Same even steps but lots of different buyers and real selling → not flagged.
    expect(staircase(stairs([0.06, 0.07, 0.06, 0.065, 0.06, 0.07, 0.06, 0.065]), many, NOW).hit).toBe(false);
    expect(staircase(stairs([0.06, 0.06]), few(2), NOW).hit).toBe(false);
  });
});
