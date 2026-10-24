/**
 * Live market headlines (v12.5): free RSS from ForexLive + FXStreet every 5 minutes, Redis `fx:news`. Each headline is
 * tagged with the currencies it touches and a severity. A HIGH headline (presidential / central-bank remarks, tariffs,
 * war, intervention, emergency, surprise…) pauses NEW auto-bot trades on those currencies for 30 minutes. Keyword
 * based on purpose: cheap, predictable, explainable. Anything it misses is caught by the price-shock check.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import { marketTags, mergeWorld, worldAlarms, worldBlock, worldTag, WORLD, type WorldAlarm, type WorldItem } from './world';

const log = moduleLogger('forex-news');
const KEY = 'fx:news';
/** v23 (owner: "trustworthy forex news outlets"): ForexLive + FXStreet since v12.5; DailyFX and Investing.com forex news
 * added. ForexFactory is the calendar feed (calendar.ts). A feed that fails only costs its own items (the others still
 * count); all of them fail → the headline feed shows as failed on Setup → Data feeds. */
const FEEDS = ['https://www.forexlive.com/feed/news', 'https://www.fxstreet.com/rss/news', 'https://www.dailyfx.com/feeds/market-news', 'https://www.investing.com/rss/news_1.rss'];
/** v27.39: the central banks' own press releases → the normal headline list, tagged with the bank's currency; a policy
 * statement / decision / minutes / press conference is a big headline (pauses that currency 30 min like the others). */
export const CB_FEEDS: Array<{ url: string; ccy: string; name: string }> = [
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', ccy: 'USD', name: 'Federal Reserve' },
  { url: 'https://www.ecb.europa.eu/rss/press.html', ccy: 'EUR', name: 'ECB' },
  { url: 'https://www.bankofengland.co.uk/rss/news', ccy: 'GBP', name: 'Bank of England' },
];
const CB_BIG = /\b(fomc|statement|decision|monetary policy|interest rates?|press conference|minutes|rate (cut|hike)|policy rate|emergency)\b/i;
/** v27.39: world / energy news (Fincept Terminal's free list) — kept apart, only world-event headlines (world.ts). */
export const WORLD_FEEDS = [
  'https://www.aljazeera.com/xml/rss/all.xml',
  'http://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.theguardian.com/world/rss',
  'https://www.middleeasteye.net/rss',
  'https://www.france24.com/en/rss',
  'https://rss.dw.com/rdf/rss-en-all',
  'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
  'https://oilprice.com/rss/main',
];
const WORLD_KEY = 'fx:world';
export const WORLD_HIST = 'fx:world:hist';

export interface Headline {
  t: number;
  title: string;
  link: string;
  source: string;
  ccys: string[];
  severity: 'high' | 'normal';
  why: string | null;
  /** v16: big option expiries listed in a ForexLive "FX option expiries" post */
  expiries?: Expiry[];
}

/** v16: one option expiry level (price is pulled toward big ones into the 10:00 New York cut). */
export interface Expiry {
  pair: string;
  level: number;
  /** size in billions of the base currency (null = not stated) */
  sizeBn: number | null;
  /** the cut: 10:00 New York on the post's day */
  cutT: number;
}

/** 10:00 New York on the New York date of `t` (handles summer / winter time). Pure. */
export function nyCutOn(t: number): number {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const base = Date.parse(`${ymd}T00:00:00Z`);
  for (const h of [14, 15]) {
    const c = base + h * 3_600_000;
    const ny = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(c)));
    if (ny === 10) return c;
  }
  return base + 14 * 3_600_000;
}

const PAIR_RE = /\b(EUR|GBP|USD|AUD|NZD|CAD|CHF|XAU)\s*\/\s*(USD|JPY|GBP|CHF|CAD|NZD|AUD|EUR)\b/g;

