/** v27.14: the owner's friend's two ICT trades — IFVG + CISD (long) and inversion → retrace to the gap's CE (short). */
import { describe, expect, it } from 'vitest';
import { buildCtx } from '../src/forex/ta';
import { fvgCeSignal, ifvgSignal, runsOn, strategyById } from '../src/forex/strategies';
import type { Bar } from '../src/forex/types';

const M = 60_000;
const T0 = Date.UTC(2026, 9, 13, 4, 0);
function series(rows: [number, number, number, number][], lead = 30, px = 1.1): Bar[] {
  const bars: Bar[] = [];
  let t = T0;
  for (let k = 0; k < lead; k++) {
    const w = 0.0006 + (k % 3) * 0.0002;
    bars.push({ t: (t += 15 * M), o: px, h: px + w, l: px - w, c: px + (k % 2 ? 0.0002 : -0.0002) });
  }
  for (const [o, h, l, c] of rows) bars.push({ t: (t += 15 * M), o, h, l, c });
  return bars;
}
/** the same chart upside down (a long becomes a short) */
const flip = (bars: Bar[], m = 2.2): Bar[] => bars.map((b) => ({ t: b.t, o: m - b.o, h: m - b.l, l: m - b.h, c: m - b.c }));

// a run down through the lows leaving a bearish gap, then a strong candle closing back above it
const IFVG: [number, number, number, number][] = [
  [1.1, 1.1003, 1.0985, 1.0988], // falling, its low 1.0985 = the gap's top
  [1.0988, 1.099, 1.096, 1.0962], // displacement down
  [1.0962, 1.097, 1.0955, 1.0958], // high 1.097 < 1.0985 → bearish gap [1.097, 1.0985]
  [1.0958, 1.096, 1.0945, 1.0948], // the low (under every earlier low → sweep)
  [1.0948, 1.0992, 1.0946, 1.099], // closes above the gap top 1.0985 but under the down-run's open 1.1 (no CISD)
];

describe('IFVG + CISD (the long)', () => {
  it('needs the close above the gap AND above the open of the down-run (CISD)', () => {
    const bars = series(IFVG);
    // 1.099 > gap top 1.0985 but < 1.1 (the down-run's open) → no CISD yet
    expect(ifvgSignal(buildCtx(bars, 15, 'EURUSD'), bars.length - 1)).toBeNull();
    const strong = series([...IFVG.slice(0, -1), [1.0948, 1.1008, 1.0946, 1.1005]]);
    const sig = ifvgSignal(buildCtx(strong, 15, 'EURUSD'), strong.length - 1)!;
    expect(sig?.side).toBe(1);
    expect(sig.stop).toBeLessThan(1.0945);
    expect(sig.target).toBeGreaterThan(1.1005);
  });
  it('mirrors to a short, and needs the sweep', () => {
    const strong = series([...IFVG.slice(0, -1), [1.0948, 1.1008, 1.0946, 1.1005]]);
    const down = flip(strong);
    expect(ifvgSignal(buildCtx(down, 15, 'EURUSD'), down.length - 1)?.side).toBe(-1);
    // no sweep: the lead-in had a lower low than the move → no signal
    const deep = series([...IFVG.slice(0, -1), [1.0948, 1.1008, 1.0946, 1.1005]], 30).map((b, k) => (k === 27 ? { ...b, l: 1.09 } : b));
    expect(ifvgSignal(buildCtx(deep, 15, 'EURUSD'), deep.length - 1)).toBeNull();
  });
});

// a bearish gap that held, a displacement candle up through it leaving a bullish gap, then the dip to that gap's middle
const CE: [number, number, number, number][] = [
  [1.1, 1.1003, 1.0985, 1.0988],
  [1.0988, 1.099, 1.096, 1.0962],
  [1.0962, 1.097, 1.0955, 1.0965], // bearish gap [1.097, 1.0985]
  [1.0965, 1.0975, 1.0958, 1.0972],
  [1.0972, 1.0978, 1.0968, 1.0975], // high 1.0978 = bottom of the new gap
  [1.0975, 1.1035, 1.0973, 1.103], // displacement up, closes above 1.0985 → inverted
  [1.103, 1.105, 1.1012, 1.1045], // low 1.1012 → bullish gap [1.0978, 1.1012], CE 1.0995
  [1.1045, 1.1048, 1.102, 1.1025],
  [1.1025, 1.1028, 1.0992, 1.1008], // dips to the middle, closes back above it → long
];

describe('inversion → retrace to the CE (the short, written as its mirror)', () => {
  it('enters at the first close back away from the gap middle', () => {
    const bars = series(CE);
    const sig = fvgCeSignal(buildCtx(bars, 15, 'EURUSD'), bars.length - 1)!;
    expect(sig?.side).toBe(1);
    expect(sig.stop).toBeLessThan(1.0978);
    const down = flip(bars);
    expect(fvgCeSignal(buildCtx(down, 15, 'EURUSD'), down.length - 1)?.side).toBe(-1);
  });
  it('no inversion before the displacement → no trade; a second touch → no trade; a gap closed through → dead', () => {
    const noInv = series([...CE.slice(0, 5).map((r): [number, number, number, number] => [1.1, 1.1004, 1.0996, 1.1]), ...CE.slice(5)]);
    expect(fvgCeSignal(buildCtx(noInv, 15, 'EURUSD'), noInv.length - 1)).toBeNull();
    const again = series([...CE, [1.1008, 1.1015, 1.0994, 1.1005]]);
    expect(fvgCeSignal(buildCtx(again, 15, 'EURUSD'), again.length - 1)).toBeNull();
    const dead = series([...CE.slice(0, -1), [1.1025, 1.1028, 1.097, 1.0975]]);
    expect(fvgCeSignal(buildCtx(dead, 15, 'EURUSD'), dead.length - 1)).toBeNull();
  });
  it('both run on every chart and market in the ICT family', () => {
    for (const id of ['ifvg_cisd', 'fvg_ce']) {
      expect(strategyById(id)?.family).toBe('ict');
      expect(runsOn(strategyById(id)!, '15m', 'NDXUSD')).toBe(true);
      expect(runsOn(strategyById(id)!, '4h', 'XAUUSD')).toBe(true);
    }
  });
});
