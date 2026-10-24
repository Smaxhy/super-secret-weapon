import { describe, expect, it } from 'vitest';
import { buildFlow, profileOf, valueArea } from '../src/forex/flow';
import { buildCtx, to4h } from '../src/forex/ta';
import { strategyById, runsOn } from '../src/forex/strategies';
import { barOfRow, parseYahoo, volumeShare } from '../src/forex/data';
import { parseCandles } from '../src/forex/coinbase';
import { judgeFeatures, JUDGE_FEATURES } from '../src/forex/judge';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.parse('2026-01-05T00:00:00Z');
/** bars from closes: open = previous close, high / low a little past the body */
const fromCloses = (cs: number[], wick = 0.05, v?: (k: number) => number | undefined): Bar[] =>
  cs.map((c, k) => {
    const o = k ? cs[k - 1]! : c;
    const b: Bar = { t: T0 + k * H, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c };
    const vol = v?.(k);
    if (vol !== undefined) b.v = vol;
    return b;
  });
/** a slow wave: the 50-candle spread (≈ 0.75) is bigger than one candle's range (≈ 0.4), like a real ranging market */
const wave = (n: number) => Array.from({ length: n }, (_, k) => 100 + Math.sin(k * 0.3) + 0.3 * Math.sin(k * 1.1));
const noise = (n: number, base = 100, amp = 0.1) => Array.from({ length: n }, (_, k) => base + amp * Math.sin(k * 1.7) + 0.5 * amp * Math.cos(k * 0.6));
const firstSignal = (id: string, bars: Bar[], from = 0) => {
  const c = buildCtx(bars, 60, 'NDXUSD');
  const s = strategyById(id)!;
  for (let i = from; i < bars.length; i++) {
    const sig = s.signal(c, i);
    if (sig) return { i, sig, c };
  }
  return null;
};

