import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTick, compose, pairKey, parsePrice, planFeeds, PYTH, PythLive, SseParser, type FeedPrice, type MinuteBar, type PythMeta } from '../src/forex/pyth';
import { feeds } from '../src/forex/feeds';

const meta = (id: string, symbol: string, extra: Record<string, string> = {}): PythMeta => ({ id, attributes: { symbol, asset_type: 'FX', ...extra } });
const METAS: PythMeta[] = [
  meta('0xAA', 'FX.EUR/USD'),
  meta('bb', 'FX.USD/JPY'),
  meta('cc', 'FX.GBP/USD'),
  meta('dd', 'FX.CHF/USD'), // only the inverse of USD/CHF exists
  meta('ee', 'FX.AUD/USD', { base: 'AUD', quote_currency: 'USD' }),
  { id: 'ff', attributes: { symbol: 'Metal.XAU/USD', asset_type: 'Metal' } },
];

describe('v17.9 Pyth feed plan', () => {
  it('reads pairs from symbols or base/quote attributes', () => {
    expect(pairKey(METAS[0]!)).toBe('EUR/USD');
    expect(pairKey(METAS[4]!)).toBe('AUD/USD');
    expect(pairKey({ id: 'x', attributes: { symbol: 'Crypto.BTC.PRE/USD' } })).toBeNull();
  });

  it('direct, inverse and USD-cross pairs; never metals; pairs it cannot make are left out', () => {
    const p = planFeeds(METAS);
    expect(p.EURUSD).toEqual([{ id: 'aa', inv: false }]);
    expect(p.USDCHF).toEqual([{ id: 'dd', inv: true }]);
    expect(p.EURJPY).toEqual([{ id: 'aa', inv: false }, { id: 'bb', inv: false }]);
    expect(p.GBPJPY).toEqual([{ id: 'cc', inv: false }, { id: 'bb', inv: false }]);
    expect(p.EURGBP).toEqual([{ id: 'aa', inv: false }, { id: 'cc', inv: true }]);
    expect(p.XAUUSD).toBeUndefined();
    expect(p.XAGUSD).toBeUndefined();
    expect(p.USDCAD).toBeUndefined(); // no CAD feed at all
    expect(p.NZDUSD).toBeUndefined();
  });

  it('composes prices: inverse = 1 / price, cross = product, time = the oldest leg, a missing leg → null', () => {
    const latest = new Map<string, FeedPrice>([
      ['aa', { px: 1.1, conf: 0.0001, t: 2_000 }],
      ['bb', { px: 150, conf: 0.01, t: 1_000 }],
      ['cc', { px: 1.25, conf: 0.0001, t: 3_000 }],
      ['dd', { px: 1.125, conf: 0.0001, t: 3_000 }],
    ]);
    const p = planFeeds(METAS);
    expect(compose(p.EURUSD!, latest)!.px).toBeCloseTo(1.1, 12);
    expect(compose(p.USDCHF!, latest)!.px).toBeCloseTo(1 / 1.125, 12);
    const ej = compose(p.EURJPY!, latest)!;
    expect(ej.px).toBeCloseTo(165, 9);
    expect(ej.t).toBe(1_000);
    expect(compose(p.EURGBP!, latest)!.px).toBeCloseTo(1.1 / 1.25, 12);
    expect(compose([{ id: 'zz', inv: false }], latest)).toBeNull();
  });

  it('parses Hermes rows (price × 10^expo, seconds → ms, 0x stripped)', () => {
    const r = parsePrice({ id: '0xAB', price: { price: '108423', conf: '12', expo: -5, publish_time: 1_760_000_000 } })!;
    expect(r.id).toBe('ab');
    expect(r.p.px).toBeCloseTo(1.08423, 10);
    expect(r.p.conf).toBeCloseTo(0.00012, 10);
    expect(r.p.t).toBe(1_760_000_000_000);
    expect(parsePrice({ id: 'ab', price: { price: '-1', expo: 0, publish_time: 1 } })).toBeNull();
    expect(parsePrice({ id: 'ab' })).toBeNull();
  });
});

