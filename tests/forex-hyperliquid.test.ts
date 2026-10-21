/** v26: Hyperliquid's order book as a backup coin price, and Dukascopy's bot firewall reported honestly. */
import { describe, expect, it } from 'vitest';
import { HyperliquidLive, hlCoin, parseL2 } from '../src/forex/hyperliquid';
import { LiveFeed, type LiveStream } from '../src/forex/live-feed';
import { DK_META, DK_WAF_TEXT, probeDukascopy, refreshDukascopy } from '../src/forex/dukascopy';
import type { LiveSocket } from '../src/forex/yahoo-live';

const NOW = Date.UTC(2026, 9, 20, 21, 0);

describe('Hyperliquid live order book', () => {
  it('parses the best bid / ask of an l2Book message and ignores the rest', () => {
    const msg = { channel: 'l2Book', data: { coin: 'ETH', time: NOW, levels: [[{ px: '2438.4', sz: '3', n: 2 }], [{ px: '2438.6', sz: '1', n: 1 }]] } };
    expect(parseL2(JSON.stringify(msg), NOW)).toEqual({ id: 'ETHUSD', bid: 2438.4, ask: 2438.6, t: NOW });
    expect(parseL2(JSON.stringify({ channel: 'subscriptionResponse', data: {} }), NOW)).toBeNull();
    expect(parseL2(JSON.stringify({ channel: 'l2Book', data: { coin: 'BTC', levels: [[], []] } }), NOW)).toBeNull();
    expect(parseL2('nope', NOW)).toBeNull();
    expect(hlCoin('DOGEUSD')).toBe('DOGE');
  });

  it('subscribes one book per coin, keeps the newest mid, and only ticks when the mid moves', () => {
    const socks: Array<{ sent: string[]; handlers: Record<string, (x?: unknown) => void> }> = [];
    const make = (): LiveSocket => {
      const s = { sent: [] as string[], handlers: {} as Record<string, (x?: unknown) => void> };
      socks.push(s);
      return { on: (ev: string, fn: (x?: unknown) => void) => void (s.handlers[ev] = fn), send: (d: string) => void s.sent.push(d), terminate: () => undefined } as unknown as LiveSocket;
    };
    let now = NOW;
    const live = new HyperliquidLive(make, () => now);
    live.start();
    socks[0]!.handlers.open!();
    const subs = socks[0]!.sent.map((x) => JSON.parse(x) as { method: string; subscription: { type: string; coin: string } });
    expect(subs.every((x) => x.method === 'subscribe' && x.subscription.type === 'l2Book')).toBe(true);
    expect(subs.map((x) => x.subscription.coin)).toContain('BTC');
    const ticks: unknown[] = [];
    live.onTicks((t) => ticks.push(...t));
    const book = (bid: string, ask: string) => JSON.stringify({ channel: 'l2Book', data: { coin: 'BTC', time: now, levels: [[{ px: bid }], [{ px: ask }]] } });
    socks[0]!.handlers.message!(book('82490', '82510'));
    socks[0]!.handlers.message!(book('82490', '82510')); // same mid → no tick
    socks[0]!.handlers.message!(book('82500', '82520'));
    expect(ticks).toHaveLength(2);
    expect(live.get('BTCUSD')).toMatchObject({ px: 82510 });
    expect(live.book('BTCUSD')).toMatchObject({ bid: 82500, ask: 82520 });
    now += 120_000;
    expect(live.get('BTCUSD')).toBeNull();
    live.stop();
  });

  it('is a backup: used only for markets the main streams have no live price for', () => {
    const stream = (name: string, px: Record<string, number>): LiveStream => ({
      name,
      get: (id) => (px[id] ? { px: px[id]!, t: NOW, bars: [] } : null),
      flowing: () => true,
      onTicks: () => () => undefined,
    });
    const feed = new LiveFeed([stream('coinbase-live', { BTCUSD: 82_000 })], [stream('hyperliquid-live', { BTCUSD: 82_050, ETHUSD: 2_440 })]);
    expect(feed.get('BTCUSD')).toMatchObject({ px: 82_000, source: 'coinbase-live' });
    expect(feed.get('ETHUSD')).toMatchObject({ px: 2_440, source: 'hyperliquid-live' });
    expect(feed.get('EURUSD')).toBeNull();
  });
});

describe('Dukascopy bot firewall (v26)', () => {
  const res = (status: number, headers: Record<string, string> = {}) => (async () => new Response(null, { status, headers })) as unknown as typeof fetch;

  it('the probe names the WAF challenge; a plain 202 or a 200 still passes', async () => {
    expect(await probeDukascopy(1000, res(202, { 'x-amzn-waf-action': 'challenge' }))).toBe(DK_WAF_TEXT);
    expect(await probeDukascopy(1000, res(202))).toBeNull();
    expect(await probeDukascopy(1000, res(200))).toBeNull();
  });

  it('a blocked refresh is remembered for a day instead of retried every hour', async () => {
    const store = new Map<string, string>();
    const redis = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v) } as never;
    store.set(DK_META, JSON.stringify({ at: NOW, blocked: DK_WAF_TEXT, ids: { EURUSD: { bars: 0, firstT: null, lastT: null, error: 'x' } } }));
    let asked = 0;
    const fetcher = async () => {
      asked++;
      return [];
    };
    const m = await refreshDukascopy(redis, NOW + 2 * 3_600_000, fetcher);
    expect(m.blocked).toBe(DK_WAF_TEXT);
    expect(asked).toBe(0); // 2 h later: still waiting (it would have retried after 1 h before)
  });
});
