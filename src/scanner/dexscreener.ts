/**
 * DexScreener — what the wider market is looking at (free public API, no key).
 *
 *  Trending: every `pollSec` pulls DexScreener's boosted lists (top + latest) and
 *  latest token profiles for Solana, fetches live pair data for those coins
 *  (≤30 per request) and ranks them by recent activity (1h volume, trades,
 *  price change, boosts). DexScreener's own "trending" ranking isn't in the
 *  public API — this is the closest equivalent. Coins we track that newly show
 *  up get checked right away and score a little higher.
 *
 *  DEX paid: /orders/v1/solana/<mint> lists paid orders. An approved
 *  "tokenProfile" order = the team paid for DexScreener's enhanced profile
 *  ("DEX paid"); "communityTakeover" = CTO. Cached (paid 1h, not paid 3 min) and
 *  rate-limited (DexScreener allows 60 req/min on these endpoints).
 */
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('dexscreener');
const BASE = 'https://api.dexscreener.com';
/** Coin lists DexScreener publishes (its own "trending" ranking isn't public). */
const LIST_PATHS = ['/token-boosts/top/v1', '/token-boosts/latest/v1', '/token-profiles/latest/v1', '/community-takeovers/latest/v1', '/ads/latest/v1'];

export interface DexPair {
  chainId: string;
  pairAddress?: string;
  dexId?: string;
  url?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  quoteToken?: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  /** Price in the quote token (SOL for pump.fun pools). */
  priceNative?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  /** usd = both sides; base / quote = whole tokens / SOL in the pool. */
  liquidity?: { usd?: number; base?: number; quote?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  boosts?: { active?: number };
}

export interface TrendingCoin {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  trendScore: number;
  volumeH1Usd: number;
  txnsH1: number;
  priceChangeH1Pct: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  boosts: number;
  url: string | null;
  /** On pump.fun (mint ends in "pump"). */
  pump: boolean;
  /** Last 5 minutes (what pops up right now). */
  volumeM5Usd: number;
  txnsM5: number;
  priceChangeM5Pct: number;
  /** Rank on the 5-minute list (null = not on it). */
  hot5mRank: number | null;
}

export interface DexPaidInfo {
  paid: boolean;
  cto: boolean;
  /** Paid but not approved yet. */
  pending: boolean;
  checkedAt: number;
}

/**
 * Pure: rank pairs by recent activity (one entry per token — its most liquid pair).
 * `window` h1 = the last hour (default), m5 = the last 5 minutes: coins popping up right now
 * (needs real 5-min volume, trades and a rising price; mostly buys).
 */
export function rankTrending(pairs: readonly DexPair[], limit = 30, window: 'h1' | 'm5' = 'h1'): TrendingCoin[] {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (p.chainId !== 'solana' || !mint) continue;
    const cur = best.get(mint);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
  }
  const rows = [...best.entries()].map(([mint, p]) => {
    const vol1h = p.volume?.h1 ?? 0;
    const txns1h = (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0);
    const pc1h = p.priceChange?.h1 ?? 0;
    const boosts = p.boosts?.active ?? 0;
    const vol5m = p.volume?.m5 ?? 0;
    const buys5m = p.txns?.m5?.buys ?? 0;
    const txns5m = buys5m + (p.txns?.m5?.sells ?? 0);
    const pc5m = p.priceChange?.m5 ?? 0;
    const trendScore =
      window === 'm5'
        ? vol5m >= 2_000 && txns5m >= 20 && pc5m > 0 && buys5m >= txns5m * 0.5
          ? Math.log10(1 + vol5m) + 0.8 * Math.log10(1 + txns5m) + Math.min(2, pc5m / 25) + Math.min(boosts, 500) / 500
          : 0
        : Math.log10(1 + vol1h) + 0.8 * Math.log10(1 + txns1h) + Math.max(-0.5, Math.min(2, pc1h / 100)) + Math.min(boosts, 500) / 250;
    return {
      mint,
      symbol: p.baseToken?.symbol ?? '?',
      name: p.baseToken?.name ?? '',
      rank: 0,
      trendScore: Math.round(trendScore * 100) / 100,
      volumeH1Usd: Math.round(vol1h),
      txnsH1: txns1h,
      priceChangeH1Pct: pc1h,
      marketCapUsd: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      boosts,
      url: p.url ?? null,
      pump: mint.endsWith('pump'),
      volumeM5Usd: Math.round(vol5m),
      txnsM5: txns5m,
      priceChangeM5Pct: pc5m,
      hot5mRank: null as number | null,
    };
  });
  return rows
    .filter((r) => (window === 'm5' ? r.trendScore > 0 : r.volumeH1Usd > 0))
    .sort((a, b) => b.trendScore - a.trendScore)
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Pure: the 1-hour list plus the 5-minute list (coins only hot right now are appended). */
export function mergeHot(h1: readonly TrendingCoin[], m5: readonly TrendingCoin[]): TrendingCoin[] {
  const hot = new Map(m5.map((c) => [c.mint, c.rank]));
  const out = h1.map((c) => ({ ...c, hot5mRank: hot.get(c.mint) ?? null }));
  const seen = new Set(out.map((c) => c.mint));
  for (const c of m5) if (!seen.has(c.mint)) out.push({ ...c, rank: out.length + 1, hot5mRank: c.rank });
  return out;
}

/** Pure: read DexScreener's /orders response. */
export function parseOrders(orders: unknown): Omit<DexPaidInfo, 'checkedAt'> {
  const list = Array.isArray(orders) ? (orders as Array<{ type?: string; status?: string }>) : [];
  const has = (type: string, statuses: string[]) => list.some((o) => o.type === type && statuses.includes(String(o.status)));
  return {
    paid: has('tokenProfile', ['approved']),
    cto: has('communityTakeover', ['approved']),
    pending: has('tokenProfile', ['processing', 'on-hold']) && !has('tokenProfile', ['approved']),
  };
}

/**
 * Score points for the DexScreener picture of a coin (shown in the buy explanation). Pure.
 * Paid promotion on a coin under an hour old earns nothing (research: early paid profiles/ads
 * are often the dev marketing before a dump — trendScore() penalises it with bundles).
 */
export function dexPoints(paid: DexPaidInfo | null, trending: TrendingCoin | null, c: { paidPoints: number; ctoPoints: number; trendingPoints: number }, ageSec = Infinity): { points: number; notes: string[] } {
  let points = 0;
  const notes: string[] = [];
  if (paid?.paid && ageSec < 3600) {
    notes.push('DEX paid on a fresh coin (no bonus)');
  } else if (paid?.paid) {
    points += c.paidPoints;
    notes.push('DEX paid');
  } else if (paid?.cto) {
    points += c.ctoPoints;
    notes.push('DexScreener CTO');
  }
  if (trending) {
    // #1 gets the full bonus, #30 a third of it.
    // #1 of either list gets the full bonus, #30 a third of it.
    const rank = Math.min(30, trending.hot5mRank ?? Infinity, trending.rank);
    points += c.trendingPoints * (1 - ((rank - 1) / 29) * (2 / 3));
    notes.push(trending.hot5mRank !== null ? `DexScreener hot right now (5 min #${trending.hot5mRank})` : `DexScreener trending #${trending.rank}`);
  }
  return { points: Math.round(points * 10) / 10, notes };
}

export class DexScreener {
  private timer: NodeJS.Timeout | null = null;
  private trending: TrendingCoin[] = [];
  private byMint = new Map<string, TrendingCoin>();
  private updatedAt = 0;
  private lastError: string | null = null;
  private readonly paid = new Map<string, DexPaidInfo>();
  private readonly inflight = new Set<string>();
  /** Requests to the 60/min endpoints in the current minute. */
  private window = { start: 0, used: 0 };
  /** Requests to /tokens/v1 (allowed 300/min) for other modules (swing universe) — kept ≤ 60/min. */
  private pairWindow = { start: 0, used: 0 };
  /** A tracked coin just entered the trending list. */
  onTrending: ((coin: TrendingCoin) => void) | null = null;

