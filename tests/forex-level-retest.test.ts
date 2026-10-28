/** v27.69 (Oct 27: his NQ levels + "Leaning towards bearish" + "Break and retest" — the bot took none of it). */
import { describe, expect, it } from 'vitest';
import { parseBias } from '../src/forex/discord';
import { postedLevelSignal, retestSignal } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { bookLevelTrade, newAccount, refundIndexFees, walkTrade } from '../src/forex/practice';
import { replayMissedLevels } from '../src/forex/level-watch';
import { VENUE_FEES } from '../src/forex/venue-fees';
import type { Bar } from '../src/forex/types';

VENUE_FEES.on = false;
const M = 60_000;

describe('his bias in plain words', () => {
  it('"Leaning towards bearish" is a bearish plan', () => {
    expect(parseBias('Leaning towards bearish')).toMatchObject({ pair: 'NDXUSD', bias: -1 });
    expect(parseBias('leaning bullish on NQ')).toMatchObject({ bias: 1 });
    expect(parseBias('Leaning more towards shorts')).toMatchObject({ bias: -1 });
    expect(parseBias('Break and retest')).toBeNull();
  });
});

/** 1-minute candles: chop around 105 for an hour, break down through 100, run to 98.5, come back up to 100, reject. */
function scenario(): { bars: Bar[]; posted: number } {
  const t0 = Date.UTC(2026, 9, 27, 17, 0, 0);
  const closes: number[] = [];
  for (let k = 0; k < 60; k++) closes.push(105 + (k % 2 ? 0.3 : -0.3));
  closes.push(104, 103, 102, 101, 100.6, 99.4, 99.0, 98.6, 98.5, 98.9, 99.3, 99.6);
  const bars: Bar[] = closes.map((c, k) => {
    const o = k ? closes[k - 1]! : c;
    return { t: t0 + k * M, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c };
  });
  bars.push({ t: t0 + bars.length * M, o: 99.6, h: 100.05, l: 99.45, c: 99.5 }); // the retest from below, closes back under
  return { bars, posted: t0 + 50 * M };
}

describe('break and retest at his level', () => {
  const { bars, posted } = scenario();
  const c = buildCtx(bars, 1, 'NDXUSD');
  const i = bars.length - 1;

  it('shorts the first retest of the broken level, stop past the retest candle, target his next level', () => {
    const s = retestSignal(c, i, [100, 97], posted, -1)!;
    expect(s.side).toBe(-1);
    const a = c.atr14[i]!;
    expect(s.stop).toBeCloseTo(99.5 + Math.max(100.05 + 0.15 * a - 99.5, 0.3 * a), 9);
    expect(s.target).toBe(97);
    expect(postedLevelSignal(c, i, [100, 97], posted, -1)).toMatchObject({ side: -1 });
  });

  it('his bias the other way, a break before his post, or a second touch → no trade', () => {
    expect(retestSignal(c, i, [100, 97], posted, 1)).toBeNull();
    expect(retestSignal(c, i, [100, 97], bars[i - 3]!.t)).toBeNull();
    const again = [...bars, { t: bars[i]!.t + M, o: 99.5, h: 100.0, l: 99.4, c: 99.6 }];
    expect(retestSignal(buildCtx(again, 1, 'NDXUSD'), again.length - 1, [100, 97], posted, -1)).toBeNull();
  });
});

