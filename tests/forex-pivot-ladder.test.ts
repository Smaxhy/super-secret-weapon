/** v27.16: the owner's friend's MNQ trades — buy the day's pivot levels, aim for yesterday's high. */
import { describe, expect, it } from 'vitest';
import { buildCtx } from '../src/forex/ta';
import { LADDER, pivotLadderSignal, runsOn, strategyById } from '../src/forex/strategies';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const D1 = Date.UTC(2026, 9, 12);
/** yesterday: 24 hourly candles swinging 100…110 (high 111, low 99, close 104) */
function yesterday(): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 24; k++) {
    const base = 100 + (k % 11);
    out.push({ t: D1 + k * H, o: base, h: base + 1, l: base - 1, c: k === 23 ? 104 : base + 0.3 });
  }
  return out;
}
const piv = () => {
  const y = yesterday();
  const h = Math.max(...y.map((b) => b.h));
  const l = Math.min(...y.map((b) => b.l));
  const c = y[y.length - 1]!.c;
  const p = (h + l + c) / 3;
  return { h, l, c, p, s1: 2 * p - h, r1: 2 * p - l };
};

describe('pivot ladder', () => {
  it('buys a dip into the pivot that closes back above it, target yesterday\'s high, stop ½ ATR under the level', () => {
    const { p, h } = piv();
    const bars = yesterday();
    const D2 = D1 + 24 * H;
    bars.push({ t: D2, o: p + 2, h: p + 2.4, l: p + 1.2, c: p + 1.5 });
    bars.push({ t: D2 + H, o: p + 1.5, h: p + 1.7, l: p - 0.6, c: p + 0.5 });
    const c = buildCtx(bars, 60, 'NDXUSD');
    const i = bars.length - 1;
    const sig = pivotLadderSignal(c, i)!;
    expect(sig?.side).toBe(1);
    expect(sig.target).toBe(h);
    expect(sig.stop).toBeCloseTo(p - LADDER.stopAtr * c.atr14[i]!, 6);
    // the candle before was already under the level → not a fresh touch
    const stale = [...bars.slice(0, -2), { ...bars[bars.length - 2]!, l: p - 0.2 }, bars[bars.length - 1]!];
    expect(pivotLadderSignal(buildCtx(stale, 60, 'NDXUSD'), i)).toBeNull();
    // closes under the level → no buy
    const through = [...bars.slice(0, -1), { ...bars[bars.length - 1]!, c: p - 0.3 }];
    expect(pivotLadderSignal(buildCtx(through, 60, 'NDXUSD'), i)).toBeNull();
  });
  it('sells a poke into R1 that closes back under it, target yesterday\'s low; graded on every chart / market', () => {
    const { r1, l } = piv();
    const bars = yesterday();
    const D2 = D1 + 24 * H;
    bars.push({ t: D2, o: r1 - 2, h: r1 - 1.2, l: r1 - 2.4, c: r1 - 1.5 });
    bars.push({ t: D2 + H, o: r1 - 1.5, h: r1 + 0.6, l: r1 - 1.7, c: r1 - 0.5 });
    const sig = pivotLadderSignal(buildCtx(bars, 60, 'NDXUSD'), bars.length - 1);
    expect(sig?.side).toBe(-1);
    expect(sig!.target).toBe(l);
    expect(strategyById('pivot_ladder')?.family).toBe('reversion');
    expect(runsOn(strategyById('pivot_ladder')!, '15m', 'NDXUSD')).toBe(true);
    expect(runsOn(strategyById('pivot_ladder')!, '4h', 'EURUSD')).toBe(true);
  });
});
