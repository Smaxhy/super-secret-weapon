/** v27.6: the VIX as expected volatility — level, past-year rank, the size brake and the 'vix' filter. */
import { describe, expect, it } from 'vitest';
import { VIX, buildMood, moodNow, moodSeries, vixFactor, vixMove, vixNowOf, vixRegime } from '../src/forex/mood';
import { FILTERS, blockReason, type FilterEnv } from '../src/forex/filters';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const D = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);
/** one VIX bar a day at 15:00 UTC: 300 calm days around 15, then a spike to 40 */
function vix(): Bar[] {
  const out: Bar[] = [];
  for (let d = 0; d < 300; d++) {
    const c = 14 + (d % 5);
    out.push({ t: T0 + d * D + 15 * H, o: c, h: c, l: c, c });
  }
  out.push({ t: T0 + 300 * D + 15 * H, o: 40, h: 40, l: 40, c: 40 });
  return out;
}

describe('v27.6 VIX', () => {
  it('expected move, regime and size brake', () => {
    expect(vixMove(16).dayPct).toBeCloseTo(1.01, 2);
    expect(vixMove(16).weekPct).toBeCloseTo(2.22, 2);
    expect([vixRegime(12), vixRegime(17), vixRegime(25), vixRegime(40)]).toEqual(['calm', 'normal', 'high', 'extreme']);
    expect([vixFactor(18), vixFactor(27), vixFactor(40), vixFactor(null)]).toEqual([1, 0.75, 0.5, 1]);
  });

  it('level and past-year rank are causal; the spike ranks at the top', () => {
    const book = buildMood({ VIX: vix() });
    const last = book.times.length - 1;
    expect(book.vixLvl[last]).toBe(40);
    expect(book.vixRank[last]).toBe(1);
    // a calm day mid-history ranks somewhere in the middle, never above 1
    const mid = book.times.findIndex((t) => t === T0 + 200 * D + 15 * H);
    expect(book.vixRank[mid]!).toBeGreaterThanOrEqual(0);
    expect(book.vixRank[mid]!).toBeLessThan(1);
    // the first 60 days have no rank yet (too little history)
    expect(Number.isNaN(book.vixRank[10]!)).toBe(true);
    expect(vixNowOf(book)).toBe(40);
    const now = moodNow(book)!;
    expect(now.vix!.regime).toBe('extreme');
    expect(now.vix!.sizeFactor).toBe(0.5);
    expect(now.vix!.note).toMatch(/0.5× its normal size/);
  });

  it("the 'vix' filter blocks new trades in the VIX's top 10%", () => {
    expect(FILTERS).toContain('vix');
    const book = buildMood({ VIX: vix() });
    const bars: Bar[] = [{ t: T0 + 300 * D + 16 * H, o: 1, h: 1, l: 1, c: 1 }, { t: T0 + 250 * D + 16 * H, o: 1, h: 1, l: 1, c: 1 }].sort((a, b) => a.t - b.t);
    const rank = moodSeries(book, bars, 60, 'vixRank');
    const e = { tf: '1h', gap: new Float64Array(2), h4: new Int8Array(2), d1: new Int8Array(2), mood: new Float64Array(2), riskLong: 0, vixRank: rank } as FilterEnv;
    expect(rank[1]).toBeGreaterThanOrEqual(VIX.panicRank);
    expect(blockReason('vix', e, 1, 1)).toMatch(/VIX/);
    expect(blockReason('vix', e, 0, 1)).toBeNull();
  });
});
