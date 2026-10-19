/** v18 entry-timing lab: limit / pullback / confirmation entries in the engine, and the summary across strategies. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, simulate, type SimOpts } from '../src/forex/engine';
import { ENTRY, entryVariantRow, summarizeEntries, type EntryKind, type EntryVariantRow } from '../src/forex/entries';
import { buildCtx } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';

const H = 3_600_000;
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
/** half the spread, charged on every fill (constant: session spreads off) */
const HS = (EUR.spreadPips * EUR.pip) / 2;
const flat = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });

/** 251 flat hourly bars at 1.1000 (ATR = 2 pips), a long signal on bar 250, then `after` bars from 251 on */
function market(after: Array<Partial<Bar> & { gapH?: number }>): Bar[] {
  const t0 = Date.UTC(2025, 0, 6);
  const bars = Array.from({ length: 251 }, (_, i) => flat(t0 + i * H, 1.1));
  let t = t0 + 250 * H;
  for (const b of after) {
    t += (b.gapH ?? 1) * H;
    const px = b.c ?? 1.1;
    bars.push({ t, o: b.o ?? px, h: b.h ?? Math.max(b.o ?? px, px) + 0.0001, l: b.l ?? Math.min(b.o ?? px, px) - 0.0001, c: px });
  }
  return bars;
}
const SIG: Signal = { side: 1, stop: 1.099, target: 1.101 };
const opts = (entry: EntryKind, extra: Partial<SimOpts> = {}): SimOpts => ({ ...DEFAULT_SIM, sessionSpreads: false, profitLock: false, entry, ...extra });
const run = (bars: Bar[], entry: EntryKind, sig: Signal = SIG, extra: Partial<SimOpts> = {}) =>
  simulate(EUR, '1h', buildCtx(bars, 60, 'EURUSD'), 'x', bars.map((_, i) => (i === 250 ? sig : null)), undefined, opts(entry, extra));
/** bars that run up through the target after the entry window */
const toTarget = [{ c: 1.1012, h: 1.1013 }, { c: 1.1012 }];

describe('v18 entry variants in the engine', () => {
  it('market: the next open plus half the spread — the same trade as before the entry option existed', () => {
    const bars = market([{ o: 1.1002, h: 1.1003, l: 1.0999, c: 1.1001 }, ...toTarget]);
    const [t] = run(bars, 'market');
    expect(t!.entry).toBeCloseTo(1.1002 + HS, 9);
    expect(t!.entryT).toBe(bars[251]!.t);
    expect(t!.reason).toBe('target');
    const c = buildCtx(bars, 60, 'EURUSD');
    const sigs = bars.map((_, i) => (i === 250 ? SIG : null));
    expect(simulate(EUR, '1h', c, 'x', sigs, undefined, { ...DEFAULT_SIM, sessionSpreads: false, profitLock: false })).toEqual(simulate(EUR, '1h', c, 'x', sigs, undefined, opts('market')));
  });

  it('limit at the close: fills at the limit when the next bar trades back to it, with the risk measured from that fill', () => {
    const bars = market([{ o: 1.1002, h: 1.1003, l: 1.0999, c: 1.1001 }, ...toTarget]);
    const [t] = run(bars, 'limit');
    expect(t).toBeDefined();
    expect(t!.entry).toBeCloseTo(1.1 + HS, 9);
    expect(t!.entryT).toBe(bars[251]!.t);
    expect(t!.keyT).toBe(bars[250]!.t + H);
    expect(t!.stopPct).toBeCloseTo(((1.1 + HS - 1.099) / (1.1 + HS)) * 100, 6);
    // a better entry for the same target: more R than the market entry
    expect(t!.r).toBeGreaterThan(run(bars, 'market')[0]!.r);
  });

  it('limit: a bar that never comes back misses the trade; a gap through the limit fills at the open', () => {
    const away = market([{ o: 1.1002, h: 1.1005, l: 1.1001, c: 1.1004 }, ...toTarget]);
    expect(run(away, 'limit')).toHaveLength(0);
    expect(run(away, 'market')).toHaveLength(1);
    const gap = market([{ o: 1.0995, h: 1.0998, l: 1.0993, c: 1.0996 }, ...toTarget]);
    const [t] = run(gap, 'limit');
    expect(t!.entry).toBeCloseTo(1.0995 + HS, 9);
  });

  it('limit: the order lives one bar — a touch on the second bar is too late', () => {
    const late = market([{ o: 1.1002, h: 1.1005, l: 1.1001, c: 1.1004 }, { o: 1.1004, h: 1.1005, l: 1.0999, c: 1.1 }, ...toTarget]);
    expect(run(late, 'limit')).toHaveLength(0);
  });

  it('pullback: a limit a quarter ATR back, good for three bars', () => {
    const L = 1.1 - ENTRY.pullbackAtr * 0.0002; // ATR of the flat bars = 2 pips
    const third = market([{ o: 1.1001, h: 1.1002, l: 1.09996, c: 1.1 }, { o: 1.1, h: 1.1002, l: 1.09996, c: 1.1001 }, { o: 1.1001, h: 1.1002, l: 1.0999, c: 1.1 }, ...toTarget]);
    const [t] = run(third, 'pullback');
    expect(t!.entry).toBeCloseTo(L + HS, 9);
    expect(t!.entryT).toBe(third[253]!.t);
    const fourth = market([{ o: 1.1001, h: 1.1002, l: 1.09996, c: 1.1 }, { o: 1.1, h: 1.1002, l: 1.09996, c: 1.1001 }, { o: 1.1001, h: 1.1002, l: 1.09996, c: 1.1 }, { o: 1.1, h: 1.1002, l: 1.0999, c: 1.1 }, ...toTarget]);
    expect(run(fourth, 'pullback')).toHaveLength(0);
  });

  it('pullback: a limit on the wrong side of the stop is never placed', () => {
    const bars = market([{ o: 1.1001, h: 1.1002, l: 1.0999, c: 1.1 }, ...toTarget]);
    expect(run(bars, 'pullback', { side: 1, stop: 1.09999, target: 1.101 })).toHaveLength(0);
  });

  it('confirm: enters at the open after a bar that closed the signal\'s way, else nothing', () => {
    const green = market([{ o: 1.1, h: 1.1004, l: 1.0999, c: 1.1003 }, { o: 1.1004, h: 1.1005, l: 1.1002, c: 1.1004 }, ...toTarget]);
    const [t] = run(green, 'confirm');
    expect(t!.entry).toBeCloseTo(1.1004 + HS, 9);
    expect(t!.entryT).toBe(green[252]!.t);
    expect(t!.keyT).toBe(green[250]!.t + H);
    const red = market([{ o: 1.1, h: 1.1001, l: 1.0996, c: 1.0997 }, { o: 1.0997, h: 1.1005, l: 1.0996, c: 1.1004 }, ...toTarget]);
    expect(run(red, 'confirm')).toHaveLength(0);
  });

  it('an order never survives a weekend gap; a signal on the last bar only becomes an open trade at market', () => {
    const wk = market([{ gapH: 50, o: 1.1002, h: 1.1003, l: 1.0999, c: 1.1001 }, ...toTarget]);
    expect(run(wk, 'limit')).toHaveLength(0);
    expect(run(wk, 'confirm')).toHaveLength(0);
    const last = market([]);
    expect(run(last, 'market')).toHaveLength(1);
    expect(run(last, 'market')[0]!.reason).toBe('open');
    expect(run(last, 'limit')).toHaveLength(0);
    expect(run(last, 'pullback')).toHaveLength(0);
    expect(run(last, 'confirm')).toHaveLength(0);
  });

  it('shorts mirror longs: a sell limit fills when the high reaches it', () => {
    const S: Signal = { side: -1, stop: 1.101, target: 1.099 };
    const bars = market([{ o: 1.0998, h: 1.1001, l: 1.0997, c: 1.0999 }, { c: 1.0988, l: 1.0987 }, { c: 1.0988 }]);
    const [t] = run(bars, 'limit', S);
    expect(t!.entry).toBeCloseTo(1.1 - HS, 9);
    expect(t!.reason).toBe('target');
    expect(run(market([{ o: 1.0998, h: 1.0999, l: 1.0995, c: 1.0996 }, { c: 1.0988, l: 1.0987 }]), 'limit', S)).toHaveLength(0);
  });
});

