/**
 * Wallet book (v11.6) — every wallet's track record, built from the trade stream alone (zero RPC):
 * realised P&L per sell (cost basis per coin, snipers / creators excluded like wallet-pnl.ts), how long it usually
 * holds (first buy → first sell per coin, EWMA), whether it sells its whole bag at once, dump events (a big sell —
 * ≥ 2% of supply or ≥ 10% of the coin's 5-min volume — followed by a ≥ `dumperDropPct` drop within 60 s) and how
 * often it buys right before someone else's dump. One updater (`onTrade`) feeds it live (token-registry) and in the
 * replay (tape rows). `classify` → proven / dumper / loser / bot / unknown drives the crowd-quality entry rule and
 * the holder-clock exit. In memory (≤ maxWallets, LRU by last seen); persisted to Redis HASH `wbook` (one compact
 * JSON per wallet, ~200 B) every minute, loaded at start; counts halve every `halfLifeDays`.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('wallet-book');

export const WBOOK_KEY = 'wbook';
const WBOOK_META = 'wbook:meta';
const SUPPLY = 1e9;
const SNIPER_MS = 15_000;
const DUMP_WINDOW_MS = 60_000;
const VOL_WINDOW_MS = 300_000;
const COIN_IDLE_MS = 2 * 3_600_000;
const MAX_COINS = 6_000;
const MAX_WALLETS_PER_COIN = 4_000;

export interface WalletBookConfig {
  enabled: boolean;
  minSells: number;
  provenWinRate: number;
  provenPf: number;
  dumperDropPct: number;
  dumperMinEvents: number;
  maxWallets: number;
  halfLifeDays: number;
}

/** Compact per-wallet record (short keys: it is stored as JSON per wallet). */
export interface WalletRec {
  /** sells with a known cost basis */
  n: number;
  /** winning sells */
  w: number;
  /** realised SOL */
  pnl: number;
  /** gross wins / gross losses (profit factor) */
  gw: number;
  gl: number;
  /** usual hold: seconds from first buy to first sell per coin (EWMA); -1 = unknown */
  hold: number;
  holdN: number;
  /** sells that were ≥80% of the bag */
  big: number;
  /** dump events / last one (ms) */
  dumps: number;
  dumpAt: number;
  /** bought within 60 s before someone's dump */
  dumpedOn: number;
  /** buys and buys at a size this wallet repeated (bots) */
  buys: number;
  rep: number;
  /** distinct coins traded */
  coins: number;
  /** last seen (ms) */
  last: number;
}

export type WalletClass = 'proven' | 'dumper' | 'loser' | 'bot' | 'unknown';

export interface BookTrade {
  mint: string;
  wallet: string;
  isBuy: boolean;
  sol: number;
  /** whole tokens */
  tokens: number;
  /** ms */
  t: number;
  /** price paid / received per whole token (SOL); the pool price after, when known */
  price: number;
  creator?: string | null;
}

interface WalletPos {
  cost: number;
  tok: number;
  maxTok: number;
  firstBuy: number;
  firstSold: boolean;
  lastSize: number;
}

interface CoinState {
  firstT: number;
  lastT: number;
  pos: Map<string, WalletPos>;
  /** 5-min volume window */
  vols: Array<{ t: number; sol: number }>;
  volSol: number;
  /** buys in the last 90 s (who could be dumped on) */
  recentBuys: Array<{ w: string; t: number }>;
  /** big sells waiting to see whether the price dropped after them */
  pendingDumps: Array<{ w: string; t: number; price: number; done: boolean }>;
}

export const emptyRec = (now = 0): WalletRec => ({ n: 0, w: 0, pnl: 0, gw: 0, gl: 0, hold: -1, holdN: 0, big: 0, dumps: 0, dumpAt: 0, dumpedOn: 0, buys: 0, rep: 0, coins: 0, last: now });

export function walletBookConfig(): WalletBookConfig {
  const c = (getConfig() as { wallets?: Partial<WalletBookConfig> }).wallets;
  return { ...(DEFAULT_CONFIG.wallets as WalletBookConfig), ...(c ?? {}) };
}

