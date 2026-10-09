/**
 * SOL/USD price for the USD-based entry rules (min volume / market cap).
 *
 * Fetched from Jupiter's price API (CoinGecko as backup), cached for 60s in
 * memory and persisted to Redis so a restart has a price immediately.
 * Returns null only if we've never managed to get a price (or it's > 1h old);
 * the entry rules then fail closed — no trading on an unknown price.
 */
import { moduleLogger } from './logger';
import { redis } from './redis';

const log = moduleLogger('sol-price');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_MS = 60_000;
const MAX_AGE_MS = 60 * 60_000;
const REDIS_KEY = 'price:sol-usd';

let cached: { price: number; at: number } | null = null;
let inflight: Promise<void> | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchPrice(): Promise<number> {
  try {
    const j = (await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`)) as Record<string, { usdPrice?: number }>;
    const p = j[SOL_MINT]?.usdPrice;
    if (p && p > 0) return p;
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'jupiter price failed');
  }
  const j = (await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')) as { solana?: { usd?: number } };
  const p = j.solana?.usd;
  if (!p || p <= 0) throw new Error('no price from coingecko');
  return p;
}

async function refresh(): Promise<void> {
  try {
    const price = await fetchPrice();
    cached = { price, at: Date.now() };
    await redis.set(REDIS_KEY, JSON.stringify(cached));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'SOL price refresh failed — using last known');
    if (!cached) {
      const stored = await redis.get(REDIS_KEY).catch(() => null);
      if (stored) cached = JSON.parse(stored);
    }
  }
}

export async function getSolUsd(): Promise<number | null> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    inflight ??= refresh().finally(() => (inflight = null));
    await inflight;
  }
  return cached && Date.now() - cached.at <= MAX_AGE_MS ? cached.price : null;
}
