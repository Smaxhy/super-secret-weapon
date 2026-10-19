/**
 * Forex candles (v12): Yahoo Finance's free chart API (no key), hourly bars, ~730 days back. Stored per
 * instrument in Redis `fx:bars:<id>` as compact [t,o,h,l,c] rows; refreshed hourly with the last 7 days merged in.
 * The bar still forming is dropped (a strategy may only see closed bars).
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import type { Bar, Instrument } from './types';

const log = moduleLogger('forex-data');
const HOUR = 3_600_000;
export const barsKey = (id: string) => `fx:bars:${id}`;

/** Parse Yahoo's chart JSON into closed hourly bars. Pure (tested). */
export function parseYahoo(json: unknown, now: number, barMs = HOUR): Bar[] {
  const r = (json as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }> } })?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q) return [];
  const out: Bar[] = [];
  for (let k = 0; k < ts.length; k++) {
    const t = Math.floor((ts[k]! * 1000) / barMs) * barMs;
    const o = q.open?.[k];
    const h = q.high?.[k];
    const l = q.low?.[k];
    const c = q.close?.[k];
    if (o == null || h == null || l == null || c == null) continue;
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || h < l) continue;
    if (t + barMs > now) continue; // still forming
    out.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c });
  }
  return mergeBars([], out);
}

/** Merge two bar lists by time (newer wins), sorted, unique. Pure. */
export function mergeBars(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.t, x);
  for (const x of b) m.set(x.t, x);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/** v17: one Yahoo request may take this long (was 20 s: a hung Yahoo stalled the hourly run for ~18 min) */
export const YAHOO_TIMEOUT_MS = 10_000;

async function fetchYahoo(symbol: string, range: string): Promise<unknown> {
  // v17: while Yahoo's breaker is open (3+ failures in a row) don't wait on it at all
  if (!feeds.allow('yahoo')) throw new Error('yahoo paused (it kept failing; retrying in a few minutes)');
  let last: Error | null = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=60m&range=${range}&includePrePost=false`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err as Error;
    }
  }
  throw last ?? new Error('yahoo failed');
}

export async function loadBars(redis: Redis, id: string): Promise<Bar[]> {
  const raw = await redis.get(barsKey(id)).catch(() => null);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as number[][]).map(([t, o, h, l, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! }));
  } catch {
    return [];
  }
}

async function saveBars(redis: Redis, id: string, bars: readonly Bar[]): Promise<void> {
  await redis.set(barsKey(id), JSON.stringify(bars.map((b) => [b.t, b.o, b.h, b.l, b.c])));
}

export interface FeedStatus {
  id: string;
  /** v13: traded market, strength-meter cross, or market-mood input */
  role?: 'traded' | 'strength' | 'mood';
  bars: number;
  firstT: number | null;
  lastT: number | null;
  error: string | null;
  /** v17: new bars this refresh added */
  fresh?: number;
}

/** Refresh one series: a full 730-day pull when we hold little, else the last 7 days merged in. */
export async function refreshSeries(redis: Redis, id: string, yahoo: string, now = Date.now(), minBars = 2_000): Promise<FeedStatus> {
  const have = await loadBars(redis, id);
  const full = have.length < minBars || now - (have[have.length - 1]?.t ?? 0) > 6 * 86_400_000;
  try {
    const fresh = parseYahoo(await fetchYahoo(yahoo, full ? '730d' : '7d'), now);
    const merged = mergeBars(have, fresh).filter((b) => b.t >= now - 740 * 86_400_000);
    if (merged.length) await saveBars(redis, id, merged);
    const prevLast = have[have.length - 1]?.t ?? 0;
    feeds.ok('yahoo-1h', { items: fresh.length, asOf: merged[merged.length - 1]?.t ?? null });
    return { id, bars: merged.length, firstT: merged[0]?.t ?? null, lastT: merged[merged.length - 1]?.t ?? null, error: null, fresh: merged.filter((b) => b.t > prevLast).length };
  } catch (err) {
    // a call skipped by the open breaker is not another failure (the backoff would grow inside one run)
    if (!/^yahoo paused/.test((err as Error).message)) feeds.fail('yahoo-1h', err);
    log.warn({ id, err: (err as Error).message }, 'forex data refresh failed');
    return { id, bars: have.length, firstT: have[0]?.t ?? null, lastT: have[have.length - 1]?.t ?? null, error: (err as Error).message };
  }
}

/** Refresh one traded instrument. */
export function refreshInstrument(redis: Redis, inst: Instrument, now = Date.now()): Promise<FeedStatus> {
  return refreshSeries(redis, inst.id, inst.yahoo, now);
}

// ── v15: 15-minute and 1-minute candles ──

/** Redis key of a fast series (`fx:bars:15m:EURUSD`). */
export const fastBarsKey = (tf: '15m' | '1m', id: string) => `fx:bars:${tf}:${id}`;
const px7 = (x: number) => Number(x.toPrecision(7));

export async function loadFastBars(redis: Redis, tf: '15m' | '1m', id: string): Promise<Bar[]> {
  const raw = await redis.get(fastBarsKey(tf, id)).catch(() => null);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as number[][]).map(([t, o, h, l, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! }));
  } catch {
    return [];
  }
}
export async function saveFastBars(redis: Redis, tf: '15m' | '1m', id: string, bars: readonly Bar[]): Promise<void> {
  await redis.set(fastBarsKey(tf, id), JSON.stringify(bars.map((b) => [b.t, px7(b.o), px7(b.h), px7(b.l), px7(b.c)]))).catch(() => undefined);
}

/**
 * Yahoo chart bars for any interval between two times (`period1` / `period2`, seconds) or a range. Yahoo serves
 * 15-minute bars for the last 60 days and 1-minute bars for the last ~30 days, at most 7 days per 1-minute request.
 */
export async function fetchYahooBars(symbol: string, interval: '1m' | '15m', q: { range: string } | { from: number; to: number }, now = Date.now()): Promise<Bar[]> {
  if (!feeds.allow('yahoo')) throw new Error('yahoo paused (it kept failing; retrying in a few minutes)');
  const barMs = interval === '1m' ? 60_000 : 15 * 60_000;
  const span = 'range' in q ? `range=${q.range}` : `period1=${Math.floor(q.from / 1000)}&period2=${Math.ceil(q.to / 1000)}`;
  let last: Error | null = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&${span}&includePrePost=false`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseYahoo(await res.json(), now, barMs);
    } catch (err) {
      last = err as Error;
    }
  }
  throw last ?? new Error('yahoo failed');
}

/** Keep a fast series to its window: newest `keepMs` of history, at most `maxBars` bars. Pure. */
export function trimBars(bars: readonly Bar[], now: number, keepMs: number, maxBars: number): Bar[] {
  const from = now - keepMs;
  let k = 0;
  while (k < bars.length && bars[k]!.t < from) k++;
  const out = bars.slice(k);
  return out.length > maxBars ? out.slice(out.length - maxBars) : out;
}
