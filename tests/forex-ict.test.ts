/** v23: ICT / smart-money rules (owner: "quarterly theory, order flow, a Judas swing at the New York open"). */
import { describe, expect, it } from 'vitest';
import { buildCtx } from '../src/forex/ta';
import { ICT, STRATEGIES, fvgSignal, mssSignal, runsOn, sessionRange, strategyById } from '../src/forex/strategies';
import { nyMinOfDay, nyOffsetMs } from '../src/forex/ny-time';
import { nyOffsetMs as fromCalendar } from '../src/forex/calendar';
import { FX_CONFIG } from '../src/forex/lab';

FX_CONFIG.provenOnly.on = false; // v27.27 default: only Edge rows trade; these tests pin the older choosers
import { buildPlan } from '../src/forex/plan';
import type { Bar } from '../src/forex/types';

const M = 60_000;
/** a Tuesday in EDT: 2026-10-13, New York = UTC−4 */
const DAY = Date.UTC(2026, 9, 13);
const nyT = (hh: number, mm: number, dayShift = 0) => DAY + dayShift * 86_400_000 + ((hh * 60 + mm) * M - nyOffsetMs(DAY));

/** flat 15-minute bars from one NY time to another, at a price with a small wiggle (ATR stays sane) */
function flat(from: number, to: number, px: number, step = 15, wig = 0.0004): Bar[] {
  const out: Bar[] = [];
  for (let t = from; t < to; t += step * M) {
    const k = ((t / M) % 7) / 7;
    out.push({ t, o: px, h: px + wig * (0.5 + k), l: px - wig * (0.5 + k), c: px + (k - 0.5) * wig * 0.5 });
  }
  return out;
}

describe('the New York clock', () => {
  it('reads minutes since NY midnight across DST (same function the calendar uses)', () => {
    expect(fromCalendar).toBe(nyOffsetMs);
    expect(nyMinOfDay(nyT(9, 30))).toBe(570);
    // EST: 2026-12-15 14:30 UTC = 9:30 NY
    expect(nyMinOfDay(Date.UTC(2026, 11, 15, 14, 30))).toBe(570);
    // EDT: 2026-10-13 13:30 UTC = 9:30 NY
    expect(nyMinOfDay(Date.UTC(2026, 9, 13, 13, 30))).toBe(570);
  });
  it('the context carries nyMin for every bar', () => {
    const bars = flat(nyT(0, 0), nyT(12, 0), 1.1);
    const c = buildCtx(bars, 15, 'EURUSD');
    expect(c.nyMin[0]).toBe(0);
    expect(c.nyMin[38]).toBe(570);
  });
});