/** Pure: what kind of wallet is this? */
export function classify(r: WalletRec | undefined | null, c: Pick<WalletBookConfig, 'minSells' | 'provenWinRate' | 'provenPf' | 'dumperMinEvents'>): WalletClass {
  if (!r) return 'unknown';
  if (r.buys >= 20 && r.rep / r.buys >= 0.6) return 'bot';
  if (r.dumps >= c.dumperMinEvents) return 'dumper';
  if (r.n < c.minSells) return 'unknown';
  const wr = r.w / r.n;
  if (wr < 0.35) return 'loser';
  const pf = r.gl > 0 ? r.gw / r.gl : r.gw > 0 ? Infinity : 0;
  if (wr >= c.provenWinRate && pf >= c.provenPf) return 'proven';
  return 'unknown';
}

/** Pure: a wallet record after `days` of fading (counts halve every halfLifeDays). */
export function decayRec(r: WalletRec, days: number, halfLifeDays: number): WalletRec {
  if (!(days > 0) || !(halfLifeDays > 0)) return r;
  const f = Math.pow(0.5, days / halfLifeDays);
  return { ...r, n: r.n * f, w: r.w * f, pnl: r.pnl * f, gw: r.gw * f, gl: r.gl * f, big: r.big * f, dumps: r.dumps * f, dumpedOn: r.dumpedOn * f, buys: r.buys * f, rep: r.rep * f };
}

/** Pure: which wallets to evict (oldest `last`) so the book stays at `max`. */
export function evictList(entries: ReadonlyArray<[string, WalletRec]>, max: number): string[] {
  if (entries.length <= max) return [];
  return [...entries].sort((a, b) => a[1].last - b[1].last).slice(0, entries.length - max).map(([w]) => w);
}

/** Seed an in-memory book from raw Redis HASH entries (the replay: read the live records, never write them back). */
export function seedBook(book: WalletBook, raw: Record<string, string>): number {
  let n = 0;
  for (const [w, s] of Object.entries(raw)) {
    try {
      const r = JSON.parse(s) as WalletRec;
      if (typeof r.n === 'number' && typeof r.last === 'number') {
        book.seed(w, { ...emptyRec(), ...r });
        n++;
      }
    } catch {
      /* skip */
    }
  }
  return n;
}

export interface WalletBookStats {
  enabled: boolean;
  wallets: number;
  proven: number;
  dumpers: number;
  losers: number;
  bots: number;
  trades: number;
  dumpEvents: number;
}

export class WalletBook {
  private readonly recs = new Map<string, WalletRec>();
  private readonly coins = new Map<string, CoinState>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastDecayDay = 0;
  private counts = { trades: 0, dumpEvents: 0 };
  private lastSweep = 0;

  constructor(private readonly redis: Redis | null = null) {}

  get size(): number {
    return this.recs.size;
  }

  get(wallet: string): WalletRec | undefined {
    return this.recs.get(wallet);
  }

  /** Put a record in directly (seeding / tests). */
  seed(wallet: string, rec: WalletRec): void {
    this.recs.set(wallet, rec);
  }

  classOf(wallet: string): WalletClass {
    return classify(this.recs.get(wallet), walletBookConfig());
  }

  /** Feed every trade (live: token registry; replay: tape rows). Sync, never throws. */
  onTrade(t: BookTrade): void {
    try {
      this.apply(t, walletBookConfig());
    } catch (err) {
      if (this.counts.trades % 5000 === 0) log.warn({ err: (err as Error).message }, 'wallet book update failed');
    }
  }

