import { describe, expect, it } from 'vitest';
import { absorptionAt, prevWeekLevels } from '../src/forex/flow';
import { buildCtx } from '../src/forex/ta';
import { strategyById } from '../src/forex/strategies';
import { strictStopDist } from '../src/forex/exits';
import { blockReason, FILTERS } from '../src/forex/filters';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
/** 3 days of hourly bars (Tue 13 → Thu 15 Oct 2026); yesterday (the 14th) has its low at exactly 99 */
function scenario(hitHourUtc: number, vol = false): Bar[] {
  const t0 = Date.parse('2026-10-13T00:00:00Z');
  const bars: Bar[] = [];
  for (let k = 0; k < 72; k++) {
    const t = t0 + k * H;
    const c = 100.25 + 0.5 * Math.sin(k * 0.5);
    const o = k ? bars[k - 1]!.c : c;
    const b: Bar = { t, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c };
    if (k === 30) b.l = 99; // yesterday's low
    if (vol) b.v = 100;
    bars.push(b);
  }
  const k = 48 + hitHourUtc;
  bars[k] = { t: bars[k]!.t, o: 100.2, h: 100.25, l: 98.95, c: 100.0, ...(vol ? { v: 400 } : {}) };
  return bars.slice(0, k + 1);
}

describe('v27.36 the friend’s level + absorption entry', () => {
  it('absorption: a new low rejected (long wick without volume, heavy volume + close in the top half with it)', () => {
    const bars = scenario(22);
    const c = buildCtx(bars, 60, 'EURUSD');
    const i = bars.length - 1;
    expect(absorptionAt(c, i, 1)).toMatchObject({ j: i, extreme: 98.95 });
    expect(absorptionAt(c, i, -1)).toBeNull();
    // with volume the candle needs heavy volume: 4× normal passes, normal volume does not
    const v = scenario(22, true);
    expect(absorptionAt(buildCtx(v, 60, 'NDXUSD'), i, 1)).not.toBeNull();
    v[i]!.v = 100;
    expect(absorptionAt(buildCtx(v, 60, 'NDXUSD'), i, 1)).toBeNull();
  });

  it('asia_absorb fires at the Asia open on yesterday’s low; level_absorb fires at any hour; asia waits otherwise', () => {
    const asia = scenario(22); // the 22:00 UTC candle closes 19:00 New York
    const c = buildCtx(asia, 60, 'EURUSD');
    const i = asia.length - 1;
    const sig = strategyById('asia_absorb')!.signal(c, i)!;
    expect(sig.side).toBe(1);
    // v27.37 the very strict stop: the tighter of "just past the absorbing candle" and the friend's stop size
    expect(sig.stop).toBeLessThan(asia[i]!.c);
    expect(asia[i]!.c - sig.stop).toBeCloseTo(Math.min(asia[i]!.c - (98.95 - 0.1 * c.atr14[i]!), strictStopDist('EURUSD', asia[i]!.c)), 9);
    expect(sig.target!).toBeGreaterThan(asia[i]!.c + 2 * (asia[i]!.c - sig.stop));
    const day = scenario(14); // 10:00 New York
    const cd = buildCtx(day, 60, 'EURUSD');
    expect(strategyById('asia_absorb')!.signal(cd, day.length - 1)).toBeNull();
    expect(strategyById('level_absorb')!.signal(cd, day.length - 1)?.side).toBe(1);
  });

  it('the absorption check is one of the filters the lab tries', () => {
    expect(FILTERS).toContain('absorb');
    const env = { tf: '1h', gap: new Float64Array(2), h4: new Int8Array(2), d1: new Int8Array(2), mood: new Float64Array(2), riskLong: 0, absorbUp: Uint8Array.of(0, 1), absorbDn: Uint8Array.of(0, 0) } as never;
    expect(blockReason('absorb', env, 1, 1)).toBeNull();
    expect(blockReason('absorb', env, 0, 1)).toMatch(/no sellers absorbed/);
    expect(blockReason('absorb', env, 1, -1)).toMatch(/no buyers absorbed/);
  });

  it('last week’s high / low roll at the Sunday FX open', () => {
    const t = Date.parse('2026-10-12T00:00:00Z'); // Monday
    const bars: Bar[] = [0, 24, 164, 165, 170].map((h, k) => ({ t: t + h * H, o: 1, h: 2 + k, l: 1 - k, c: 1 }));
    const w = prevWeekLevels({ bars });
    expect(w[2]).toBeNull(); // Sun 20:00 UTC: still the same week
    expect(w[3]).toEqual({ h: 4, l: -1 }); // Sun 21:00 UTC: the new FX week — last week = the first three bars
    expect(w[4]).toEqual({ h: 4, l: -1 });
  });
});