describe('v18 entry summary across strategies', () => {
  const st = (n: number, avg: number, total = avg * n) => ({ n, avgR: avg, totalR: total, winPct: 50, medianR: avg, pf: avg > 0 ? 1.5 : 0.8, maxDdR: 1 });
  const row = (id: string, vs: Array<[EntryKind, number, number, number, number]>) => ({
    id,
    entryVariants: vs.map(([entry, inN, inAvg, outN, outAvg]) => entryVariantRow(entry, { inSample: st(inN, inAvg), outSample: st(outN, outAvg), all: st(inN + outN, (inAvg + outAvg) / 2) })),
  });
  it('averages the change against the market entry, counts the fills kept and the total R, and skips thin or random rows', () => {
    const rows = [
      row('a', [['market', 100, 0.1, 40, 0.1], ['limit', 80, 0.2, 30, 0.2], ['pullback', 60, 0.15, 20, 0.05], ['confirm', 90, 0.05, 36, 0.12]]),
      row('b', [['market', 50, 0.0, 20, 0.0], ['limit', 40, 0.1, 15, -0.1], ['pullback', 20, 0.3, 10, 0.3], ['confirm', 45, 0.0, 18, 0.0]]),
      row('thin', [['market', 20, 0.5, 8, 0.5], ['limit', 10, 1, 4, 1], ['pullback', 10, 1, 4, 1], ['confirm', 10, 1, 4, 1]]),
      row('random', [['market', 100, 0.5, 40, 0.5], ['limit', 100, 1, 40, 1], ['pullback', 100, 1, 40, 1], ['confirm', 100, 1, 40, 1]]),
    ];
    const s = summarizeEntries(rows);
    expect(s.map((x) => x.entry)).toEqual(['limit', 'pullback', 'confirm']);
    const lim = s.find((x) => x.entry === 'limit')!;
    expect(lim.compared).toBe(2);
    expect(lim.inDeltaR).toBeCloseTo(0.1, 6);
    expect(lim.outDeltaR).toBeCloseTo(0.0, 6); // +0.1 and −0.1
    expect(lim.outBetterPct).toBe(50);
    expect(lim.filledPct).toBe(75); // 30/40 and 15/20
    // total unseen R: a (6 − 4 = +2) and b (−1.5 − 0 = −1.5) → +0.25 a strategy
    expect(lim.outTotalDeltaR).toBeCloseTo(0.25, 6);
    const pb = s.find((x) => x.entry === 'pullback')!;
    expect(pb.compared).toBe(1); // b's pullback has only 20 first-70% trades
    expect(pb.outDeltaR).toBeCloseTo(-0.05, 6);
    expect(summarizeEntries([{ id: 'x' }])[0]!.compared).toBe(0);
  });
  it('the variant row keeps the unseen total', () => {
    const v: EntryVariantRow = entryVariantRow('confirm', { inSample: st(30, 0.1), outSample: st(12, 0.2, 2.4), all: st(42, 0.13) });
    expect(v.outTotalR).toBeCloseTo(2.4, 9);
    expect(v.outPf).toBe(1.5);
  });
});