  private apply(t: BookTrade, c: WalletBookConfig): void {
    if (!c.enabled || !(t.sol > 0) || !(t.tokens > 0) || !t.wallet) return;
    this.counts.trades++;
    const coin = this.coin(t.mint, t.t);
    coin.lastT = Math.max(coin.lastT, t.t);
    // 5-min volume window
    coin.vols.push({ t: t.t, sol: t.sol });
    coin.volSol += t.sol;
    while (coin.vols.length && coin.vols[0]!.t < t.t - VOL_WINDOW_MS) coin.volSol -= coin.vols.shift()!.sol;
    // pending dumps: did the price drop after a big sell?
    if (coin.pendingDumps.length && t.price > 0) this.settleDumps(coin, t, c);

    const rec = this.rec(t.wallet, t.t);
    rec.last = t.t;
    let pos = coin.pos.get(t.wallet);
    if (!pos) {
      if (coin.pos.size >= MAX_WALLETS_PER_COIN) return;
      pos = { cost: 0, tok: 0, maxTok: 0, firstBuy: 0, firstSold: false, lastSize: 0 };
      coin.pos.set(t.wallet, pos);
      rec.coins++;
    }
    const creator = t.creator ?? null;
    if (t.isBuy) {
      rec.buys++;
      const size = Math.round(t.sol * 1000) / 1000;
      if (pos.lastSize > 0 && size === pos.lastSize) rec.rep++;
      pos.lastSize = size;
      const sniper = t.t - coin.firstT <= SNIPER_MS || (creator !== null && t.wallet === creator);
      if (!sniper) {
        pos.cost += t.sol;
        if (pos.firstBuy === 0) pos.firstBuy = t.t;
      }
      pos.tok += t.tokens;
      pos.maxTok = Math.max(pos.maxTok, pos.tok);
      coin.recentBuys.push({ w: t.wallet, t: t.t });
      while (coin.recentBuys.length && coin.recentBuys[0]!.t < t.t - 90_000) coin.recentBuys.shift();
      this.dirty.add(t.wallet);
      return;
    }
    // sell
    const bagBefore = pos.tok;
    const sold = Math.min(t.tokens, Math.max(0, bagBefore));
    const bigSell = (t.tokens / SUPPLY) * 100 >= 2 || (coin.volSol > 0 && t.sol >= coin.volSol * 0.1);
    if (bigSell) {
      coin.pendingDumps.push({ w: t.wallet, t: t.t, price: t.price, done: false });
      if (coin.pendingDumps.length > 20) coin.pendingDumps.shift();
    }
    if (bagBefore > 0 && sold / bagBefore >= 0.8) rec.big++;
    if (pos.cost > 0 && sold > 0 && pos.tok > 0) {
      const frac = Math.min(1, sold / pos.tok);
      const basis = pos.cost * frac;
      const pnl = t.sol - basis;
      rec.n++;
      if (pnl > 0) {
        rec.w++;
        rec.gw += pnl;
      } else rec.gl += -pnl;
      rec.pnl += pnl;
      pos.cost -= basis;
      if (!pos.firstSold && pos.firstBuy > 0) {
        pos.firstSold = true;
        const h = Math.max(1, (t.t - pos.firstBuy) / 1000);
        rec.hold = rec.holdN === 0 ? h : rec.hold + (h - rec.hold) * 0.3;
        rec.holdN++;
      }
    }
    pos.tok = Math.max(0, pos.tok - t.tokens);
    this.dirty.add(t.wallet);
  }

  private settleDumps(coin: CoinState, t: BookTrade, c: WalletBookConfig): void {
    const cut = t.t - DUMP_WINDOW_MS;
    for (const d of coin.pendingDumps) {
      if (d.done) continue;
      if (d.t < cut) {
        d.done = true;
        continue;
      }
      if (d.price > 0 && t.price <= d.price * (1 - c.dumperDropPct / 100)) {
        d.done = true;
        this.counts.dumpEvents++;
        const r = this.rec(d.w, t.t);
        r.dumps++;
        r.dumpAt = d.t;
        this.dirty.add(d.w);
        for (const b of coin.recentBuys) {
          if (b.w !== d.w && b.t >= d.t - DUMP_WINDOW_MS && b.t <= d.t) {
            const v = this.rec(b.w, t.t);
            v.dumpedOn++;
            this.dirty.add(b.w);
          }
        }
      }
    }
    if (coin.pendingDumps.every((d) => d.done)) coin.pendingDumps.length = 0;
  }

  private rec(wallet: string, now: number): WalletRec {
    let r = this.recs.get(wallet);
    if (!r) {
      r = emptyRec(now);
      this.recs.set(wallet, r);
      const max = walletBookConfig().maxWallets;
      if (this.recs.size > max * 1.05) this.evict(max);
    }
    return r;
  }

  private coin(mint: string, t: number): CoinState {
    let c = this.coins.get(mint);
    if (!c) {
      c = { firstT: t, lastT: t, pos: new Map(), vols: [], volSol: 0, recentBuys: [], pendingDumps: [] };
      this.coins.set(mint, c);
    }
    if (t - this.lastSweep > 60_000) {
      this.lastSweep = t;
      for (const [m, s] of this.coins) if (t - s.lastT > COIN_IDLE_MS) this.coins.delete(m);
      if (this.coins.size > MAX_COINS) {
        const oldest = [...this.coins.entries()].sort((a, b) => a[1].lastT - b[1].lastT).slice(0, this.coins.size - MAX_COINS);
        for (const [m] of oldest) this.coins.delete(m);
      }
    }
    return c;
  }