describe('judas_swing: a sweep of the pre-open range after 9:30 NY, closed back inside', () => {
  /** quiet London range 1.0990–1.1010 (3:00–9:30), then at 9:30–9:45 a spike to 1.1030 that closes back at 1.1000 */
  function day(sweepHigh: boolean, dayShift = 0) {
    const bars = flat(nyT(0, 0, dayShift), nyT(9, 30, dayShift), 1.1, 15, 0.001);
    const spike: Bar = sweepHigh
      ? { t: nyT(9, 30, dayShift), o: 1.1002, h: 1.103, l: 1.1, c: 1.1 }
      : { t: nyT(9, 30, dayShift), o: 1.0998, h: 1.1, l: 1.097, c: 1.1 };
    return [...bars, spike];
  }
  it('fires short at the 9:45 close on the 15-minute chart with the stop past the sweep and the target at the range low', () => {
    const bars = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...day(true)];
    const c = buildCtx(bars, 15, 'EURUSD');
    const i = bars.length - 1;
    expect(c.nyMin[i]! + c.barMin).toBe(ICT.nyOpen + 15);
    const sig = strategyById('judas_swing')!.signal(c, i)!;
    expect(sig).not.toBeNull();
    expect(sig.side).toBe(-1);
    expect(sig.stop).toBeGreaterThan(1.103);
    expect(sig.target).toBeLessThan(1.1);
    expect(sig.target).toBeGreaterThan(1.0985);
    // flat by 4 pm New York: 9:45 → 16:00 = 25 bars
    expect(sig.maxBars).toBe(25);
  });
  it('mirrors for a sweep of the low, and gives the signal ONCE (the next bar inside the range is silent)', () => {
    const bars = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...day(false)];
    const c = buildCtx(bars, 15, 'EURUSD');
    const sig = strategyById('judas_swing')!.signal(c, bars.length - 1)!;
    expect(sig.side).toBe(1);
    expect(sig.stop).toBeLessThan(1.097);
    const next: Bar = { t: nyT(9, 45), o: 1.1, h: 1.1005, l: 1.0995, c: 1.1 };
    const c2 = buildCtx([...bars, next], 15, 'EURUSD');
    expect(strategyById('judas_swing')!.signal(c2, bars.length)).toBeNull();
  });
  it('stays silent without a sweep, outside the window, and on a coin', () => {
    const quiet = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...flat(nyT(0, 0), nyT(9, 45), 1.1, 15, 0.001)];
    const c = buildCtx(quiet, 15, 'EURUSD');
    expect(strategyById('judas_swing')!.signal(c, quiet.length - 1)).toBeNull();
    const late = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...flat(nyT(0, 0), nyT(11, 0), 1.1, 15, 0.001), { t: nyT(11, 0), o: 1.1, h: 1.103, l: 1.1, c: 1.1 }];
    const c2 = buildCtx(late, 15, 'EURUSD');
    expect(strategyById('judas_swing')!.signal(c2, late.length - 1)).toBeNull();
    const s = strategyById('judas_swing')!;
    expect(runsOn(s, '15m', 'EURUSD')).toBe(true);
    expect(runsOn(s, '1h', 'EURUSD')).toBe(true);
    expect(runsOn(s, '4h', 'EURUSD')).toBe(false);
    expect(runsOn(s, '15m', 'BTCUSD')).toBe(false);
  });
  it('works on the hourly chart too: the 9–10 NY bar sweeps the London range and closes back inside', () => {
    const h1 = flat(nyT(0, 0, -1), nyT(9, 0), 1.1, 60, 0.001);
    const sweep: Bar = { t: nyT(9, 0), o: 1.1, h: 1.104, l: 1.0995, c: 1.1 };
    const c = buildCtx([...h1, sweep], 60, 'EURUSD');
    const sig = strategyById('judas_swing')!.signal(c, h1.length)!;
    expect(sig?.side).toBe(-1);
    expect(sig.maxBars).toBe(6);
  });
});

describe('ny_q3 + amd_daily: quarterly theory on the New York morning and on the day', () => {
  it('ny_q3 decides at the 9:00 close: Q2 (7:30–9:00) swept Q1 (6:00–7:30) high and came back → short, 2R, flat by noon', () => {
    const bars = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...flat(nyT(0, 0), nyT(8, 30), 1.1, 15, 0.001)];
    // 8:30 news spike through Q1's high, 8:45 close back inside
    bars.push({ t: nyT(8, 30), o: 1.1, h: 1.1035, l: 1.0998, c: 1.1025 });
    bars.push({ t: nyT(8, 45), o: 1.1025, h: 1.1028, l: 1.0995, c: 1.1 });
    const c = buildCtx(bars, 15, 'EURUSD');
    const sig = strategyById('ny_q3')!.signal(c, bars.length - 1)!;
    expect(sig?.side).toBe(-1);
    expect(sig.stop).toBeGreaterThan(1.1035);
    expect(sig.target).toBeLessThan(1.1);
    expect(sig.maxBars).toBe(12);
    // not at any other close
    const c2 = buildCtx(bars.slice(0, -1), 15, 'EURUSD');
    expect(strategyById('ny_q3')!.signal(c2, bars.length - 2)).toBeNull();
    expect(runsOn(strategyById('ny_q3')!, '1h', 'EURUSD')).toBe(false);
    expect(runsOn(strategyById('ny_q3')!, '15m', 'EURUSD')).toBe(true);
  });
  it('amd_daily decides at the 6:00 am close: London swept Asia (previous NY evening) low and came back → long toward Asia high', () => {
    // Asia (yesterday evening) wider than London's quiet hours, so London's wiggle never pokes over Asia's high
    const bars = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 60, 0.001), ...flat(nyT(0, 0), nyT(5, 0), 1.1, 60, 0.0004)];
    bars.push({ t: nyT(5, 0), o: 1.1, h: 1.1005, l: 1.096, c: 1.1 });
    const c = buildCtx(bars, 60, 'EURUSD');
    const sig = strategyById('amd_daily')!.signal(c, bars.length - 1)!;
    expect(sig?.side).toBe(1);
    expect(sig.stop).toBeLessThan(1.096);
    expect(sig.target).toBeGreaterThan(1.1);
    expect(sig.maxBars).toBe(6);
    const r = sessionRange(c, bars.length - 1, ICT.asiaStart, 24 * 60, 0, ICT.amdDecide, true)!;
    expect(r.h).toBeCloseTo(1.101, 3);
    expect(r.winLo).toBe(1.096);
  });
  it('sessionRange is causal: only bars up to i count', () => {
    const bars = [...flat(nyT(0, 0, -1), nyT(24, 0, -1), 1.1, 15, 0.001), ...flat(nyT(0, 0), nyT(10, 30), 1.1, 15, 0.001)];
    bars[bars.length - 1] = { ...bars[bars.length - 1]!, h: 1.2 };
    const c = buildCtx(bars, 15, 'EURUSD');
    const i = bars.length - 3;
    const r = sessionRange(c, i, ICT.preOpenFrom, ICT.nyOpen, ICT.nyOpen, ICT.judasUntil)!;
    expect(r.winHi).toBeLessThan(1.11);
  });
});

