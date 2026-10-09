/**
 * Social analyzer — free checks from the token's own metadata file.
 *
 * Every Pump.fun token points to a small JSON file (on IPFS) with its
 * description and optional X / Telegram / website links. Fetching it costs no
 * Helius credits. From it we score:
 *   - socials: does it have an X account, Telegram, website, a description?
 *     Links re-used by several other launches (copy-paste scams) count less.
 *   - narrative: is the story worth anything? Boost / hot-on-X keywords, what
 *     the bot has learned about these words (keyword-learner), metadata quality
 *     (real description, name matches ticker, fresh links), copycats (same
 *     name as many launches this hour) and trend momentum. See narrativeScore().
 *
 * Paid checks (does the X account really exist, followers, mentions,
 * sentiment) come later with the X API — see social-scanner.ts.
 */
import type { Redis } from 'ioredis';
import type { FeatureName } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { keywordScore, keywordStats, tokenize, type KeywordStat } from '../learner/keyword-learner';

const log = moduleLogger('social-analyzer');

const FETCH_TIMEOUT_MS = 6_000;
const REUSE_WINDOW_SECONDS = 7 * 86_400;
/** Gateways tried in order for ipfs links (the one in the URI first). */
const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];

export interface TokenSocials {
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export type SocialFeatures = Pick<Record<FeatureName, number>, 'socials' | 'narrative'>;

export const NEUTRAL_SOCIAL_FEATURES: SocialFeatures = { socials: 0.5, narrative: 0.5 };

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length < 500 ? t : null;
};

/** Pull links out of a metadata JSON blob (Pump.fun and a few other common shapes). Pure. */
export function parseMetadata(json: unknown): TokenSocials {
  const j = (json ?? {}) as Record<string, unknown>;
  const ext = (j.extensions ?? j.properties ?? {}) as Record<string, unknown>;
  return {
    description: clean(j.description),
    twitter: clean(j.twitter ?? ext.twitter ?? j.x),
    telegram: clean(j.telegram ?? ext.telegram),
    website: clean(j.website ?? ext.website),
  };
}

