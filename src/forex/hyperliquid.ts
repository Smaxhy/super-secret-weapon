/**
 * v26 (owner: "super accurate price updates, especially when we go live"): Hyperliquid's own live order book for the coins,
 * from its public WebSocket (no key, no account, read-only). Hyperliquid is one of the venues the bot may go live on, so its
 * best bid / ask is the price a live coin trade there would really get. It is a BACKUP stream here (live-feed.ts): Coinbase
 * spot stays the coin bot's main price because the coin lab is graded on Coinbase candles; Hyperliquid prices fill in when
 * Coinbase is quiet. Subscription: {"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}} → messages
 * {"channel":"l2Book","data":{"coin","time","levels":[[bids…],[asks…]]}} (levels: {px, sz, n}, best first).
 *
 * v27.48 (owner: OANDA's demo login is broken; "make the index price on time"): Hyperliquid also lists builder-deployed
 * (HIP-3) perps that follow the Nasdaq 100, S&P, Dow, Russell, gold and silver, 24/7, free. `discover()` reads the list
 * of those exchanges (`perpDexs` + `meta` per dex) and matches names (`HL_FUTURES`, only names with a `dex:` prefix —
 * the main dex's "SPX" is the SPX6900 memecoin); their books are subscribed like the coins'. Their prices are NOT the
 * CME futures the lab / stops / Kojiro use, so they never reach `get()` or the tick push: the practice account reads
 * `book()` and adds the measured gap (basis.ts), exactly like OANDA's CFDs.
 */
import WebSocket from 'ws';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import { addTick, type LiveTick, type MinuteBar } from './pyth';
import { INSTRUMENTS, type Bar, type Instrument } from './types';
import type { LiveSocket, SocketFactory } from './yahoo-live';

const log = moduleLogger('hyperliquid');

export const HYPERLIQUID = {
  ws: 'wss://api.hyperliquid.xyz/ws',
  /** a price counts as live this long after it last arrived */
  freshMs: 90_000,
  watchdogMs: 60_000,
  /** the server drops a socket with no traffic for a minute: ping well inside that */
  pingMs: 30_000,
  info: 'https://api.hyperliquid.xyz/info',
  /** re-read the list of index / metal markets this often */
  discoverMs: 6 * 3_600_000,
  maxDexes: 40,
} as const;

/** Our futures-priced markets → the names a Hyperliquid builder market may carry (the part after `dex:`). */
export const HL_FUTURES: Record<string, RegExp> = {
  NDXUSD: /^(XYZ100|NDX|NAS100|US100|USTECH|USTEC|NASDAQ|NASDAQ100|NQ)$/,
  SPXUSD: /^(SP500|SPX|SPX500|US500|ES)$/,
  DJIUSD: /^(US30|USA30|DJI|DJIA|DJ30|WS30|DOW|DOW30|DOWJONES|YM)$/,
  RUTUSD: /^(US2000|US2K|USA2000|RUT|RTY|R2K|R2000|RUSSELL|RUSSELL2000|SMALLCAP|SMALLCAP2000)$/,
  XAUUSD: /^(GOLD|XAU|XAUUSD)$/,
  XAGUSD: /^(SILVER|XAG|XAGUSD)$/,
};

/** v27.75: builder-market names that look like an index / metal but matched none of the patterns — listed in the bot log
 * so a name we don't know (Dow / Russell / silver run on Yahoo's ~10-minute-late price without one) can be added. Pure. */
export function lookalikes(names: readonly string[], found: Record<string, string>): string[] {
  const taken = new Set(Object.values(found));
  const hint = /(US|DOW|DJ|RUS|R2|SMALL|NAS|SP|GOLD|SILV|XA|INDEX|IDX)/;
  return names.filter((n) => n.includes(':') && !taken.has(n) && hint.test((n.split(':').pop() ?? '').toUpperCase())).slice(0, 30);
}

