/**
 * Swing universe — which BIGGER coins the bot follows for swing trades (v7).
 *
 * Every `swing.refreshSec`:
 *  1. candidates: your watchlist (`swing.watchlist`), coins on the trending tabs that already
 *     migrated (pump.fun runners / for-you / live with complete=true, GeckoTerminal PumpSwap pools),
 *     DexScreener trending pump.fun coins, and our own tracked coins with the most volume that
 *     migrated and grew;
 *  2. live pair data from DexScreener (≤ 30 coins per request): market cap, liquidity, volume,
 *     price changes — and the coin's PumpSwap pair, which must be pump.fun's canonical pool
 *     (lib/pump-pda.ts; a non-canonical pool only while the live self-check hasn't confirmed the
 *     derivation, and only if it clearly dominates);
 *  3. kept: migrated ≥ minAgeMin ago, MC minMarketCapUsd–maxMarketCapUsd, liquidity ≥
 *     minLiquidityUsd, 24 h volume ≥ minVolume24hUsd; ranked (watchlist first, then activity),
 *     the best `maxCoins` are followed LIVE — their pool is adopted, every trade on it flows in;
 *  4. coins that dropped out are let go after `evictAfterMin` (never one we hold);
 *  5. 24 h of 5-min candles per coin from GeckoTerminal (≤ history.maxPerMin calls a minute,
 *     refreshed every history.refreshMin; priced in SOL like our own live prices) → bounce-back
 *     power (evaluator/swing.ts) and the 3-hour high.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { bounceBack, parseGeckoOhlcv, pickPumpSwapPair, type Bar, type BounceStats } from '../evaluator/swing';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { canonicalPumpPool, pdaCheck } from '../lib/pump-pda';
import { WSOL_MINT } from '../lib/pumpfun';
import { getSolUsd } from '../lib/sol-price';
import { breakerAfter, type TrendCoin, type TrendingFeeds, TREND_SOURCES } from './trending-feeds';
import type { DexPair, DexScreener } from './dexscreener';
import { deriveMetrics, type LiveState } from './live-state';
import type { MarketLeaders } from './market-leaders';
import type { TokenRegistry } from './token-registry';
import { normalizeId } from '../evaluator/social-analyzer';
import type { VampGuard } from '../evaluator/vamp-guard';

const log = moduleLogger('swing-universe');
const GECKO = 'https://api.geckoterminal.com/api/v2';
/** Redis SET of coins this module adopted (so a restart can still let them go). */
const K_ADOPTED = 'swing:adopted';

export type SwingSource = 'watchlist' | 'trending' | 'dex' | 'grown';

export interface SwingCoin {
  mint: string;
  symbol: string;
  name: string;
  pool: string | null;
  /** The pool is pump.fun's canonical one (matched the derived address). */
  poolVerified: boolean;
  sources: SwingSource[];
  /** Trending lists it's on right now (pump.fun / GeckoTerminal). */
  trendingLists: string[];
  watchlist: boolean;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volume1hUsd: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  txns24h: number | null;
  migratedAtMs: number | null;
  createdAtMs: number | null;
  /** We started following it for swings (vs tracked since its launch). */
  adopted: boolean;
  /** In the live set right now (its trades flow in). */
  live: boolean;
  firstSeenAt: number;
  lastWantedAt: number;
  dexAt: number;
  /** Why it isn't in the live set (dashboard). */
  out: string | null;
  bounce: BounceStats | null;
  /** Highest high of the last 3 hours (SOL per token, from the history) — where a bigger pullback started. */
  high3hSol: number | null;
  historyAt: number;
  banned: boolean;
  mayhem: boolean;
  /** Top-10 holders (RPC), set by the swing trader. */
  holders: { top10Pct: number; at: number } | null;
  /** Latest decision (swing trader). */
  last: { at: number; score: number; decision: string; why: string } | null;
}

interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  sources: Set<SwingSource>;
  lists: Set<string>;
  createdMs: number | null;
  pool: string | null;
  banned: boolean;
  mayhem: boolean;
}

