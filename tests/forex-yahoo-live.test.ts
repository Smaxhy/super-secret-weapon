/** v17.11: live prices from Yahoo's streamer (Pyth needs an API key since August 2026) + the combined live feed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePricing, parseMessage, roundPx, YahooLive, YL, type LiveSocket } from '../src/forex/yahoo-live';
import { LiveFeed, type LiveStream } from '../src/forex/live-feed';
import { feedHealth, feeds } from '../src/forex/feeds';
import type { MinuteBar } from '../src/forex/pyth';

// a tiny protobuf writer for test messages
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const key = (field: number, wt: number) => varint(field * 8 + wt);
const str = (field: number, s: string) => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...key(field, 2), ...varint(b.length), ...b];
};
const f32 = (field: number, x: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x, 0);
  return [...key(field, 5), ...b];
};
const sint = (field: number, n: number) => [...key(field, 0), ...varint(n >= 0 ? n * 2 : -n * 2 - 1)];
const pricing = (id: string, price: number, timeMs: number, extra: number[] = []) => Buffer.from([...str(1, id), ...f32(2, price), ...sint(3, timeMs), ...extra]);
const wrap = (buf: Buffer) => JSON.stringify({ type: 'pricing', message: buf.toString('base64') });

const T = 1_760_000_000_000;

describe('v17.11 Yahoo PricingData decoding', () => {
  it('reads id / price / time / previous close / bid / ask and skips fields it does not use', () => {
    const buf = pricing('EURUSD=X', 1.08423, T, [...str(4, 'USD'), ...sint(9, 12345), ...f32(16, 1.08), ...f32(23, 1.0842), ...f32(25, 1.08426), ...[...key(32, 1), 0, 0, 0, 0, 0, 0, 0, 0]]);
    const p = decodePricing(buf)!;
    expect(p.id).toBe('EURUSD=X');
    expect(p.price).toBeCloseTo(1.08423, 6);
    expect(p.time).toBe(T);
    expect(p.prevClose).toBeCloseTo(1.08, 6);
    expect(p.bid).toBeCloseTo(1.0842, 6);
    expect(p.ask).toBeCloseTo(1.08426, 6);
  });

  it('time in seconds or microseconds is turned into ms; broken / priceless messages are dropped', () => {
    expect(decodePricing(pricing('JPY=X', 150.1, T / 1000))!.time).toBe(T);
    expect(decodePricing(pricing('JPY=X', 150.1, T * 1000))!.time).toBe(T);
    expect(decodePricing(Buffer.from(str(1, 'EURUSD=X')))).toBeNull();
    expect(decodePricing(pricing('EURUSD=X', 1.1, T).subarray(0, 12))).toBeNull();
    expect(decodePricing(Buffer.from([0x0f]))).toBeNull(); // wire type 7
  });

  it('accepts the v2 JSON wrapper and a bare base64 string', () => {
    const buf = pricing('GBPUSD=X', 1.25, T);
    expect(parseMessage(wrap(buf))!.id).toBe('GBPUSD=X');
    expect(parseMessage(buf.toString('base64'))!.price).toBeCloseTo(1.25, 6);
    expect(parseMessage('{"type":"heartbeat"}')).toBeNull();
    expect(parseMessage('{oops')).toBeNull();
  });

  it('rounds the float32 price to a tenth of a pip', () => {
    expect(roundPx(1.0842299461364746, { pip: 0.0001 })).toBe(1.08423);
    expect(roundPx(150.12300109863281, { pip: 0.01 })).toBe(150.123);
  });
});

class FakeSocket implements LiveSocket {
  sent: string[] = [];
  terminated = false;
  private h: Record<string, Array<(...a: unknown[]) => void>> = {};
  on(ev: string, fn: (...a: unknown[]) => void): void {
    (this.h[ev] ??= []).push(fn);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const f of this.h[ev] ?? []) f(...a);
  }
  send(d: string) {
    this.sent.push(d);
  }
  terminate() {
    this.terminated = true;
  }
}

describe('v17.11 YahooLive stream', () => {
  afterEach(() => vi.useRealTimers());

  it('subscribes to every currency pair (never metals), turns messages into live prices + candles + ticks', () => {
    let now = T + 30_000; // a price time more than 5 s in the future is clamped to the receive time
    const socks: FakeSocket[] = [];
    const yl = new YahooLive(() => {
      const s = new FakeSocket();
      socks.push(s);
      return s;
    }, () => now);
    const ticks: string[] = [];
    yl.onTicks((ts) => ticks.push(...ts.map((t) => `${t.id}@${t.mid}`)));
    yl.start();
    expect(socks).toHaveLength(1);
    socks[0]!.emit('open');
    const sub = JSON.parse(socks[0]!.sent[0]!) as { subscribe: string[] };
    expect(sub.subscribe).toContain('EURUSD=X');
    expect(sub.subscribe).toContain('JPY=X');
    expect(sub.subscribe).not.toContain('GC=F');
    socks[0]!.emit('message', Buffer.from(wrap(pricing('EURUSD=X', 1.0842299461364746, T))));
    socks[0]!.emit('message', wrap(pricing('JPY=X', 150.1230010986, T + 500)));
    socks[0]!.emit('message', wrap(pricing('EURUSD=X', 1.0840, T + 20_000)));
    socks[0]!.emit('message', wrap(pricing('EURUSD=X', 1.5, T - 5_000))); // older than the newest: ignored
    socks[0]!.emit('message', wrap(pricing('GC=F', 2650, T))); // not a streamed market
    expect(ticks).toEqual(['EURUSD@1.08423', 'USDJPY@150.123', 'EURUSD@1.084']);
    const eu = yl.get('EURUSD')!;
    expect(eu.px).toBe(1.084);
    expect(eu.t).toBe(T + 20_000);
    expect(eu.bars).toHaveLength(1);
    expect(eu.bars[0]![1]).toBe(1.08423);
    expect(eu.bars[0]![2]).toBe(1.084);
    expect(yl.get('XAUUSD')).toBeNull();
    expect(yl.flowing()).toBe(true);
    expect(feeds.get('yahoo-live').okAt).not.toBeNull();
    // a price that stopped arriving is not live any more
    now += YL.freshMs + 1;
    expect(yl.get('EURUSD')).toBeNull();
    expect(yl.flowing()).toBe(false);
    yl.stop();
    expect(socks[0]!.terminated).toBe(true);
  });

  it('reconnects: quickly after a working connection closes, with back-off when it never delivered', () => {
    vi.useFakeTimers({ now: T });
    const before = feeds.get('yahoo-live').fails;
    const socks: FakeSocket[] = [];
    const yl = new YahooLive(() => {
      const s = new FakeSocket();
      socks.push(s);
      return s;
    });
    yl.start();
    socks[0]!.emit('open');
    socks[0]!.emit('message', wrap(pricing('EURUSD=X', 1.1, T)));
    socks[0]!.emit('close');
    expect(yl.get('EURUSD')).toBeNull(); // no socket → not live
    vi.advanceTimersByTime(1_000);
    expect(socks).toHaveLength(2);
    socks[1]!.emit('close'); // nothing arrived: a failure
    expect(feeds.get('yahoo-live').fails).toBeGreaterThan(before);
    vi.advanceTimersByTime(999);
    expect(socks).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socks).toHaveLength(3);
    socks[2]!.emit('close');
    vi.advanceTimersByTime(1_999);
    expect(socks).toHaveLength(3); // second failure waits longer
    vi.advanceTimersByTime(1);
    expect(socks).toHaveLength(4);
    // the subscription is sent again every 15 s
    socks[3]!.emit('open');
    vi.advanceTimersByTime(YL.resubscribeMs);
    expect(socks[3]!.sent.length).toBe(2);
    yl.stop();
    vi.advanceTimersByTime(120_000);
    expect(socks).toHaveLength(4);
  });
});

describe('v17.11 combined live feed', () => {
  const stream = (name: string, px: Record<string, [number, number]>, flowing = true): LiveStream => ({
    name,
    get: (id) => (px[id] ? { px: px[id]![0], t: px[id]![1], bars: [] as MinuteBar[] } : null),
    flowing: () => flowing,
    onTicks: () => () => undefined,
  });
  it('takes the freshest stream per pair and says which one', () => {
    const f = new LiveFeed([stream('pyth', { EURUSD: [1.1, 5], USDJPY: [150, 1] }), stream('yahoo-live', { EURUSD: [1.1001, 4], USDJPY: [150.01, 3], GBPUSD: [1.25, 2] }, false)]);
    expect(f.get('EURUSD')).toMatchObject({ px: 1.1, source: 'pyth' });
    expect(f.get('USDJPY')).toMatchObject({ px: 150.01, source: 'yahoo-live' });
    expect(f.get('GBPUSD')!.source).toBe('yahoo-live');
    expect(f.get('AUDUSD')).toBeNull();
    expect(f.flowing()).toBe(true);
    expect(new LiveFeed([stream('a', {}, false)]).flowing()).toBe(false);
  });

  it('the feed card shows Pyth as off without an API key', () => {
    const rows = feedHealth({}, { now: T, open: true, oanda: false });
    expect(rows.find((r) => r.id === 'pyth-live')!.status).toBe('off');
    expect(rows.find((r) => r.id === 'yahoo-live')!.status).toBe('never');
    expect(feedHealth({}, { now: T, open: true, oanda: false, pyth: true }).find((r) => r.id === 'pyth-live')!.status).toBe('never');
  });
});
