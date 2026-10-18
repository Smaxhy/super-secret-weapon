/**
 * Live market headlines (v12.5): free RSS from ForexLive + FXStreet every 5 minutes, Redis `fx:news`. Each headline is
 * tagged with the currencies it touches and a severity. A HIGH headline (presidential / central-bank remarks, tariffs,
 * war, intervention, emergency, surprise…) pauses NEW auto-bot trades on those currencies for 30 minutes. Keyword
 * based on purpose: cheap, predictable, explainable. Anything it misses is caught by the price-shock check.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('forex-news');
const KEY = 'fx:news';
const FEEDS = ['https://www.forexlive.com/feed/news', 'https://www.fxstreet.com/rss/news'];

export interface Headline {
  t: number;
  title: string;
  link: string;
  source: string;
  ccys: string[];
  severity: 'high' | 'normal';
  why: string | null;
}

const CCY_WORDS: Array<[string, RegExp]> = [
  ['USD', /\b(fed|fomc|powell|trump|white house|treasury|us |u\.s\.|united states|dollar|nfp|non-?farm|payrolls|us cpi|bessent|waller|williams)\b/i],
  ['EUR', /\b(ecb|lagarde|euro ?zone|eurozone|euro\b|germany|german|france|french|italy|eu )\b/i],
  ['GBP', /\b(boe|bank of england|bailey|uk |u\.k\.|britain|british|sterling|pound|reeves)\b/i],
  ['JPY', /\b(boj|bank of japan|ueda|japan|japanese|yen|takaichi|mof )\b/i],
  ['CHF', /\b(snb|swiss|franc|switzerland)\b/i],
  ['AUD', /\b(rba|australia|australian|aussie)\b/i],
  ['NZD', /\b(rbnz|new zealand|kiwi)\b/i],
  ['CAD', /\b(boc|bank of canada|canada|canadian|loonie|carney)\b/i],
  ['XAU', /\b(gold|bullion)\b/i],
];
const HIGH = /\b(breaking|emergency|intervention|intervene|war|attack|missile|invasion|sanction|tariff|surprise|unexpected|shock|resign|default|crash|plunge|soar|speech|speaks|remarks|press conference|testif|rate (cut|hike)|cuts rates|hikes rates|trump|powell|lagarde|ueda|bailey)\b/i;

/** Tag one headline. Pure. */
export function classify(title: string): { ccys: string[]; severity: Headline['severity']; why: string | null } {
  const ccys = CCY_WORDS.filter(([, re]) => re.test(` ${title} `)).map(([c]) => c);
  const m = HIGH.exec(title);
  return { ccys, severity: m && ccys.length ? 'high' : 'normal', why: m ? m[0].toLowerCase() : null };
}

/** Parse RSS 2.0 items. Pure. */
export function parseRss(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  const dec = (x: string) => x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const title = dec(/<title>([\s\S]*?)<\/title>/i.exec(it)?.[1] ?? '');
    const link = dec(/<link>([\s\S]*?)<\/link>/i.exec(it)?.[1] ?? '');
    const t = Date.parse(dec(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(it)?.[1] ?? ''));
    if (!title || !Number.isFinite(t)) continue;
    out.push({ t, title, link, source, ...classify(title) });
  }
  return out;
}

/** Why a NEW trade on `pair` should wait because of a recent big headline. Pure. */
export function headlineBlock(pair: string, now: number, items: readonly Headline[], windowMin = 30): string | null {
  const ccys = pair.startsWith('XA') ? ['USD', 'XAU'] : [pair.slice(0, 3), pair.slice(3, 6)];
  for (const h of items) {
    if (h.severity !== 'high' || now - h.t > windowMin * 60_000 || h.t > now + 60_000) continue;
    if (h.ccys.some((c) => ccys.includes(c))) return `headline (${h.why}): ${h.title.slice(0, 80)}`;
  }
  return null;
}

/** Price shock: the last 15 one-minute bars moved more than `k` × a normal hour. Pure. */
export function priceShock(bars: ReadonlyArray<readonly [number, number, number, number]>, atr1h: number, k = 1.5): boolean {
  if (!(atr1h > 0) || bars.length < 5) return false;
  const last = bars.slice(-15);
  const hi = Math.max(...last.map((b) => b[1]));
  const lo = Math.min(...last.map((b) => b[2]));
  return hi - lo > k * atr1h;
}

export class ForexHeadlines {
  private items: Headline[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly redis: Redis) {}

  async start(): Promise<void> {
    const raw = await this.redis.get(KEY).catch(() => null);
    if (raw) {
      try {
        this.items = JSON.parse(raw) as Headline[];
      } catch {
        // refetch
      }
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5 * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    const fresh: Headline[] = [];
    for (const url of FEEDS) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(15_000) });
        if (res.ok) fresh.push(...parseRss(await res.text(), new URL(url).hostname.replace('www.', '')));
      } catch (err) {
        log.warn({ url, err: (err as Error).message }, 'headline feed failed');
      }
    }
    if (!fresh.length) return;
    const seen = new Set<string>();
    this.items = [...fresh, ...this.items]
      .filter((h) => {
        const k = h.title.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return Date.now() - h.t < 3 * 86_400_000;
      })
      .sort((a, b) => b.t - a.t)
      .slice(0, 300);
    await this.redis.set(KEY, JSON.stringify(this.items)).catch(() => undefined);
  }

  get(): Headline[] {
    return this.items;
  }
  blockFor(pair: string, now = Date.now()): string | null {
    return headlineBlock(pair, now, this.items);
  }
}
