/**
 * Market mood (v10.30, idea from OctoBot; DATA ONLY — it changes no trade). Memecoins tend to do worse while SOL itself is
 * dumping or the whole market is fearful, so every evaluation stores:
 *   mood.solChange1hPct / 4h / 24h — SOL's own move (sampled every 5 min from the SOL/USD price the bot already uses)
 *   mood.fearGreed                  — the crypto Fear & Greed index 0–100 (alternative.me, free, hourly)
 * The learners (win model, rule search, AI coach) see these as features and can find out whether they matter; only
 * then would a rule act on them.
 */
import type { Redis } from 'ioredis';
import { getSolUsd } from '../lib/sol-price';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('market-mood');
const K_SOL = 'mood:sol';
const K_FNG = 'mood:fng';
const KEEP_MS = 26 * 3600_000;

export interface MarketMood {
  solUsd: number | null;
  solChange1hPct: number | null;
  solChange4hPct: number | null;
  solChange24hPct: number | null;
  fearGreed: number | null;
}

let current: MarketMood = { solUsd: null, solChange1hPct: null, solChange4hPct: null, solChange24hPct: null, fearGreed: null };
export const moodNow = (): MarketMood => current;

/** Pure: % change of the latest price vs the sample closest to `agoMs` before it (within ±30% of that span). */
export function changeOver(points: ReadonlyArray<{ t: number; price: number }>, agoMs: number): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const target = last.t - agoMs;
  let best: { t: number; price: number } | null = null;
  for (const p of points) if (p.t <= last.t - agoMs * 0.7 && (!best || Math.abs(p.t - target) < Math.abs(best.t - target))) best = p;
  if (!best || best.price <= 0 || Math.abs(best.t - target) > agoMs * 0.3) return null;
  return Math.round((last.price / best.price - 1) * 1000) / 10;
}

async function sampleSol(redis: Redis): Promise<void> {
  const price = await getSolUsd();
  const now = Date.now();
  if (price && price > 0) {
    await redis.multi().zadd(K_SOL, String(now), `${now}:${price}`).zremrangebyscore(K_SOL, '-inf', String(now - KEEP_MS)).exec();
  }
  const raw = await redis.zrangebyscore(K_SOL, String(now - KEEP_MS), '+inf');
  const points = raw.map((x) => {
    const [t, p] = x.split(':');
    return { t: Number(t), price: Number(p) };
  }).filter((p) => p.t > 0 && p.price > 0);
  current = { ...current, solUsd: price ?? current.solUsd, solChange1hPct: changeOver(points, 3600_000), solChange4hPct: changeOver(points, 4 * 3600_000), solChange24hPct: changeOver(points, 24 * 3600_000) };
}

async function sampleFearGreed(redis: Redis): Promise<void> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<{ value?: string }> };
    const v = Number(j.data?.[0]?.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      current = { ...current, fearGreed: v };
      await redis.set(K_FNG, String(v), 'EX', 6 * 3600);
    }
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'fear & greed fetch failed');
    const stored = Number(await redis.get(K_FNG).catch(() => null));
    if (current.fearGreed === null && Number.isFinite(stored) && stored > 0) current = { ...current, fearGreed: stored };
  }
}

export function startMarketMood(redis: Redis): () => void {
  const a = setInterval(() => void sampleSol(redis).catch(() => undefined), 5 * 60_000);
  const b = setInterval(() => void sampleFearGreed(redis), 60 * 60_000);
  void sampleSol(redis).catch(() => undefined);
  void sampleFearGreed(redis);
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}