  private evict(max: number): void {
    for (const w of evictList([...this.recs.entries()], max)) {
      this.recs.delete(w);
      this.dirty.delete(w);
      if (this.redis) void this.redis.hdel(WBOOK_KEY, w).catch(() => undefined);
    }
  }

  /** The watched position a wallet holds in a coin (replay / exits): whole tokens still held, first buy time. */
  position(mint: string, wallet: string): { tok: number; firstBuy: number; maxTok: number } | null {
    const p = this.coins.get(mint)?.pos.get(wallet);
    return p ? { tok: p.tok, firstBuy: p.firstBuy, maxTok: p.maxTok } : null;
  }

  stats(): WalletBookStats {
    const c = walletBookConfig();
    let proven = 0, dumpers = 0, losers = 0, bots = 0;
    for (const r of this.recs.values()) {
      const k = classify(r, c);
      if (k === 'proven') proven++;
      else if (k === 'dumper') dumpers++;
      else if (k === 'loser') losers++;
      else if (k === 'bot') bots++;
    }
    return { enabled: c.enabled, wallets: this.recs.size, proven, dumpers, losers, bots, ...this.counts };
  }

  /** Best proven wallets (by realised SOL) / worst dumpers (by dump events) for the dashboard. */
  top(kind: 'proven' | 'dumper', n = 10): Array<{ wallet: string; rec: WalletRec }> {
    const c = walletBookConfig();
    const xs = [...this.recs.entries()].filter(([, r]) => classify(r, c) === kind).map(([wallet, rec]) => ({ wallet, rec }));
    xs.sort((a, b) => (kind === 'proven' ? b.rec.pnl - a.rec.pnl : b.rec.dumps - a.rec.dumps));
    return xs.slice(0, n);
  }

  /** Daily fade (counts halve every halfLifeDays) — called by the persist timer and the replay. */
  decay(now = Date.now()): void {
    const day = Math.floor(now / 86_400_000);
    if (this.lastDecayDay === 0) {
      this.lastDecayDay = day;
      return;
    }
    const days = day - this.lastDecayDay;
    if (days <= 0) return;
    const hl = walletBookConfig().halfLifeDays;
    for (const [w, r] of this.recs) {
      this.recs.set(w, decayRec(r, days, hl));
      this.dirty.add(w);
    }
    this.lastDecayDay = day;
  }

  /** Load the book from Redis (start). */
  async load(): Promise<number> {
    if (!this.redis) return 0;
    try {
      const [all, meta] = await Promise.all([this.redis.hgetall(WBOOK_KEY), this.redis.hget(WBOOK_META, 'day')]);
      for (const [w, s] of Object.entries(all)) {
        try {
          const r = JSON.parse(s) as WalletRec;
          if (typeof r.n === 'number' && typeof r.last === 'number') this.recs.set(w, { ...emptyRec(), ...r });
        } catch {
          /* skip */
        }
      }
      this.lastDecayDay = Number(meta ?? 0) || 0;
      log.info({ wallets: this.recs.size }, '📒 wallet book loaded');
      return this.recs.size;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'wallet book load failed');
      return 0;
    }
  }

  /** Persist dirty records (every minute, and at stop). */
  async persist(now = Date.now()): Promise<number> {
    if (!this.redis || !this.dirty.size) return 0;
    this.decay(now);
    const ws = [...this.dirty];
    this.dirty.clear();
    try {
      for (let i = 0; i < ws.length; i += 2000) {
        const pipe = this.redis.pipeline();
        const chunk: Record<string, string> = {};
        for (const w of ws.slice(i, i + 2000)) {
          const r = this.recs.get(w);
          if (r) chunk[w] = JSON.stringify(r);
        }
        if (Object.keys(chunk).length) pipe.hset(WBOOK_KEY, chunk);
        pipe.hset(WBOOK_META, 'day', String(this.lastDecayDay));
        await pipe.exec();
      }
      return ws.length;
    } catch (err) {
      for (const w of ws) this.dirty.add(w);
      log.warn({ err: (err as Error).message }, 'wallet book persist failed');
      return 0;
    }
  }

  start(): void {
    this.decay();
    this.timer = setInterval(() => void this.persist(), 60_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.persist();
  }
}
