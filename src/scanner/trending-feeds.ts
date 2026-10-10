/**
 * Trending tabs — what the platforms themselves are showing right now (free, no keys):
 *
 *  pump.fun (unofficial frontend API, frontend-api-v3.pump.fun — ~50 req/min allowed, we use ≤ 8):
 *    live        coins live-streaming right now, with the REAL viewer count (`num_participants`)
 *    koth        King of the Hill (the curve leader)
 *    for_you     the home feed
 *    runners     "top runners"
 *  GeckoTerminal (public API, keyless ~10 req/min — we use ≤ 1):
 *    gecko_5m / gecko_1h   trending Solana pools (pump.fun / PumpSwap coins kept)
 *  DexScreener `metas/trending` (narratives like "Cat", "AI") → hot keywords.
 *
 * Research (Oct 2026): no public data shows that entering a trending list predicts more gains —
 * lists rank recent activity, so a coin usually shows up AFTER its move. So a list entry is an
 * ATTENTION signal and a trigger to check the coin, never a buy by itself; the chart-strategy
 * lab measures list entries against random entries like any other signal.
 *
 * Every source sits behind a circuit breaker: a Cloudflare page (403 HTML) or 429 pauses it
 * (5 min / the reset time), errors are counted and shown on the Scanner page.
 */
import { getConfig } from '../config/runtime-config';
import { DEFAULT_CONFIG } from '../config/default';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('trending');
const PUMP = 'https://frontend-api-v3.pump.fun';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const DEX = 'https://api.dexscreener.com';

export type TrendSource = 'pump_live' | 'pump_koth' | 'pump_for_you' | 'pump_runners' | 'gecko_5m' | 'gecko_1h';
export const TREND_SOURCES: TrendSource[] = ['pump_live', 'pump_koth', 'pump_for_you', 'pump_runners', 'gecko_5m', 'gecko_1h'];

/** One coin on a trending list (normalised across sources). */
export interface TrendCoin {
  mint: string;
  symbol: string;
  name: string;
  /** Position on the list (1 = top). */
  rank: number;
  usdMarketCap: number | null;
  /** Live viewers (pump.fun livestream), null = not live / unknown. */
  viewers: number | null;
  live: boolean;
  complete: boolean | null;
  createdMs: number | null;
  kothSinceMs: number | null;
  replyCount: number | null;
  /** pump.fun moderation / agent flags — never buy these. */
  banned: boolean;
  mayhem: boolean;
  /** GeckoTerminal: price change and volume. */
  priceChange5mPct?: number | null;
  priceChange1hPct?: number | null;
  volume1hUsd?: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const ms = (v: unknown): number | null => {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n; // seconds or ms
};

/** Pure: one pump.fun coin row (any feed) → TrendCoin. null if it has no mint. */
export function parsePumpCoin(raw: unknown, rank: number): TrendCoin | null {
  const o = (raw && typeof raw === 'object' && 'coin' in (raw as object) ? (raw as { coin: unknown }).coin : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const mint = str(o.mint);
  if (!mint) return null;
  const mayhem = o.mayhem_state !== undefined && o.mayhem_state !== null && o.mayhem_state !== '' && o.mayhem_state !== false;
  const downrank = num(o.livestream_downrank_score);
  const banUntil = ms(o.livestream_ban_expiry);
  return {
    mint,
    symbol: str(o.symbol),
    name: str(o.name),
    rank,
    usdMarketCap: num(o.usd_market_cap),
    viewers: num(o.num_participants),
    live: o.is_currently_live === true,
    complete: typeof o.complete === 'boolean' ? o.complete : null,
    createdMs: ms(o.created_timestamp),
    kothSinceMs: ms(o.king_of_the_hill_timestamp),
    replyCount: num(o.reply_count),
    banned: o.is_banned === true || (banUntil !== null && banUntil > Date.now()) || (downrank !== null && downrank > 0),
    mayhem,
  };
}

/** Pure: a pump.fun feed response (array, {coins:[…]}, a single coin, or [{coin}]) → TrendCoins. */
export function parsePumpFeed(body: unknown): TrendCoin[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { coins?: unknown }).coins)
      ? (body as { coins: unknown[] }).coins
      : body && typeof body === 'object'
        ? [body]
        : [];
  const out: TrendCoin[] = [];
  list.forEach((x, i) => {
    const c = parsePumpCoin(x, i + 1);
    if (c) out.push(c);
  });
  return out;
}

