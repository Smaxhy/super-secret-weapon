/** v17.9: the dashboard's live forex prices — store updates, staleness, live P&L, the live candle on the chart. */
import { describe, expect, it } from 'vitest';
import { applyFx, EMPTY_FX, foldTick, isLive, liveExit, liveOf, livePnl, overlayLive, type FxLive } from '../dashboard/src/hooks/useFxLive';

const T0 = 1_760_000_000_000;
const push = (px: Record<string, unknown>) => ({ t: T0, px });

describe('applyFx (the shared store)', () => {
  it('keeps the newest price per pair and its direction vs the previous mid', () => {
    let s = applyFx(EMPTY_FX, push({ EURUSD: [1.1, 1.09995, 1.10005, T0] }), T0);
    expect(s.ticks.EURUSD).toEqual({ mid: 1.1, bid: 1.09995, ask: 1.10005, priceT: T0, at: T0, dir: 0 });
    expect(s.at).toBe(T0);
    s = applyFx(s, push({ EURUSD: [1.1002, 1.10015, 1.10025, T0 + 1000], USDJPY: [150, 149.99, 150.01, T0 + 1000] }), T0 + 1000);
    expect(s.ticks.EURUSD!.dir).toBe(1);
    expect(s.ticks.USDJPY!.dir).toBe(0);
    s = applyFx(s, push({ EURUSD: [1.1001, 1.10005, 1.10015, T0 + 2000] }), T0 + 2000);
    expect(s.ticks.EURUSD!.dir).toBe(-1);
    s = applyFx(s, push({ EURUSD: [1.1001, 1.10005, 1.10015, T0 + 3000] }), T0 + 3000);
    expect(s.ticks.EURUSD!.dir).toBe(0);
    expect(s.ticks.USDJPY!.mid).toBe(150); // pairs not in a push keep their last price
  });
  it('skips broken rows and an older price, and returns the same store when nothing changed', () => {
    const s = applyFx(EMPTY_FX, push({ EURUSD: [1.1, 1.09995, 1.10005, T0 + 5000] }), T0);
    expect(applyFx(s, push({ EURUSD: [1.2, 1.19, 1.21, T0] }), T0 + 1000)).toBe(s); // older priceT
    expect(applyFx(s, push({ GBPUSD: [0, 0, 0, T0], AUDUSD: [0.65, 0.66, 0.64, T0], NZDUSD: 'x', USDCAD: [1.3, null, 1.31, T0] }), T0 + 1000)).toBe(s);
    expect(applyFx(s, { t: T0 }, T0)).toBe(s);
    expect(applyFx(s, null, T0)).toBe(s);
    // no priceT → the receive time stands in
    expect(applyFx(EMPTY_FX, push({ USDCHF: [0.8, 0.79995, 0.80005] }), T0 + 7).ticks.USDCHF!.priceT).toBe(T0 + 7);
  });
});

describe('staleness', () => {
  const s = applyFx(EMPTY_FX, push({ EURUSD: [1.1, 1.09995, 1.10005, T0] }), T0);
  it('a pair is live for 15 s after it arrived, then null', () => {
    expect(liveOf(s, 'EURUSD', undefined, T0 + 15_000)?.mid).toBe(1.1);
    expect(liveOf(s, 'EURUSD', undefined, T0 + 15_001)).toBeNull();
    expect(liveOf(s, 'EURUSD', 5_000, T0 + 6_000)).toBeNull();
    expect(liveOf(s, 'XAUUSD', undefined, T0)).toBeNull();
  });
  it('the LIVE badge shows while anything moved in the last 10 s', () => {
    expect(isLive(EMPTY_FX, T0)).toBe(false);
    expect(isLive(s, T0 + 10_000)).toBe(true);
    expect(isLive(s, T0 + 10_001)).toBe(false);
  });
});

