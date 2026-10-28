/** v27.74 (Oct 28: his NQ short at 29,879 → 29,804 — sold above his three levels and used them as targets). */
import { describe, expect, it } from 'vitest';
import { postedLevelSignal, towardSignal } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import type { Bar } from '../src/forex/types';

const M = 60_000;
const LEVELS = [29835, 29804, 29782.5];

/** 1-minute candles: an hour drifting up from 29,820 to ~29,880, a poke to 29,903, then a red candle back under the old high. */
function scenario(): { bars: Bar[]; posted: number } {
  const t0 = Date.UTC(2026, 9, 28, 0, 40, 0);
  const closes: number[] = [];
  for (let k = 0; k < 70; k++) closes.push(29820 + k * 0.85 + (k % 2 ? 2 : -2));
  const bars: Bar[] = closes.map((c, k) => {
    const o = k ? closes[k - 1]! : c;
    return { t: t0 + k * M, o, h: Math.max(o, c) + 1.5, l: Math.min(o, c) - 1.5, c };
  });
  const last = bars[bars.length - 1]!.c;
  bars.push({ t: t0 + bars.length * M, o: last, h: 29903, l: last - 1, c: 29898 }); // the poke above the old highs
  bars.push({ t: t0 + bars.length * M, o: 29898, h: 29899, l: 29872, c: 29874 }); // closes back under them, red
  return { bars, posted: t0 - 5 * M };
}

describe('sell high toward his levels', () => {
  const { bars, posted } = scenario();
  const c = buildCtx(bars, 1, 'NDXUSD');
  const i = bars.length - 1;
  const minRisk = (bars[i]!.c * 0.08) / 100;

  it('bearish plan, stretched above his top level, poke + close back under → short, stop past the poke, target his nearest level ≥ 1.5R (29,835 is too close here)', () => {
    const s = towardSignal(c, i, LEVELS, posted, -1, minRisk)!;
    expect(s.side).toBe(-1);
    expect(s.stop).toBeGreaterThan(29903);
    expect(s.target).toBe(29804);
    expect((29874 - 29835) / (s.stop - 29874)).toBeLessThan(1.5);
    expect(s.note).toMatch(/sold high toward his level/);
    expect(postedLevelSignal(c, i, LEVELS, posted, -1, null, minRisk)).toMatchObject({ side: -1, target: 29804 });
  });

  it('no bias, the bullish side, a poke before his post, or price not stretched past his levels → no trade', () => {
    expect(towardSignal(c, i, LEVELS, posted, 0, minRisk)).toBeNull();
    expect(towardSignal(c, i, LEVELS, posted, 1, minRisk)).toBeNull();
    expect(towardSignal(c, i, LEVELS, bars[i]!.t + M, -1, minRisk)).toBeNull();
    expect(towardSignal(c, i, [29870, 29850], posted, -1, minRisk)).toBeNull();
  });

  it('stretch is measured from ALL his levels: an older lower list does not let a short in just above his newest level (v27.76)', () => {
    const older = [29783, 29765, 29736.25];
    // this set alone is far below the poke, but his newest levels (targets) reach 29,880 → not stretched past them
    expect(towardSignal(c, i, older, posted, -1, minRisk, [...older, 29880, 29835])).toBeNull();
    expect(towardSignal(c, i, older, posted, -1, minRisk, [...older, ...LEVELS])).not.toBeNull();
  });

  it('fires once: the next red candle after the signal does not sell again', () => {
    const more = [...bars, { t: bars[i]!.t + M, o: 29874, h: 29876, l: 29860, c: 29862 }];
    expect(towardSignal(buildCtx(more, 1, 'NDXUSD'), more.length - 1, LEVELS, posted, -1, minRisk)).toBeNull();
  });
});
