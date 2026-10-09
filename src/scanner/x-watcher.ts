/**
 * X (Twitter) watcher — turns posts from accounts you choose (default
 * @elonmusk) into "hot keywords" for a few hours. New tokens whose name,
 * ticker or description match a hot keyword get a narrative boost, and
 * recent matching launches are checked immediately.
 *
 * Needs TWITTER_BEARER_TOKEN (X API, pay-per-use: roughly $0.005 per post
 * read). Polls every `pollSec` asking only for posts newer than the last one
 * seen, so cost stays around a few dollars a month. Without a token this does
 * nothing.
 */
import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('x-watcher');
const HOT_KEY = 'x:hot';
const STOP = new Set(
  (
    'the and for that this with have from your just what will been they them then than when were about there their would could should into more some very only also over like make made good great today tomorrow people thing things really because which while being doing going https http amp ' +
    // generic crypto words would match half of all launches — never "hot"
    'coin coins token tokens solana pump crypto meme memes official launch community'
  ).split(' '),
);

/** keyword → expiry (ms). Refreshed from Redis every poll. */
let hot = new Map<string, number>();
/** Keywords currently hot on X (lower-case). Expired ones drop out even between polls. */
export const hotKeywords = (now = Date.now()): string[] => [...hot].filter(([, until]) => until > now).map(([w]) => w);

/** Words worth matching against token names: hashtags, cashtags, Capitalised words, 4+ letters. Pure. */
export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[#$]([A-Za-z][A-Za-z0-9_]{1,20})/g)) out.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]{3,20})\b/g)) {
    const w = m[1]!.toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  return [...out].slice(0, 15);
}

async function xGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.x.com/2${path}`, { headers: { Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export function startXWatcher(redis: Redis, onHotKeyword: (keyword: string, mints: string[]) => void): NodeJS.Timeout | null {
  if (!env.TWITTER_BEARER_TOKEN) {
    log.info('no TWITTER_BEARER_TOKEN — X keyword watching is off');
    return null;
  }
  const ids = new Map<string, string>();

  const tick = async () => {
    const cfg = getConfig().x;
    try {
      for (const username of cfg.accounts) {
        let id = ids.get(username) ?? (await redis.get(`x:id:${username}`));
        if (!id) {
          id = (await xGet<{ data?: { id: string } }>(`/users/by/username/${encodeURIComponent(username)}`)).data?.id ?? null;
          if (!id) continue;
          await redis.set(`x:id:${username}`, id);
        }
        ids.set(username, id);
        const since = await redis.get(`x:since:${username}`);
        const r = await xGet<{ data?: Array<{ id: string; text: string }>; meta?: { newest_id?: string } }>(
          `/users/${id}/tweets?max_results=5&exclude=retweets,replies${since ? `&since_id=${since}` : ''}`,
        );
        if (r.meta?.newest_id) await redis.set(`x:since:${username}`, r.meta.newest_id);
        for (const post of r.data ?? []) {
          const words = extractKeywords(post.text);
          if (!words.length) continue;
          const until = Date.now() + cfg.hotHours * 3600_000;
          for (const w of words) await redis.zadd(HOT_KEY, until, w);
          log.info({ username, words }, `🐦 @${username} posted — hot keywords: ${words.join(', ')}`);
          void recordEvent({ module: 'x-watcher', type: 'hot_keywords', message: `@${username}: ${words.join(', ')}`, data: { text: post.text.slice(0, 280) } });
          // Tokens launched in the last 30 min that already match → check them now.
          const recent = await prisma.token.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 60_000) } }, select: { mint: true, name: true, symbol: true } });
          for (const w of words) {
            const hits = recent.filter((t) => `${t.name} ${t.symbol}`.toLowerCase().includes(w)).map((t) => t.mint);
            if (hits.length) onHotKeyword(w, hits);
          }
        }
      }
      await redis.zremrangebyscore(HOT_KEY, '-inf', String(Date.now()));
      const rows = await redis.zrange(HOT_KEY, '0', '-1', 'WITHSCORES');
      const next = new Map<string, number>();
      for (let i = 0; i + 1 < rows.length; i += 2) next.set(rows[i]!, Number(rows[i + 1]));
      hot = next;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'X poll failed');
    }
  };
  void tick();
  return setInterval(() => void tick(), Math.max(60, getConfig().x.pollSec) * 1000);
}
