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
    expect(BOT.maxLossUsdByAcct.cbot).toBe(20);
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
