/** v18 overnight financing: the carry its way minus the broker markup, per bar in the engine and per daily roll on the practice account. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, simulate, type SimOpts } from '../src/forex/engine';
import { FINANCING, finPerBar, finRatePct, rollsBetween, swapGain } from '../src/forex/financing';
import { carryAt, type MacroData } from '../src/forex/macro';
import { summarizeFinancing } from '../src/forex/lab';
import { newAccount, tick, type PracticeAccount, type Quote } from '../src/forex/practice';
import { buildCtx, type CtxExt } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';

const H = 3_600_000;
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const HS = (EUR.spreadPips * EUR.pip) / 2;
const flat = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });
const M = FINANCING.markupPct;

describe('v18 financing arithmetic', () => {
  it('rate = carry its way minus the markup; per-bar and per-roll amounts scale with time and price', () => {
    expect(finRatePct(1, 5)).toBeCloseTo(5 - M, 9);
    expect(finRatePct(-1, 5)).toBeCloseTo(-5 - M, 9);
    expect(Number.isNaN(finRatePct(1, NaN))).toBe(true);
    // one hourly bar at 1.1 with 5% carry: (5 − M)% × 60 / 525,960 of the price
    expect(finPerBar(1, 5, 1.1, 60)).toBeCloseTo((((5 - M) / 100) * 60 * 1.1) / FINANCING.minutesPerYear, 12);
    expect(finPerBar(1, 5, 1.1, 240)).toBeCloseTo(4 * finPerBar(1, 5, 1.1, 60), 12);
    expect(finPerBar(1, NaN, 1.1, 60)).toBe(0);
    expect(swapGain(1, 5, 1.1, 3)).toBeCloseTo((((5 - M) / 100) * 3 * 1.1) / 365, 12);
    expect(swapGain(-1, -5, 1.1, 1)).toBeCloseTo((((5 - M) / 100) * 1.1) / 365, 12); // short a negative-carry pair earns
    expect(swapGain(1, NaN, 1.1, 1)).toBe(0);
  });

  it('daily rolls at 17:00 New York (22:00 UTC in winter, 21:00 in summer), Wednesday books three nights', () => {
    const tue = Date.UTC(2025, 0, 7, 10);
    const thu = Date.UTC(2025, 0, 9, 10);
    const r = rollsBetween(tue, thu);
    expect(r).toEqual([
      { t: Date.UTC(2025, 0, 7, 22), days: 1 },
      { t: Date.UTC(2025, 0, 8, 22), days: 3 },
    ]);
    expect(rollsBetween(Date.UTC(2025, 6, 7, 10), Date.UTC(2025, 6, 8, 10))).toEqual([{ t: Date.UTC(2025, 6, 7, 21), days: 1 }]);
    expect(rollsBetween(thu, tue)).toEqual([]);
    expect(rollsBetween(Date.UTC(2025, 0, 7, 22), Date.UTC(2025, 0, 7, 23))).toEqual([]); // the roll itself is not after `from`
    expect(rollsBetween(Date.UTC(2025, 0, 7, 21, 59), Date.UTC(2025, 0, 7, 22))).toHaveLength(1);
  });

  it('carryAt reads the rates in force at that moment (a rate older than the age limit no longer counts)', () => {
    const m: MacroData = { at: 0, rates: { EUR: [[Date.UTC(2024, 0, 1), 4]], USD: [[Date.UTC(2024, 0, 1), 5.5]] }, cot: {} } as unknown as MacroData;
    expect(carryAt(m, 'EURUSD', Date.UTC(2024, 1, 1))).toBeCloseTo(-1.5, 9);
    expect(carryAt(m, 'XAUUSD', Date.UTC(2024, 1, 1))).toBeCloseTo(-5.5, 9);
    expect(Number.isNaN(carryAt(m, 'GBPUSD', Date.UTC(2024, 1, 1)))).toBe(true);
    expect(Number.isNaN(carryAt(m, 'EURUSD', Date.UTC(2024, 8, 1)))).toBe(true);
    expect(Number.isNaN(carryAt(null, 'EURUSD', Date.UTC(2024, 1, 1)))).toBe(true);
  });
});

describe('v18 financing in the engine', () => {
  /** 251 flat bars, a long signal on bar 250 held `hold` bars by a time exit, then more flat bars */
  function series(hold: number, carry: number | null, gapAt?: number): { bars: Bar[]; sig: Signal; ext: boolean } {
    const t0 = Date.UTC(2025, 0, 6);
    const bars: Bar[] = [];
    let t = t0;
    for (let i = 0; i < 251 + hold + 20; i++) {
      if (gapAt !== undefined && i === gapAt) t += 50 * H;
      bars.push(flat(t, 1.1));
      t += H;
    }
    return { bars, sig: { side: 1, stop: 1.09, target: 1.2, maxBars: hold }, ext: carry !== null };
  }
  const run = (s: ReturnType<typeof series>, carry: number, opts: Partial<SimOpts> = {}, side: 1 | -1 = 1) => {
    const c = buildCtx(s.bars, 60, 'EURUSD');
    if (s.ext) c.ext = { carry: new Float64Array(s.bars.length).fill(carry) } as unknown as CtxExt;
    const sig: Signal = side === 1 ? s.sig : { side: -1, stop: 1.11, target: 1.0, maxBars: s.sig.maxBars! };
    return simulate(EUR, '1h', c, 'x', s.bars.map((_, i) => (i === 250 ? sig : null)), undefined, { ...DEFAULT_SIM, sessionSpreads: false, profitLock: false, ...opts });
  };

  it('accrues the carry minus the markup on every bar held and books it inside R', () => {
    const s = series(200, 5);
    const [t] = run(s, 5);
    expect(t!.reason).toBe('time');
    const perBarR = finPerBar(1, 5, 1.1, 60) / (1.1 + HS - 1.09);
    expect(t!.fin).toBeCloseTo(200 * perBarR, 9);
    expect(t!.fin!).toBeGreaterThan(0.08);
    // spot leg = the spread paid; the rest is financing
    expect(t!.r).toBeCloseTo(-(2 * HS) / (1.1 + HS - 1.09) + t!.fin!, 9);
    // a short pays the carry AND the markup
    const [sh] = run(s, 5, {}, -1);
    expect(sh!.fin).toBeCloseTo((200 * finPerBar(-1, 5, 1.1, 60)) / (1.11 - (1.1 - HS)), 9);
    expect(sh!.fin!).toBeLessThan(-0.1);
  });

  it('no rates feed, or financing off: nothing booked and the trade is exactly the old one', () => {
    const s = series(200, 5);
    const off = run(s, 5, { financing: false })[0]!;
    expect(off.fin).toBeUndefined();
    const nan = run(s, NaN)[0]!;
    expect(nan.fin).toBeUndefined();
    expect(nan.r).toBeCloseTo(off.r, 12);
    const noExt = run(series(200, null), 5)[0]!;
    expect(noExt.fin).toBeUndefined();
    expect(noExt.r).toBeCloseTo(off.r, 12);
  });

  it('only bars count: a weekend gap earns nothing (the bot is flat over it)', () => {
    const s = series(200, 5, 300);
    const [t] = run(s, 5);
    expect(t!.reason).toBe('time');
    const perBarR = finPerBar(1, 5, 1.1, 60) / (1.1 + HS - 1.09);
    expect(t!.fin).toBeCloseTo(t!.bars * perBarR, 6);
    expect(t!.bars).toBe(200);
  });

  it('summarises the financing share across rows', () => {
    const rows = [
      { id: 'a', tf: '1h' as const, fin: { inAvgR: 0.02, outAvgR: 0.04, known: true } },
      { id: 'b', tf: '4h' as const, fin: { inAvgR: -0.1, outAvgR: -0.08, known: true } },
      { id: 'c', tf: '1h' as const, fin: { inAvgR: 0, outAvgR: 0, known: false } },
      { id: 'random', tf: '1h' as const, fin: { inAvgR: 1, outAvgR: 1, known: true } },
    ];
    const f = summarizeFinancing(rows);
    expect(f.rows).toBe(3);
    expect(f.known).toBe(2);
    expect(f.inAvgR).toBeCloseTo(-0.04, 9);
    expect(f.outAvgR).toBeCloseTo(-0.02, 9);
    expect(f.hurt).toEqual([{ id: 'b', tf: '4h', outAvgR: -0.08 }]);
    expect(f.helped).toEqual([{ id: 'a', tf: '1h', outAvgR: 0.04 }]);
    expect(f.markupPct).toBe(M);
  });
});