/** Pure: GeckoTerminal trending_pools → TrendCoins (Solana pump.fun / PumpSwap / Raydium coins). */
export function parseGeckoTrending(body: unknown): TrendCoin[] {
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: TrendCoin[] = [];
  data.forEach((p, i) => {
    const pool = p as { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } }> };
    const id = pool.relationships?.base_token?.data?.id ?? '';
    const mint = id.startsWith('solana_') ? id.slice('solana_'.length) : '';
    if (!mint) return;
    const a = pool.attributes ?? {};
    const pc = (a.price_change_percentage ?? {}) as Record<string, unknown>;
    const vol = (a.volume_usd ?? {}) as Record<string, unknown>;
    const name = str(a.name);
    out.push({
      mint,
      symbol: name.split('/')[0]?.trim() ?? '',
      name,
      rank: out.length + 1,
      usdMarketCap: num(a.market_cap_usd) ?? num(a.fdv_usd),
      viewers: null,
      live: false,
      complete: null,
      createdMs: typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) || null : null,
      kothSinceMs: null,
      replyCount: null,
      banned: false,
      mayhem: false,
      priceChange5mPct: num(pc.m5),
      priceChange1hPct: num(pc.h1),
      volume1hUsd: num(vol.h1),
    });
    void i;
  });
  return out;
}

/** Pure: DexScreener metas/trending → narrative words (lower case). */
export function parseDexMetas(body: unknown, max = 10): string[] {
  const list = Array.isArray(body) ? body : [];
  return list
    .map((m) => str((m as { name?: unknown; slug?: unknown }).name || (m as { slug?: unknown }).slug).toLowerCase().trim())
    .filter((w) => w.length >= 2 && w.length <= 24)
    .slice(0, max);
}

interface Breaker {
  pausedUntil: number;
  fails: number;
  okAt: number | null;
  lastError: string | null;
}

/** Pure: what to do after a response — ok, pause (and for how long), or a counted failure. */
export function breakerAfter(status: number, contentType: string, now: number, resetHeader: string | null): { pauseUntil: number | null; error: string | null } {
  if (status === 403 && !contentType.includes('json')) return { pauseUntil: now + 5 * 60_000, error: 'Cloudflare challenge (403) — paused 5 min' };
  if (status === 429) {
    const r = Number(resetHeader);
    const until = Number.isFinite(r) && r > 0 ? (r > 1e12 ? r : r > 1e9 ? r * 1000 : now + r * 1000) : now + 60_000;
    return { pauseUntil: Math.max(until, now + 10_000), error: 'rate limited (429)' };
  }
  if (status >= 400) return { pauseUntil: null, error: `HTTP ${status}` };
  return { pauseUntil: null, error: null };
}

export class TrendingFeeds {
  private readonly lists = new Map<TrendSource, { coins: TrendCoin[]; at: number }>();
  private readonly breakers = new Map<string, Breaker>();
  private readonly timers: NodeJS.Timeout[] = [];
  private metaWords: string[] = [];
  /** A coin newly appeared on a list (it wasn't on it at the previous poll). */
  onEntry: ((source: TrendSource, coin: TrendCoin) => void) | null = null;

  private cfg() {
    return getConfig().trending ?? DEFAULT_CONFIG.trending;
  }

