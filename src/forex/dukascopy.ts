/**
 * v16 Dukascopy history (free bank-grade data, no account, open-source `dukascopy-node`): hourly bid + ask candles for
 * every traded market and strength cross, kept in Redis `fx:bars:dk:<id>` as [t, o, h, l, c, spreadPips] (mid prices,
 * spread at the bar's close). Used for (a) older history in front of Yahoo's 730 days, so the honest test has years
 * more data — FX only: gold / silver trade as futures on Yahoo and a spot history would jump at the seam — and (b) the
 * real spread per UTC hour (`spreads.ts`). First pull goes back `DK.historyDays` in 90-day pieces, then once a day the
 * newest days. Redis `fx:dk:meta` = what was fetched.
 */
import type Redis from 'ioredis';
import { getHistoricalRates } from 'dukascopy-node';
import { moduleLogger } from '../lib/logger';
import { INSTRUMENTS, STRENGTH_PAIRS, instrument, type Bar } from './types';
import { profileFrom, setSpreadProfile } from './spreads';
import { marketClock } from './calendar';
import { feeds } from './feeds';

const log = moduleLogger('forex-dukascopy');
const DAY = 86_400_000;

export const DK = {
  /** how far back the first pull goes */
  historyDays: 1100,
  /** one request covers this many days */
  chunkDays: 90,
  /** spread profile from the newest N days */
  spreadDays: 120,
  /** re-check at most this often */
  refreshHours: 24,
  /** a seam jump bigger than this (fraction of price) → don't stitch the older history on */
  maxSeamGap: 0.004,
  /** pause between requests (be polite to the free service) */
  pauseMs: 300,
  /** one request may take at most this long (the library has no abort) */
  timeoutMs: 45_000,
};
const HOUR = 3_600_000;

export const dkKey = (id: string) => `fx:bars:dk:${id}`;
export const DK_META = 'fx:dk:meta';

export interface DkBar extends Bar {
  /** spread at the close, pips */
  s: number;
}

export interface DkMeta {
  at: number;
  ids: Record<string, { bars: number; firstT: number | null; lastT: number | null; error: string | null }>;
}

type Fetch = (id: string, priceType: 'bid' | 'ask', from: Date, to: Date) => Promise<number[][]>;

/** Reject after `ms` (dukascopy-node has no abort option). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

/**
 * The real fetcher (dukascopy-node, h1 candles). v17: `volumes: true` + `ignoreFlats: true` — the library's flat-candle
 * filter reads the volume column, so with volumes off every weekend / holiday hour came back as a flat filler candle.
 */
const fetchDk: Fetch = (id, priceType, from, to) =>
  withTimeout(
    getHistoricalRates({ instrument: id.toLowerCase() as never, dates: { from, to }, timeframe: 'h1', priceType, format: 'array', volumes: true, ignoreFlats: true, batchSize: 5, pauseBetweenBatchesMs: 800, retryCount: 2, failAfterRetryCount: false }) as unknown as Promise<number[][]>,
    DK.timeoutMs,
    `dukascopy ${id} ${priceType}`,
  );

/** A real trading hour: not a weekend / holiday filler and not still forming. Pure. */
export function liveHour(t: number, now: number | null, barMs = HOUR): boolean {
  if (now !== null && t + barMs > now) return false;
  return marketClock(t + barMs / 2).open;
}
const flatRow = (r: readonly number[]) => r[1] === r[2] && r[2] === r[3] && r[3] === r[4];

const pipOf = (id: string) => instrument(id)?.pip ?? (id.includes('JPY') ? 0.01 : 0.0001);

/**
 * Bid + ask candles → mid bars with the close spread in pips. Dropped (v17): bars missing on either side, bars with no
 * volume on either side, bars flat on both sides (filler), weekend / holiday hours and the still-forming bar (`now`).
 * Pure.
 */
export function midBars(id: string, bid: ReadonlyArray<readonly number[]>, ask: ReadonlyArray<readonly number[]>, now: number | null = null): DkBar[] {
  const pip = pipOf(id);
  const askBy = new Map(ask.map((r) => [r[0]!, r]));
  const out: DkBar[] = [];
  for (const b of bid) {
    const a = askBy.get(b[0]!);
    if (!a) continue;
    if (b[5] === 0 || a[5] === 0) continue;
    if (flatRow(b) && flatRow(a)) continue;
    if (!liveHour(b[0]!, now)) continue;
    const [t, bo, bh, bl, bc] = b as [number, number, number, number, number];
    const [, ao, ah, al, ac] = a as [number, number, number, number, number];
    if (![bo, bh, bl, bc, ao, ah, al, ac].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ t, o: (bo + ao) / 2, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2, s: Math.max(0, (ac - bc) / pip) });
  }
  return out.sort((x, y) => x.t - y.t);
}

const px7 = (x: number) => Number(x.toPrecision(7));

/** Stored rows without the filler / weekend bars older versions saved (pure). */
export function cleanDk(bars: readonly DkBar[]): DkBar[] {
  return bars.filter((b) => !(b.o === b.h && b.h === b.l && b.l === b.c) && liveHour(b.t, null));
}

