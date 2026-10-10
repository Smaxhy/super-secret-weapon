/**
 * X (Twitter) check per coin (owner: "also check X communities and X tweets").
 *
 * FREE (always, from the coin's metadata links):
 *   - what the X link is: a profile, a single post, a community, or nothing
 *   - copy-paste links: the same community / post / profile used by other recent launches
 *     (classic scam tell — tracked per handle AND per community / post id)
 *
 * LIVE (needs TWITTER_BEARER_TOKEN, X API pay-per-use — only for coins that are close to a buy,
 * cached per coin, capped by X_DAILY_READS):
 *   - profile: followers, account age, posts
 *   - post: likes / reposts / replies + the author's followers and account age
 *   - community: member count + age
 *   - mentions: recent posts with the coin's CONTRACT ADDRESS (people actually shilling this coin, not the
 *     ticker which matches thousands of others): how many, how many different accounts, the biggest one
 * → score points + notes for the buy explanation, and `x.*` features for the AI coach / autopsy.
 */
import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('x-check');

export interface XLink {
  kind: 'profile' | 'post' | 'community' | 'none';
  handle: string | null;
  /** Post id or community id. */
  id: string | null;
}

/** Pure: what kind of X link this is. */
export function parseXLink(url: string | null | undefined): XLink {
  if (!url) return { kind: 'none', handle: null, id: null };
  const c = /(?:twitter\.com|x\.com)\/i\/communities\/(\d+)/i.exec(url);
  if (c) return { kind: 'community', handle: null, id: c[1]! };
  const p = /(?:twitter\.com|x\.com)\/([^/?#]+)\/status(?:es)?\/(\d+)/i.exec(url);
  if (p) return { kind: 'post', handle: p[1]!.toLowerCase(), id: p[2]! };
  const h = /(?:twitter\.com|x\.com)\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(url);
  if (h && !['i', 'home', 'search', 'intent', 'share'].includes(h[1]!.toLowerCase())) return { kind: 'profile', handle: h[1]!.toLowerCase(), id: null };
  return { kind: 'none', handle: null, id: null };
}

export interface XLive {
  profile?: { followers: number; ageDays: number; posts: number; missing?: boolean } | null;
  post?: { likes: number; reposts: number; replies: number; authorFollowers: number; authorAgeDays: number; ageMin: number; missing?: boolean } | null;
  community?: { members: number; ageDays: number; missing?: boolean } | null;
  mentions?: { posts: number; accounts: number; biggestFollowers: number; reach: number } | null;
}

export interface XVerdict {
  points: number;
  notes: string[];
  /** Flat numbers for the AI coach / autopsy (x.*). */
  features: Record<string, number>;
}

/** Pure: points from the X picture. */
export function xVerdict(link: XLink, reused: number, live: XLive | null): XVerdict {
  let points = 0;
  const notes: string[] = [];
  const f: Record<string, number> = { linkKind: { none: 0, profile: 1, post: 2, community: 3 }[link.kind], reused };
  if (link.kind === 'none') notes.push('no X link');
  if (reused >= 3) {
    points -= 4;
    notes.push(`X link reused by ${reused} other launches (copy-paste)`);
  } else if (reused >= 1) {
    points -= 1;
    notes.push(`X link used by ${reused} other launch${reused > 1 ? 'es' : ''}`);
  }
  const pr = live?.profile;
  if (pr) {
    f.profileFollowers = pr.followers;
    f.profileAgeDays = pr.ageDays;
    if (pr.missing) {
      points -= 4;
      notes.push('X profile does not exist / suspended');
    } else if (pr.followers >= 5_000 && pr.ageDays >= 30) {
      points += 3;
      notes.push(`X profile ${Math.round(pr.followers / 1000)}k followers, ${Math.round(pr.ageDays)} days old`);
    } else if (pr.ageDays < 3 && pr.followers < 100) {
      points -= 2;
      notes.push(`X profile brand new (${pr.followers} followers)`);
    }
  }
  const po = live?.post;
  if (po) {
    f.postLikes = po.likes;
    f.postReposts = po.reposts;
    f.postAuthorFollowers = po.authorFollowers;
    if (po.missing) {
      points -= 2;
      notes.push('linked X post is gone');
    } else {
      const eng = po.likes + 2 * po.reposts + po.replies;
      if (eng >= 300 || po.authorFollowers >= 20_000) {
        points += 3;
        notes.push(`linked X post: ${po.likes} likes, ${po.reposts} reposts (author ${Math.round(po.authorFollowers / 1000)}k)`);
      } else if (eng >= 50) {
        points += 1;
        notes.push(`linked X post: ${po.likes} likes`);
      }
    }
  }
  const cm = live?.community;
  if (cm) {
    f.communityMembers = cm.members;
    f.communityAgeDays = cm.ageDays;
    if (cm.missing) {
      points -= 2;
      notes.push('X community is gone');
    } else if (cm.members >= 500) {
      points += 3;
      notes.push(`X community ${cm.members} members`);
    } else if (cm.members >= 100) {
      points += 1;
      notes.push(`X community ${cm.members} members`);
    } else if (cm.members < 20) {
      points -= 1;
      notes.push(`X community only ${cm.members} members`);
    }
  }
  const mn = live?.mentions;
  if (mn) {
    f.mentionPosts = mn.posts;
    f.mentionAccounts = mn.accounts;
    f.mentionReach = mn.reach;
    if (mn.accounts >= 5) {
      points += 3;
      notes.push(`${mn.accounts} X accounts posted the contract address recently (reach ${Math.round(mn.reach / 1000)}k)`);
    } else if (mn.accounts >= 2) {
      points += 1;
      notes.push(`${mn.accounts} X accounts posted the contract address`);
    }
    if (mn.biggestFollowers >= 10_000) {
      points += 2;
      notes.push(`shared on X by an account with ${Math.round(mn.biggestFollowers / 1000)}k followers`);
    }
  }
  return { points: Math.max(-8, Math.min(10, points)), notes, features: f };
}

const reuseKey = (l: XLink) => (l.kind === 'community' ? `reuse:xc:${l.id}` : l.kind === 'post' ? `reuse:xp:${l.id}` : l.handle ? `reuse:tw:${l.handle}` : null);

/** Remember which X link a launch used (free; called when its metadata is read). */
export async function recordXLink(redis: Redis, mint: string, url: string | null): Promise<void> {
  const k = reuseKey(parseXLink(url));
  if (k) await redis.multi().sadd(k, mint).expire(k, 3 * 86_400).exec();
}

/** How many OTHER launches used this X link (community / post / handle). */
export async function xLinkReuse(redis: Redis, url: string | null): Promise<number> {
  const k = reuseKey(parseXLink(url));
  return k ? Math.max(0, (await redis.scard(k)) - 1) : 0;
}

interface XUser { id: string; created_at?: string; public_metrics?: { followers_count?: number; tweet_count?: number } }

const days = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : 0);

/** Live X lookups for one coin — cached 30 min, capped per day. Never throws (null = unavailable). */
export async function xLive(redis: Redis, mint: string, url: string | null, maxReadsPerDay: number): Promise<XLive | null> {
  if (!env.TWITTER_BEARER_TOKEN) return null;
  const cacheKey = `x:check:${mint}`;
  const hit = await redis.get(cacheKey);
  if (hit) return JSON.parse(hit) as XLive;
  const day = `x:reads:${new Date().toISOString().slice(0, 10)}`;
  // Roughly: profile/community lookup 1 read, a post 1–2, the mention search up to 10.
  const used = Number((await redis.get(day)) ?? 0);
  if (used + 12 > maxReadsPerDay) return null;
  const get = async <T>(path: string, reads: number): Promise<{ status: number; body: T | null }> => {
    await redis.multi().incrby(day, reads).expire(day, 3 * 86_400).exec();
    const res = await fetch(`https://api.x.com/2${path}`, { headers: { Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
  };
  const link = parseXLink(url);
  const out: XLive = {};
  try {
    if (link.kind === 'profile' && link.handle) {
      const r = await get<{ data?: XUser }>(`/users/by/username/${encodeURIComponent(link.handle)}?user.fields=created_at,public_metrics`, 1);
      out.profile = r.body?.data
        ? { followers: r.body.data.public_metrics?.followers_count ?? 0, ageDays: days(r.body.data.created_at), posts: r.body.data.public_metrics?.tweet_count ?? 0 }
        : r.status === 404 || (r.status === 200 && !r.body?.data) ? { followers: 0, ageDays: 0, posts: 0, missing: true } : null;
    } else if (link.kind === 'post' && link.id) {
      const r = await get<{ data?: { created_at?: string; public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number } }; includes?: { users?: XUser[] } }>(
        `/tweets/${link.id}?tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=created_at,public_metrics`,
        2,
      );
      const t = r.body?.data;
      const u = r.body?.includes?.users?.[0];
      out.post = t
        ? { likes: t.public_metrics?.like_count ?? 0, reposts: t.public_metrics?.retweet_count ?? 0, replies: t.public_metrics?.reply_count ?? 0, authorFollowers: u?.public_metrics?.followers_count ?? 0, authorAgeDays: days(u?.created_at), ageMin: days(t.created_at) * 1440 }
        : r.status === 404 || r.status === 200 ? { likes: 0, reposts: 0, replies: 0, authorFollowers: 0, authorAgeDays: 0, ageMin: 0, missing: true } : null;
    } else if (link.kind === 'community' && link.id) {
      const r = await get<{ data?: { member_count?: number; created_at?: string } }>(`/communities/${link.id}?community.fields=member_count,created_at`, 1);
      out.community = r.body?.data ? { members: r.body.data.member_count ?? 0, ageDays: days(r.body.data.created_at) } : r.status === 404 ? { members: 0, ageDays: 0, missing: true } : null;
    }
    // Who is posting the contract address right now (the ticker would match thousands of other coins).
    const s = await get<{ data?: Array<{ author_id?: string }>; includes?: { users?: XUser[] }; meta?: { result_count?: number } }>(
      `/tweets/search/recent?query=${encodeURIComponent(`${mint} -is:retweet`)}&max_results=10&expansions=author_id&user.fields=public_metrics`,
      10,
    );
    if (s.body) {
      const users = s.body.includes?.users ?? [];
      const followers = users.map((u) => u.public_metrics?.followers_count ?? 0);
      out.mentions = { posts: s.body.meta?.result_count ?? s.body.data?.length ?? 0, accounts: new Set((s.body.data ?? []).map((d) => d.author_id)).size, biggestFollowers: Math.max(0, ...followers), reach: followers.reduce((a, b) => a + b, 0) };
    }
  } catch (err) {
    log.debug({ mint, err: (err as Error).message }, 'X lookup failed');
  }
  await redis.set(cacheKey, JSON.stringify(out), 'EX', 30 * 60);
  return out;
}
