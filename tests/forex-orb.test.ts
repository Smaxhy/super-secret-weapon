/** v27.5: opening-range breakout on the real 9:30 New York open + Kelly in the Monte Carlo. */
import { describe, expect, it } from 'vitest';
import { buildCtx } from '../src/forex/ta';
import { runsOn, strategyById } from '../src/forex/strategies';
import { nyOffsetMs } from '../src/forex/ny-time';
import { monteCarlo } from '../src/forex/montecarlo';
import type { Bar } from '../src/forex/types';

const M = 60_000;
const DAY = Date.UTC(2026, 9, 13); // Tuesday, EDT
const nyT = (hh: number, mm: number) => DAY + (hh * 60 + mm) * M - nyOffsetMs(DAY);
function flat(from: number, to: number, px: number, wig = 20): Bar[] {
  const out: Bar[] = [];
  for (let t = from; t < to; t += 15 * M) {
    const k = ((t / M) % 7) / 7;
    out.push({ t, o: px, h: px + wig * (0.5 + k), l: px - wig * (0.5 + k), c: px + (k - 0.5) * wig * 0.5 });
  }
  return out;
}

describe('orb_ny', () => {
  const s = strategyById('orb_ny')!;
  const base = () => {
    const bars = flat(nyT(0, 0) - 2 * 86_400_000, nyT(9, 30), 20_000);
    bars.push({ t: nyT(9, 30), o: 20_000, h: 20_030, l: 19_990, c: 20_020 }, { t: nyT(9, 45), o: 20_020, h: 20_025, l: 19_985, c: 20_000 });
    bars.push({ t: nyT(10, 0), o: 20_000, h: 20_020, l: 19_995, c: 20_010 }); // inside
    return bars;
  };

  it('buys the first 15-minute close above the 9:30–10:00 range, stop at the range low, flat by 4 pm', () => {
    const bars = base();
    bars.push({ t: nyT(10, 15), o: 20_010, h: 20_045, l: 20_005, c: 20_040 });
    const c = buildCtx(bars, 15, 'NDXUSD');
    const sig = s.signal(c, bars.length - 1)!;
    expect(sig.side).toBe(1);
    expect(sig.stop).toBe(19_985);
    expect(sig.target).toBeCloseTo(20_040 + 1.5 * 55, 6);
    expect(sig.maxBars).toBeGreaterThan(20);
  });

  it('only the first break of the day counts, and none after 11:30', () => {
    const bars = base();
    bars.push({ t: nyT(10, 15), o: 20_010, h: 20_045, l: 20_005, c: 20_040 }, { t: nyT(10, 30), o: 20_040, h: 20_042, l: 20_000, c: 20_010 }, { t: nyT(10, 45), o: 20_010, h: 20_050, l: 20_008, c: 20_045 });
    expect(s.signal(buildCtx(bars, 15, 'NDXUSD'), bars.length - 1)).toBeNull();
    const late = base().concat(flat(nyT(10, 15), nyT(11, 30), 20_005, 1));
    late.push({ t: nyT(11, 30), o: 20_005, h: 20_060, l: 20_000, c: 20_055 });
    expect(s.signal(buildCtx(late, 15, 'NDXUSD'), late.length - 1)).toBeNull();
  });

  it('15-minute chart only, never on a coin', () => {
    expect(runsOn(s, '15m', 'NDXUSD')).toBe(true);
    expect(runsOn(s, '1h', 'NDXUSD')).toBe(false);
    expect(runsOn(s, '15m', 'BTCUSD')).toBe(false);
  });
});

describe('Kelly', () => {
  it('60% winners at 1.5R vs 1R losers → Kelly 33%; a coin flip at 1:1 → 0', () => {
    const rs = Array.from({ length: 100 }, (_, i) => (i % 5 < 3 ? 1.5 : -1));
    expect(monteCarlo(rs, 1)!.kellyPct).toBeCloseTo(33.3, 0);
    expect(monteCarlo(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1)), 1)!.kellyPct).toBe(0);
  });
});
