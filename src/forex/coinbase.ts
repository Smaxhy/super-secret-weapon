/**
 * v24 (owner: "crypto needs a lot better, more accurate data"): the coins' candles and live prices come from the
 * Coinbase Exchange public API — real exchange trades, real bid / ask, no key, no account. Candles: REST
 * `/products/<BTC-USD>/candles` (300 a call, 1h and 15m, years back by paging). Live: the `ticker` channel on the
 * public WebSocket feed (every trade: price, best bid, best ask). Yahoo stays the fallback when Coinbase can't be
 * reached (it is 15-minute delayed and has no bid / ask on coins).
 */
import WebSocket from 'ws';
import { moduleLogger } from '../lib/logger';
import { loadBars, mergeBars, refreshSeries, saveBars, type FeedStatus } from './data';
import { feeds } from './feeds';
import { addTick, type LiveTick, type MinuteBar } from './pyth';
import { INSTRUMENTS, type Bar, type Instrument } from './types';
import type { LiveSocket, SocketFactory } from './yahoo-live';

const log = moduleLogger('coinbase');

export const COINBASE = {
  rest: 'https://api.exchange.coinbase.com',
  ws: 'wss://ws-feed.exchange.coinbase.com',
  /** candles a call (the API's maximum) */
  perCall: 300,
  /** pause between pages (the public limit is ~10 requests a second) */
  gapMs: 150,
  timeoutMs: 12_000,
  /** hourly history on the first pull (Yahoo gives 730 days; the lab's 70/30 exam wants as much as it can get) */
  historyDays: 1_100,
  /** a live price counts as live this long after it last arrived */
  freshMs: 90_000,
  watchdogMs: 60_000,
  resubscribeMs: 30_000,
} as const;

/** Coinbase product of a coin (`BTCUSD` → `BTC-USD`). */
export const productOf = (id: string) => `${id.slice(0, -3)}-${id.slice(-3)}`;
export const idOfProduct = (product: string) => product.replace('-', '');

/** Coinbase candles come newest first as [time s, low, high, open, close, volume]. Complete bars only. Pure. */
export function parseCandles(json: unknown, now: number, barMs: number): Bar[] {
  if (!Array.isArray(json)) return [];
  const out: Bar[] = [];
  for (const row of json as unknown[]) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [ts, l, h, o, c] = row as number[];
    if (![ts, l, h, o, c].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const t = Math.floor((ts! * 1000) / barMs) * barMs;
    if (!(o! > 0 && h! > 0 && l! > 0 && c! > 0) || h! < l!) continue;
    if (t + barMs > now) continue;
    out.push({ t, o: o!, h: Math.max(h!, o!, c!), l: Math.min(l!, o!, c!), c: c! });
  }
  return mergeBars([], out);
}

