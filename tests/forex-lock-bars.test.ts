/** v28.10 (owner: "it's barely holding trades, it sells immediately"): a bot trade's profit lock trails on its own
 * chart's candles, like the lab's engine — not on every 1-minute wiggle. */
import { describe, expect, it } from 'vitest';
import { newAccount, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';
import { PROFIT_LOCK } from '../src/forex/profit-lock';

VENUE_FEES.on = false;
Object.assign(PROFIT_LOCK, { on: true, atFrac: 0.15, gapFrac: 0.15, keepFrac: 0.05 });
const H = Date.UTC(2026, 9, 30, 2, 0, 0);
const M = 60_000;
// an ETH short on the 1-hour chart: entry 2,000, tested stop 2,020, target 1,960 → the lock arms 6 below, trails 6 behind
const short = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'e1', pair: 'ETHUSD', side: -1, units: 1, entry: 2000, marginUsd: 100, leverage: 20, stop: 2020, target: 1960, openedAt: H, checkedT: H - M, ref: 'donchian55:1h:ETHUSD:1', strategy: 'donchian55', tf: '1h', ...o });
type B = [number, number, number, number, number]; // t, high, low, close, open
const q = (bars: B[]): Quote => {
  const mid = bars[bars.length - 1]![3];
  return { id: 'ETHUSD', mid, bid: mid - 0.05, ask: mid + 0.05, t: bars[bars.length - 1]![0] + M, bars, dayChangePct: null, source: 'coinbase-live' } as Quote;
};
const m1: B = [H + M, 2000, 1990, 1991, 2000]; // arms the lock (best 1990.05)
const m2: B = [H + 2 * M, 1997, 1992, 1995, 1991]; // bounces 7 back: a minute-by-minute trail (stop 1996.05) would close it
const next: B = [H + 60 * M, 1995.5, 1989, 1990, 1995]; // the next hourly candle

describe('profit lock on the chart candle', () => {
  it('a bounce inside the hour does not close it; at the hour the stop moves behind the best price', () => {
    const a = newAccount(1000);
    a.open = [short()];
    tick(a, { ETHUSD: q([m1, m2]) }, H + 3 * M);
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.locked).toBe(true);
    expect(a.open[0]!.stop).toBe(2020); // not moved until the candle closes
    tick(a, { ETHUSD: q([m1, m2, next]) }, H + 61 * M);
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.stop).toBeCloseTo(1996.05, 2);
  });

  it('a candle that closes against the trade after its best → closed at the next candle', () => {
    const a = newAccount(1000);
    a.open = [short()];
    const back: B = [H + 2 * M, 2003, 1992, 2001, 1991]; // went back above the entry inside the hour
    tick(a, { ETHUSD: q([m1, back, next]) }, H + 61 * M);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]).toMatchObject({ reason: 'stop', exit: 1995.05 });
  });

  it('a hand trade (no lab ref) still trails every minute', () => {
    const a = newAccount(1000);
    a.open = [short({ ref: undefined, tf: undefined })];
    tick(a, { ETHUSD: q([m1, m2]) }, H + 3 * M);
    expect(a.open).toHaveLength(0);
  });
});

describe('v28.12 step lock on the bot account', () => {
  it('a trade whose row picked the step lock widens its trail past +1R', () => {
    const a = newAccount(1000);
    a.open = [short({ lockKind: 'step' })];
    tick(a, { ETHUSD: q([m1]) }, H + 2 * M);
    const lock = a.open[0]!.lock!;
    expect(lock.gap).toBeCloseTo(6, 1); // tight: 15% of the 40 to the target
    expect(lock.tight!.gap).toBeCloseTo(10, 1); // past +1R (20 below the entry): a quarter of it
    expect(lock.tight!.from).toBeLessThan(1981);
  });
});