describe('livePnl / liveExit', () => {
  const s: FxLive = applyFx(EMPTY_FX, push({ EURUSD: [1.101, 1.1009, 1.1011, T0] }), T0);
  it('long: moves with the bid; short: with the ask', () => {
    const long = { pair: 'EURUSD', side: 1 as const, pnlUsd: 10, px: 1.1, pnlPerPx: 10_000 };
    expect(liveExit(long, s, T0)).toBe(1.1009);
    expect(livePnl(long, s, T0)).toBeCloseTo(10 + 0.0009 * 10_000, 6); // +$9
    const short = { pair: 'EURUSD', side: -1 as const, pnlUsd: -2, px: 1.1, pnlPerPx: -10_000 };
    expect(liveExit(short, s, T0)).toBe(1.1011);
    expect(livePnl(short, s, T0)).toBeCloseTo(-2 - 0.0011 * 10_000, 6); // −$11 more
  });
  it('keeps the polled P&L without pnlPerPx / px, without a fresh price, or when the live price is far off', () => {
    expect(livePnl({ pair: 'EURUSD', side: 1, pnlUsd: 10, px: 1.1 }, s, T0)).toBe(10);
    expect(livePnl({ pair: 'EURUSD', side: 1, pnlUsd: 10, pnlPerPx: 10_000 }, s, T0)).toBe(10);
    expect(livePnl({ pair: 'EURUSD', side: 1, pnlUsd: 10, px: 1.1, pnlPerPx: 10_000 }, s, T0 + 20_000)).toBe(10);
    expect(livePnl({ pair: 'XAUUSD', side: 1, pnlUsd: 3, px: 2400, pnlPerPx: 1 }, s, T0)).toBe(3);
    expect(livePnl({ pair: 'EURUSD', side: 1, pnlUsd: 10, px: 1.3, pnlPerPx: 10_000 }, s, T0)).toBe(10); // 15% away = feed mismatch
    expect(liveExit({ pair: 'EURUSD', side: 1, px: 1.3 }, s, T0)).toBeNull();
  });
});

describe('the live candle on the chart', () => {
  const M = 60_000;
  const t = 100 * M; // a bucket start
  const bars = [
    [t - 2 * M, 1.1, 1.102, 1.099, 1.101],
    [t - M, 1.101, 1.103, 1.1, 1.102],
  ];
  it('foldTick builds the forming candle and keeps only this bucket and the one before', () => {
    let lb = foldTick([], 1.102, t - M + 50_000, M);
    expect(lb).toEqual([{ t: t - M, o: 1.102, h: 1.102, l: 1.102, c: 1.102 }]);
    lb = foldTick(lb, 1.105, t - M + 55_000, M);
    lb = foldTick(lb, 1.101, t + 1_000, M);
    lb = foldTick(lb, 1.104, t + 2_000, M);
    expect(lb).toEqual([
      { t: t - M, o: 1.102, h: 1.105, l: 1.102, c: 1.105 },
      { t, o: 1.101, h: 1.104, l: 1.101, c: 1.104 },
    ]);
    expect(foldTick(lb, 1.2, t - M + 1, M)).toBe(lb); // an older price
    expect(foldTick(lb, 1.2, t + 2 * M, M).map((x) => x.t)).toEqual([t, t + 2 * M]);
  });
  it('the newest candle in the live bucket: high / low widen, close = live', () => {
    expect(overlayLive(bars, [{ t: t - M, o: 1.102, h: 1.104, l: 1.1015, c: 1.1035 }], M)).toEqual([bars[0], [t - M, 1.101, 1.104, 1.1, 1.1035]]);
  });
  it('the newest candle is the bucket before: a new candle opens at its close (and the old one takes its late ticks)', () => {
    const out = overlayLive(bars, [{ t: t - M, o: 1.102, h: 1.1025, l: 1.1018, c: 1.1019 }, { t, o: 1.1019, h: 1.1021, l: 1.1012, c: 1.1015 }], M);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual([t - M, 1.101, 1.103, 1.1, 1.1019]);
    expect(out[2]).toEqual([t, 1.1019, 1.1021, 1.1012, 1.1015]);
    const fresh = overlayLive(bars, [{ t, o: 1.104, h: 1.104, l: 1.104, c: 1.104 }], M);
    expect(fresh[2]).toEqual([t, 1.102, 1.104, 1.102, 1.104]); // opens at the last close, so the high covers it
  });
  it('a feed that is behind (newest candle 2+ buckets old) or ahead is never stretched', () => {
    expect(overlayLive(bars, [{ t: t + M, o: 1.1, h: 1.1, l: 1.1, c: 1.1 }], M)).toBe(bars);
    expect(overlayLive(bars, [{ t: t - 2 * M - M, o: 1.1, h: 1.1, l: 1.1, c: 1.1 }], M)).toBe(bars);
    expect(overlayLive(bars, [], M)).toBe(bars);
    expect(overlayLive([], [{ t, o: 1, h: 1, l: 1, c: 1 }], M)).toEqual([]);
  });
});