/** Builder markets (`dex:NAME`) that follow our futures markets; first listed wins. Pure. */
export function matchFutures(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, re] of Object.entries(HL_FUTURES)) {
    const hit = names.find((n) => n.includes(':') && re.test((n.split(':').pop() ?? '').toUpperCase()));
    if (hit) out[id] = hit;
  }
  return out;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Hyperliquid coin name of an instrument (`BTCUSD` → `BTC`). */
export const hlCoin = (id: string) => id.slice(0, -3);

export interface HlBook {
  id: string;
  coin?: string;
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
  return { id: `${m.data.coin}USD`, coin: m.data.coin, bid, ask, t: Number.isFinite(t) && t > 0 ? t : now };
}

const realSocket: SocketFactory = (url) => new WebSocket(url, { handshakeTimeout: 15_000 }) as unknown as LiveSocket;

/** The coins' Hyperliquid stream (same surface as the other live streams: `get(id)`, `flowing()`, `onTicks()`). */
export class HyperliquidLive {
  readonly name = 'hyperliquid-live';
  private readonly ids: string[];
  /** coin name → our id (coins + discovered futures markets) */
  private idOf = new Map<string, string>();
  /** v27.48: our futures id → its Hyperliquid builder market */
  private futures = new Map<string, string>();
  private latest = new Map<string, HlBook & { at: number }>();
  private bars = new Map<string, MinuteBar[]>();
  private listeners = new Set<(ticks: LiveTick[]) => void>();
  /** v27.75: raw (unshifted) mids of the index / metal builder markets — the practice account moves them onto the futures */
  private futListeners = new Set<(ticks: LiveTick[]) => void>();
  private sock: LiveSocket | null = null;
  private stopped = true;
  private fails = 0;
  private lastMsgAt = 0;
  private connectedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private retry: NodeJS.Timeout | null = null;
  updates = 0;
  lastTickAt = 0;

  constructor(private readonly makeSocket: SocketFactory = realSocket, private readonly clock: () => number = Date.now, insts: readonly Instrument[] = INSTRUMENTS, private readonly fetcher: Fetcher | null = null) {
    this.ids = insts.filter((i) => i.kind === 'crypto').map((i) => i.id);
    for (const id of this.ids) this.idOf.set(hlCoin(id), id);
  }

  start(): void {
    if (!this.stopped || !this.ids.length) return;
    this.stopped = false;
    this.connect();
    if (this.fetcher) {
      void this.discover();
      const again = setInterval(() => void this.discover(), HYPERLIQUID.discoverMs);
      again.unref?.();
      this.timers.push(again);
    }
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
    this.timers.push(dog, ping);
  }

