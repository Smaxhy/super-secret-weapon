import { describe, expect, it } from 'vitest';
import { BOT, tradesOpenedSince, tradesOpenedToday, tradingDayStart } from '../src/forex/practice';
import { SIZING, simulatePortfolio, type PTrade } from '../src/forex/portfolio';

const H = 3_600_000;
describe('v27.38 max trades per day', () => {
  it('the trading day starts 22:00 UTC; a trade counts once (parts / weekend legs / re-opened legs not again)', () => {
    const now = Date.parse('2026-10-26T10:00:00Z');
    expect(new Date(tradingDayStart(now)).toISOString()).toBe('2026-10-25T22:00:00.000Z');
    expect(new Date(tradingDayStart(Date.parse('2026-10-25T23:00:00Z'))).toISOString()).toBe('2026-10-25T22:00:00.000Z');
    const day = tradingDayStart(now);
    const pos = (ref: string, openedAt: number) => ({ ref, openedAt }) as never;
    const a = {
      open: [pos('a', day + H), pos('w', day + 2 * H)], // w = a weekend trade re-opened today
      closed: [pos('b', day + 3 * H), pos('b', day + 3 * H), pos('w', day - 50 * H), pos('old', day - H)],
      orders: [{ ref: 'c', placedAt: day + 4 * H }],
    };
    expect(tradesOpenedToday(a, now)).toBe(3); // a, b, c
    expect(BOT.maxTradesPerDay.bot).toBe(SIZING.maxPerDay);
    expect(BOT.maxTradesPerDay.cbot).toBe(0); // v27.49: off (was 15, v27.42)
    expect(BOT.maxTradesPerHour.cbot).toBe(0); // v27.49: off (was 3)
    expect(tradesOpenedSince(a, day + 2.5 * H)).toBe(2); // b, c
    expect(SIZING.maxPerDay).toBe(0); // v27.40: no daily cap
  });

  it('the honest test takes at most the daily cap', () => {
    const t0 = Date.parse('2026-10-20T00:00:00Z');
    const trades: PTrade[] = Array.from({ length: 30 }, (_, k) => ({ strategy: `s${k % 10}`, tf: '1h', pair: ['EURUSD', 'USDJPY', 'XAUUSD', 'NDXUSD', 'BTCUSD'][k % 5]!, side: 1, entryT: t0 + k * 10 * 60_000, exitT: t0 + k * 10 * 60_000 + 5 * 60_000, r: 1, sizeF: 1 }) as never);
    const base = { label: 'x', baseRiskPct: 1, maxOpen: 50, maxPerStrategy: null, prioritise: true, ccyCapPct: null, leverage: 30, marginShare: 0.25, ddSizing: false, flatSizing: true, mc: false };
    const capped = simulatePortfolio(trades, { ...base, maxPerDay: 5 });
    expect(capped.skipped.day).toBe(25);
    const free = simulatePortfolio(trades, { ...base, maxPerDay: null });
    expect(free.skipped.day ?? 0).toBe(0);
  });
});
