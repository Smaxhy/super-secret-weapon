/** v17.8: the Auto-bot page's pure helpers — candle rows from either API shape, chart label nudging, pips / time text. */
import { describe, expect, it } from 'vitest';
import { candleLagMin, fxDigits, fxPip, fxUsd, sinceOpen, toBars } from '../dashboard/src/components/FxActiveTrade';
import { spreadLabels, tradeAnchor } from '../dashboard/src/components/MarketChart';

describe('toBars (candles from /api/forex/candles)', () => {
  it('takes [t,o,h,l,c] rows and {t,o,h,l,c} objects, sorted by time', () => {
    expect(toBars([[2, 1, 2, 0.5, 1.5], { t: 1, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 5 }])).toEqual([
      [1, 1, 1.2, 0.9, 1.1],
      [2, 1, 2, 0.5, 1.5],
    ]);
  });
  it('drops broken rows and anything that is not a list', () => {
    expect(toBars([[1, 2, 3], { t: 1, o: 1, h: null, l: 1, c: 1 }, null, 'x', [3, 1, 1, 1, Number.NaN]])).toEqual([]);
    expect(toBars(undefined)).toEqual([]);
    expect(toBars({ bars: [] })).toEqual([]);
  });
});

describe('spreadLabels (price labels in the chart gutter)', () => {
  it('pushes overlapping labels apart, keeps order and stays inside the chart', () => {
    const out = spreadLabels([{ y: 50 }, { y: 52 }, { y: 51 }], 17, 9, 200);
    const ys = out.map((o) => o.ly);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(17);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(17);
    expect(out.map((o) => o.y)).toEqual([50, 51, 52]);
    const edge = spreadLabels([{ y: 198 }, { y: 199 }, { y: 200 }], 17, 9, 200).map((o) => o.ly);
    expect(Math.max(...edge)).toBeLessThanOrEqual(200);
    expect(edge[2]! - edge[1]!).toBeGreaterThanOrEqual(17);
  });
  it('leaves labels that are already apart where they are', () => {
    expect(spreadLabels([{ y: 20 }, { y: 100 }], 17, 9, 200).map((o) => o.ly)).toEqual([20, 100]);
  });
});

describe('pips, prices and time text', () => {
  it('knows the pip and the digits of JPY pairs and metals', () => {
    expect(fxPip('EURUSD')).toBe(0.0001);
    expect(fxPip('USDJPY')).toBe(0.01);
    expect(fxPip('XAUUSD')).toBe(0.01);
    expect(fxPip('XAGUSD')).toBe(0.001);
    expect([fxDigits('EURUSD'), fxDigits('GBPJPY'), fxDigits('XAUUSD')]).toEqual([5, 3, 2]);
  });
  it('signs dollars only when asked and drops the seconds of a trade older than a minute', () => {
    expect(fxUsd(8.2, true)).toBe('+$8.20');
    expect(fxUsd(-1.1, true)).toBe('−$1.10');
    expect(fxUsd(8.2)).toBe('$8.20');
    const now = 1_000_000_000;
    expect(sinceOpen(now - 35 * 60_000 - 12_000, now)).toBe('35m');
    expect(sinceOpen(now - (2 * 3600 + 14 * 60) * 1000, now)).toBe('2h 14m');
    expect(sinceOpen(now - 40_000, now)).toBe('40s');
  });
});

describe('tradeAnchor (one trade\'s chart: entry / stop / target lines and the entry marker)', () => {
  // the chart's own x scale: the newest candle sits half a bar left of the plot edge cw
  const cw = 268;
  const n = 72;
  const step = 300_000;
  const t0 = 0;
  const t1 = (n - 1) * step;
  const x = (t: number) => ((t - t0) / (t1 - t0 + step)) * cw + cw / n / 2;
  it('a trade opened after the newest candle (fresh trade, delayed feed) still gets visible lines and a marker on the plot', () => {
    for (const entryT of [t1 + 0.6 * step, t1 + 2 * step, t1 + 8 * step]) {
      const a = tradeAnchor(x(entryT), cw);
      expect(cw - a.solid).toBeGreaterThanOrEqual(20);
      expect(a.marker).toBeLessThanOrEqual(cw);
      expect(a.marker).toBeGreaterThanOrEqual(0);
      expect(a.after).toBe(x(entryT) > cw - 2);
    }
  });
  it('leaves an entry inside the candles where it is and keeps the start of the plot', () => {
    const xe = x(t1 - 30 * step);
    expect(tradeAnchor(xe, cw)).toEqual({ solid: xe, marker: xe, after: false });
    expect(tradeAnchor(-5, cw)).toEqual({ solid: 0, marker: 0, after: false });
    expect(tradeAnchor(Number.NaN, cw).solid).toBe(0);
  });
});

describe('candleLagMin (the chart says when its candles are behind)', () => {
  const now = 10_000_000_000;
  const bars = (t: number) => [[t - 60_000, 1, 1, 1, 1], [t, 1, 1, 1, 1]];
  it('is quiet while the newest candle is current', () => {
    expect(candleLagMin(bars(now - 60_000), 60_000, now)).toBeNull();
    expect(candleLagMin(bars(now - 50 * 60_000), 3_600_000, now)).toBeNull();
    expect(candleLagMin([], 60_000, now)).toBeNull();
  });
  it('says how old the newest candle is when the feed is behind (Yahoo metals ~10 min)', () => {
    expect(candleLagMin(bars(now - 11 * 60_000), 60_000, now)).toBe(11);
    expect(candleLagMin(bars(now - 4 * 60_000), 60_000, now)).toBeNull(); // under 5 min: normal
  });
});