describe('order flow: fair-value gap and structure shift', () => {
  it('fvg_entry: sweep of the lows, a displacement candle, a gap, the retrace into it closes back above → long', () => {
    const bars = flat(nyT(0, 0), nyT(6, 0), 1.1, 15, 0.001);
    // sweep the recent lows, then displacement: three candles where bar1.h < bar3.l
    bars.push({ t: nyT(6, 0), o: 1.1, h: 1.1002, l: 1.0975, c: 1.0995 }); // sweep (below 1.099)
    bars.push({ t: nyT(6, 15), o: 1.0995, h: 1.106, l: 1.0994, c: 1.1058 }); // displacement, body ≫ ATR
    bars.push({ t: nyT(6, 30), o: 1.1058, h: 1.107, l: 1.1035, c: 1.1065 }); // gap = [1.1002, 1.1035]
    bars.push({ t: nyT(6, 45), o: 1.1065, h: 1.1068, l: 1.1045, c: 1.105 });
    bars.push({ t: nyT(7, 0), o: 1.105, h: 1.1055, l: 1.1025, c: 1.1045 }); // back into the gap, closes above it
    const c = buildCtx(bars, 15, 'EURUSD');
    const sig = fvgSignal(c, bars.length - 1)!;
    expect(sig?.side).toBe(1);
    expect(sig.stop).toBeLessThan(1.1002);
    expect(sig.target).toBeGreaterThan(1.1045);
    // a gap the price fell through is dead
    const dead = [...bars, { t: nyT(7, 15), o: 1.1045, h: 1.105, l: 1.099, c: 1.1035 }];
    expect(fvgSignal(buildCtx(dead, 15, 'EURUSD'), dead.length - 1)).toBeNull();
    // without the sweep (lows never taken) → no signal
    const noSweep = bars.map((b, k) => (k === bars.length - 5 ? { ...b, l: 1.0992 } : b));
    expect(fvgSignal(buildCtx(noSweep, 15, 'EURUSD'), noSweep.length - 1)).toBeNull();
    expect(runsOn(strategyById('fvg_entry')!, '4h', 'BTCUSD')).toBe(true);
  });
  it('mss_sweep: a dip under a confirmed swing low then a close above the last lower high → long', () => {
    const bars: Bar[] = [];
    let t = nyT(0, 0);
    const push = (o: number, h: number, l: number, c: number) => bars.push({ t: (t += 15 * M), o, h, l, c });
    for (let k = 0; k < 30; k++) push(1.1, 1.1008, 1.0992, 1.1);
    // a swing low at 1.095 (confirmed by 3 higher bars after it), a lower high at 1.099 (confirmed), then the sweep + shift
    push(1.099, 1.0995, 1.0955, 1.096);
    push(1.096, 1.0965, 1.095, 1.0955); // swing low
    push(1.0955, 1.097, 1.0952, 1.0968);
    push(1.0968, 1.098, 1.0965, 1.0978);
    push(1.0978, 1.099, 1.0975, 1.0985); // lower high 1.099
    push(1.0985, 1.0988, 1.097, 1.0972);
    push(1.0972, 1.0975, 1.096, 1.0965);
    push(1.0965, 1.0968, 1.0955, 1.0958);
    push(1.0958, 1.0962, 1.094, 1.0945); // sweep under 1.095
    push(1.0945, 1.097, 1.0943, 1.0968);
    push(1.0968, 1.0998, 1.0965, 1.0995); // closes above the lower high → shift
    const c = buildCtx(bars, 15, 'EURUSD');
    const sig = mssSignal(c, bars.length - 1);
    expect(sig?.side).toBe(1);
    expect(sig!.stop).toBeLessThan(1.094);
    // the bar before had not crossed → silent
    expect(mssSignal(buildCtx(bars.slice(0, -1), 15, 'EURUSD'), bars.length - 2)).toBeNull();
  });
});

