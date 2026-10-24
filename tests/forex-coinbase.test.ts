/** v24: the coins' candles and live prices from the Coinbase Exchange public API. */
import { describe, expect, it } from 'vitest';
import { CoinbaseLive, fetchCoinbaseBars, idOfProduct, parseCandles, parseTicker, productOf } from '../src/forex/coinbase';
import type { LiveSocket } from '../src/forex/yahoo-live';
import { INSTRUMENTS } from '../src/forex/types';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12);

describe('candles', () => {
  it('maps ids to products both ways', () => {
    expect(productOf('BTCUSD')).toBe('BTC-USD');
    expect(productOf('DOGEUSD')).toBe('DOGE-USD');
    expect(idOfProduct('AVAX-USD')).toBe('AVAXUSD');
    for (const i of INSTRUMENTS.filter((x) => x.kind === 'crypto')) expect(idOfProduct(productOf(i.id))).toBe(i.id);
  });
  it('parses newest-first [time, low, high, open, close, volume] rows into complete bars, oldest first', () => {
    const rows = [
      [NOW / 1000, 99, 101, 100, 100.5, 10], // still forming (closes after now)
      [(NOW - 2 * H) / 1000, 98, 102, 100, 101, 10],
      [(NOW - 3 * H) / 1000, 97, 100, 99, 98, 10],
      ['bad'],
      [(NOW - 4 * H) / 1000, 100, 99, 99, 99, 1], // high < low
    ];
    const bars = parseCandles(rows, NOW, H);
    expect(bars.map((b) => b.t)).toEqual([NOW - 3 * H, NOW - 2 * H]);
    expect(bars[1]).toEqual({ t: NOW - 2 * H, o: 100, h: 102, l: 98, c: 101, v: 10 });
  });
  it('pages 300 candles at a time from `from` to now', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const start = Date.parse(u.searchParams.get('start')!);
      const end = Date.parse(u.searchParams.get('end')!);
      const out: number[][] = [];
      for (let t = start; t < end; t += H) out.push([t / 1000, 1, 3, 2, 2, 1]);
      return { ok: true, json: async () => out.reverse() } as unknown as Response;
    }) as unknown as typeof fetch;
    const bars = await fetchCoinbaseBars('BTCUSD', 3_600, NOW - 700 * H, NOW, fetchImpl);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/products/BTC-USD/candles?granularity=3600');
    expect(bars).toHaveLength(700);
    expect(bars[0]!.t).toBe(NOW - 700 * H);
  });
});

describe('live ticker', () => {
  it('parses a ticker message (price, best bid / ask, time) and ignores the rest', () => {
    const t = parseTicker(JSON.stringify({ type: 'ticker', product_id: 'ETH-USD', price: '2438.7', best_bid: '2438.5', best_ask: '2438.9', time: '2026-10-20T12:30:00.123Z' }), NOW);
    expect(t).toEqual({ id: 'ETHUSD', px: 2438.7, bid: 2438.5, ask: 2438.9, t: Date.parse('2026-10-20T12:30:00.123Z') });
    expect(parseTicker(JSON.stringify({ type: 'subscriptions' }), NOW)).toBeNull();
    expect(parseTicker('not json', NOW)).toBeNull();
  });
  it('subscribes to the coins, keeps the newest mid per coin with 1-minute candles, and reconnects on close', () => {
    const socks: Array<{ sent: string[]; handlers: Record<string, (x?: unknown) => void> }> = [];
    const make = (): LiveSocket => {
      const s = { sent: [] as string[], handlers: {} as Record<string, (x?: unknown) => void> };
      socks.push(s);
      return { on: (ev: string, fn: (x?: unknown) => void) => void (s.handlers[ev] = fn), send: (d: string) => void s.sent.push(d), terminate: () => undefined } as unknown as LiveSocket;
    };
    let now = NOW;
    const live = new CoinbaseLive(make, () => now);
    live.start();
    expect(socks).toHaveLength(1);
    socks[0]!.handlers.open!();
    const sub = JSON.parse(socks[0]!.sent[0]!) as { type: string; product_ids: string[]; channels: string[] };
    expect(sub.type).toBe('subscribe');
    expect(sub.product_ids).toContain('BTC-USD');
    expect(sub.product_ids).toContain('DOGE-USD');
    expect(sub.channels).toEqual(['ticker']);
    const ticks: unknown[] = [];
    live.onTicks((t) => ticks.push(...t));
    socks[0]!.handlers.message!(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: '82500', best_bid: '82490', best_ask: '82510', time: new Date(now).toISOString() }));
    expect(live.get('BTCUSD')).toMatchObject({ px: 82500, t: now });
    expect(live.book('BTCUSD')).toMatchObject({ bid: 82490, ask: 82510 });
    expect(live.get('BTCUSD')!.bars).toHaveLength(1);
    expect(live.get('EURUSD')).toBeNull();
    expect(ticks).toHaveLength(1);
    expect(live.flowing()).toBe(true);
    now += 120_000;
    expect(live.get('BTCUSD')).toBeNull(); // 90 s freshness
    socks[0]!.handlers.close!();
    expect(live.get('BTCUSD')).toBeNull();
    live.stop();
  });
});
