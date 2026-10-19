/** v18.4 resting limit orders on the bot account: filled on the 1-minute candles like the backtester, expired, kept on a stale feed. */
import { describe, expect, it } from 'vitest';
import { fillOrder, newAccount, tick, type PracticeAccount, type Quote, type RestingOrder } from '../src/forex/practice';
import { toLabTrade } from '../src/forex/lab';

const T0 = Date.UTC(2025, 0, 7, 10);
const order = (over: Partial<RestingOrder> = {}): RestingOrder => ({ id: 'o1', pair: 'EURUSD', side: 1, limit: 1.1, kind: 'pullback', placedAt: T0, expiresAt: T0 + 3 * 3_600_000, ref: 'ema_pullback:1h:EURUSD:1', strategy: 'ema_pullback', stop: 1.095, target: 1.11, marginUsd: 100, leverage: 30, riskPct: 1, tf: '1h', ...over });
const quote = (mid: number, bars: Quote['bars']): Quote => ({ id: 'EURUSD', mid, bid: mid - 0.00005, ask: mid + 0.00005, t: T0, bars, dayChangePct: null, source: 'yahoo' });
const acct = (o: RestingOrder): PracticeAccount => ({ ...newAccount(1000), orders: [o] });

describe('v18.4 resting orders', () => {
  it('fills at the limit when a minute trades down to it (buy limit on the ask), then the position guards itself', () => {
    const a = acct(order());
    // minute 1 stays above, minute 2 dips to the limit (ask low = l + half = 1.1)
    const ev = tick(a, { EURUSD: quote(1.1004, [[T0 + 60_000, 1.1012, 1.1006, 1.1008, 1.101], [T0 + 120_000, 1.1006, 1.09995, 1.1003, 1.1005]]) }, T0 + 180_000);
    expect(ev.some((e) => /filled long EURUSD/.test(e))).toBe(true);
    expect(a.orders).toHaveLength(0);
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.entry).toBeCloseTo(1.1, 9);
    expect(a.open[0]!.ref).toBe('ema_pullback:1h:EURUSD:1');
    expect(a.open[0]!.stop).toBe(1.095);
    expect(a.open[0]!.riskUsd0).toBeGreaterThan(0);
  });

  it('a minute that opens through the limit fills at that open (better), a sell limit mirrors on the bid', () => {
    const a = acct(order());
    tick(a, { EURUSD: quote(1.0995, [[T0 + 60_000, 1.0998, 1.0992, 1.0996, 1.0994]]) }, T0 + 120_000);
    expect(a.open[0]!.entry).toBeCloseTo(1.0994 + 0.00005, 9);
    const b = acct(order({ side: -1, limit: 1.1, stop: 1.105, target: 1.09 }));
    tick(b, { EURUSD: quote(1.0996, [[T0 + 60_000, 1.10006, 1.0994, 1.0996, 1.0995]]) }, T0 + 120_000);
    expect(b.open).toHaveLength(1);
    expect(b.open[0]!.entry).toBeCloseTo(1.1, 9);
  });

  it('waits while the price stays away or the feed is stale, expires unfilled, never fills through the stop', () => {
    const a = acct(order());
    expect(tick(a, { EURUSD: quote(1.1006, [[T0 + 60_000, 1.1012, 1.1004, 1.1008, 1.1006]]) }, T0 + 120_000)).toHaveLength(0);
    expect(a.orders).toHaveLength(1);
    expect(tick(a, { EURUSD: { ...quote(1.09, [[T0 + 60_000, 1.1, 1.09, 1.09, 1.1]]), stale: true } }, T0 + 120_000)).toHaveLength(0);
    expect(a.orders).toHaveLength(1);
    const ev = tick(a, { EURUSD: quote(1.1006, []) }, T0 + 4 * 3_600_000);
    expect(ev[0]).toMatch(/expired unfilled/);
    expect(a.orders).toHaveLength(0);
    expect(a.open).toHaveLength(0);
    // a gap through the stop: no fill, order dropped with a reason
    const c = acct(order());
    const ev2 = tick(c, { EURUSD: quote(1.094, [[T0 + 60_000, 1.0945, 1.0935, 1.094, 1.094]]) }, T0 + 120_000);
    expect(ev2[0]).toMatch(/gapped past its stop/);
    expect(c.open).toHaveLength(0);
  });

  it('fillOrder refuses when the margin is gone and builds the position from the order\'s plan', () => {
    const a = newAccount(50);
    expect(fillOrder(a, order({ marginUsd: 100 }), 1.1, { EURUSD: 1.1 }, T0, T0)).toMatch(/free margin/);
    const b = newAccount(1000);
    expect(fillOrder(b, order({ beAt: 1.102, trailAtr: 2, maxBars: 12, conviction: { tier: 'sure', conf: 3, of: 4, mult: 1.5, lev: 50 } }), 1.1, { EURUSD: 1.1 }, T0, T0)).toBeNull();
    expect(b.open[0]).toMatchObject({ beAt: 1.102, trailAtr: 2, maxBars: 12, tf: '1h', conviction: { tier: 'sure' } });
  });

  it('a lab trade carries its resting order', () => {
    const t = toLabTrade({ strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1, entryT: T0, keyT: T0, exitT: T0, entry: 1.1, exit: 1.1, r: 0, stopPct: 1, reason: 'open', bars: 0, stop: 1.095, stop0: 1.095, target: 1.11 }, { chosen: true, sizeF: 1, prio: 0, judge: null, order: { kind: 'pullback', limit: 1.0995, until: T0 + 4 * 3_600_000 } });
    expect(t.order).toEqual({ kind: 'pullback', limit: 1.0995, until: T0 + 4 * 3_600_000 });
  });
});
