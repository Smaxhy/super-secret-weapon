/** v27.20 (owner: "make the SL on crypto much stricter, not past $20"): the coin bot's per-trade USD loss cap. */
import { describe, expect, it } from 'vitest';
import { BOT, newAccount, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;

const T = Date.UTC(2026, 9, 22, 14, 0, 0);
const q = (mid: number, bars: Array<[number, number, number, number, number]> = []): Quote => ({ id: 'BTCUSD', mid, bid: mid - 5, ask: mid + 5, t: T, bars, dayChangePct: null, source: 'coinbase-live' });
// 0.02 BTC long at 100,000 with a stop at 96,000 → $80 at risk
const long = (): PracticePosition => ({ id: 'p1', pair: 'BTCUSD', side: 1, units: 0.02, entry: 100_000, marginUsd: 100, leverage: 20, stop: 96_000, target: 106_000, openedAt: T, checkedT: 0, lock: null });

describe('per-trade USD loss cap', () => {
  it('the coin bot and (v27.22) the forex bot are capped at $20', () => {
    expect(BOT.maxLossUsdByAcct.cbot).toBe(20); // v27.95 (was $50 from v27.78)
    expect(BOT.maxLossUsdByAcct.bot).toBe(20);
  });
  it('v27.96: trims a trade whose tested stop loses more than $20 (the stop stays where it was tested)', () => {
    const a = newAccount(1000);
    a.maxLossUsd = 20;
    a.open = [long()];
    const m1 = T + 60_000;
    const ev = tick(a, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
    expect(ev.join(' ')).toMatch(/trimmed to 20%/);
    const p = a.open[0]!;
    expect(p.stop).toBe(96_000); // never pulled in
    expect(p.units).toBeCloseTo(0.02 * (15.9 / 77.9), 8);
    // the part sold now + the rest at the tested stop = $18 (90% of the cap, room for a gap fill)
    expect(-(p.bankedUsd ?? 0) + p.units * 4_000).toBeCloseTo(18, 1);
    const b = newAccount(1000);
    b.maxLossUsd = 20;
    b.open = [{ ...long(), stop: 99_500 }];
    tick(b, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
    expect(b.open[0]!.stop).toBe(99_500);
  });
  it('a trade already past the cap closes at the market, and the stop then holds the loss near $20', () => {
    const a = newAccount(1000);
    a.maxLossUsd = 20;
    a.open = [long()];
    const m1 = T + 60_000;
    tick(a, { BTCUSD: q(98_500, [[m1, 99_000, 98_400, 98_500, 99_000]]) }, m1 + 30_000);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.pnlUsd).toBeCloseTo(-30.1, 1); // already −$30 when the cap arrived: closed now, not later
    const b = newAccount(1000);
    b.maxLossUsd = 20;
    b.open = [long()];
    tick(b, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
    tick(b, { BTCUSD: q(98_800, [[m1 + 60_000, 99_900, 98_700, 98_800, 99_900]]) }, m1 + 90_000);
    expect(b.open).toHaveLength(1); // a dip that doesn't reach the tested stop no longer stops it out (v27.96)
    tick(b, { BTCUSD: q(96_500, [[m1 + 120_000, 98_800, 95_900, 96_500, 98_800]]) }, m1 + 190_000);
    expect(b.open).toHaveLength(0);
    expect(b.closed.reduce((n, c) => n + c.pnlUsd, 0)).toBeGreaterThanOrEqual(-20);
  });
});

describe('v27.95 every trade, fee included, stays inside $20', () => {
  it('trims an all-in / copied trade too, and leaves room for the round-trip fee', () => {
    VENUE_FEES.on = true;
    try {
      const a = newAccount(1000);
      a.maxLossUsd = 20;
      a.open = [{ ...long(), allIn: true, tf: 'signal' }];
      const m1 = T + 60_000;
      tick(a, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
      expect(a.open[0]!.stop).toBe(96_000);
      expect(a.open[0]!.units).toBeLessThan(0.02 * 0.2);
      tick(a, { BTCUSD: q(98_000, [[m1 + 60_000, 99_900, 97_000, 98_000, 99_900]]) }, m1 + 90_000);
      expect(a.open).toHaveLength(1);
      tick(a, { BTCUSD: q(96_500, [[m1 + 120_000, 98_000, 95_900, 96_500, 98_000]]) }, m1 + 190_000);
      expect(a.open).toHaveLength(0);
      // the part sold + the stopped rest, both fees included
      expect(a.closed.reduce((n, c) => n + c.pnlUsd, 0)).toBeGreaterThanOrEqual(-20.01);
    } finally {
      VENUE_FEES.on = false;
    }
  });
});

import { undoPositions } from '../src/forex/practice';

describe('v27.22 undoPositions', () => {
  it('strikes the picked open trade, takes its booked rolls back and remembers its signal', () => {
    const a = newAccount(1000);
    a.open = [{ ...long(), id: 'x', pair: 'NZDUSD', strategy: 'pivot_bounce', ref: 'pivot_bounce:4h:NZDUSD:1', bankedUsd: 1.5 }, { ...long(), id: 'y' }];
    a.balanceUsd = 1001.5;
    const r = undoPositions(a, (p) => p.pair === 'NZDUSD');
    expect(r.ids).toEqual(['x']);
    expect(a.open.map((p) => p.id)).toEqual(['y']);
    expect(a.balanceUsd).toBe(1000);
    expect(a.skipRefs).toEqual(['pivot_bounce:4h:NZDUSD:1']);
  });
});

describe('v27.45 a trade can carry its own loss cap', () => {
  it('a $30 cap on the trade beats the account $20 cap', () => {
    const a = newAccount(1000);
    a.maxLossUsd = 20;
    a.open = [{ ...long(), maxLossUsd: 30 }];
    const m1 = T + 60_000;
    tick(a, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
    expect(a.open[0]!.stop).toBe(96_000); // v27.96: trimmed, not pulled in
    expect(-(a.open[0]!.bankedUsd ?? 0) + a.open[0]!.units * 4_000).toBeCloseTo(27, 1); // 90% of $30
  });
});
