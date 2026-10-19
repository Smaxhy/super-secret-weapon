/** v17.13: the bot's charts place candles side by side (no weekend gaps), label time cleanly and fit a phone. */
import { describe, expect, it } from 'vitest';
import { axisLabels, barStep, fitBars, xOfTime } from '../dashboard/src/components/MarketChart';

const M15 = 900_000;
const fri = Date.UTC(2026, 9, 16, 14, 0);
const mon = Date.UTC(2026, 9, 19, 4, 0);
const bars = [...Array.from({ length: 4 }, (_, i) => [fri + i * M15, 1, 1, 1, 1]), ...Array.from({ length: 4 }, (_, i) => [mon + i * M15, 1, 1, 1, 1])];

describe('v17.13 chart axis', () => {
  it('the usual candle spacing ignores the weekend gap', () => {
    expect(barStep(bars)).toBe(M15);
  });

  it('times map onto candles side by side: the weekend takes no room, a time after the newest candle carries on', () => {
    const slot = 10;
    expect(xOfTime(bars, fri, slot)).toBe(0);
    expect(xOfTime(bars, fri + M15 / 2, slot)).toBe(5); // the middle of the first candle
    expect(xOfTime(bars, mon, slot)).toBe(40); // the 5th candle starts right after Friday's last one
    expect(xOfTime(bars, fri + 3 * M15 + 36 * 3_600_000, slot)).toBe(40); // inside the gap: on the border
    expect(xOfTime(bars, mon + 3 * M15 + M15 / 2, slot)).toBeCloseTo(75, 6); // halfway through the newest candle
    expect(xOfTime(bars, mon + 5 * M15, slot)).toBeCloseTo(90, 6); // carries on after it
  });

  it('labels say the weekday when the day changes, drop repeats, and use dates on 4h+ candles', () => {
    const l = axisLabels([fri, fri + M15, mon, mon + M15], M15);
    expect(l[0]).toMatch(/^\S+ /); // "Fri 14:00"
    expect(l[1]).not.toMatch(/^[A-Za-z]/); // same day: time only
    expect(l[2]).toMatch(/^\S+ /); // the day changed
    expect(axisLabels([fri, fri], M15)).toEqual([expect.any(String), '']);
    expect(axisLabels([fri, mon], 4 * 3_600_000)[1]).not.toMatch(/:/);
  });

  it('a phone gets fewer, wider candles (the newest ones)', () => {
    const many = Array.from({ length: 200 }, (_, i) => [i * M15, 1, 1, 1, 1]);
    const fit = fitBars(many, 360, 6);
    expect(fit.length).toBeLessThan(60);
    expect(fit[fit.length - 1]).toBe(many[199]);
    expect(fitBars(many.slice(0, 10), 360)).toHaveLength(10);
  });
});