/** One page of candles [from, to) at `granularitySec` (60 / 900 / 3600 / …). */
export async function fetchCoinbasePage(id: string, granularitySec: number, from: number, to: number, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Bar[]> {
  if (!feeds.allow('coinbase')) throw new Error('coinbase paused (it kept failing; retrying in a few minutes)');
  const url = `${COINBASE.rest}/products/${productOf(id)}/candles?granularity=${granularitySec}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'super-secret-weapon/1.0' }, signal: AbortSignal.timeout(COINBASE.timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCandles(await res.json(), now, granularitySec * 1000);
}

/** Every candle from `from` to now, paged 300 at a time (oldest page first). */
export async function fetchCoinbaseBars(id: string, granularitySec: number, from: number, now = Date.now(), fetchImpl: typeof fetch = fetch, maxPages = 400): Promise<Bar[]> {
  const barMs = granularitySec * 1000;
  let out: Bar[] = [];
  let cursor = Math.floor(from / barMs) * barMs;
  for (let page = 0; page < maxPages && cursor < now; page++) {
    const to = Math.min(now, cursor + COINBASE.perCall * barMs);
    out = mergeBars(out, await fetchCoinbasePage(id, granularitySec, cursor, to, now, fetchImpl));
    cursor = to;
    if (COINBASE.gapMs > 0 && cursor < now) await new Promise((r) => setTimeout(r, COINBASE.gapMs));
  }
  return out;
}

/** Refresh a coin's hourly series in Redis `fx:bars:<id>` from Coinbase; Yahoo when Coinbase fails. */
export async function refreshCoinSeries(redis: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> }, inst: Instrument, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<FeedStatus> {
  const have = await loadBars(redis as never, inst.id);
  const lastT = have[have.length - 1]?.t ?? 0;
  const full = have.length < 2_000 || now - lastT > 6 * 86_400_000;
  const from = full ? now - COINBASE.historyDays * 86_400_000 : lastT - 2 * 3_600_000;
  try {
    const fresh = await fetchCoinbaseBars(inst.id, 3_600, from, now, fetchImpl);
    if (full && !fresh.length) throw new Error('no candles returned');
    const merged = mergeBars(have, fresh).filter((b) => b.t >= now - (COINBASE.historyDays + 10) * 86_400_000);
    if (merged.length) await saveBars(redis as never, inst.id, merged);
    feeds.ok('coinbase-candles', { items: fresh.length, asOf: merged[merged.length - 1]?.t ?? null });
    return { id: inst.id, bars: merged.length, firstT: merged[0]?.t ?? null, lastT: merged[merged.length - 1]?.t ?? null, error: null, fresh: merged.filter((b) => b.t > lastT).length, source: 'coinbase' } as FeedStatus;
  } catch (err) {
    if (!/^coinbase paused/.test((err as Error).message)) feeds.fail('coinbase-candles', err);
    log.warn({ id: inst.id, err: (err as Error).message }, 'coinbase candles failed — falling back to Yahoo');
    const y = await refreshSeries(redis as never, inst.id, inst.yahoo, now);
    return { ...y, error: y.error ? `coinbase: ${(err as Error).message}; yahoo: ${y.error}` : null, source: 'yahoo' } as FeedStatus;
  }
}

/** 15-minute (or 1-minute) candles for the fast lab. */
export function fetchCoinbaseFast(inst: Instrument, tf: '15m' | '1m', fromT: number, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Bar[]> {
  return fetchCoinbaseBars(inst.id, tf === '1m' ? 60 : 900, fromT, now, fetchImpl, tf === '1m' ? 120 : 80);
}

// ── live ticker ──

/** A `ticker` message of the public feed (the fields we read). */
export interface TickerMsg {
  type: string;
  product_id?: string;
  price?: string;
  best_bid?: string;
  best_ask?: string;
  time?: string;
}
export interface CoinTick {
  id: string;
  px: number;
  bid: number;
  ask: number;
  t: number;
}
/** Parse one feed message into a tick (null for anything but a usable ticker). Pure. */
export function parseTicker(raw: string, now = Date.now()): CoinTick | null {
  let m: TickerMsg;
  try {
    m = JSON.parse(raw) as TickerMsg;
  } catch {
    return null;
  }
  if (!m || m.type !== 'ticker' || !m.product_id) return null;
  const px = Number(m.price);
  const bid = Number(m.best_bid);
  const ask = Number(m.best_ask);
  if (!(px > 0)) return null;
  const t = m.time ? Date.parse(m.time) : NaN;
  return { id: idOfProduct(m.product_id), px, bid: bid > 0 ? bid : px, ask: ask > 0 ? ask : px, t: Number.isFinite(t) ? t : now };
}

const realSocket: SocketFactory = (url) => new WebSocket(url, { handshakeTimeout: 15_000 }) as unknown as LiveSocket;

/** The coins' live stream (same surface as the Yahoo / Pyth streams: `get(id)`, `flowing()`, `onTicks()`). */
export class CoinbaseLive {
  readonly name = 'coinbase-live';
  private readonly ids: string[];
  private latest = new Map<string, CoinTick & { at: number }>();
  private bars = new Map<string, MinuteBar[]>();
  private listeners = new Set<(ticks: LiveTick[]) => void>();
  private sock: LiveSocket | null = null;
  private stopped = true;
  private fails = 0;
  private lastMsgAt = 0;
  private connectedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private retry: NodeJS.Timeout | null = null;
  updates = 0;
  lastTickAt = 0;

  constructor(private readonly makeSocket: SocketFactory = realSocket, private readonly clock: () => number = Date.now, insts: readonly Instrument[] = INSTRUMENTS) {
    this.ids = insts.filter((i) => i.kind === 'crypto').map((i) => i.id);
  }

  start(): void {
    if (!this.stopped || !this.ids.length) return;
    this.stopped = false;
    this.connect();
    const dog = setInterval(() => {
      const now = this.clock();
      if (this.sock && now - Math.max(this.lastMsgAt, this.connectedAt) > COINBASE.watchdogMs) {
        log.warn('coinbase live stream silent — reconnecting');
        this.drop('silent');
      }
    }, 15_000);
    dog.unref?.();
    this.timers = [dog];
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const s = this.sock;
    this.sock = null;
    try {
      s?.terminate();
    } catch {
      // closing
    }
  }

  onTicks(fn: (ticks: LiveTick[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id: string, now = this.clock()): { px: number; t: number; bars: MinuteBar[] } | null {
    const p = this.latest.get(id);
    if (!p || !this.sock || now - p.at > COINBASE.freshMs) return null;
    return { px: (p.bid + p.ask) / 2, t: p.t, bars: (this.bars.get(id) ?? []).map((b) => [...b] as MinuteBar) };
  }

  /** the real bid / ask of a coin (null when not live) */
  book(id: string, now = this.clock()): { bid: number; ask: number; t: number } | null {
    const p = this.latest.get(id);
    if (!p || !this.sock || now - p.at > COINBASE.freshMs) return null;
    return { bid: p.bid, ask: p.ask, t: p.t };
  }

  flowing(now = this.clock()): boolean {
    return now - this.lastTickAt < 10_000;
  }

  private connect(): void {
    if (this.stopped) return;
    let s: LiveSocket;
    try {
      s = this.makeSocket(COINBASE.ws);
    } catch (err) {
      this.failed((err as Error).message);
      return;
    }
    this.sock = s;
    this.connectedAt = this.clock();
    s.on('open', () => {
      if (this.sock === s) s.send(JSON.stringify({ type: 'subscribe', product_ids: this.ids.map(productOf), channels: ['ticker'] }));
    });
    s.on('message', (data) => {
      if (this.sock === s) this.onMessage(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    s.on('error', (err) => {
      if (this.sock === s) this.failed(err.message);
    });
    s.on('close', () => {
      if (this.sock === s) this.failed('closed');
    });
  }

  onMessage(raw: string): void {
    const now = this.clock();
    this.lastMsgAt = now;
    const tick = parseTicker(raw, now);
    if (!tick || !this.ids.includes(tick.id)) return;
    this.fails = 0;
    this.latest.set(tick.id, { ...tick, at: now });
    this.bars.set(tick.id, addTick(this.bars.get(tick.id) ?? [], tick.t, (tick.bid + tick.ask) / 2));
    this.updates++;
    this.lastTickAt = now;
    feeds.ok('coinbase-live', { items: this.latest.size, asOf: tick.t });
    const out: LiveTick[] = [{ id: tick.id, mid: (tick.bid + tick.ask) / 2, conf: (tick.ask - tick.bid) / 2, t: tick.t }];
    for (const fn of this.listeners) {
      try {
        fn(out);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'coinbase tick listener failed');
      }
    }
  }

  private drop(why: string): void {
    const s = this.sock;
    this.sock = null;
    try {
      s?.terminate();
    } catch {
      // closing
    }
    this.failed(why);
  }

  private failed(why: string): void {
    if (this.stopped) return;
    this.sock = null;
    this.fails++;
    feeds.fail('coinbase-live', why);
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(6, this.fails - 1));
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), wait);
    this.retry.unref?.();
  }
}

export const coinbaseLive = new CoinbaseLive();
