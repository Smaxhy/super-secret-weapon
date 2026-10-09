/**
 * "What's working now" — the top coins and the narratives they share.
 *
 * Every `leaders.everyMin` minutes:
 *  - our own leaders: tracked coins with the most trading volume in the last
 *    hour (sampled from the live state every minute),
 *  - plus DexScreener's trending Solana coins,
 *  - their names / tickers / descriptions are split into words; words shared
 *    by ≥ `leaders.minLeaders` leaders become "hot narratives".
 * Hot narratives work like X hot keywords: new coins matching what's running
 * right now score higher on narrative. Shown on the Scanner page.
 */
import { getConfig } from '../config/runtime-config';
import { tokenize } from '../learner/keyword-learner';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { DexScreener } from './dexscreener';
import type { LiveState } from './live-state';

const log = moduleLogger('market-leaders');

export interface Leader {
  mint: string;
  symbol: string;
  name: string;
  source: 'own' | 'dexscreener';
  /** Our leaders: SOL traded in the last hour. DexScreener: 1h volume in USD. */
  volume1h: number;
  priceChangeH1Pct: number | null;
  marketCapUsd: number | null;
}

/** Pure: words shared by at least `minLeaders` leaders (most shared first). */
export function sharedNarratives(texts: ReadonlyArray<{ name: string; symbol: string; description?: string | null }>, minLeaders: number, max: number): Array<{ word: string; leaders: number }> {
  const count = new Map<string, number>();
  for (const t of texts) for (const w of new Set(tokenize(t))) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count.entries()]
    .filter(([, n]) => n >= minLeaders)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word, leaders]) => ({ word, leaders }));
}

/** Pure: coins with the biggest volume added over the last hour (from minute samples). */
export function topByHourVolume(samples: ReadonlyMap<string, ReadonlyArray<{ t: number; v: number }>>, now: number, limit: number): Array<{ mint: string; volume1h: number }> {
  const out: Array<{ mint: string; volume1h: number }> = [];
  for (const [mint, s] of samples) {
    const last = s[s.length - 1];
    if (!last || now - last.t > 5 * 60_000) continue;
    const base = s.find((x) => now - x.t <= 60 * 60_000) ?? s[0]!;
    const v = last.v - base.v;
    if (v > 0) out.push({ mint, volume1h: v });
  }
  return out.sort((a, b) => b.volume1h - a.volume1h).slice(0, limit);
}

export class MarketLeaders {
  private sampleTimer: NodeJS.Timeout | null = null;
  private computeTimer: NodeJS.Timeout | null = null;
  private readonly samples = new Map<string, Array<{ t: number; v: number }>>();
  private leaders: Leader[] = [];
  private narratives: Array<{ word: string; leaders: number }> = [];
  private updatedAt = 0;

  constructor(
    private readonly liveState: LiveState,
    private readonly dex: DexScreener | null,
  ) {}

  start(): void {
    void this.sample();
    this.sampleTimer = setInterval(() => void this.sample(), 60_000);
    const every = Math.max(1, getConfig().leaders?.everyMin ?? 5) * 60_000;
    setTimeout(() => void this.compute(), 90_000).unref?.();
    this.computeTimer = setInterval(() => void this.compute(), every);
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.computeTimer) clearInterval(this.computeTimer);
  }

  /** Hot narrative words right now (feed into narrative scoring). */
  keywords(): string[] {
    return getConfig().leaders?.enabled === false ? [] : this.narratives.map((n) => n.word);
  }

  snapshot(): { leaders: Leader[]; narratives: Array<{ word: string; leaders: number }>; updatedAt: string | null } {
    return { leaders: this.leaders, narratives: this.narratives, updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null };
  }

  private async sample(now = Date.now()): Promise<void> {
    try {
      const active = await this.liveState.activeVolumes();
      for (const a of active) {
        const s = this.samples.get(a.mint) ?? [];
        s.push({ t: now, v: a.volumeSol });
        while (s.length && now - s[0]!.t > 65 * 60_000) s.shift();
        this.samples.set(a.mint, s);
      }
      for (const [m, s] of this.samples) if (!s.length || now - s[s.length - 1]!.t > 65 * 60_000) this.samples.delete(m);
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'leader sampling failed');
    }
  }

  private async compute(now = Date.now()): Promise<void> {
    const c = getConfig().leaders;
    if (c && c.enabled === false) return;
    try {
      const own = topByHourVolume(this.samples, now, c?.topOwn ?? 15);
      const rows = own.length ? await prisma.token.findMany({ where: { mint: { in: own.map((o) => o.mint) } }, select: { mint: true, name: true, symbol: true, description: true } }) : [];
      const byMint = new Map(rows.map((r) => [r.mint, r]));
      const ownLeaders: Leader[] = own.flatMap((o) => {
        const t = byMint.get(o.mint);
        return t ? [{ mint: o.mint, symbol: t.symbol, name: t.name, source: 'own' as const, volume1h: Math.round(o.volume1h * 10) / 10, priceChangeH1Pct: null, marketCapUsd: null }] : [];
      });
      const dexLeaders: Leader[] = (this.dex?.snapshot().trending ?? []).slice(0, 20).map((d) => ({
        mint: d.mint,
        symbol: d.symbol,
        name: d.name,
        source: 'dexscreener' as const,
        volume1h: d.volumeH1Usd,
        priceChangeH1Pct: d.priceChangeH1Pct,
        marketCapUsd: d.marketCapUsd,
      }));
      const seen = new Set<string>();
      this.leaders = [...ownLeaders, ...dexLeaders].filter((l) => (seen.has(l.mint) ? false : (seen.add(l.mint), true)));
      this.narratives = sharedNarratives(
        this.leaders.map((l) => ({ name: l.name, symbol: l.symbol, description: byMint.get(l.mint)?.description ?? null })),
        c?.minLeaders ?? 2,
        c?.maxKeywords ?? 12,
      );
      this.updatedAt = now;
      if (this.narratives.length) log.info({ narratives: this.narratives.map((n) => n.word) }, '🔥 hot narratives among the top coins');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'market leaders update failed');
    }
  }
}
