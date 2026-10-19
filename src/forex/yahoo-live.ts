/**
 * v17.11 live ticking prices from Yahoo's streamer (owner: "live ticking is down"). Pyth's public Hermes started
 * refusing requests without an API key in August 2026, so the v17.9 stream never got a price. Yahoo's streamer
 * (`wss://streamer.finance.yahoo.com/?version=2`, the one finance.yahoo.com and yfinance use) needs no account: send
 * { subscribe: ["EURUSD=X", …] } (again every 15 s, as yfinance does), and each change arrives as
 * { type: 'pricing', message: <base64 protobuf PricingData> } — id 1 (string), price 2 (float), time 3 (sint64 ms),
 * previous close 16 (float), bid 23 / ask 25 (float). Currency pairs only (metals stay on the polled COMEX futures,
 * which are ~10 min delayed). Prices are float32 on the wire → rounded to a tenth of a pip. Keeps the newest price per
 * pair and 1-minute candles from the ticks (so stop / target checks see the highs and lows between checks), reconnects
 * with back-off, and reports to the feed book ('yahoo-live').
 */
import WebSocket from 'ws';
import { moduleLogger } from '../lib/logger';
import { marketClock } from './calendar';
import { feeds } from './feeds';
import { addTick, type LiveTick, type MinuteBar } from './pyth';
import { INSTRUMENTS, type Instrument } from './types';

const log = moduleLogger('forex-yahoo-live');

export const YL = {
  url: 'wss://streamer.finance.yahoo.com/?version=2',
  /** the subscription is sent again this often (the streamer drops quiet subscriptions) */
  resubscribeMs: 15_000,
  /** a pair's price counts as live for this long after it last arrived (Yahoo only sends changes) */
  freshMs: 90_000,
  /** forex open and nothing at all for this long → reconnect */
  watchdogMs: 90_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  keepBars: 180,
};

export interface Pricing {
  id: string;
  price: number;
  /** ms */
  time: number;
  prevClose?: number;
  bid?: number;
  ask?: number;
}

/** Minimal protobuf reader for Yahoo's PricingData (only the fields we use; everything else skipped). Pure. */
export function decodePricing(buf: Uint8Array): Pricing | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const varint = (): number => {
    // multiplication, not shifts: a time in ms needs more than 32 bits
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++]!;
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
    throw new Error('bad varint');
  };
  const out: Partial<Pricing> = {};
  try {
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wt = key & 7;
      if (wt === 0) {
        const v = varint();
        if (field === 3) out.time = v % 2 === 0 ? v / 2 : -(v + 1) / 2; // sint64 zigzag
      } else if (wt === 5) {
        if (i + 4 > buf.length) return null;
        const f = view.getFloat32(i, true);
        i += 4;
        if (field === 2) out.price = f;
        else if (field === 16) out.prevClose = f;
        else if (field === 23) out.bid = f;
        else if (field === 25) out.ask = f;
      } else if (wt === 2) {
        const len = varint();
        if (i + len > buf.length) return null;
        if (field === 1) out.id = new TextDecoder().decode(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 1) {
        i += 8;
      } else return null;
    }
  } catch {
    return null;
  }
  if (!out.id || !(typeof out.price === 'number' && out.price > 0 && Number.isFinite(out.price))) return null;
  let t = out.time ?? 0;
  if (t > 1e14) t = Math.round(t / 1_000); // µs
  else if (t > 0 && t < 1e11) t *= 1_000; // s
  return { id: out.id, price: out.price, time: t, ...(out.prevClose ? { prevClose: out.prevClose } : {}), ...(out.bid ? { bid: out.bid } : {}), ...(out.ask ? { ask: out.ask } : {}) };
}

/** One streamer message (v2 JSON wrapper, or a bare base64 string) → pricing rows. Pure. */
export function parseMessage(raw: string): Pricing | null {
  let b64 = raw.trim();
  if (b64.startsWith('{')) {
    try {
      const j = JSON.parse(b64) as { message?: unknown };
      if (typeof j.message !== 'string') return null;
      b64 = j.message;
    } catch {
      return null;
    }
  }
  try {
    return decodePricing(new Uint8Array(Buffer.from(b64, 'base64')));
  } catch {
    return null;
  }
}

/** float32 on the wire → a tenth of a pip (EUR/USD 5 decimals, JPY pairs 3). Pure. */
export function roundPx(px: number, inst: Pick<Instrument, 'pip'>): number {
  const d = Math.max(0, Math.round(-Math.log10(inst.pip / 10)));
  return Number(px.toFixed(d));
}

/** what the stream needs from a socket (tests pass a fake) */
export interface LiveSocket {
  on(ev: 'open', fn: () => void): void;
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'close', fn: () => void): void;
  on(ev: 'error', fn: (err: Error) => void): void;
  send(data: string): void;
  terminate(): void;
}
export type SocketFactory = (url: string) => LiveSocket;

const realSocket: SocketFactory = (url) =>
  new WebSocket(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)', origin: 'https://finance.yahoo.com' }, handshakeTimeout: 15_000 }) as unknown as LiveSocket;