  start(): void {
    const c = this.cfg();
    if (!c.enabled) return;
    const every = (sec: number, f: () => Promise<void>) => {
      void f();
      const t = setInterval(() => void f(), Math.max(10, sec) * 1000);
      t.unref?.();
      this.timers.push(t);
    };
    if (c.pump.enabled) {
      every(c.pump.liveSec, () => this.pumpFeed('pump_live', `/coins/currently-live?offset=0&limit=60&includeNsfw=false`));
      every(c.pump.kothSec, () => this.pumpFeed('pump_koth', `/coins/king-of-the-hill?includeNsfw=false`));
      every(c.pump.forYouSec, () => this.pumpFeed('pump_for_you', `/coins/for-you?offset=0&limit=48&includeNsfw=false`));
      every(c.pump.runnersSec, () => this.pumpFeed('pump_runners', `/coins/top-runners`));
    }
    if (c.gecko.enabled) {
      every(c.gecko.everySec, () => this.gecko('gecko_5m', '5m'));
      // 1h list offset by half a period so the two calls never land together.
      setTimeout(() => every(c.gecko.everySec, () => this.gecko('gecko_1h', '1h')), (c.gecko.everySec * 1000) / 2).unref?.();
    }
    if (c.dexMetas.enabled) every(c.dexMetas.everySec, () => this.dexMetas());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  list(source: TrendSource): TrendCoin[] {
    return this.lists.get(source)?.coins ?? [];
  }

  /** Narratives DexScreener shows as trending (hot keywords). */
  narratives(): string[] {
    return this.metaWords;
  }

  health(): Array<{ source: string; ok: boolean; coins: number; updatedAt: string | null; pausedUntil: string | null; error: string | null }> {
    const keys = [...TREND_SOURCES, 'dex_metas'];
    return keys.map((k) => {
      const b = this.breakers.get(k);
      const l = this.lists.get(k as TrendSource);
      return {
        source: k,
        ok: !!b?.okAt && (!b.lastError || (b.okAt ?? 0) > Date.now() - 10 * 60_000),
        coins: k === 'dex_metas' ? this.metaWords.length : (l?.coins.length ?? 0),
        updatedAt: b?.okAt ? new Date(b.okAt).toISOString() : null,
        pausedUntil: b && b.pausedUntil > Date.now() ? new Date(b.pausedUntil).toISOString() : null,
        error: b?.lastError ?? null,
      };
    });
  }

  private async fetchJson(key: string, url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
    const b = this.breakers.get(key) ?? { pausedUntil: 0, fails: 0, okAt: null, lastError: null };
    this.breakers.set(key, b);
    const now = Date.now();
    if (b.pausedUntil > now) return null;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8_000) });
      const verdict = breakerAfter(res.status, res.headers.get('content-type') ?? '', now, res.headers.get('x-ratelimit-reset'));
      if (verdict.error) {
        b.fails++;
        b.lastError = verdict.error;
        if (verdict.pauseUntil) b.pausedUntil = verdict.pauseUntil;
        else if (b.fails >= 5) b.pausedUntil = now + 2 * 60_000; // keeps failing → back off a little
        if (b.fails % 10 === 1) log.warn({ source: key, err: verdict.error }, 'trending feed failed');
        return null;
      }
      const body = await res.json();
      b.fails = 0;
      b.okAt = now;
      b.lastError = null;
      return body;
    } catch (err) {
      b.fails++;
      b.lastError = (err as Error).message.slice(0, 120);
      if (b.fails >= 5) b.pausedUntil = now + 2 * 60_000;
      if (b.fails % 10 === 1) log.debug({ source: key, err: b.lastError }, 'trending feed error');
      return null;
    }
  }

  private update(source: TrendSource, coins: TrendCoin[]): void {
    const before = new Set((this.lists.get(source)?.coins ?? []).map((c) => c.mint));
    const first = !this.lists.has(source);
    this.lists.set(source, { coins, at: Date.now() });
    // The first poll after a start is a snapshot, not "new" entries.
    if (first) return;
    for (const c of coins) if (!before.has(c.mint)) this.onEntry?.(source, c);
  }

  private async pumpFeed(source: TrendSource, path: string): Promise<void> {
    const body = await this.fetchJson(source, `${PUMP}${path}`);
    if (body !== null) this.update(source, parsePumpFeed(body));
  }

  private async gecko(source: TrendSource, duration: '5m' | '1h'): Promise<void> {
    const body = await this.fetchJson(source, `${GECKO}/networks/solana/trending_pools?duration=${duration}&page=1`, { accept: 'application/json;version=20230302' });
    if (body !== null) this.update(source, parseGeckoTrending(body));
  }

  private async dexMetas(): Promise<void> {
    const body = await this.fetchJson('dex_metas', `${DEX}/metas/trending/v1`);
    if (body !== null) this.metaWords = parseDexMetas(body, this.cfg().dexMetas.maxWords);
  }
}