describe('v18 financing on the practice account', () => {
  const quote = (mid: number, t: number): Quote => ({ id: 'EURUSD', mid, bid: mid - 0.00005, ask: mid + 0.00005, t, bars: [], dayChangePct: null, source: 'yahoo' });
  const open = (a: PracticeAccount, side: 1 | -1, openedAt: number) => {
    a.open.push({ id: 'p1', pair: 'EURUSD', side, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 110, stop: side === 1 ? 1.09 : 1.11, target: null, openedAt, checkedT: openedAt, lock: null });
  };

  it('books each roll since it opened into the balance and the trade total, Wednesday three nights, once', () => {
    const a = newAccount(1000);
    const t0 = Date.UTC(2025, 0, 7, 10); // Tuesday
    open(a, 1, t0);
    const now = Date.UTC(2025, 0, 9, 10); // Thursday: Tuesday's roll (1) + Wednesday's (3)
    const ev = tick(a, { EURUSD: quote(1.1, now) }, now, undefined, () => 5);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatch(/financing \+\$/);
    const expected = Math.round(10_000 * swapGain(1, 5, 1.1, 4) * 100) / 100;
    const p = a.open[0]!;
    expect(p.swapUsd).toBeCloseTo(expected, 9);
    expect(p.bankedUsd).toBeCloseTo(expected, 9);
    expect(a.balanceUsd).toBeCloseTo(1000 + expected, 9);
    expect(p.swapT).toBe(Date.UTC(2025, 0, 8, 22));
    // the same moment again: nothing more
    expect(tick(a, { EURUSD: quote(1.1, now) }, now, undefined, () => 5)).toHaveLength(0);
    expect(a.balanceUsd).toBeCloseTo(1000 + expected, 9);
    // the next roll, a short this time pays
    const b = newAccount(1000);
    open(b, -1, t0);
    tick(b, { EURUSD: quote(1.1, now) }, now, undefined, () => 5);
    expect(b.balanceUsd).toBeLessThan(1000);
    expect(b.open[0]!.swapUsd!).toBeCloseTo(Math.round(10_000 * swapGain(-1, 5, 1.1, 4) * 100) / 100, 9);
  });

  it('no rate known: nothing booked and the rolls stay owed; no carry lookup: nothing at all', () => {
    const a = newAccount(1000);
    const t0 = Date.UTC(2025, 0, 7, 10);
    open(a, 1, t0);
    const now = Date.UTC(2025, 0, 9, 10);
    expect(tick(a, { EURUSD: quote(1.1, now) }, now, undefined, () => NaN)).toHaveLength(0);
    expect(a.open[0]!.swapT).toBeUndefined();
    expect(a.balanceUsd).toBe(1000);
    expect(tick(a, { EURUSD: quote(1.1, now) }, now)).toHaveLength(0);
    expect(a.balanceUsd).toBe(1000);
    // the feed comes back: both nights are booked then
    tick(a, { EURUSD: quote(1.1, now) }, now, undefined, () => 5);
    expect(a.open[0]!.swapT).toBe(Date.UTC(2025, 0, 8, 22));
    expect(a.balanceUsd).toBeGreaterThan(1000);
  });
});