interface Latest {
  px: number;
  /** price time (ms) */
  t: number;
  /** when it arrived (this process's clock) */
  at: number;
}

/** The live stream. `get(id)` = the newest price of a currency pair (null when not live). */
export class YahooLive {
  readonly name = 'yahoo-live';
  private bySymbol = new Map<string, Instrument>();
  private latest = new Map<string, Latest>();
  private bars = new Map<string, MinuteBar[]>();
  private listeners = new Set<(ticks: LiveTick[]) => void>();
  private sock: LiveSocket | null = null;
  private stopped = true;
  private fails = 0;
  private gotSinceConnect = false;
  private lastMsgAt = 0;
  private connectedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private retry: NodeJS.Timeout | null = null;
  /** prices applied since start */
  updates = 0;
  lastTickAt = 0;

  constructor(private readonly makeSocket: SocketFactory = realSocket, private readonly clock: () => number = Date.now, insts: readonly Instrument[] = INSTRUMENTS) {
    for (const i of insts) if (i.kind === 'fx') this.bySymbol.set(i.yahoo.toUpperCase(), i);
  }

  get pairs(): string[] {
    return [...this.bySymbol.values()].map((i) => i.id);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    const resub = setInterval(() => this.subscribe(), YL.resubscribeMs);
    const dog = setInterval(() => {
      const now = this.clock();
      if (this.sock && marketClock(now).open && now - Math.max(this.lastMsgAt, this.connectedAt) > YL.watchdogMs) {
        log.warn('yahoo live stream silent — reconnecting');
        this.drop('silent while forex is open');
      }
    }, 15_000);
    for (const t of [resub, dog]) t.unref?.();
    this.timers = [resub, dog];
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

  /** the newest live price of a pair (null when unknown, or it last arrived more than `YL.freshMs` ago) */
  get(id: string, now = this.clock()): { px: number; t: number; bars: MinuteBar[] } | null {
    const p = this.latest.get(id);
    if (!p || !this.sock || now - p.at > YL.freshMs) return null;
    return { px: p.px, t: p.t, bars: (this.bars.get(id) ?? []).map((b) => [...b] as MinuteBar) };
  }

  /** prices arrived in the last 10 s */
  flowing(now = this.clock()): boolean {
    return now - this.lastTickAt < 10_000;
  }

  private connect(): void {
    if (this.stopped) return;
    let s: LiveSocket;
    try {
      s = this.makeSocket(YL.url);
    } catch (err) {
      this.failed((err as Error).message);
      return;
    }
    this.sock = s;
    this.gotSinceConnect = false;
    this.connectedAt = this.clock();
    s.on('open', () => {
      if (this.sock === s) this.subscribe();
    });
    s.on('message', (data) => {
      if (this.sock === s) this.onMessage(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    s.on('error', (err) => {
      if (this.sock === s) log.debug({ err: err.message }, 'yahoo live socket error');
    });
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null;
      if (this.stopped) return;
      if (this.gotSinceConnect) {
        this.fails = 0;
        this.schedule(1_000);
      } else this.failed('closed before any price arrived');
    });
  }

  private drop(why: string): void {
    const s = this.sock;
    this.sock = null;
    try {
      s?.terminate();
    } catch {
      // gone
    }
    if (!this.stopped) this.failed(why);
  }

  private failed(why: string): void {
    this.fails++;
    feeds.fail('yahoo-live', why);
    log.warn({ why, fails: this.fails }, 'yahoo live stream failed');
    this.schedule(YL.backoffMs[Math.min(YL.backoffMs.length - 1, this.fails - 1)]!);
  }

  private schedule(ms: number): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, ms);
    this.retry.unref?.();
  }

  private subscribe(): void {
    try {
      this.sock?.send(JSON.stringify({ subscribe: [...this.bySymbol.keys()] }));
    } catch {
      // the close handler reconnects
    }
  }

  /** apply one streamer message (exported for tests through the instance) */
  onMessage(raw: string): void {
    const now = this.clock();
    this.lastMsgAt = now;
    const p = parseMessage(raw);
    if (!p) return;
    const inst = this.bySymbol.get(p.id.toUpperCase());
    if (!inst) return;
    const px = roundPx(p.price, inst);
    const t = p.time > 0 ? Math.min(p.time, now + 5_000) : now;
    const prev = this.latest.get(inst.id);
    if (prev && t < prev.t) return;
    this.latest.set(inst.id, { px, t, at: now });
    addTick(this.bars.get(inst.id) ?? this.bars.set(inst.id, []).get(inst.id)!, t, px, YL.keepBars);
    this.updates++;
    this.lastTickAt = now;
    if (!this.gotSinceConnect || this.updates % 200 === 0) {
      this.gotSinceConnect = true;
      this.fails = 0;
      feeds.ok('yahoo-live', { items: this.latest.size, asOf: t });
    }
    const tick: LiveTick = { id: inst.id, mid: px, conf: 0, t };
    for (const fn of this.listeners) {
      try {
        fn([tick]);
      } catch {
        // a broken listener must not stop the stream
      }
    }
  }
}

/** The one Yahoo stream the forex side uses. */
export const yahooLive = new YahooLive();
