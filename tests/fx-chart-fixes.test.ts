/** v26.3 (owner: "the charts bug a lot"): bad candles are dropped, trendlines follow the candles to the right edge. */
import { describe, expect, it } from 'vitest';
import { cleanBars, linePoints } from '../dashboard/src/components/MarketChart';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0);

describe('v26.3 chart fixes', () => {
  it('drops broken candles, sorts, dedupes and widens a high / low that misses the body', () => {
    const out = cleanBars([
      [T0 + H, 1.1, 1.2, 1.0, 1.15],
      [T0, 1.0, 1.1, 0.9, 1.05],
      [T0 + 2 * H, NaN, 1.2, 1.0, 1.1],
      [T0 + 3 * H, 1.1, 1.0, 1.2, 1.1], // high < low
      [T0 + H, 1.1, 1.2, 1.0, 1.12], // same time: newest wins
      [T0 + 4 * H, 1.1, 1.12, 1.09, 1.13], // close above the high
      [T0 + 5 * H, 1.1] as unknown as number[],
    ]);
    expect(out.map((b) => b[0])).toEqual([T0, T0 + H, T0 + 4 * H]);
    expect(out[1]![4]).toBe(1.12);
    expect(out[2]![2]).toBe(1.13);
  });

  it('a trendline runs through the candle centres from its first point to the right edge', () => {
    const bars = Array.from({ length: 6 }, (_, i) => [T0 + i * H, 1, 1, 1, 1]);
    const pts = linePoints(bars, { t1: T0 + 2 * H, p1: 1, t2: T0 + 4 * H, p2: 1.2 }, 10)!;
    expect(pts[0]![0]).toBe(25); // the candle holding the first point
    expect(pts[pts.length - 1]![0]).toBe(60); // the plot's right edge
    expect(pts[pts.length - 1]![1]).toBeCloseTo(1 + 0.1 * 4, 6); // price one hour past the newest candle's open
    expect(linePoints(bars, { t1: T0, p1: 1, t2: T0, p2: 1 }, 10)).toBeNull();
  });
});
