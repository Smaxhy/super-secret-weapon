/**
 * Social analyzer — free checks from the token's own metadata file.
 *
 * Every Pump.fun token points to a small JSON file (on IPFS) with its
 * description and optional X / Telegram / website links. Fetching it costs no
 * Helius credits. From it we score:
 *   - socials: does it have an X account, Telegram, website, a description?
 *     Links re-used by several other launches (copy-paste scams) count less.
 *   - narrative: does the name/description match your boost or block keywords?
 *
 * Paid checks (does the X account really exist, followers, mentions,
 * sentiment) come later with the X API — see social-scanner.ts.
 */
import type { Redis } from 'ioredis';
import type { FeatureName } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

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

export class SocialAnalyzer {
  constructor(private readonly redis: Redis) {}

  /** Fetch + store the metadata once per token. Never throws. */
  async fetchAndStore(mint: string, uri: string): Promise<void> {
    const lockKey = `meta:lock:${mint}`;
    if (!(await this.redis.set(lockKey, '1', 'EX', 600, 'NX'))) return; // already in progress / done recently
    const socials = (await this.fetchMetadata(uri)) ?? { description: null, twitter: null, telegram: null, website: null };
    try {
      await prisma.token.update({ where: { mint }, data: { ...socials, metadataFetchedAt: new Date() } });
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
