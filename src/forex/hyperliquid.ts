/**
 * v26 (owner: "super accurate price updates, especially when we go live"): Hyperliquid's own live order book for the coins,
 * from its public WebSocket (no key, no account, read-only). Hyperliquid is one of the venues the bot may go live on, so its
 * best bid / ask is the price a live coin trade there would really get. It is a BACKUP stream here (live-feed.ts): Coinbase
 * spot stays the coin bot's main price because the coin lab is graded on Coinbase candles; Hyperliquid prices fill in when
 * Coinbase is quiet. Subscription: {"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}} → messages
 * {"channel":"l2Book","data":{"coin","time","levels":[[bids…],[asks…]]}} (levels: {px, sz, n}, best first).
 */
import WebSocket from 'ws';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import { addTick, type LiveTick, type MinuteBar } from './pyth';
import { INSTRUMENTS, type Instrument } from './types';
import type { LiveSocket, SocketFactory } from './yahoo-live';

const log = moduleLogger('hyperliquid');

export const HYPERLIQUID = {
  ws: 'wss://api.hyperliquid.xyz/ws',
  /** a price counts as live this long after it last arrived */
  freshMs: 90_000,
  watchdogMs: 60_000,
  /** the server drops a socket with no traffic for a minute: ping well inside that */
  pingMs: 30_000,
} as const;

/** Hyperliquid coin name of an instrument (`BTCUSD` → `BTC`). */
export const hlCoin = (id: string) => id.slice(0, -3);

export interface HlBook {
  id: string;
  bid: number;
  ask: number;
  t: number;
}

/** Parse one feed message into the best bid / ask of a coin (null for anything else). Pure. */
export function parseL2(raw: string, now = Date.now()): HlBook | null {
  let m: { channel?: string; data?: { coin?: string; time?: number; levels?: Array<Array<{ px?: string }>> } };
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || m.channel !== 'l2Book' || !m.data?.coin || !Array.isArray(m.data.levels)) return null;
  const bid = Number(m.data.levels[0]?.[0]?.px);
  const ask = Number(m.data.levels[1]?.[0]?.px);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const t = Number(m.data.time);
  return { id: `${m.data.coin}USD`, bid, ask, t: Number.isFinite(t) && t > 0 ? t : now };
}

const realSocket: SocketFactory = (url) => new WebSocket(url, { handshakeTimeout: 15_000 }) as unknown as LiveSocket;

/** The coins' Hyperliquid stream (same surface as the other live streams: `get(id)`, `flowing()`, `onTicks()`). */
export class HyperliquidLive {
  readonly name = 'hyperliquid-live';
  private readonly ids: string[];
  private latest = new Map<string, HlBook & { at: number }>();
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
      if (this.sock && now - Math.max(this.lastMsgAt, this.connectedAt) > HYPERLIQUID.watchdogMs) {
        log.warn('hyperliquid stream silent — reconnecting');
        this.drop('silent');
      }
    }, 15_000);
    const ping = setInterval(() => {
      try {
        this.sock?.send(JSON.stringify({ method: 'ping' }));
      } catch {
        // the watchdog reconnects
      }
    }, HYPERLIQUID.pingMs);
    dog.unref?.();
    ping.unref?.();
    this.timers = [dog, ping];
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
    if (!p || !this.sock || now - p.at > HYPERLIQUID.freshMs) return null;
    return { px: (p.bid + p.ask) / 2, t: p.t, bars: (this.bars.get(id) ?? []).map((b) => [...b] as MinuteBar) };
  }

  /** the venue's real best bid / ask of a coin (null when not live) */
  book(id: string, now = this.clock()): { bid: number; ask: number; t: number } | null {
    const p = this.latest.get(id);
    if (!p || !this.sock || now - p.at > HYPERLIQUID.freshMs) return null;
    return { bid: p.bid, ask: p.ask, t: p.t };
  }

  flowing(now = this.clock()): boolean {
    return now - this.lastTickAt < 10_000;
  }

  private connect(): void {
    if (this.stopped) return;
    let s: LiveSocket;
    try {
      s = this.makeSocket(HYPERLIQUID.ws);
    } catch (err) {
      this.failed((err as Error).message);
      return;
    }
    this.sock = s;
    this.connectedAt = this.clock();
    s.on('open', () => {
      if (this.sock !== s) return;
      for (const id of this.ids) s.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: hlCoin(id) } }));
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
    const b = parseL2(raw, now);
    if (!b || !this.ids.includes(b.id)) return;
    this.fails = 0;
    const mid = (b.bid + b.ask) / 2;
    const prev = this.latest.get(b.id);
    this.latest.set(b.id, { ...b, at: now });
    this.bars.set(b.id, addTick(this.bars.get(b.id) ?? [], b.t, mid));
    this.updates++;
    this.lastTickAt = now;
    feeds.ok('hyperliquid-live', { items: this.latest.size, asOf: b.t });
    // the book republishes every block: only a moved mid is a tick
    if (prev && (prev.bid + prev.ask) / 2 === mid) return;
    const out: LiveTick[] = [{ id: b.id, mid, conf: (b.ask - b.bid) / 2, t: b.t }];
    for (const fn of this.listeners) {
      try {
        fn(out);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'hyperliquid tick listener failed');
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
    feeds.fail('hyperliquid-live', why);
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(6, this.fails - 1));
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), wait);
    this.retry.unref?.();
  }
}

export const hyperliquidLive = new HyperliquidLive();
