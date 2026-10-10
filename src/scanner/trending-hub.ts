/**
 * Trending hub — turns the trending tabs (trending-feeds.ts + DexScreener) into signals.
 *
 * Research rules (Oct 2026; tuned later by the labs):
 *  - a coin newly appearing on a list → the bot checks it right away (never a direct buy) and
 *    the chart-strategy lab paper-trades the entry, so we LEARN whether list entries pay;
 *  - +2 points per independent organic list it's on (pump.fun live / for-you / runners / KOTH,
 *    GeckoTerminal 5m / 1h) in the last 10 min, max +6 — paid boosts / ads count 0;
 *  - live-streaming with ≥ 50 viewers and the count rising → +2 (real "eyes on the coin");
 *  - King of the Hill for 5+ min with the curve not moving → −3; KOTH with the curve
 *    accelerating → +3;
 *  - fresh (< 60 min) AND paid (DEX paid / 50+ boosts) AND bundled (> 10%) or insiders →
 *    −8 and half size (dev marketing before a dump); the dev selling on top → no buy;
 *  - banned / downranked / Mayhem-mode coins → never bought.
 */
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { TrendCoin, TrendingFeeds, TrendSource } from './trending-feeds';
import { TREND_SOURCES } from './trending-feeds';

export interface TrendInfo {
  /** Lists it's on right now. */
  sources: TrendSource[];
  /** Organic lists seen in the last 10 min (incl. now). */
  recentSources: TrendSource[];
  viewers: number | null;
  /** Viewers now vs ~5 min ago (null = no history). */
  viewersRising: boolean | null;
  kothMinutes: number | null;
  banned: boolean;
  mayhem: boolean;
  /** Best (lowest) rank across lists now. */
  bestRank: number | null;
}

export interface TrendScoreInput {
  info: TrendInfo | null;
  ageSec: number;
  /** Curve % per minute now (market analyzer). */
  curveVelocity: number;
  dexPaid: boolean;
  boosts: number;
  bundlePct: number;
  insiderFlags: boolean;
  devSoldFraction: number;
}

/** Pure: score points, notes, hard fails and a size factor from the trending picture. */
export function trendScore(i: TrendScoreInput, c: { pointsPerSource: number; maxSourcePoints: number; liveViewers: number }): { points: number; notes: string[]; fails: string[]; sizeFactor: number } {
  const out = { points: 0, notes: [] as string[], fails: [] as string[], sizeFactor: 1 };
  const t = i.info;
  if (t?.banned) out.fails.push('banned / downranked on pump.fun');
  if (t?.mayhem) out.fails.push('Mayhem-mode coin (agent-driven trading)');
  if (t) {
    const n = new Set(t.recentSources).size;
    if (n) {
      out.points += Math.min(c.maxSourcePoints, n * c.pointsPerSource);
      out.notes.push(`trending on ${n} list${n > 1 ? 's' : ''} (${[...new Set(t.recentSources)].join(', ')})`);
    }
    if (t.viewers !== null && t.viewers >= c.liveViewers && t.viewersRising) {
      out.points += 2;
      out.notes.push(`live stream: ${t.viewers} viewers and rising`);
    }
    if (t.kothMinutes !== null && t.kothMinutes >= 5) {
      if (i.curveVelocity <= 0.5) {
        out.points -= 3;
        out.notes.push(`King of the Hill ${Math.round(t.kothMinutes)} min but the curve stalled`);
      } else if (i.curveVelocity >= 3) {
        out.points += 3;
        out.notes.push('King of the Hill with the curve accelerating');
      }
    }
  }
  // Fresh + paid marketing + bundles/insiders = the classic pre-dump setup.
  const paid = i.dexPaid || i.boosts >= 50;
  if (i.ageSec < 3600 && paid && (i.bundlePct > 10 || i.insiderFlags)) {
    if (i.devSoldFraction > 0.05) out.fails.push('fresh coin with paid promotion, bundles and the dev selling');
    else {
      out.points -= 8;
      out.sizeFactor = 0.5;
      out.notes.push('fresh coin with paid promotion and bundles/insiders (−8, half size)');
    }
  }
  out.points = Math.round(out.points * 10) / 10;
  return out;
}