/** Pure: rank for the live set — watchlist first, then 1h/24h activity, trending, and how it's moving. */
export function swingRank(c: Pick<SwingCoin, 'watchlist' | 'volume1hUsd' | 'volume24hUsd' | 'txns24h' | 'trendingLists' | 'sources' | 'priceChange24hPct'>): number {
  if (c.watchlist) return 1_000 + Math.log10(1 + (c.volume24hUsd ?? 0));
  return (
    Math.log10(1 + (c.volume1hUsd ?? 0)) +
    0.6 * Math.log10(1 + (c.volume24hUsd ?? 0)) +
    0.3 * Math.log10(1 + (c.txns24h ?? 0)) +
    0.5 * c.trendingLists.length +
    (c.sources.includes('grown') ? 0.5 : 0) +
    Math.max(-0.5, Math.min(0.5, (c.priceChange24hPct ?? 0) / 200))
  );
}

/** Pure: why a coin can't be in the live set (null = it can). */
export function swingFilter(c: Pick<SwingCoin, 'pool' | 'marketCapUsd' | 'liquidityUsd' | 'volume24hUsd' | 'migratedAtMs' | 'banned' | 'mayhem'>, cfg: { minMarketCapUsd: number; maxMarketCapUsd: number; minLiquidityUsd: number; minVolume24hUsd: number; minAgeMin: number }, now: number): string | null {
  if (c.banned || c.mayhem) return c.banned ? 'banned on pump.fun' : 'Mayhem-mode coin';
  if (!c.pool) return 'not on PumpSwap (no pump.fun pool found)';
  if (c.marketCapUsd === null) return 'no market data yet';
  if (c.marketCapUsd < cfg.minMarketCapUsd) return `MC under $${cfg.minMarketCapUsd.toLocaleString('en-US')}`;
  if (c.marketCapUsd > cfg.maxMarketCapUsd) return `MC over $${cfg.maxMarketCapUsd.toLocaleString('en-US')}`;
  if (c.liquidityUsd !== null && c.liquidityUsd < cfg.minLiquidityUsd) return `liquidity under $${cfg.minLiquidityUsd.toLocaleString('en-US')}`;
  if (c.volume24hUsd !== null && c.volume24hUsd < cfg.minVolume24hUsd) return `24h volume under $${cfg.minVolume24hUsd.toLocaleString('en-US')}`;
  if (c.migratedAtMs !== null && now - c.migratedAtMs < cfg.minAgeMin * 60_000) return `migrated under ${cfg.minAgeMin} min ago`;
  return null;
}