/** Expiry levels from the text of a ForexLive option-expiries post. Pure. */
export function parseExpiries(text: string, postT: number): Expiry[] {
  const cutT = nyCutOn(postT);
  const out: Expiry[] = [];
  const marks = [...text.matchAll(PAIR_RE)];
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k]!;
    const pair = `${m[1]}${m[2]}`;
    const seg = text.slice(m.index! + m[0].length, k + 1 < marks.length ? marks[k + 1]!.index! : undefined);
    const jpy = pair.endsWith('JPY');
    const numRe = jpy || pair === 'XAUUSD' ? /\b(\d{2,4}\.\d{1,2})\b(\s*\(([^)]*)\))?/g : /\b(\d\.\d{3,5})\b(\s*\(([^)]*)\))?/g;
    for (const n of seg.matchAll(numRe)) {
      const level = Number(n[1]);
      if (!(level > 0)) continue;
      const sz = /(\d+(?:\.\d+)?)\s*(bn|b|billion|m|mn|mln|million)\b/i.exec(n[3] ?? '');
      const sizeBn = sz ? Number(sz[1]) / (/^(m|mn|mln|million)$/i.test(sz[2]!) ? 1000 : 1) : null;
      if (!out.some((e) => e.pair === pair && e.level === level)) out.push({ pair, level, sizeBn, cutT });
    }
  }
  return out;
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
  // v27: US stock indices — a generic stock-market word tags all four, a named index its own
  ['NDX', /\b(nasdaq|ndx|nq|tech stocks|big tech|nvidia|apple|microsoft|wall street|stocks|equities|s&p ?500|earnings)\b/i],
  ['SPX', /\b(s&p|s&p ?500|spx|es futures|wall street|stocks|equities|earnings)\b/i],
  ['DJI', /\b(dow|djia|dow jones|wall street|stocks|equities|earnings)\b/i],
  ['RUT', /\b(russell|small caps?|small-caps?|wall street|stocks|equities)\b/i],
  // v22: coins — a generic crypto word tags all three majors; a named coin its own
  ['BTC', /\b(bitcoin|btc|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin|sec v\.? |etf)\b/i],
  ['ETH', /\b(ether|ethereum|eth|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['SOL', /\b(solana|sol|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['XRP', /\b(ripple|xrp|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['DOGE', /\b(dogecoin|doge|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['ADA', /\b(cardano|ada|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['LINK', /\b(chainlink|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
  ['AVAX', /\b(avalanche|avax|crypto|cryptocurrenc\w*|coinbase|binance|stablecoin)\b/i],
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
    // v27.39: RSS 1.0 (RDF) feeds date items with dc:date instead of pubDate
    const t = Date.parse(dec(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(it)?.[1] ?? /<dc:date>([\s\S]*?)<\/dc:date>/i.exec(it)?.[1] ?? ''));
    if (!title || !Number.isFinite(t)) continue;
    const h: Headline = { t, title, link, source, ...classify(title) };
    // v16: option expiries are listed in the body of these posts
    if (/option expir/i.test(title)) {
      const body = dec(/<content:encoded>([\s\S]*?)<\/content:encoded>/i.exec(it)?.[1] ?? /<description>([\s\S]*?)<\/description>/i.exec(it)?.[1] ?? '');
      const ex = parseExpiries(body, t);
      if (ex.length) h.expiries = ex;
    }
    out.push(h);
  }
  return out;
}

/** Expiries from today's posts whose cut hasn't passed by more than an hour (newest post wins). Pure. */
export function currentExpiries(items: readonly Headline[], now: number): Expiry[] {
  const out: Expiry[] = [];
  for (const h of items) for (const e of h.expiries ?? []) if (now - e.cutT < 3_600_000 && e.cutT - now < 30 * 3_600_000 && !out.some((x) => x.pair === e.pair && x.level === e.level)) out.push(e);
  return out;
}

/** Why a NEW trade on `pair` should wait because of a recent big headline. Pure. */
export function headlineBlock(pair: string, now: number, items: readonly Headline[], windowMin = 30): string | null {
  const ccys = marketTags(pair); // v27.39: DOGE / LINK / AVAX were cut to 3 letters before and never matched
  for (const h of items) {
    if (h.severity !== 'high' || now - h.t > windowMin * 60_000 || h.t > now + 60_000) continue;
    if (h.ccys.some((c) => ccys.includes(c))) return `headline (${h.why}): ${h.title.slice(0, 80)}`;
  }
  return null;
}

/** Price shock: the last 15 one-minute bars moved more than `k` × a normal hour. Pure. */
export function priceShock(bars: ReadonlyArray<readonly [number, number, number, number, number?]>, atr1h: number, k = 1.5): boolean {
  if (!(atr1h > 0) || bars.length < 5) return false;
  const last = bars.slice(-15);
  const hi = Math.max(...last.map((b) => b[1]));
  const lo = Math.min(...last.map((b) => b[2]));
  return hi - lo > k * atr1h;
}

export class ForexHeadlines {
  private items: Headline[] = [];
  /** v27.39 world-event headlines (world.ts) and the alarms they raise */
  private world: WorldItem[] = [];
  private alarms: WorldAlarm[] = [];
  private recorded = new Set<string>();
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
    await this.loadWorld();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5 * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  /** v17.2: the stored headlines only (no fetch, no timer) — for the lab's child process. */
  async loadCached(): Promise<void> {
    try {
      this.items = JSON.parse((await this.redis.get(KEY)) ?? '[]') as Headline[];
    } catch {
      this.items = [];
    }
    await this.loadWorld();
  }
  private async loadWorld(): Promise<void> {
    try {
      this.world = JSON.parse((await this.redis.get(WORLD_KEY).catch(() => null)) ?? '[]') as WorldItem[];
    } catch {
      this.world = [];
    }
    this.alarms = worldAlarms(this.world, Date.now());
    for (const a of this.alarms) this.recorded.add(`${a.kind}:${a.startedAt}`);
  }

  private async fetchFeed(url: string): Promise<string> {
    const res = await fetch(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /** v27.39: central-bank press releases (into the headline list) + world news (world-event headlines only). */
  private async refreshExtra(): Promise<Headline[]> {
    const cb: Headline[] = [];
    const cbErr: string[] = [];
    for (const f of CB_FEEDS) {
      try {
        const got = parseRss(await this.fetchFeed(f.url), f.name);
        if (!got.length) throw new Error('parsed 0 items (feed moved?)');
        for (const h of got) {
          const ccys = [...new Set([f.ccy, ...h.ccys])];
          const big = CB_BIG.exec(h.title);
          cb.push({ ...h, ccys, severity: big ? 'high' : 'normal', why: big ? `${f.name}: ${big[0].toLowerCase()}` : h.why });
        }
      } catch (err) {
        cbErr.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    if (cb.length) feeds.ok('cb-press', { items: cb.length, asOf: Math.max(...cb.map((h) => h.t)) });
    else if (cbErr.length) feeds.fail('cb-press', cbErr.join('; '));
    const fresh: WorldItem[] = [];
    const wErr: string[] = [];
    let read = 0;
    for (const url of WORLD_FEEDS) {
      try {
        const got = parseRss(await this.fetchFeed(url), new URL(url).hostname.replace(/^(www|feeds|rss|news)\./, ''));
        if (!got.length) throw new Error('parsed 0 items (feed moved?)');
        read++;
        for (const h of got) {
          const tag = worldTag(h.title);
          if (tag.kinds.length) fresh.push({ t: h.t, title: h.title, link: h.link, source: h.source, ...tag });
        }
      } catch (err) {
        wErr.push(`${new URL(url).hostname}: ${(err as Error).message}`);
      }
    }
    if (read) feeds.ok('world-news', { items: fresh.length, asOf: fresh.length ? Math.max(...fresh.map((x) => x.t)) : null });
    else if (wErr.length) feeds.fail('world-news', wErr.join('; '));
    if (wErr.length && read) log.warn({ errs: wErr }, 'some world feeds failed');
    const now = Date.now();
    this.world = mergeWorld(fresh, this.world, now);
    this.alarms = worldAlarms(this.world, now);
    await this.redis.set(WORLD_KEY, JSON.stringify(this.world)).catch(() => undefined);
    // every new alarm is recorded once, so the lab can grade the pause later
    for (const a of this.alarms) {
      const k = `${a.kind}:${a.startedAt}`;
      if (this.recorded.has(k)) continue;
      this.recorded.add(k);
      log.info({ kind: a.kind, markets: a.markets, headline: a.headlines[0]?.title }, 'world event alarm');
      await this.redis.multi().lpush(WORLD_HIST, JSON.stringify({ kind: a.kind, startedAt: a.startedAt, critical: a.critical, markets: a.markets, count: a.count, title: a.headlines[a.headlines.length - 1]?.title ?? '' })).ltrim(WORLD_HIST, 0, WORLD.histMax - 1).exec().catch(() => undefined);
    }
    return cb;
  }

  private async refresh(): Promise<void> {
    const fresh: Headline[] = [];
    const errs: string[] = [];
    for (const url of FEEDS) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = parseRss(await res.text(), new URL(url).hostname.replace('www.', ''));
        // v17: a page that parses to nothing means the feed moved — say so instead of going quiet for good
        if (!got.length) throw new Error('parsed 0 items (feed moved?)');
        fresh.push(...got);
      } catch (err) {
        errs.push(`${new URL(url).hostname}: ${(err as Error).message}`);
        log.warn({ url, err: (err as Error).message }, 'headline feed failed');
      }
    }
    fresh.push(...(await this.refreshExtra().catch((err: Error) => (log.warn({ err: err.message }, 'world / central-bank feeds failed'), [] as Headline[]))));
    if (errs.length && !fresh.length) feeds.fail('headlines', errs.join('; '));
    else if (fresh.length) feeds.ok('headlines', { items: fresh.length, asOf: Math.max(...fresh.map((h) => h.t)) });
    if (errs.length && fresh.length) log.warn({ errs }, 'some headline feeds failed');
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
    return headlineBlock(pair, now, this.items) ?? worldBlock(pair, now, this.alarms);
  }
  /** v27.39: world-event headlines (newest first) and the alarms on / ended in the last 6 hours. */
  worldView(now = Date.now()): { alarms: WorldAlarm[]; items: WorldItem[] } {
    return { alarms: worldAlarms(this.world, now), items: this.world.slice(0, 60) };
  }
  /** v16: option expiries whose cut is today and not more than an hour past. */
  expiries(now = Date.now()): Expiry[] {
    return currentExpiries(this.items, now);
  }
}