describe('v27.35 standard deviation, volume profile, order flow', () => {
  it('value area: POC on the busiest bin, 70% around it; time profile without volume', () => {
    expect(valueArea([1, 2, 10, 3, 1], 0, 1)).toEqual({ poc: 2.5, val: 2, vah: 4 });
    // volume piles up at 100–101 → POC there even though the price also visited 105
    const bars: Bar[] = [];
    for (let k = 0; k < 40; k++) bars.push({ t: k, o: 100.4, h: 100.9, l: 100.1, c: 100.5, v: 1_000 });
    for (let k = 40; k < 44; k++) bars.push({ t: k, o: 104, h: 105, l: 103, c: 104.5, v: 10 });
    const vp = profileOf({ bars }, -1, bars.length - 1)!;
    expect(vp.byVolume).toBe(true);
    expect(vp.poc).toBeGreaterThan(100);
    expect(vp.poc).toBeLessThan(101);
    expect(vp.vah).toBeLessThan(103);
    const noVol = profileOf({ bars: bars.map(({ v: _v, ...b }) => b) }, -1, bars.length - 1)!;
    expect(noVol.byVolume).toBe(false);
  });

  it('order flow from candles: closes at the highs = buyers, relative volume, NaN without volume', () => {
    const up = Array.from({ length: 30 }, (_, k) => 100 + k * 0.5);
    const bars = up.map((c, k) => ({ t: T0 + k * H, o: c - 0.4, h: c, l: c - 0.5, c, v: k === 29 ? 300 : 100 }));
    const f = buildFlow(buildCtx(bars, 60, 'BTCUSD'));
    expect(f.hasVol).toBe(true);
    expect(f.cmf[29]!).toBeCloseTo(1, 5);
    expect(f.relVol[29]!).toBeCloseTo(3, 5);
    const f2 = buildFlow(buildCtx(bars.map(({ v: _v, ...b }) => b), 60, 'EURUSD'));
    expect(f2.hasVol).toBe(false);
    expect(Number.isNaN(f2.cmf[29]!)).toBe(true);
  });

  it('readings are causal: bar i is the same whether or not later bars exist', () => {
    const cs = noise(300).map((x, k) => x + (k > 200 ? (k - 200) * 0.05 : 0));
    const bars = fromCloses(cs, 0.05, (k) => 50 + (k % 7) * 10);
    const all = buildFlow(buildCtx(bars, 60, 'BTCUSD'));
    const cut = buildFlow(buildCtx(bars.slice(0, 220), 60, 'BTCUSD'));
    for (const i of [100, 150, 219]) {
      expect(cut.lrZ[i]).toBe(all.lrZ[i]);
      expect(cut.cmf[i]).toBe(all.cmf[i]);
      expect(cut.relVol[i]).toBe(all.relVol[i]);
      expect(cut.vp(i)).toEqual(all.vp(i));
    }
  });

  it('sd_revert: flat channel, a 2.2-SD dip comes back → buy toward the line', () => {
    const cs = wave(120);
    cs.push(98, 97.8, 98.6);
    const hit = firstSignal('sd_revert', fromCloses(cs), 120);
    expect(hit).not.toBeNull();
    expect(hit!.sig.side).toBe(1);
    expect(hit!.sig.target!).toBeGreaterThan(hit!.c.close[hit!.i]!);
  });

  it('vp_reentry: closed under the value area, back inside → target the POC', () => {
    const cs = wave(112);
    cs.push(99, 99.7);
    const hit = firstSignal('vp_reentry', fromCloses(cs), 113);
    expect(hit).not.toBeNull();
    expect(hit!.sig.side).toBe(1);
    expect(hit!.sig.target).toBeCloseTo(hit!.c.flow!.vp(hit!.i - 1)!.poc, 9);
  });

  it('order-flow rules fire only with volume: a selling climax reverses', () => {
    const cs = noise(60);
    cs.push(99.9);
    const bars = fromCloses(cs, 0.05, () => 100);
    // the climax candle: huge range to a new low, closes near its high, 4× volume
    bars.push({ t: T0 + 61 * H, o: 99.9, h: 100.05, l: 99.3, c: 99.98, v: 400 });
    const hit = firstSignal('of_climax', bars, 60);
    expect(hit?.sig.side).toBe(1);
    expect(firstSignal('of_climax', bars.map(({ v: _v, ...b }) => b), 60)).toBeNull();
    expect(runsOn(strategyById('of_climax')!, '15m', 'EURUSD')).toBe(true);
  });

  it('volume is kept through the feeds: Yahoo (0 = none), stored rows, Coinbase, 4-hour sums', () => {
    const json = { chart: { result: [{ timestamp: [T0 / 1000, T0 / 1000 + 3600], indicators: { quote: [{ open: [1, 1], high: [2, 2], low: [0.5, 0.5], close: [1.5, 1.5], volume: [0, 1234] }] } }] } };
    const ys = parseYahoo(json, T0 + 10 * H);
    expect(ys[0]!.v).toBeUndefined();
    expect(ys[1]!.v).toBe(1234);
    expect(barOfRow([1, 2, 3, 1, 2, 55])).toMatchObject({ v: 55 });
    expect(barOfRow([1, 2, 3, 1, 2]).v).toBeUndefined();
    expect(volumeShare(ys)).toBe(0.5);
    const cb = parseCandles([[T0 / 1000, 1, 3, 2, 2.5, 42]], T0 + 10 * H, H);
    expect(cb[0]!.v).toBe(42);
    const h1 = fromCloses([1, 2, 3, 4, 5, 6, 7, 8], 0.1, (k) => k + 1);
    expect(to4h(h1).map((b) => b.v)).toEqual([10, 26]);
    h1[5]!.v = undefined;
    expect(to4h(h1)[1]!.v).toBeUndefined();
  });

  it('the signal judge sees the new readings (volume ones only where there is volume)', () => {
    const cs = noise(150);
    const withVol = buildCtx(fromCloses(cs, 0.05, () => 100), 60, 'NDXUSD');
    const noVol = buildCtx(fromCloses(cs), 60, 'EURUSD');
    const ix = (f: string) => JUDGE_FEATURES.indexOf(f as never);
    const x1 = judgeFeatures(withVol, null, 140, 1, 99.5, 101, { style: 'trend', prior: 0, form: 0, tf: '1h' });
    const x2 = judgeFeatures(noVol, null, 140, 1, 99.5, 101, { style: 'trend', prior: 0, form: 0, tf: '1h' });
    for (const f of ['lrZ', 'lrR2', 'vpPoc', 'vaPos', 'cmf', 'relVol']) expect(Number.isFinite(x1[ix(f)]!)).toBe(true);
    expect(Number.isFinite(x2[ix('vpPoc')]!)).toBe(true);
    expect(Number.isNaN(x2[ix('cmf')]!)).toBe(true);
    expect(Number.isNaN(x2[ix('relVol')]!)).toBe(true);
  });
});