export class SwingUniverse {
  private readonly coins = new Map<string, SwingCoin>();
  private timer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private running = false;
  private grownAt = 0;
  private restored = false;
  private grown: Array<{ mint: string; volume1h: number }> = [];
  private readonly gecko = { pausedUntil: 0, fails: 0, okAt: 0, lastError: null as string | null, calls: [] as number[] };
  readonly stats = { refreshes: 0, adopted: 0, evicted: 0, historyFetches: 0, vamps: 0, lastRefreshAt: 0, lastError: null as string | null };
  /** Copycat guard: bigger coins become the original for their ticker; copies are dropped (set in index.ts). */
  vamp: VampGuard | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly registry: TokenRegistry,
    private readonly dex: DexScreener | null,
    private readonly trending: TrendingFeeds | null,
    private readonly leaders: MarketLeaders | null,
  ) {}

  private cfg() {
    return getConfig().swing ?? DEFAULT_CONFIG.swing;
  }

  start(): void {
    const c = this.cfg();
    setTimeout(() => void this.refresh(), 20_000).unref?.();
    this.timer = setInterval(() => void this.refresh(), Math.max(20, c.refreshSec) * 1000);
    this.historyTimer = setInterval(() => void this.historyTick(), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
  }

  /** Coins followed live right now (the swing trader checks these). */
  liveCoins(): SwingCoin[] {
    return [...this.coins.values()].filter((c) => c.live);
  }

  get(mint: string): SwingCoin | null {
    return this.coins.get(mint) ?? null;
  }

  /** Dashboard: everything we know, live coins first. */
  snapshot(limit = 60): { coins: SwingCoin[]; stats: SwingUniverse['stats']; pda: typeof pdaCheck; history: { ok: boolean; error: string | null; pausedUntil: string | null } } {
    const list = [...this.coins.values()].sort((a, b) => Number(b.live) - Number(a.live) || Number(b.watchlist) - Number(a.watchlist) || swingRank(b) - swingRank(a)).slice(0, limit);
    return {
      coins: list,
      stats: this.stats,
      pda: pdaCheck,
      history: { ok: this.gecko.okAt > 0 && !this.gecko.lastError, error: this.gecko.lastError, pausedUntil: this.gecko.pausedUntil > Date.now() ? new Date(this.gecko.pausedUntil).toISOString() : null },
    };
  }

  /** Candidates from every source. */
  private async candidates(now: number): Promise<Map<string, Candidate>> {
    const c = this.cfg();
    const out = new Map<string, Candidate>();
    const add = (mint: string, src: SwingSource, x: Partial<Pick<Candidate, 'symbol' | 'name' | 'createdMs' | 'pool' | 'banned' | 'mayhem'>> & { list?: string } = {}) => {
      if (!mint || mint.length < 32 || mint.length > 44) return;
      let e = out.get(mint);
      if (!e) out.set(mint, (e = { mint, symbol: '', name: '', sources: new Set(), lists: new Set(), createdMs: null, pool: null, banned: false, mayhem: false }));
      e.sources.add(src);
      if (x.list) e.lists.add(x.list);
      if (!e.symbol && x.symbol) e.symbol = x.symbol;
      if (!e.name && x.name) e.name = x.name;
      if (!e.createdMs && x.createdMs) e.createdMs = x.createdMs;
      if (!e.pool && x.pool) e.pool = x.pool;
      e.banned ||= !!x.banned;
      e.mayhem ||= !!x.mayhem;
    };
    for (const m of (c.watchlist ?? []).slice(0, c.maxWatchlist)) add(m.trim(), 'watchlist');
    if (this.trending) {
      for (const s of TREND_SOURCES) {
        for (const t of this.trending.list(s) as TrendCoin[]) {
          const migrated = t.complete === true || (s.startsWith('gecko') && !!t.dex && t.dex.includes('pump'));
          if (!migrated) continue;
          if (t.usdMarketCap !== null && t.usdMarketCap < c.minMarketCapUsd * 0.8) continue;
          add(t.mint, 'trending', { symbol: t.symbol, name: t.name, createdMs: s.startsWith('pump') ? t.createdMs : null, pool: t.pool ?? null, banned: t.banned, mayhem: t.mayhem, list: s });
        }
      }
    }
    for (const d of this.dex?.snapshot().trending ?? []) {
      if (d.pump && (d.marketCapUsd ?? 0) >= c.minMarketCapUsd * 0.8) add(d.mint, 'dex', { symbol: d.symbol, name: d.name });
    }
    // Our own coins that grew (top 1h volume among tracked coins; refreshed every 5 min).
    if (this.leaders && now - this.grownAt > 5 * 60_000) {
      this.grownAt = now;
      this.grown = this.leaders.ownTop(40);
    }
    const sol = await getSolUsd();
    for (const g of this.grown) {
      if (!this.liveState.isTracked(g.mint)) continue;
      const view = await this.liveState.read(g.mint);
      if (!view?.complete || view.adopted) continue;
      const mc = sol ? deriveMetrics(view).marketCapSol * sol : null;
      if (mc !== null && mc >= c.minMarketCapUsd) add(g.mint, 'grown', { createdMs: view.createdAtMs });
    }
    // Members stay candidates (their lists come and go between polls).
    for (const m of this.coins.values()) if (m.live) for (const s of m.sources) add(m.mint, s, { symbol: m.symbol, name: m.name });
    return out;
  }

  async refresh(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled || this.running) return;
    this.running = true;
    try {
      if (!this.restored) await this.restoreAdopted(now);
      const cand = await this.candidates(now);
      const watch = new Set((c.watchlist ?? []).map((m) => m.trim()));
      // Live market data (one request per 30 coins, oldest data first).
      const stale = [...cand.keys()].filter((m) => now - (this.coins.get(m)?.dexAt ?? 0) >= Math.max(30, c.refreshSec) * 1000 * 0.9);
      const pairs = this.dex && stale.length ? await this.dex.pairsFor(stale.slice(0, 120)) : [];
      const byMint = new Map<string, DexPair[]>();
      for (const p of pairs) {
        const m = p.baseToken?.address;
        if (!m || p.chainId !== 'solana') continue;
        (byMint.get(m) ?? byMint.set(m, []).get(m)!).push(p);
      }
      const allowUnverified = pdaCheck.match === 0;
      for (const [mint, x] of cand) {
        const prev = this.coins.get(mint);
        const coin: SwingCoin = prev ?? {
          mint, symbol: x.symbol, name: x.name, pool: null, poolVerified: false, sources: [], trendingLists: [], watchlist: false, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, volume1hUsd: null,
          priceChange1hPct: null, priceChange24hPct: null, txns24h: null, migratedAtMs: null, createdAtMs: x.createdMs, adopted: false, live: false, firstSeenAt: now, lastWantedAt: now, dexAt: 0,
          out: null, bounce: null, high3hSol: null, historyAt: 0, banned: false, mayhem: false, holders: null, last: null,
        };
        coin.sources = [...x.sources];
        coin.trendingLists = [...x.lists];
        coin.watchlist = watch.has(mint);
        coin.banned = x.banned;
        coin.mayhem = x.mayhem;
        if (!coin.symbol && x.symbol) coin.symbol = x.symbol;
        if (!coin.name && x.name) coin.name = x.name;
        if (!coin.createdAtMs && x.createdMs) coin.createdAtMs = x.createdMs;
        const canonical = canonicalPumpPool(mint);
        const ps = byMint.get(mint);
        if (ps) {
          const pick = pickPumpSwapPair(ps, canonical, WSOL_MINT);
          if (pick && (pick.verified || allowUnverified)) {
            const p = pick.pair;
            coin.pool = p.pairAddress ?? null;
            coin.poolVerified = pick.verified;
            coin.symbol = p.baseToken?.symbol || coin.symbol;
            coin.name = p.baseToken?.name || coin.name;
            coin.marketCapUsd = p.marketCap ?? p.fdv ?? null;
            coin.liquidityUsd = p.liquidity?.usd ?? null;
            coin.volume24hUsd = p.volume?.h24 ?? null;
            coin.volume1hUsd = p.volume?.h1 ?? null;
            coin.priceChange1hPct = p.priceChange?.h1 ?? null;
            coin.priceChange24hPct = p.priceChange?.h24 ?? null;
            coin.txns24h = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
            coin.migratedAtMs = p.pairCreatedAt ?? coin.migratedAtMs;
          } else if (!coin.pool) coin.pool = null;
          coin.dexAt = now;
        }
        // No DexScreener pair (unreachable / not listed yet): the canonical pool, when a list named it,
        // we already follow the coin, or you put it on the watchlist (live trades then fill in the numbers).
        if (!coin.pool && canonical && (x.pool === canonical || this.liveState.isTracked(mint) || x.sources.has('watchlist'))) {
          coin.pool = canonical;
          coin.poolVerified = true;
        }
        if (x.sources.has('grown') || this.liveState.isTracked(mint)) await this.fillFromLive(coin, now);
        this.coins.set(mint, coin);
      }
      // Rank and pick the live set.
      const ranked = [...cand.keys()].map((m) => this.coins.get(m)!).filter(Boolean);
      for (const coin of ranked) coin.out = swingFilter(coin, c, now);
      await this.dropVamps(ranked, now);
      // Watchlist coins are followed even before market data arrives (their own trades fill it in).
      for (const coin of ranked) if (coin.watchlist && coin.pool && coin.out === 'no market data yet') coin.out = null;
      const ok = ranked.filter((x) => !x.out).sort((a, b) => swingRank(b) - swingRank(a));
      const keep = new Set([...ok.filter((x) => x.watchlist).slice(0, c.maxWatchlist), ...ok.filter((x) => !x.watchlist).slice(0, c.maxCoins)].map((x) => x.mint));
      for (const coin of ok) if (!keep.has(coin.mint)) coin.out = 'not in the top coins right now';
      for (const coin of this.coins.values()) {
        if (keep.has(coin.mint)) {
          coin.lastWantedAt = now;
          if (!coin.live) await this.follow(coin);
          else await this.liveState.keepAlive(coin.mint, now);
        }
      }
      await this.evict(now, keep);
      this.stats.refreshes++;
      this.stats.lastRefreshAt = now;
      this.stats.lastError = null;
    } catch (err) {
      this.stats.lastError = (err as Error).message;
      log.warn({ err: this.stats.lastError }, 'swing universe refresh failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Vamps (copycats): two coins with one ticker → the clearly bigger one is the original, the other
   * is out. Bigger coins are recorded as originals so copies of them are never bought anywhere.
   */
  private async dropVamps(coins: SwingCoin[], now: number): Promise<void> {
    if (!this.vamp) return;
    const vc = getConfig().vamp ?? DEFAULT_CONFIG.vamp;
    const size = (x: SwingCoin) => Math.max(x.marketCapUsd ?? 0, (x.liquidityUsd ?? 0) * 5);
    const byTicker = new Map<string, SwingCoin[]>();
    for (const coin of coins) {
      const k = normalizeId(coin.symbol);
      if (k.length >= vc.minKeyLength) (byTicker.get(k) ?? byTicker.set(k, []).get(k)!).push(coin);
    }
    for (const group of byTicker.values()) {
      if (group.length < 2) continue;
      const top = [...group].sort((a, b) => size(b) - size(a))[0]!;
      for (const x of group) if (x !== top && !x.watchlist) x.out = `vamp: copies $${top.symbol} (a bigger coin with the same ticker)`;
    }
    for (const coin of coins) {
      if ((coin.marketCapUsd ?? 0) >= vc.minOriginalMcUsd && !coin.out?.startsWith('vamp')) await this.vamp.record({ mint: coin.mint, symbol: coin.symbol, name: coin.name, mcUsd: coin.marketCapUsd, why: 'big' }, now);
    }
    for (const coin of coins) {
      if (coin.out?.startsWith('vamp') || coin.watchlist) continue;
      const why = await this.vamp.check(coin.mint, coin.symbol, coin.name, now);
      if (why) coin.out = why;
    }
    this.stats.vamps = coins.filter((x) => x.out?.startsWith('vamp')).length;
  }

  /** After a restart: coins adopted before are live (and evictable) again. */
  private async restoreAdopted(now: number): Promise<void> {
    this.restored = true;
    for (const mint of await this.redis.smembers(K_ADOPTED).catch(() => [] as string[])) {
      if (!this.liveState.isTracked(mint)) {
        await this.redis.srem(K_ADOPTED, mint).catch(() => undefined);
        continue;
      }
      if (this.coins.has(mint)) continue;
      const coin: SwingCoin = {
        mint, symbol: '', name: '', pool: canonicalPumpPool(mint), poolVerified: true, sources: [], trendingLists: [], watchlist: false, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, volume1hUsd: null,
        priceChange1hPct: null, priceChange24hPct: null, txns24h: null, migratedAtMs: null, createdAtMs: null, adopted: true, live: true, firstSeenAt: now, lastWantedAt: now, dexAt: 0,
        out: null, bounce: null, high3hSol: null, historyAt: 0, banned: false, mayhem: false, holders: null, last: null,
      };
      await this.fillFromLive(coin, now);
      this.coins.set(mint, coin);
    }
  }

  /** Our own live numbers (tracked coins): price, MC and liquidity from the pool we follow. */
  private async fillFromLive(coin: SwingCoin, now: number): Promise<void> {
    const view = await this.liveState.read(coin.mint);
    if (!view?.complete) return;
    const sol = await getSolUsd();
    const m = deriveMetrics(view);
    if (sol && m.priceSol > 0 && view.ammTrades > 0) {
      if (coin.marketCapUsd === null || now - coin.dexAt > 5 * 60_000) coin.marketCapUsd = m.marketCapSol * sol;
      if (coin.liquidityUsd === null || now - coin.dexAt > 5 * 60_000) coin.liquidityUsd = 2 * m.liquiditySol * sol;
    }
    coin.migratedAtMs ??= view.migratedAtMs;
    coin.createdAtMs ??= view.createdAtMs;
    coin.adopted = !!view.adopted;
    if (!coin.symbol) {
      const t = await prisma.token.findUnique({ where: { mint: coin.mint }, select: { symbol: true, name: true } }).catch(() => null);
      if (t) {
        coin.symbol = t.symbol;
        coin.name = t.name;
      }
    }
  }

  /** Start following a coin live: adopt its pool (or keep our own tracked coin alive). */
  private async follow(coin: SwingCoin): Promise<void> {
    if (!coin.pool) return;
    try {
      const res = await this.registry.adoptMigrated({ mint: coin.mint, pool: coin.pool, symbol: coin.symbol, name: coin.name, createdAtMs: coin.createdAtMs, migratedAtMs: coin.migratedAtMs });
      coin.live = true;
      if (res === 'adopted') {
        coin.adopted = true;
        this.stats.adopted++;
        await this.redis.sadd(K_ADOPTED, coin.mint).catch(() => undefined);
      }
    } catch (err) {
      log.warn({ mint: coin.mint, err: (err as Error).message }, 'could not follow coin');
    }
  }

  /** Let go of coins that left the universe a while ago (never one we hold; never our own tracked coins' history). */
  private async evict(now: number, keep: Set<string>): Promise<void> {
    const c = this.cfg();
    for (const coin of [...this.coins.values()]) {
      if (keep.has(coin.mint)) continue;
      const gone = now - coin.lastWantedAt >= c.evictAfterMin * 60_000;
      if (coin.live && gone) {
        const open = await prisma.position.count({ where: { mint: coin.mint, status: { in: ['OPEN', 'CLOSING'] } } }).catch(() => 1);
        if (open) continue;
        coin.live = false;
        if (coin.adopted) {
          await this.liveState.forget(coin.mint).catch(() => undefined);
          await this.redis.srem(K_ADOPTED, coin.mint).catch(() => undefined);
          this.stats.evicted++;
        }
      }
      // Forget the record itself after a day out of the universe.
      if (!coin.live && now - coin.lastWantedAt > 24 * 3600_000) this.coins.delete(coin.mint);
    }
  }

  /** Fetch 24 h of 5-min candles for live coins whose history is missing or old (rate-limited). */
  private async historyTick(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled || !c.history.enabled) return;
    if (this.gecko.pausedUntil > now) return;
    this.gecko.calls = this.gecko.calls.filter((t) => now - t < 60_000);
    if (this.gecko.calls.length >= c.history.maxPerMin) return;
    const due = this.liveCoins()
      .filter((x) => x.pool && now - x.historyAt >= c.history.refreshMin * 60_000)
      .sort((a, b) => Number(b.watchlist) - Number(a.watchlist) || a.historyAt - b.historyAt)[0];
    if (!due) return;
    this.gecko.calls.push(now);
    due.historyAt = now;
    const bars = await this.fetchOhlcv(due.pool!, now);
    if (bars.length) {
      due.bounce = bounceBack(bars, { dipPct: c.dipPct, recoverPct: c.recoverPct }, now);
      const recent = bars.filter((b) => now - b.t <= 3 * 3600_000);
      due.high3hSol = recent.length ? Math.max(...recent.map((b) => b.h)) : null;
      this.stats.historyFetches++;
    }
  }

  private async fetchOhlcv(pool: string, now: number): Promise<Bar[]> {
    try {
      const res = await fetch(`${GECKO}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=5&limit=288&currency=token&token=base`, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(8_000) });
      const v = breakerAfter(res.status, res.headers.get('content-type') ?? '', now, res.headers.get('x-ratelimit-reset'));
      if (v.error) {
        this.gecko.fails++;
        this.gecko.lastError = v.error;
        if (v.pauseUntil) this.gecko.pausedUntil = v.pauseUntil;
        else if (this.gecko.fails >= 5) this.gecko.pausedUntil = now + 2 * 60_000;
        return [];
      }
      const bars = parseGeckoOhlcv(await res.json());
      this.gecko.fails = 0;
      this.gecko.okAt = now;
      this.gecko.lastError = null;
      return bars;
    } catch (err) {
      this.gecko.fails++;
      this.gecko.lastError = (err as Error).message.slice(0, 120);
      if (this.gecko.fails >= 5) this.gecko.pausedUntil = now + 2 * 60_000;
      return [];
    }
  }
}