const ORGANIC: TrendSource[] = ['pump_live', 'pump_koth', 'pump_for_you', 'pump_runners', 'gecko_5m', 'gecko_1h'];

export class TrendingHub {
  /** mint → source → last time seen on that list. */
  private readonly seen = new Map<string, Map<TrendSource, number>>();
  /** mint → [time, viewers] samples (last ~15 min). */
  private readonly viewers = new Map<string, Array<[number, number]>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly feeds: TrendingFeeds) {}

  start(): void {
    this.timer = setInterval(() => this.sample(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Record what every list shows now (call after polls; also runs every 30 s). */
  sample(now = Date.now()): void {
    for (const s of TREND_SOURCES) {
      for (const c of this.feeds.list(s)) {
        let m = this.seen.get(c.mint);
        if (!m) this.seen.set(c.mint, (m = new Map()));
        m.set(s, now);
        if (c.viewers !== null) {
          const v = this.viewers.get(c.mint) ?? [];
          if (!v.length || now - v[v.length - 1]![0] >= 20_000) v.push([now, c.viewers]);
          while (v.length && now - v[0]![0] > 15 * 60_000) v.shift();
          this.viewers.set(c.mint, v);
        }
      }
    }
    if (this.seen.size > 20_000) {
      for (const [mint, m] of this.seen) if ([...m.values()].every((t) => now - t > 60 * 60_000)) this.seen.delete(mint);
    }
  }

  /** Everything the lists say about a coin right now (null = on no list recently). */
  info(mint: string, now = Date.now()): TrendInfo | null {
    const m = this.seen.get(mint);
    let current: TrendCoin | null = null;
    const sources: TrendSource[] = [];
    let bestRank: number | null = null;
    for (const s of TREND_SOURCES) {
      const c = this.feeds.list(s).find((x) => x.mint === mint);
      if (!c) continue;
      sources.push(s);
      bestRank = bestRank === null ? c.rank : Math.min(bestRank, c.rank);
      if (!current || (c.viewers !== null && current.viewers === null) || c.kothSinceMs) current = { ...current, ...c, banned: (current?.banned ?? false) || c.banned, mayhem: (current?.mayhem ?? false) || c.mayhem } as TrendCoin;
    }
    const recentSources = m ? ORGANIC.filter((s) => now - (m.get(s) ?? 0) <= 10 * 60_000) : [];
    if (!sources.length && !recentSources.length) return null;
    const v = this.viewers.get(mint) ?? [];
    const old = v.find(([t]) => now - t >= 4 * 60_000);
    const latest = v[v.length - 1];
    return {
      sources,
      recentSources,
      viewers: current?.viewers ?? latest?.[1] ?? null,
      viewersRising: old && latest ? latest[1] > old[1] : null,
      kothMinutes: current?.kothSinceMs ? Math.max(0, (now - current.kothSinceMs) / 60_000) : null,
      banned: current?.banned ?? false,
      mayhem: current?.mayhem ?? false,
      bestRank,
    };
  }

  /** Dashboard: coins on the lists right now, most lists first. */
  snapshot(limit = 40): Array<TrendCoin & { sources: TrendSource[] }> {
    const by = new Map<string, TrendCoin & { sources: TrendSource[] }>();
    for (const s of TREND_SOURCES) {
      for (const c of this.feeds.list(s)) {
        const e = by.get(c.mint);
        if (e) {
          e.sources.push(s);
          e.rank = Math.min(e.rank, c.rank);
          if (c.viewers !== null) e.viewers = c.viewers;
          if (c.usdMarketCap !== null && e.usdMarketCap === null) e.usdMarketCap = c.usdMarketCap;
          if (!e.symbol && c.symbol) e.symbol = c.symbol;
        } else by.set(c.mint, { ...c, sources: [s] });
      }
    }
    return [...by.values()].sort((a, b) => b.sources.length - a.sources.length || a.rank - b.rank).slice(0, limit);
  }

  config() {
    return getConfig().trending ?? DEFAULT_CONFIG.trending;
  }

  /** DexScreener's trending narratives (hot keywords). */
  narratives(): string[] {
    return this.feeds.narratives();
  }

  feedHealth() {
    return this.feeds.health();
  }
}