/** Stored bars; v17: rows saved before the flat-candle fix are cleaned on load and re-saved once. */
export async function loadDk(redis: Redis, id: string): Promise<DkBar[]> {
  const raw = await redis.get(dkKey(id)).catch(() => null);
  if (!raw) return [];
  let bars: DkBar[];
  try {
    bars = (JSON.parse(raw) as number[][]).map(([t, o, h, l, c, s]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, s: s ?? 0 }));
  } catch {
    return [];
  }
  const clean = cleanDk(bars);
  if (clean.length !== bars.length) {
    log.info({ id, removed: bars.length - clean.length }, 'dukascopy: removed flat / weekend filler bars');
    await saveDk(redis, id, clean).catch(() => undefined);
  }
  return clean;
}

async function saveDk(redis: Redis, id: string, bars: readonly DkBar[]): Promise<void> {
  await redis.set(dkKey(id), JSON.stringify(bars.map((b) => [b.t, px7(b.o), px7(b.h), px7(b.l), px7(b.c), Math.round(b.s * 100) / 100])));
}

/** Merge newer bars over older ones by time. Pure. */
export function mergeDk(have: readonly DkBar[], fresh: readonly DkBar[]): DkBar[] {
  const m = new Map(have.map((b) => [b.t, b]));
  for (const b of fresh) m.set(b.t, b);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/**
 * Older Dukascopy history in front of the Yahoo bars (FX only). Stitched only when the seam lines up (the last
 * Dukascopy close before Yahoo's first bar is within `DK.maxSeamGap` of Yahoo's first open). Pure.
 */
export function stitchHistory(id: string, yahoo: readonly Bar[], dk: readonly DkBar[], now: number, days = DK.historyDays): Bar[] {
  if (!yahoo.length || !dk.length || instrument(id)?.kind === 'metal') return [...yahoo];
  const first = yahoo[0]!.t;
  const older = dk.filter((b) => b.t < first && b.t >= now - days * DAY);
  if (!older.length) return [...yahoo];
  const seam = older[older.length - 1]!;
  if (first - seam.t > 4 * DAY) return [...yahoo];
  if (Math.abs(seam.c - yahoo[0]!.o) / yahoo[0]!.o > DK.maxSeamGap) return [...yahoo];
  return [...older.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })), ...yahoo];
}

/** Install the hourly spread profile of every market from its stored Dukascopy bars. */
export async function installSpreadProfiles(redis: Redis, now = Date.now()): Promise<number> {
  let n = 0;
  for (const inst of INSTRUMENTS) {
    const bars = await loadDk(redis, inst.id);
    const recent = bars.filter((b) => b.t >= now - DK.spreadDays * DAY).map((b) => [b.t, b.s] as const);
    const p = profileFrom(recent);
    setSpreadProfile(inst.id, p);
    if (p) n++;
  }
  return n;
}

/**
 * Refresh every market's Dukascopy history (first time: `historyDays` back in pieces; then the newest days), then
 * install the spread profiles. Never throws; one market failing doesn't stop the others.
 */
export async function refreshDukascopy(redis: Redis, now = Date.now(), fetcher: Fetch = fetchDk): Promise<DkMeta> {
  let prev: DkMeta | null = null;
  try {
    prev = JSON.parse((await redis.get(DK_META)) ?? 'null') as DkMeta | null;
  } catch {
    prev = null;
  }
  if (prev && now - prev.at < DK.refreshHours * 3_600_000) {
    await installSpreadProfiles(redis, now);
    return prev;
  }
  const meta: DkMeta = { at: now, ids: {} };
  const ids = [...INSTRUMENTS.map((i) => i.id), ...STRENGTH_PAIRS.map((p) => p.id)];
  for (const id of ids) {
    const have = await loadDk(redis, id);
    const start = have.length ? Math.max(have[have.length - 1]!.t - DAY, now - DK.historyDays * DAY) : now - DK.historyDays * DAY;
    let bars = have;
    let error: string | null = null;
    for (let from = start; from < now; from += DK.chunkDays * DAY) {
      const to = Math.min(now, from + DK.chunkDays * DAY);
      try {
        const [bid, ask] = [await fetcher(id, 'bid', new Date(from), new Date(to)), await fetcher(id, 'ask', new Date(from), new Date(to))];
        bars = mergeDk(bars, midBars(id, bid, ask, now));
      } catch (err) {
        error = (err as Error).message;
        break;
      }
      if (DK.pauseMs > 0) await new Promise((r) => setTimeout(r, DK.pauseMs));
    }
    bars = bars.filter((b) => b.t >= now - (DK.historyDays + 5) * DAY);
    if (bars.length) await saveDk(redis, id, bars);
    meta.ids[id] = { bars: bars.length, firstT: bars[0]?.t ?? null, lastT: bars[bars.length - 1]?.t ?? null, error };
    if (error) log.warn({ id, err: error }, 'dukascopy refresh failed');
  }
  await redis.set(DK_META, JSON.stringify(meta)).catch(() => undefined);
  const errs = Object.entries(meta.ids).filter(([, v]) => v.error);
  const newest = Math.max(0, ...Object.values(meta.ids).map((v) => v.lastT ?? 0)) || null;
  if (errs.length < Object.keys(meta.ids).length) feeds.ok('dk-history', { items: Object.keys(meta.ids).length - errs.length, asOf: newest });
  else feeds.fail('dk-history', errs[0]?.[1].error ?? 'every market failed');
  const profiles = await installSpreadProfiles(redis, now);
  log.info({ markets: Object.keys(meta.ids).length, profiles }, 'dukascopy history refreshed');
  return meta;
}
