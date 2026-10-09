/**
 * KOL signal — how many known traders (Wallets page, kind KOL) are in a coin.
 *
 * The whale tracker records every KOL buy/sell it sees on the trade stream:
 *   kol:buy:<mint>   sorted set wallet → time of its (latest) buy   (3h)
 *   kol:sell:<mint>  wallet → time it sold (only KOLs that bought)   (3h)
 *   kol:recent       mint → time of the latest KOL buy (for the dashboard list)
 * `kolActivity` reads it back for scoring, the pre-buy rug screen and exits.
 */
import type { Redis } from 'ioredis';

const TTL_SEC = 3 * 3600;
const buyKey = (mint: string) => `kol:buy:${mint}`;
const sellKey = (mint: string) => `kol:sell:${mint}`;
const K_RECENT = 'kol:recent';

export interface KolConfig {
  enabled: boolean;
  windowMin: number;
  minKols: number;
  pointsPerKol: number;
  maxPoints: number;
  dumpMinKols: number;
  dumpWindowMin: number;
  dumpPenalty: number;
  checkCooldownSec: number;
}

/** Wallet → name + weight, kept current by the whale tracker. */
let directory = new Map<string, { name: string; weight: number }>();
export function setKolDirectory(d: Map<string, { name: string; weight: number }>): void {
  directory = d;
}
export function isKol(wallet: string): boolean {
  return directory.has(wallet);
}

export interface KolActivity {
  /** KOLs that bought within the window (newest first). */
  buyers: Array<{ wallet: string; name: string; weight: number }>;
  /** KOLs (that bought) who sold within the dump window. */
  recentSellers: Array<{ wallet: string; name: string }>;
  /** Every KOL that bought this coin (last 3h). */
  everBought: number;
  dumping: boolean;
}

const nameOf = (w: string) => directory.get(w)?.name ?? `${w.slice(0, 4)}…${w.slice(-4)}`;

export async function recordKolTrade(redis: Redis, mint: string, wallet: string, isBuy: boolean, now = Date.now()): Promise<number> {
  if (isBuy) {
    await redis
      .multi()
      .zadd(buyKey(mint), String(now), wallet)
      .expire(buyKey(mint), TTL_SEC)
      .zadd(K_RECENT, String(now), mint)
      .zremrangebyscore(K_RECENT, '-inf', String(now - TTL_SEC * 1000))
      .exec();
    return redis.zcount(buyKey(mint), String(now - 60 * 60_000), '+inf');
  }
  // Only sells by KOLs that bought this coin matter ("the KOLs are leaving").
  if ((await redis.zscore(buyKey(mint), wallet)) === null) return 0;
  await redis.multi().zadd(sellKey(mint), String(now), wallet).expire(sellKey(mint), TTL_SEC).exec();
  return 0;
}

export async function kolActivity(redis: Redis, mint: string, c: Pick<KolConfig, 'windowMin' | 'dumpMinKols' | 'dumpWindowMin'>, now = Date.now()): Promise<KolActivity> {
  const [buys, sells, ever] = await Promise.all([
    redis.zrevrangebyscore(buyKey(mint), '+inf', String(now - c.windowMin * 60_000), 'WITHSCORES'),
    redis.zrevrangebyscore(sellKey(mint), '+inf', String(now - Math.max(c.windowMin, c.dumpWindowMin) * 60_000), 'WITHSCORES'),
    redis.zcard(buyKey(mint)),
  ]);
  const pairs = (flat: string[]) => Array.from({ length: flat.length / 2 }, (_, i) => ({ wallet: flat[i * 2]!, t: Number(flat[i * 2 + 1]) }));
  const soldAt = new Map(pairs(sells).map((x) => [x.wallet, x.t]));
  // Still in = bought in the window and hasn't sold since that buy.
  const buyers = pairs(buys)
    .filter((b) => !((soldAt.get(b.wallet) ?? 0) > b.t))
    .map(({ wallet }) => ({ wallet, name: nameOf(wallet), weight: directory.get(wallet)?.weight ?? 0.5 }));
  const recentSellers = pairs(sells)
    .filter((x) => now - x.t <= c.dumpWindowMin * 60_000)
    .map(({ wallet }) => ({ wallet, name: nameOf(wallet) }));
  return { buyers, recentSellers, everBought: ever, dumping: recentSellers.length >= c.dumpMinKols && recentSellers.length * 2 >= ever };
}

/** Score points for KOL activity (pure). */
export function kolPoints(a: KolActivity | null, c: Pick<KolConfig, 'pointsPerKol' | 'maxPoints' | 'dumpPenalty'>): { points: number; notes: string[] } {
  if (!a) return { points: 0, notes: [] };
  const notes: string[] = [];
  let points = 0;
  if (a.buyers.length) {
    const weighted = a.buyers.reduce((s, b) => s + b.weight, 0);
    points += Math.min(c.maxPoints, c.pointsPerKol * weighted);
    const names = a.buyers.slice(0, 4).map((b) => b.name).join(', ');
    notes.push(`${a.buyers.length} KOL${a.buyers.length > 1 ? 's' : ''} in (${names}${a.buyers.length > 4 ? '…' : ''})`);
  }
  if (a.dumping) {
    points -= c.dumpPenalty;
    notes.push(`KOLs dumping (${a.recentSellers.map((s) => s.name).slice(0, 3).join(', ')} sold)`);
  }
  return { points: Math.round(points * 10) / 10, notes };
}

/** Coins KOLs bought in the last `windowMin` (most KOLs first) — for the dashboard. */
export async function kolBoard(redis: Redis, c: Pick<KolConfig, 'windowMin' | 'dumpMinKols' | 'dumpWindowMin'>, limit = 15, now = Date.now()): Promise<Array<{ mint: string; kols: number; names: string[]; sold: number; lastBuyAt: string }>> {
  const mints = await redis.zrevrangebyscore(K_RECENT, '+inf', String(now - c.windowMin * 60_000), 'WITHSCORES', 'LIMIT', 0, 60);
  const out: Array<{ mint: string; kols: number; names: string[]; sold: number; lastBuyAt: string }> = [];
  for (let i = 0; i < mints.length; i += 2) {
    const mint = mints[i]!;
    const a = await kolActivity(redis, mint, c, now);
    if (!a.buyers.length && !a.recentSellers.length) continue;
    out.push({ mint, kols: a.buyers.length, names: a.buyers.map((b) => b.name), sold: a.recentSellers.length, lastBuyAt: new Date(Number(mints[i + 1])).toISOString() });
  }
  return out.sort((a, b) => b.kols - a.kols).slice(0, limit);
}

export async function resetKolActivity(redis: Redis): Promise<void> {
  await redis.del(K_RECENT);
}
