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
  it('pulls a looser stop in to the $20 loss and never loosens a tighter one', () => {
    const a = newAccount(1000);
    a.maxLossUsd = 20;
    a.open = [long()];
    const m1 = T + 60_000;
    const ev = tick(a, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
    expect(ev.join(' ')).toMatch(/\$20 loss cap/);
    expect(a.open[0]!.stop).toBeCloseTo(99_000, 6); // $20 ÷ 0.02 BTC = $1,000 below the entry
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
    expect(b.open).toHaveLength(0);
    expect(b.closed[0]!.pnlUsd).toBeCloseTo(-20, 1);
  });
});

describe('v27.95 every trade, fee included, stays inside $20', () => {
  it('pulls an all-in / copied trade in too, and leaves room for the round-trip fee', () => {
    VENUE_FEES.on = true;
    try {
      const a = newAccount(1000);
      a.maxLossUsd = 20;
      a.open = [{ ...long(), allIn: true, tf: 'signal' }];
      const m1 = T + 60_000;
      tick(a, { BTCUSD: q(99_900, [[m1, 100_000, 99_800, 99_900, 100_000]]) }, m1 + 30_000);
      const fee = (2 * 0.045 * 100 * 20) / 100; // $1.80 on a $2,000 position
      expect(a.open[0]!.stop).toBeCloseTo(100_000 - (20 - fee) / 0.02, 4);
      tick(a, { BTCUSD: q(98_000, [[m1 + 60_000, 99_900, 97_000, 98_000, 99_900]]) }, m1 + 90_000);
      expect(a.open).toHaveLength(0);
      expect(a.closed[0]!.pnlUsd).toBeGreaterThanOrEqual(-20.01);
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
    expect(a.open[0]!.stop).toBeCloseTo(98_500, 6); // $30 ÷ 0.02 BTC = $1,500 below the entry
  });
});