  private async info(body: object): Promise<unknown> {
    const res = await this.fetcher!(HYPERLIQUID.info, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Hyperliquid info HTTP ${res.status}`);
    return res.json();
  }

  /** v27.48: find the builder markets that follow the indices / metals and subscribe their books. */
  async discover(): Promise<Record<string, string>> {
    if (!this.fetcher) return {};
    try {
      const dexes = (await this.info({ type: 'perpDexs' })) as Array<{ name?: string } | null>;
      const names: string[] = [];
      for (const d of (dexes ?? []).slice(0, HYPERLIQUID.maxDexes + 1)) {
        if (!d?.name) continue;
        const meta = (await this.info({ type: 'meta', dex: d.name }).catch(() => null)) as { universe?: Array<{ name?: string; isDelisted?: boolean }> } | null;
        for (const u of meta?.universe ?? []) if (u.name && !u.isDelisted) names.push(u.name.includes(':') ? u.name : `${d.name}:${u.name}`);
      }
      const found = matchFutures(names);
      const fresh = Object.entries(found).filter(([id, coin]) => this.futures.get(id) !== coin);
      for (const [id, coin] of fresh) {
        const old = this.futures.get(id);
        if (old) this.idOf.delete(old);
        this.futures.set(id, coin);
        this.idOf.set(coin, id);
        try {
          this.sock?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
        } catch {
          // subscribed on the next connect
        }
      }
      if (Object.keys(found).length) this.onDiscover?.(found);
      this.onMarkets?.(found, lookalikes(names, found));
      if (fresh.length || !this.futures.size) log.info({ found, dexes: (dexes ?? []).filter(Boolean).length }, Object.keys(found).length ? 'Hyperliquid index / metal markets found' : 'no Hyperliquid index / metal markets found');
      return found;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Hyperliquid market list failed');
      return Object.fromEntries(this.futures);
    }
  }

  /** v27.52: told the market list after every discovery (index.ts stores it in Redis for the labs / the worker child) */
  onDiscover: ((found: Record<string, string>) => void) | null = null;
  /** v27.75: every discovery — what was found and the index-looking names that matched nothing (for the bot log) */
  onMarkets: ((found: Record<string, string>, unknown: string[]) => void) | null = null;

  /** v27.48: which builder market follows which of our futures markets */
  futuresFound(): Record<string, string> {
    return Object.fromEntries(this.futures);
  }
  private isFut(id: string): boolean {
    return this.futures.has(id);
  }

  /** v27.48: a futures market's own 1-minute candles (mid prices), newest last — for the gap measurement */
  async candles(id: string, minutes = 300): Promise<Array<[number, number]>> {
    const coin = this.futures.get(id);
    if (!coin || !this.fetcher) return (this.bars.get(id) ?? []).map((b) => [b[0], b[3]]);
    const end = this.clock();
    const rows = (await this.info({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: end - minutes * 60_000, endTime: end } })) as Array<{ t?: number; c?: string }>;
    const out = (rows ?? []).map((r) => [Number(r.t), Number(r.c)] as [number, number]).filter(([t, c]) => t > 0 && c > 0);
    return out.length ? out : (this.bars.get(id) ?? []).map((b) => [b[0], b[3]]);
  }

  /** v27.48: a futures market's 1-minute candles built from its book (unshifted) */
  futBars(id: string): MinuteBar[] {
    return (this.bars.get(id) ?? []).map((b) => [...b] as MinuteBar);
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
  /** v27.75: every move of an index / metal builder market (raw, NOT the futures price — add the measured gap) */
  onFutTicks(fn: (ticks: LiveTick[]) => void): () => void {
    this.futListeners.add(fn);
    return () => this.futListeners.delete(fn);
  }

  get(id: string, now = this.clock()): { px: number; t: number; bars: MinuteBar[] } | null {
    const p = this.latest.get(id);
    // v27.48: a builder index / metal market is never handed out raw (it isn't the futures price)
    if (!p || !this.sock || now - p.at > HYPERLIQUID.freshMs || this.isFut(id)) return null;
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
      for (const coin of this.futures.values()) s.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
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
    const parsed = parseL2(raw, now);
    const id = parsed?.coin ? this.idOf.get(parsed.coin) : undefined;
    if (!parsed || !id) return;
    const b = { ...parsed, id };
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
    for (const fn of this.isFut(b.id) ? this.futListeners : this.listeners) {
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

export const hyperliquidLive = new HyperliquidLive(realSocket, Date.now, INSTRUMENTS, (url, init) => fetch(url, init));

/** v27.52: Redis key holding {our id → Hyperliquid builder market} (written after each discovery, read by the labs). */
export const HL_FUTURES_KEY = 'fx:hl:futures';

/** v27.52: a builder market's candles over REST (no account): newest last, finished and forming alike. */
export async function hlCandles(coin: string, interval: '1m' | '5m' | '15m' | '1h' | '4h', startTime: number, endTime: number, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<Bar[]> {
  const res = await fetcher(HYPERLIQUID.info, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Hyperliquid candles HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ t?: number; o?: string; h?: string; l?: string; c?: string; v?: string }> | null;
  return (rows ?? [])
    .map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }))
    .filter((b) => b.t > 0 && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)
    .map((b) => (b.v > 0 ? b : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }))
    .sort((a, b) => a.t - b.t);
}

/** v27.52: the stored {our id → builder market} list ({} when none yet). */
export async function loadHlFutures(redis: { get(k: string): Promise<string | null> }): Promise<Record<string, string>> {
  try {
    const raw = await redis.get(HL_FUTURES_KEY);
    const m = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