/** "https://x.com/Foo/status/123" → { handle: "foo", isPost: true }. */
export function twitterInfo(url: string | null): { handle: string | null; isPost: boolean; isCommunity: boolean } {
  if (!url) return { handle: null, isPost: false, isCommunity: false };
  const m = /(?:twitter\.com|x\.com)\/([^/?#]+)(\/status\/\d+)?/i.exec(url);
  if (!m) return { handle: null, isPost: false, isCommunity: false };
  const first = m[1]!.toLowerCase();
  if (first === 'i') return { handle: null, isPost: false, isCommunity: /communities/i.test(url) };
  return { handle: first.replace(/^@/, ''), isPost: !!m[2], isCommunity: false };
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** How many OTHER recent launches used this same link. */
export interface ReuseCounts {
  twitter: number;
  website: number;
}

/** Score 0-1 for social presence. Pure — exported for tests. */
export function socialsScore(s: TokenSocials, reuse: ReuseCounts): number {
  const tw = twitterInfo(s.twitter);
  let score = 0;
  // A real profile link is worth most; a link to a single post or a community less.
  if (tw.handle && !tw.isPost) score += 0.4;
  else if (tw.handle || tw.isCommunity) score += 0.25;
  if (s.telegram && /t\.me\//i.test(s.telegram)) score += 0.2;
  const site = domainOf(s.website);
  if (site && !/pump\.fun|x\.com|twitter\.com|t\.me/.test(site)) score += 0.3;
  if (s.description && s.description.length >= 20) score += 0.1;
  // Links copied from other launches are a classic scam tell.
  if (reuse.twitter >= 3 || reuse.website >= 3) score *= 0.3;
  else if (reuse.twitter >= 1 || reuse.website >= 1) score *= 0.7;
  return Math.max(0, Math.min(1, score));
}

/** Keyword match on name + symbol + description. Pure. */
export function keywordCheck(text: string, boost: readonly string[], block: readonly string[]): { blocked: string | null; boosted: string | null } {
  const t = text.toLowerCase();
  const hit = (list: readonly string[]) => list.find((k) => k.trim() && new RegExp(`\\b${k.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) ?? null;
  return { blocked: hit(block), boosted: hit(boost) };
}

// ---------------------------------------------------------------------------
// Narrative quality
// ---------------------------------------------------------------------------

const TREND_WINDOW_MS = 3_600_000;
const TREND_TTL_SECONDS = 2 * 3600;
/** A keyword shared by at least this many launches in the last hour is "trending". */
export const TREND_MIN_LAUNCHES = 3;

/** "Baby $DOGE!!" → "babydoge". Used to spot launches with the same name / ticker. */
export const normalizeId = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 32);

/** 0..1: is the description a real sentence or junk (empty, one emoji, keyboard mash)? Pure. */
export function descriptionQuality(desc: string | null | undefined): number {
  const d = (desc ?? '').trim();
  if (!d) return 0.15;
  const letters = (d.match(/[a-z]/gi) ?? []).length;
  if (letters < 6) return 0.15; // emoji / ticker only
  const words = d.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w));
  if (words.length < 2) return 0.25;
  // Keyboard mash: few vowels, very long "words", one char repeated.
  const alpha = d.replace(/[^a-z]/gi, '').toLowerCase();
  const vowels = (alpha.match(/[aeiouy]/g) ?? []).length / Math.max(1, alpha.length);
  const avgLen = words.reduce((a, w) => a + w.length, 0) / words.length;
  if (vowels < 0.18 || avgLen > 14 || /(.)\1{5,}/.test(alpha)) return 0.2;
  const unique = new Set(words.map((w) => w.toLowerCase())).size / words.length;
  let q = 0.45;
  if (words.length >= 5) q += 0.2;
  if (words.length >= 12) q += 0.15;
  if (unique >= 0.6) q += 0.1;
  if (letters / d.length >= 0.6) q += 0.1;
  return Math.min(1, q);
}

/** 0..1: does the ticker belong to the name (word, initials, prefix)? Pure. */
export function nameSymbolConsistency(name: string, symbol: string): number {
  const n = normalizeId(name);
  const s = normalizeId(symbol);
  if (!n || !s) return 0.3;
  if (n === s || n.includes(s) || s.includes(n)) return 1;
  const initials = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
  if (initials.length >= 2 && (initials === s || s.startsWith(initials))) return 1;
  // Ticker letters appear in order inside the name ("Dogwifhat" → "WIF", "Bonk Inu" → "BNK").
  let i = 0;
  for (const ch of n) if (ch === s[i]) i++;
  if (i === s.length) return 0.8;
  return 0.4;
}

export interface TrendingKeyword {
  word: string;
  /** Launches in the last hour (including this one) whose name/ticker used the word. */
  launches: number;
  /** Learned win rate for the word, null if not enough samples. */
  winRate: number | null;
}

export interface NarrativeInput {
  blocked: string | null;
  boosted: string | null;
  hot: string | null;
  learned: { score: number; n: number; baseRate: number; top: KeywordStat[] } | null;
  /** Metadata quality only counts once the metadata file was fetched. */
  metadata: { description: string | null; socials: number } | null;
  name: string;
  symbol: string;
  /** Other launches in the last hour with the same name or ticker. */
  copycats: number;
  /** This launch was the first of those. */
  firstOfTrend: boolean;
  trending: TrendingKeyword[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Narrative score 0..1 (0.5 = nothing special) with a short human reason. Pure. */
export function narrativeScore(i: NarrativeInput): { score: number; reason: string } {
  if (i.blocked) return { score: 0, reason: `blocked keyword "${i.blocked}"` };
  const parts: Array<{ d: number; why: string }> = [];
  const add = (d: number, why: string) => {
    if (Math.abs(d) >= 0.005) parts.push({ d, why });
  };

  if (i.hot) add(0.25, `hot on X: "${i.hot}"`);
  if (i.boosted && i.boosted !== i.hot) add(0.15, `boost keyword "${i.boosted}"`);

  // (b) What the bot learned about these words, scaled by how much data there is.
  if (i.learned && i.learned.n > 0) {
    const base = Math.max(0.05, i.learned.baseRate);
    const rel = Math.max(-1, Math.min(1, (i.learned.score - base) / base));
    const conf = Math.min(1, i.learned.n / 50);
    const best = i.learned.top[0];
    add(rel * 0.2 * conf, `learned words${best ? ` ("${best.word}")` : ''} win ${pct(i.learned.score)} vs ${pct(base)} avg`);
  }

  // (c) Metadata quality.
  if (i.metadata) {
    const dq = descriptionQuality(i.metadata.description);
    add((dq - 0.5) * 0.2, dq >= 0.7 ? 'real description' : dq <= 0.3 ? 'empty/junk description' : 'short description');
    add((i.metadata.socials - 0.5) * 0.12, i.metadata.socials >= 0.6 ? 'fresh socials' : 'weak/copied socials');
  }
  const cons = nameSymbolConsistency(i.name, i.symbol);
  if (cons < 0.5) add(-0.05, 'ticker does not match name');

  // Copycats vs. first of a trend.
  if (i.firstOfTrend && i.copycats >= 2) add(0.1, `first of a trend (${i.copycats} copies followed)`);
  else if (i.copycats >= 5) add(-0.25, `copycat of ${i.copycats} launches this hour`);
  else if (i.copycats >= 2) add(-0.12, `copycat of ${i.copycats} launches this hour`);

  // (d) Trend momentum: a keyword many launches share right now, and how such coins did.
  const base = i.learned?.baseRate ?? 0.2;
  const trend = [...i.trending].filter((t) => t.launches >= TREND_MIN_LAUNCHES).sort((a, b) => b.launches - a.launches)[0];
  if (trend) {
    if (trend.winRate !== null && trend.winRate > base * 1.15) add(0.1, `"${trend.word}" trending (${trend.launches}/h) and winning`);
    else if (trend.winRate !== null && trend.winRate < base * 0.85) add(-0.06, `"${trend.word}" trending (${trend.launches}/h) but losing`);
    else add(0.03, `"${trend.word}" trending (${trend.launches}/h)`);
  }

  const score = Math.max(0, Math.min(1, 0.5 + parts.reduce((a, p) => a + p.d, 0)));
  const reason =
    parts
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 3)
      .map((p) => p.why)
      .join('; ') || 'neutral narrative';
  return { score: Math.round(score * 1000) / 1000, reason };
}

export interface NarrativeToken {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  metadataFetchedAt: Date | null;
  createdAt?: Date | null;
}

export class SocialAnalyzer {
  constructor(private readonly redis: Redis) {}

  /**
   * Remember a launch's name / ticker / keywords for an hour or two, for
   * copycat and trend detection. Called from fetchAndStore; safe to call again.
   */
  async recordLaunch(mint: string, name: string, symbol: string, createdAtMs = Date.now()): Promise<void> {
    try {
      const p = this.redis.multi();
      const keys = new Set<string>();
      for (const id of [normalizeId(name), normalizeId(symbol)]) if (id.length >= 2) keys.add(`trend:id:${id}`);
      for (const w of tokenize({ name, symbol }).slice(0, 8)) keys.add(`trend:kw:${w}`);
      for (const k of keys) p.zadd(k, createdAtMs, mint).expire(k, TREND_TTL_SECONDS);
      await p.exec();
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, 'failed to record launch');
    }
  }

  /** Copycats (same name/ticker, last hour) and whether this launch came first. */
  async copycats(mint: string, name: string, symbol: string, nowMs = Date.now()): Promise<{ copycats: number; firstOfTrend: boolean }> {
    const ids = [...new Set([normalizeId(name), normalizeId(symbol)].filter((id) => id.length >= 2))];
    let copycats = 0;
    let firstOfTrend = false;
    for (const id of ids) {
      const rows = (await this.redis.zrangebyscore(`trend:id:${id}`, nowMs - TREND_WINDOW_MS, '+inf', 'WITHSCORES', 'LIMIT', 0, 200)) as string[];
      const members = rows.filter((_, j) => j % 2 === 0);
      const others = members.filter((m) => m !== mint).length;
      if (others > copycats) {
        copycats = others;
        firstOfTrend = members[0] === mint;
      }
    }
    return { copycats, firstOfTrend };
  }

  /**
   * Full narrative check for the evaluator: feature value 0..1, a short
   * reason for the buy explanation, and the hard-block keyword (if any).
   */
  async narrative(
    t: NarrativeToken,
    keywords: { boost: readonly string[]; block: readonly string[] },
    hot: readonly string[],
  ): Promise<{ score: number; reason: string; blocked: string | null }> {
    const text = `${t.name} ${t.symbol} ${t.description ?? ''}`;
    const blocked = keywordCheck(text, [], keywords.block).blocked;
    if (blocked) return { score: 0, reason: `blocked keyword "${blocked}"`, blocked };
    const boosted = keywordCheck(text, keywords.boost, []).boosted;
    const hotHit = keywordCheck(text, hot, []).boosted;
    try {
      const kwText = { name: t.name, symbol: t.symbol, description: t.description };
      const nowMs = Date.now();
      const [learned, copy, socials] = await Promise.all([
        keywordScore(this.redis, kwText),
        this.copycats(t.mint, t.name, t.symbol, nowMs),
        t.metadataFetchedAt ? this.reuseCounts(t).then((r) => socialsScore(t, r)) : Promise.resolve(null),
      ]);
      const words = tokenize({ name: t.name, symbol: t.symbol }).slice(0, 8);
      const p = this.redis.multi();
      for (const w of words) p.zcount(`trend:kw:${w}`, nowMs - TREND_WINDOW_MS, '+inf');
      const counts = ((await p.exec()) ?? []).map(([, v]) => Number(v) || 0);
      const stats = await keywordStats(this.redis, words);
      const trending: TrendingKeyword[] = words.map((word, j) => ({ word, launches: counts[j] ?? 0, winRate: stats.get(word)?.winRate ?? null }));
      const r = narrativeScore({
        blocked: null,
        boosted,
        hot: hotHit,
        learned,
        metadata: socials === null ? null : { description: t.description, socials },
        name: t.name,
        symbol: t.symbol,
        copycats: copy.copycats,
        firstOfTrend: copy.firstOfTrend,
        trending,
      });
      return { ...r, blocked: null };
    } catch (err) {
      log.debug({ mint: t.mint, err: (err as Error).message }, 'narrative check failed');
      return { score: hotHit || boosted ? 0.7 : 0.5, reason: hotHit ? `hot on X: "${hotHit}"` : boosted ? `boost keyword "${boosted}"` : 'neutral narrative', blocked: null };
    }
  }

  /** Fetch + store the metadata once per token. Never throws. */
  async fetchAndStore(mint: string, uri: string): Promise<void> {
    const lockKey = `meta:lock:${mint}`;
    if (!(await this.redis.set(lockKey, '1', 'EX', 600, 'NX'))) return; // already in progress / done recently
    const socials = (await this.fetchMetadata(uri)) ?? { description: null, twitter: null, telegram: null, website: null };
    try {
      const row = await prisma.token.update({
        where: { mint },
        data: { ...socials, metadataFetchedAt: new Date() },
        select: { name: true, symbol: true, createdAt: true },
      });
      await this.recordLaunch(mint, row.name, row.symbol, row.createdAt.getTime());
      // Remember which links this launch used, to spot copy-paste reuse.
      const p = this.redis.multi();
      const handle = twitterInfo(socials.twitter).handle;
      if (handle) p.sadd(`reuse:tw:${handle}`, mint).expire(`reuse:tw:${handle}`, REUSE_WINDOW_SECONDS);
      const site = domainOf(socials.website);
      if (site) p.sadd(`reuse:web:${site}`, mint).expire(`reuse:web:${site}`, REUSE_WINDOW_SECONDS);
      await p.exec();
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, 'failed to store metadata');
    }
  }

  async reuseCounts(s: TokenSocials): Promise<ReuseCounts> {
    const handle = twitterInfo(s.twitter).handle;
    const site = domainOf(s.website);
    const [tw, web] = await Promise.all([
      handle ? this.redis.scard(`reuse:tw:${handle}`) : Promise.resolve(0),
      site ? this.redis.scard(`reuse:web:${site}`) : Promise.resolve(0),
    ]);
    // The sets include this token itself.
    return { twitter: Math.max(0, tw - 1), website: Math.max(0, web - 1) };
  }

  private async fetchMetadata(uri: string): Promise<TokenSocials | null> {
    const cid = /\/ipfs\/([^/?#]+)/.exec(uri)?.[1] ?? (uri.startsWith('ipfs://') ? uri.slice(7) : null);
    const urls = cid ? [uri.startsWith('http') ? uri : null, ...IPFS_GATEWAYS.map((g) => g + cid)].filter((u): u is string => !!u) : [uri];
    for (const url of [...new Set(urls)]) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
        if (!res.ok) continue;
        const text = await res.text();
        if (text.length > 200_000) return null;
        return parseMetadata(JSON.parse(text));
      } catch {
        // try the next gateway
      }
    }
    log.debug({ uri }, 'metadata not reachable');
    return null;
  }
}