  start(): void {
    const sec = Math.max(30, getConfig().dex.pollSec);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), sec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): { trending: TrendingCoin[]; updatedAt: string | null; error: string | null } {
    return { trending: this.trending, updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null, error: this.lastError };
  }

  trendingInfo(mint: string): TrendingCoin | null {
    return this.byMint.get(mint) ?? null;
  }

  /** Cached DEX-paid status; starts a background check if unknown/expired (returns null meanwhile). */
  paidInfo(mint: string, now = Date.now()): DexPaidInfo | null {
    const c = this.paid.get(mint);
    const ttl = c?.paid || c?.cto ? 3600_000 : 180_000;
    if (c && now - c.checkedAt < ttl) return c;
    if (!this.inflight.has(mint)) void this.checkPaid(mint);
    return c ?? null;
  }

  /** Ask DexScreener now (awaitable — used where a few hundred ms don't matter). */
  async checkPaid(mint: string): Promise<DexPaidInfo | null> {
    if (!getConfig().dex.enabled || !this.take()) return this.paid.get(mint) ?? null;
    this.inflight.add(mint);
    try {
      const orders = await this.get(`/orders/v1/solana/${mint}`);
      const info = { ...parseOrders(orders), checkedAt: Date.now() };
      this.paid.set(mint, info);
      if (this.paid.size > 20_000) this.paid.clear();
      return info;
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, 'DEX paid check failed');
      return this.paid.get(mint) ?? null;
    } finally {
      this.inflight.delete(mint);
    }
  }

  private async refresh(): Promise<void> {
    if (!getConfig().dex.enabled) return;
    try {
      let failed = 0;
      let lastErr = '';
      const lists = await Promise.all(
        LIST_PATHS.map((p) =>
          this.take()
            ? this.get(p).catch((err: Error) => {
                failed++;
                lastErr = err.message;
                return [];
              })
            : Promise.resolve([]),
        ),
      );
      if (failed === LIST_PATHS.length) throw new Error(`can't reach DexScreener: ${lastErr}`);
      const mints = [
        ...new Set(
          lists
            .flat()
            .filter((x): x is { chainId: string; tokenAddress: string } => !!x && typeof x === 'object' && (x as { chainId?: string }).chainId === 'solana')
            .map((x) => x.tokenAddress)
            .filter(Boolean),
        ),
      ].slice(0, 150);
      const pairs: DexPair[] = [];
      for (let i = 0; i < mints.length; i += 30) {
        const res = await this.get(`/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`).catch(() => []);
        if (Array.isArray(res)) pairs.push(...(res as DexPair[]));
      }
      const dc = getConfig().dex;
      const ranked = mergeHot(rankTrending(pairs, dc.trendingSize), rankTrending(pairs, dc.hot5mSize ?? 15, 'm5'));
      const before = this.byMint;
      const hotBefore = new Set(this.trending.filter((c) => c.hot5mRank !== null).map((c) => c.mint));
      this.trending = ranked;
      this.byMint = new Map(ranked.map((c) => [c.mint, c]));
      this.updatedAt = Date.now();
      this.lastError = null;
      // Newly trending, or newly popping on the 5-minute list → check it right away.
      for (const c of ranked) if (!before.has(c.mint) || (c.hot5mRank !== null && !hotBefore.has(c.mint))) this.onTrending?.(c);
      log.debug({ coins: ranked.length }, 'DexScreener trending refreshed');
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn({ err: this.lastError }, 'DexScreener refresh failed');
    }
  }

  /**
   * Live pair data for any coins (≤ 30 per request; e.g. the swing universe). Coins over the
   * per-minute budget or a failed request simply come back without pairs. Never throws.
   */
  async pairsFor(mints: readonly string[], now = Date.now()): Promise<DexPair[]> {
    if (!getConfig().dex.enabled) return [];
    const out: DexPair[] = [];
    const list = [...new Set(mints)];
    for (let i = 0; i < list.length; i += 30) {
      if (now - this.pairWindow.start >= 60_000) this.pairWindow = { start: now, used: 0 };
      if (this.pairWindow.used >= 60) break;
      this.pairWindow.used++;
      try {
        const res = await this.get(`/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`);
        if (Array.isArray(res)) out.push(...(res as DexPair[]));
      } catch (err) {
        log.debug({ err: (err as Error).message }, 'DexScreener pairs request failed');
      }
    }
    return out;
  }

  /** Simple per-minute budget for the 60 req/min endpoints (kept under 45). */
  private take(now = Date.now()): boolean {
    if (now - this.window.start >= 60_000) this.window = { start: now, used: 0 };
    if (this.window.used >= 45) return false;
    this.window.used++;
    return true;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json', 'user-agent': 'solbot/1.0' }, signal: AbortSignal.timeout(8_000) });
    if (res.status === 429) throw new Error('DexScreener rate limit (429)');
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    return res.json();
  }
}