describe('wiring', () => {
  it('the five rules are in the library, in the ict family, with charts restricted where the clock needs it', () => {
    for (const id of ['judas_swing', 'ny_q3', 'amd_daily', 'fvg_entry', 'mss_sweep']) expect(STRATEGIES.find((s) => s.id === id)?.family).toBe('ict');
    expect(strategyById('judas_swing')!.charts).toEqual(['15m', '1h']);
    expect(strategyById('fvg_entry')!.charts).toBeUndefined();
  });
  it('the ICT session rules may trade the 15-minute chart while botFastCharts is off, and the plan says so', () => {
    FX_CONFIG.botFastCharts = false; // v27.19 default is on; this pins the off case
    const base = {
      now: nyT(9, 46),
      clock: { open: true, minutesToChange: 3000, noNewTrades: false, flattenNow: false, sessions: ['New York'], sinceOpenMin: 3000, rollover: false },
      oanda: false,
      markets: [{ id: 'EURUSD', price: 1.1, firing: [] }],
      mood: null,
      fastFiring: { '15m': { tf: '15m', t: nyT(9, 45), at: nyT(9, 45), byPair: { EURUSD: [{ id: 'judas_swing', name: 'Judas', side: -1, allowed: true, why: null, chosen: true }, { id: 'rsi2', name: 'RSI2', side: 1, allowed: true, why: null, chosen: true }] } } },
      chosen: ['judas_swing:15m', 'rsi2:15m'],
      fastCharts: false,
      fastStrategies: ['judas_swing'],
      names: { judas_swing: 'Judas', rsi2: 'RSI2' },
      positions: [],
      resume: [],
      equityUsd: 1000,
      lastSync: {},
      labOpen: {},
      runs: [],
      upcoming: () => [],
      blockNow: () => null,
      strict: { mode: 'quality', minAgree: 2 },
    };
    const plan = buildPlan(base as unknown as Parameters<typeof buildPlan>[0]);
    // v22.1 fix: each desk's plan lists only its own markets
    expect(plan.markets.length).toBe(26); // v27: + 4 stock indices
    expect(buildPlan({ ...base, universe: 'fx' } as unknown as Parameters<typeof buildPlan>[0]).markets.length).toBe(17); // v27.80: the Dow is off
    expect(buildPlan({ ...base, universe: 'fx' } as unknown as Parameters<typeof buildPlan>[0]).markets.some((m) => m.id === 'DJIUSD')).toBe(false);
    expect(buildPlan({ ...base, universe: 'crypto' } as unknown as Parameters<typeof buildPlan>[0]).markets.map((m) => m.id)).toEqual(['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD', 'ADAUSD', 'LINKUSD', 'AVAXUSD']);
    const sigs = plan.markets.find((m) => m.id === 'EURUSD')!.signals;
    expect(sigs.find((s) => s.name === 'Judas')!.verdict).not.toMatch(/lab only/);
    expect(sigs.find((s) => s.name === 'RSI2')!.verdict).toMatch(/lab only/);
  });
});