describe('the missed level trade, booked as if taken', () => {
  const T = Date.UTC(2026, 9, 28, 0, 20, 0);
  const min = (k: number, o: number, h: number, l: number, c: number): Bar => ({ t: T + k * M, o, h, l, c });

  it('runs to the target → closed there at that minute, P&L in the balance', () => {
    const a = newAccount(1000);
    const after = [min(0, 29831, 29834, 29820, 29822), min(1, 29822, 29824, 29801, 29806), min(2, 29806, 29808, 29790, 29795)];
    const r = bookLevelTrade(a, { pair: 'NDXUSD', side: -1, entry: 29831, stop: 29855, target: 29804, openedAt: T, ref: 'discord_kojiro_levels:signal:NDXUSD:1', strategy: 'discord_kojiro_levels', riskPct: 20, leverage: 50 }, after);
    expect(r.closedAt).toBe(T + 2 * M);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]).toMatchObject({ reason: 'target', exit: 29804 });
    expect(a.balanceUsd).toBeGreaterThan(1000);
    expect(bookLevelTrade(a, { pair: 'NDXUSD', side: -1, entry: 29831, stop: 29855, target: 29804, openedAt: T, ref: 'discord_kojiro_levels:signal:NDXUSD:1', strategy: 'discord_kojiro_levels', riskPct: 20, leverage: 50 }, after).line).toMatch(/already booked/);
  });

  it('nothing hit yet → stays open from the last minute on; a stop touched first beats the target', () => {
    const a = newAccount(1000);
    const r = bookLevelTrade(a, { pair: 'NDXUSD', side: -1, entry: 29831, stop: 29855, target: 29804, openedAt: T, ref: 'x:signal:NDXUSD:2', strategy: 'discord_kojiro_levels', riskPct: 20, leverage: 50 }, [min(0, 29831, 29840, 29825, 29830)]);
    expect(r.closedAt).toBeNull();
    expect(a.open[0]).toMatchObject({ entry: 29831, target: 29804, tf: 'signal', checkedT: T + M });
    const w = walkTrade(-1, 29831, 29855, 29804, [min(0, 29831, 29860, 29800, 29810)], 0.5);
    expect(w).toMatchObject({ exitIdx: 0, reason: 'stop', exit: 29855 });
  });
});

describe('replaying the minutes since his post', () => {
  it('books the break-and-retest short the watcher would have taken, at that minute', async () => {
    const { bars, posted } = scenario();
    const booked: Array<{ entry: number; side: number; openedAt: number }> = [];
    const practice = { bookLevelTrade: async (_acct: unknown, r: { entry: number; side: 1 | -1; openedAt: number }) => (booked.push(r), { line: 'booked', closedAt: null }) };
    const redis = { set: async () => 'OK' } as unknown as Parameters<typeof replayMissedLevels>[0];
    const lines = await replayMissedLevels(redis, practice as never, 'NDXUSD', 'kojiro', [{ levels: [100, 97], side: -1, t: posted, dol: null, all: [100, 97] }], posted, bars);
    expect(lines).toEqual(['booked']);
    expect(booked[0]).toMatchObject({ side: -1, entry: 99.5, openedAt: bars[bars.length - 1]!.t + M });
  });
});

describe('the old index fee given back', () => {
  it('refunds the difference once, on index closes that paid the old rate only', () => {
    const a = newAccount(1000);
    const base = { side: -1 as const, units: 1.444, entry: 29189.75, leverage: 50, stop: null, target: null, openedAt: 1, checkedT: 0 };
    // the Oct 26 SELL: $842.97 margin at 50× → old fee 2 × 0.03% × 42,148.5 = $25.29
    a.closed = [
      { ...base, id: 'k', pair: 'NDXUSD', marginUsd: 842.97, exit: 29151.25, closedAt: 10, pnlUsd: 30.31, reason: 'signal', feeUsd: 25.29, strategy: 'discord_kojiro', tf: 'signal', ref: 'discord_kojiro:signal:NDXUSD:x', riskUsd0: 210 },
      { ...base, id: 'f', pair: 'EURUSD', marginUsd: 500, exit: 1.1, entry: 1.1, closedAt: 11, pnlUsd: 5, reason: 'target', feeUsd: 6 },
    ];
    a.ledger = { 'discord_kojiro:signal': [[10, 30.31, 0.144, 'discord_kojiro:signal:NDXUSD:x', 2]] };
    a.balanceUsd = 1084.21;
    const r = refundIndexFees(a, 0.03, 0.009);
    expect(r.ids).toEqual(['k']);
    expect(a.closed[0]).toMatchObject({ feeUsd: 7.59, pnlUsd: 48.01 });
    expect(a.balanceUsd).toBe(1101.91);
    expect(a.ledger['discord_kojiro:signal']![0]![1]).toBe(48.01);
    expect(refundIndexFees(a, 0.03, 0.009).ids).toEqual([]);
  });
});