describe('v17.9 SSE + minute candles', () => {
  it('splits events across chunks, CRLF, comments and error events', () => {
    const ev: Array<{ event: string; data: string }> = [];
    const s = new SseParser();
    s.push(': keep-alive\n\nda', (e) => ev.push(e));
    s.push('ta: {"a":1}\r\n\r\nevent: error\ndata: boom\n', (e) => ev.push(e));
    s.push('\n', (e) => ev.push(e));
    expect(ev).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'error', data: 'boom' },
    ]);
  });

  it('folds ticks into 1-minute candles (old ticks ignored, capped)', () => {
    const bars: MinuteBar[] = [];
    addTick(bars, 60_000, 1.1);
    addTick(bars, 61_000, 1.12);
    addTick(bars, 62_000, 1.09);
    addTick(bars, 125_000, 1.1);
    addTick(bars, 30_000, 5); // older minute: ignored
    expect(bars).toEqual([
      [60_000, 1.12, 1.09, 1.09, 1.1],
      [120_000, 1.1, 1.1, 1.1, 1.1],
    ]);
    for (let k = 3; k < 10; k++) addTick(bars, k * 60_000, 1, 4);
    expect(bars.length).toBe(4);
    expect(bars[bars.length - 1]![0]).toBe(9 * 60_000);
  });
});

describe('v17.9 PythLive stream', () => {
  afterEach(() => vi.restoreAllMocks());
  const sse = (events: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(e));
        c.close();
      },
    });
  const update = (rows: Array<[string, string, number]>) =>
    `data: ${JSON.stringify({ binary: { encoding: 'hex', data: [] }, parsed: rows.map(([id, price, sec]) => ({ id, price: { price, conf: '5', expo: -5, publish_time: sec }, ema_price: { price, conf: '5', expo: -5, publish_time: sec }, metadata: {} })) })}\n\n`;

  it('resolves feeds, streams prices into live quotes + candles, goes stale, reports to the feed book', async () => {
    const T = 1_760_000_000;
    let now = T * 1000 + 500;
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/v2/price_feeds')) return { ok: true, status: 200, json: async () => METAS, body: null };
      return { ok: true, status: 200, json: async () => ({}), body: sse([': hi\n\n', update([['aa', '110000', T], ['bb', '15000000', T]]), update([['aa', '110100', T]])]) };
    });
    const live = new PythLive(fetcher as never, () => now);
    const ticks: string[] = [];
    live.onTicks((ts) => ticks.push(...ts.map((x) => x.id)));
    live.start();
    await vi.waitFor(() => expect(live.updates).toBeGreaterThanOrEqual(2));
    live.stop();
    expect(urls[0]).toContain('/v2/price_feeds?asset_type=fx');
    expect(urls[1]).toContain('/v2/updates/price/stream?');
    expect(urls[1]).toContain('ids[]=aa');
    expect(urls[1]).toContain('parsed=true');
    const eu = live.get('EURUSD')!;
    expect(eu.px).toBeCloseTo(1.101, 10);
    expect(eu.bars).toHaveLength(1);
    expect(eu.bars[0]![1]).toBeCloseTo(1.101, 10); // high
    expect(eu.bars[0]![2]).toBeCloseTo(1.1, 10); // low
    expect(live.get('EURJPY')!.px).toBeCloseTo(1.101 * 150, 8);
    expect(live.get('XAUUSD')).toBeNull();
    expect(ticks).toContain('EURUSD');
    expect(ticks).toContain('USDJPY');
    expect(feeds.get('pyth-live').okAt).not.toBeNull();
    now += PYTH.staleMs + 1;
    expect(live.get('EURUSD')).toBeNull();
  });

  it('an error event or a failed feed list counts as a failure and is retried', async () => {
    const before = feeds.get('pyth-live').fails;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/v2/price_feeds')) return { ok: false, status: 503, json: async () => [], body: null };
      return { ok: true, status: 200, json: async () => ({}), body: null };
    });
    const live = new PythLive(fetcher as never);
    live.start();
    await vi.waitFor(() => expect(feeds.get('pyth-live').fails).toBeGreaterThan(before));
    live.stop();
    expect(live.get('EURUSD')).toBeNull();
  });
});