describe('v25 owner rules: ICT live, Fibonacci never alone', () => {
  it('ICT rows are chosen on the fast chart even with a "no" verdict; other "no" rows are not', async () => {
    const { chosenOf } = await import('../src/forex/fast');
    const { FX_CONFIG } = await import('../src/forex/lab');
    const rows = [
      { id: 'judas_swing', tf: '15m', verdict: 'no' as const },
      { id: 'pin_bar', tf: '15m', verdict: 'no' as const },
      { id: 'ny_q3', tf: '15m', verdict: 'no' as const },
    ];
    expect(chosenOf(rows, [], FX_CONFIG.ownerLive)).toEqual(['judas_swing:15m', 'ny_q3:15m']);
    expect(chosenOf(rows, ['ny_q3:15m'], FX_CONFIG.ownerLive)).toEqual(['judas_swing:15m']); // the learner can still drop one
    expect(chosenOf(rows, [])).toEqual([]);
  });

  it('the hourly chooser lets the owner list in on the forex desk only', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/forex/lab.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/this\.universe === 'fx' \? new Set\(FX_CONFIG\.ownerLive\)/);
    expect(src).toMatch(/profitFloor\(x\)\.ok && \(FX_CONFIG\.provenOnly\.on \? FX_CONFIG\.provenOnly\.verdicts\[this\.universe\]\.includes\(x\.verdict\) : ownerLive\.has\(x\.id\) \|\| \(mode === 'edge'/); // v27.1: the floor first; v27.27 / v27.85: proven-only switch, verdicts per desk
  });

  it('fib_pullback waits alone and trades next to a second setup the same way', async () => {
    const { soloWait } = await import('../src/forex/lab');
    const H = 3_600_000;
    const fib = { strategy: 'fib_pullback', pair: 'USDJPY', side: 1 as const, entryT: 100 * H };
    expect(soloWait(fib, [fib], 60)).toMatch(/alone/);
    expect(soloWait(fib, [{ strategy: 'pin_bar', pair: 'USDJPY', side: -1, entryT: 100 * H }], 60)).toMatch(/alone/); // other way
    expect(soloWait(fib, [{ strategy: 'pin_bar', pair: 'EURUSD', side: 1, entryT: 100 * H }], 60)).toMatch(/alone/); // other market
    expect(soloWait(fib, [{ strategy: 'random', pair: 'USDJPY', side: 1, entryT: 100 * H }], 60)).toMatch(/alone/); // yardstick
    expect(soloWait(fib, [{ strategy: 'pin_bar', pair: 'USDJPY', side: 1, entryT: 95 * H }], 60)).toMatch(/alone/); // too long ago
    expect(soloWait(fib, [{ strategy: 'pin_bar', pair: 'USDJPY', side: 1, entryT: 98 * H }], 60)).toBeNull();
    const { FX_CONFIG } = await import('../src/forex/lab');
    const was = { ...FX_CONFIG.requireConfluence };
    try {
      // v27.83: by default every strategy waits for a second setup, on both desks
      expect(soloWait({ ...fib, strategy: 'pin_bar' }, [], 60)).toMatch(/alone/);
      expect(soloWait({ ...fib, strategy: 'keltner', pair: 'LINKUSD' }, [], 60)).toMatch(/alone/);
      expect(soloWait({ ...fib, strategy: 'keltner', pair: 'LINKUSD' }, [{ strategy: 'momentum_bar', pair: 'LINKUSD', side: 1, entryT: 100 * H }], 60)).toBeNull();
      FX_CONFIG.requireConfluence.fx = false;
      expect(soloWait({ ...fib, strategy: 'pin_bar' }, [], 60)).toBeNull(); // off → only listed strategies
      expect(soloWait(fib, [], 60)).toMatch(/alone/);
    } finally {
      Object.assign(FX_CONFIG.requireConfluence, was);
    }
  });

  it('the wait is its own reason in the why / shadow buckets', async () => {
    const { classify } = await import('../src/forex/why');
    expect(classify('fib_pullback alone — waits for a second setup the same way on this market')).toBe('solo');
  });
});
