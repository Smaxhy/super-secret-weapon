/**
 * v27.91 Databento (owner: "can I just give you an API key and you do it"): CME futures history for the index / metal
 * markets (Nasdaq NQ, S&P ES, Dow YM, Russell RTY, gold GC, silver SI) from Databento's historical HTTP API
 * (`hist.databento.com/v0`, HTTP basic auth with the key as the user name, dataset GLBX.MDP3, continuous front month by
 * volume `NQ.v.0`). The key is pasted on the dashboard (Setup → "Databento"), tested first, kept in this server's DB as
 * BotConfig `_databento` (never in git, masked on read); `DATABENTO_API_KEY` in the VPS .env also works.
 *
 * Every download is priced first (`metadata.get_cost`, free) and refused past the spend cap (`DATABENTO_MAX_USD`,
 * default $20 of the account's free credit; spent total in `fx:db:meta`). Hourly candles WITH volume are stored in
 * Redis `fx:bars:db:<id>` [t,o,h,l,c,v] (`DATABENTO.historyDays` back, newest piece first, then back-filled), refreshed
 * every 6 h by the main process (`DatabentoSync`, index.ts); the lab (inline or child) only reads the store and puts
 * the older bars in front of Yahoo's (`stitchFutures`) → ~3 years of CME history to test on instead of Yahoo's 2.
 * Display: the card also shows what real order flow (every trade with its buy / sell side) would cost for a year —
 * nothing of that is downloaded without the owner's say-so. Live CME prices need Databento's monthly plan (not wired).
 */
import type { Redis } from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { feeds } from './feeds';
import type { Bar } from './types';

const log = moduleLogger('databento');
const DAY = 86_400_000;
const HOUR = 3_600_000;

export const DATABENTO = {
  base: 'https://hist.databento.com/v0',
  dataset: 'GLBX.MDP3',
  /** our market → Databento continuous symbol (front month by volume, like the contract people trade) */
  symbols: {
    NDXUSD: 'NQ.v.0', SPXUSD: 'ES.v.0', DJIUSD: 'YM.v.0', RUTUSD: 'RTY.v.0', XAUUSD: 'GC.v.0', XAGUSD: 'SI.v.0',
    // v28.14: CME currency futures → older history for the 7 dollar pairs (Yahoo's hourly FX stops at ~2 years;
    // Dukascopy is blocked). Quoted in USD per foreign unit; JPY / CAD / CHF are inverted to the spot quote.
    EURUSD: '6E.v.0', GBPUSD: '6B.v.0', AUDUSD: '6A.v.0', NZDUSD: '6N.v.0', USDJPY: '6J.v.0', USDCAD: '6C.v.0', USDCHF: '6S.v.0',
  } as Record<string, string>,
  /** futures quoted the other way round to our spot pair (1 / price) */
  invert: new Set(['USDJPY', 'USDCAD', 'USDCHF']),
  historyDays: 1100,
  pieceDays: 180,
  everyHours: 6,
  /** v28.15: while any market's history is still filling, a run every hour (each run gets through ~1 piece a minute) */
  catchUpHours: 1,
  /** a run stops starting new downloads after this long */
  budgetMs: 480_000,
  timeoutMs: 120_000,
  /** total USD this bot may spend on history (the account's free credit is $125) */
  maxUsd: Number(process.env.DATABENTO_MAX_USD ?? 20) || 20,
  /** one request priced above this is skipped (something is off — candles cost cents) */
  pieceMaxUsd: 3,
  /** the seam where Databento's older bars meet Yahoo's first one: same contract → within this share of the price */
  maxSeamGap: 0.006,
  /** v28.14: currency futures sit a little off spot (forward points, ≤ ~1.5%) → their older bars are scaled onto spot
   *  at the seam when the two are within this share; a contract roll inside the history is back-adjusted when its
   *  jump is within `maxRollJump` */
  maxSpotGap: 0.03,
  maxRollJump: 0.03,
};
/** a Databento bar with the contract it came from (continuous symbols roll between contracts) */
export type DbBar = Bar & { iid?: number };

export const DB_META = 'fx:db:meta';
export const DB_ROW = '_databento';
export const dbKey = (id: string) => `fx:bars:db:${id}`;

export interface DbMarketMeta {
  first: number | null;
  last: number | null;
  n: number;
  /** the store reaches `historyDays` back, or Databento had nothing older */
  full: boolean;
  error: string | null;
}
export interface DbEstimate {
  what: string;
  usd: number | null;
  error?: string;
}
export interface DbMeta {
  at: number;
  spentUsd: number;
  availEnd: number | null;
  ids: Record<string, DbMarketMeta>;
  error: string | null;
  estimates?: DbEstimate[];
  estimatedAt?: number;
}

// ── key ──
const conf: { key: string; source: 'dashboard' | 'env' | null } = { key: '', source: null };
export function setDatabentoKey(key: string | null): void {
  const env = (process.env.DATABENTO_API_KEY ?? '').trim();
  if (key) Object.assign(conf, { key, source: 'dashboard' as const });
  else Object.assign(conf, { key: env, source: env ? ('env' as const) : null });
}
setDatabentoKey(null);
export const databentoConf = () => ({ ...conf });
export async function loadDatabentoKey(): Promise<void> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: DB_ROW } });
    const v = (row?.value ?? null) as { key?: string } | null;
    if (v?.key) setDatabentoKey(v.key);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'databento key not loaded');
  }
}
export async function saveDatabentoKey(key: string | null): Promise<void> {
  const value = key ? { key, updatedAt: new Date().toISOString() } : { updatedAt: new Date().toISOString() };
  await prisma.botConfig.upsert({ where: { key: DB_ROW }, update: { value }, create: { key: DB_ROW, value } });
  setDatabentoKey(key);
}

// ── HTTP ──
export interface DbResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type DbFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<DbResponse>;

const authOf = (key: string) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
const iso = (t: number) => new Date(t).toISOString();

async function call(key: string, path: string, params: Record<string, string>, method: 'GET' | 'POST', fetcher: DbFetch, timeoutMs = DATABENTO.timeoutMs): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const url = `${DATABENTO.base}/${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
  const res = await fetcher(url, {
    method,
    headers: { authorization: authOf(key), accept: 'application/json, text/csv', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(method === 'POST' ? { body: qs } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Databento ${path}: HTTP ${res.status}${res.status === 401 ? ' (key not accepted)' : res.status === 402 ? ' (no credit left)' : ''} ${errText(body)}`.trim());
  return body;
}
function errText(body: string): string {
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: unknown };
    const d = j.detail ?? j.message;
    return typeof d === 'string' ? `— ${d.slice(0, 200)}` : d ? `— ${JSON.stringify(d).slice(0, 200)}` : '';
  } catch {
    return body ? `— ${body.slice(0, 200)}` : '';
  }
}

/** The key works when Databento lists its datasets with GLBX.MDP3 (CME) among them. Free. */
export async function testDatabentoKey(key: string, fetcher: DbFetch = fetch as never): Promise<{ ok: true; datasets: number } | { ok: false; error: string }> {
  try {
    const body = await call(key, 'metadata.list_datasets', {}, 'GET', fetcher, 20_000);
    const list = JSON.parse(body) as unknown;
    if (!Array.isArray(list)) return { ok: false, error: 'unexpected answer from Databento' };
    if (!list.includes(DATABENTO.dataset)) return { ok: false, error: `the key works but CME (${DATABENTO.dataset}) is not in its datasets` };
    return { ok: true, datasets: list.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The newest moment Databento's history has (`metadata.get_dataset_range`); older API answers used `end_date`. */
export async function availableEnd(key: string, fetcher: DbFetch): Promise<number> {
  const j = JSON.parse(await call(key, 'metadata.get_dataset_range', { dataset: DATABENTO.dataset }, 'GET', fetcher, 20_000)) as { end?: string; end_date?: string };
  const t = Date.parse(j.end ?? j.end_date ?? '');
  if (!Number.isFinite(t)) throw new Error('Databento gave no end date for its CME history');
  return t;
}

const rangeParams = (symbol: string, schema: string, start: number, end: number): Record<string, string> => ({
  dataset: DATABENTO.dataset,
  symbols: symbol,
  schema,
  stype_in: 'continuous',
  stype_out: 'instrument_id',
  start: iso(start),
  end: iso(end),
});

/** USD the download would cost (`metadata.get_cost`, free to ask). */
export async function costOf(key: string, symbol: string, schema: string, start: number, end: number, fetcher: DbFetch): Promise<number> {
  const v = JSON.parse(await call(key, 'metadata.get_cost', rangeParams(symbol, schema, start, end), 'POST', fetcher, 30_000)) as unknown;
  const usd = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(usd)) throw new Error('Databento gave no price for the download');
  return usd;
}

/** A Databento timestamp: nanoseconds since 1970 or ISO with up to 9 decimals. Pure. */
export function parseDbTime(s: string): number {
  const x = s.trim();
  if (/^\d+$/.test(x)) return Number(BigInt(x) / 1_000_000n);
  return Date.parse(x.replace(/\.(\d{1,3})\d*(Z|[+-]\d\d:?\d\d)?$/, (_m, ms: string, z?: string) => `.${ms.padEnd(3, '0')}${z ?? 'Z'}`));
}
/** A price: "21034.25" (pretty) or a fixed-point integer in 1e-9 units. Pure. */
export function parseDbPx(s: string): number {
  const x = s.trim();
  if (/^-?\d+$/.test(x) && x.replace('-', '').length > 12) return Number(x) / 1e9;
  return Number(x);
}

/** Databento OHLCV CSV (header row first) → bars, one per open time (the last row wins at a roll). Pure. */
export function parseOhlcvCsv(csv: string): DbBar[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0]!.split(',').map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const [it, io, ih, il, ic, iv, ii] = ['ts_event', 'open', 'high', 'low', 'close', 'volume', 'instrument_id'].map(col);
  if ([it, io, ih, il, ic].some((i) => i === undefined || i < 0)) throw new Error(`unexpected Databento CSV columns: ${head.join(',')}`);
  const m = new Map<number, DbBar>();
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const t = parseDbTime(f[it!] ?? '');
    const [o, h, l, c] = [io, ih, il, ic].map((i) => parseDbPx(f[i!] ?? ''));
    if (!Number.isFinite(t) || ![o, h, l, c].every((p) => Number.isFinite(p) && p! > 0)) continue;
    const v = iv !== undefined && iv >= 0 ? Number(f[iv]) : NaN;
    const iid = ii !== undefined && ii >= 0 ? Number(f[ii]) : NaN;
    m.set(t, { t, o: o!, h: Math.max(h!, o!, c!), l: Math.min(l!, o!, c!), c: c!, ...(Number.isFinite(v) && v > 0 ? { v } : {}), ...(Number.isFinite(iid) && iid > 0 ? { iid } : {}) });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** Hourly candles of one continuous symbol over [start, end). Costs credit — price it first. */
export async function fetchOhlcv1h(key: string, symbol: string, start: number, end: number, fetcher: DbFetch): Promise<DbBar[]> {
  const body = await call(key, 'timeseries.get_range', { ...rangeParams(symbol, 'ohlcv-1h', start, end), encoding: 'csv', compression: 'none', pretty_px: 'true', pretty_ts: 'true', map_symbols: 'true' }, 'POST', fetcher);
  return parseOhlcvCsv(body);
}

// ── store ──
export async function loadDb(redis: Pick<Redis, 'get'>, id: string, strict = false): Promise<DbBar[]> {
  const raw = strict ? await redis.get(dbKey(id)) : await redis.get(dbKey(id)).catch(() => null);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as number[][]).map(([t, o, h, l, c, v, iid]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, ...(v ? { v } : {}), ...(iid ? { iid } : {}) }));
  } catch {
    return [];
  }
}
export function mergeBars(have: readonly DbBar[], fresh: readonly DbBar[]): DbBar[] {
  const m = new Map(have.map((b) => [b.t, b]));
  for (const b of fresh) m.set(b.t, b);
  return [...m.values()].sort((x, y) => x.t - y.t);
}
async function saveDb(redis: Pick<Redis, 'get' | 'set'>, id: string, fresh: readonly DbBar[], now: number): Promise<DbBar[]> {
  const stored = await loadDb(redis, id, true);
  const bars = mergeBars(stored, fresh).filter((b) => b.t >= now - (DATABENTO.historyDays + 5) * DAY);
  if (bars.length) await redis.set(dbKey(id), JSON.stringify(bars.map((b) => (b.iid ? [b.t, b.o, b.h, b.l, b.c, b.v ?? 0, b.iid] : [b.t, b.o, b.h, b.l, b.c, b.v ?? 0]))));
  return bars;
}
export async function loadDbMeta(redis: Pick<Redis, 'get'>): Promise<DbMeta | null> {
  try {
    const raw = await redis.get(DB_META);
    return raw ? (JSON.parse(raw) as DbMeta) : null;
  } catch {
    return null;
  }
}

/**
 * One refresh (main process): for every market, catch up from its newest bar to Databento's newest hour, then
 * back-fill older pieces until `historyDays` is reached. Every request is priced first; the spend cap and the time
 * budget stop the run (what was fetched is kept). Never throws; the result is saved in `fx:db:meta`.
 */
export async function refreshDatabento(redis: Pick<Redis, 'get' | 'set'>, key: string, now = Date.now(), fetcher: DbFetch = fetch as never, ids: readonly string[] = Object.keys(DATABENTO.symbols)): Promise<DbMeta> {
  const prev = await loadDbMeta(redis);
  const meta: DbMeta = { at: now, spentUsd: prev?.spentUsd ?? 0, availEnd: null, ids: { ...(prev?.ids ?? {}) }, error: null, estimates: prev?.estimates, estimatedAt: prev?.estimatedAt };
  const t0 = Date.now();
  const timeLeft = () => Date.now() - t0 < DATABENTO.budgetMs;
  let bars = 0;
  try {
    const end = Math.floor((await availableEnd(key, fetcher)) / HOUR) * HOUR;
    meta.availEnd = end;
    const from = now - DATABENTO.historyDays * DAY;
    /** price, check the cap, download; false = stop the whole run */
    const piece = async (id: string, symbol: string, a: number, b: number): Promise<DbBar[] | null> => {
      const usd = await costOf(key, symbol, 'ohlcv-1h', a, b, fetcher);
      if (usd > DATABENTO.pieceMaxUsd) throw new Error(`${symbol} ${iso(a).slice(0, 10)}…${iso(b).slice(0, 10)} would cost $${usd.toFixed(2)} — skipped`);
      if (meta.spentUsd + usd > DATABENTO.maxUsd) {
        meta.error = `spend cap reached ($${meta.spentUsd.toFixed(2)} of $${DATABENTO.maxUsd} spent) — raise DATABENTO_MAX_USD to download more`;
        return null;
      }
      const got = await fetchOhlcv1h(key, symbol, a, b, fetcher);
      meta.spentUsd = Math.round((meta.spentUsd + usd) * 10_000) / 10_000;
      bars += got.length;
      log.info({ id, symbol, from: iso(a), to: iso(b), bars: got.length, usd }, 'databento: hourly candles downloaded');
      return got;
    };
    // v28.14: two passes so one slow market can't starve the rest (gold / silver had 0 bars: the run's time budget was
    // always gone by the time it reached them). Pass 1 catches every market up to Databento's newest hour (an empty
    // store starts with its newest piece); pass 2 back-fills, the market with the least history first.
    const stores = new Map<string, DbBar[]>();
    let stop = false;
    for (const id of ids) {
      const symbol = DATABENTO.symbols[id];
      if (!symbol || stop) continue;
      const m: DbMarketMeta = { first: null, last: null, n: 0, full: false, ...(meta.ids[id] ?? {}), error: null };
      meta.ids[id] = m;
      try {
        let stored = await loadDb(redis, id, true);
        const fwdFrom = stored.length ? stored[stored.length - 1]!.t + HOUR : Math.max(from, end - DATABENTO.pieceDays * DAY);
        if (end - fwdFrom >= HOUR && timeLeft()) {
          const got = await piece(id, symbol, fwdFrom, end);
          if (got === null) stop = true;
          else stored = await saveDb(redis, id, got, now);
        }
        stores.set(id, stored);
        Object.assign(m, { first: stored[0]?.t ?? null, last: stored[stored.length - 1]?.t ?? null, n: stored.length });
      } catch (err) {
        m.error = (err as Error).message;
        log.warn({ id, err: m.error }, 'databento: market refresh failed');
      }
    }
    const order = [...stores.keys()].sort((a, b) => (stores.get(a)![0]?.t ?? end) > (stores.get(b)![0]?.t ?? end) ? -1 : 1);
    for (const id of order) {
      if (stop || !timeLeft()) break;
      const symbol = DATABENTO.symbols[id]!;
      const m = meta.ids[id]!;
      try {
        let stored = stores.get(id)!;
        while (!m.full && timeLeft()) {
          const first = stored.length ? stored[0]!.t : end;
          if (first <= from + 2 * DAY) {
            m.full = true;
            break;
          }
          const a = Math.max(from, first - DATABENTO.pieceDays * DAY);
          const got = await piece(id, symbol, a, first);
          if (got === null) {
            stop = true;
            break;
          }
          if (!got.some((b) => b.t < first)) {
            m.full = true; // nothing older at Databento
            break;
          }
          stored = await saveDb(redis, id, got, now);
        }
        Object.assign(m, { first: stored[0]?.t ?? null, last: stored[stored.length - 1]?.t ?? null, n: stored.length });
      } catch (err) {
        m.error = (err as Error).message;
        log.warn({ id, err: m.error }, 'databento: market refresh failed');
      }
    }
  } catch (err) {
    meta.error = (err as Error).message;
  }
  const marketErr = Object.values(meta.ids).find((m) => m.error)?.error ?? null;
  if (meta.error || marketErr) feeds.fail('databento', new Error(meta.error ?? marketErr!));
  else feeds.ok('databento', { items: bars, asOf: meta.availEnd });
  await redis.set(DB_META, JSON.stringify(meta)).catch(() => undefined);
  return meta;
}

/** What a year / 3 months of real order flow (every trade with its buy / sell side) would cost — display only. */
export async function orderFlowEstimates(key: string, availEnd: number, fetcher: DbFetch = fetch as never): Promise<DbEstimate[]> {
  const asks: Array<[string, string, number]> = [
    ['Nasdaq (NQ) every trade, last 12 months', 'NQ.v.0', 365],
    ['Nasdaq (NQ) every trade, last 3 months', 'NQ.v.0', 91],
    ['Gold (GC) every trade, last 12 months', 'GC.v.0', 365],
    ['S&P (ES) every trade, last 12 months', 'ES.v.0', 365],
  ];
  const out: DbEstimate[] = [];
  for (const [what, sym, days] of asks) {
    try {
      out.push({ what, usd: Math.round((await costOf(key, sym, 'trades', availEnd - days * DAY, availEnd, fetcher)) * 100) / 100 });
    } catch (err) {
      out.push({ what, usd: null, error: (err as Error).message });
    }
  }
  return out;
}

/**
 * Databento's older hourly bars in front of Yahoo's (futures only), when the seam lines up: the last Databento bar
 * before Yahoo's first is ≤ 4 days earlier and within `maxSeamGap` of Yahoo's first open (the same contract — a roll
 * between them would put a step in the history). Pure.
 */
export function stitchFutures(yahoo: readonly Bar[], db: readonly Bar[], now: number, days = DATABENTO.historyDays): Bar[] {
  if (!yahoo.length || !db.length) return [...yahoo];
  const first = yahoo[0]!.t;
  const older = db.filter((b) => b.t < first && b.t >= now - days * DAY);
  if (!older.length) return [...yahoo];
  const seam = older[older.length - 1]!;
  if (first - seam.t > 4 * DAY) return [...yahoo];
  if (Math.abs(seam.c - yahoo[0]!.o) / yahoo[0]!.o > DATABENTO.maxSeamGap) return [...yahoo];
  return [...older, ...yahoo];
}

/**
 * v28.14: a continuous futures series rolls from one contract to the next; the jump at each roll (forward points, not
 * a market move) is taken out by scaling everything before it, when the jump is within `maxRollJump`. Pure.
 */
export function backAdjust(bars: readonly DbBar[]): Bar[] {
  const out: Bar[] = bars.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, ...(v ? { v } : {}) }));
  let f = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (f !== 1) {
      const b = out[i]!;
      Object.assign(b, { o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f });
    }
    const prev = bars[i - 1];
    const cur = bars[i]!;
    if (prev && prev.iid && cur.iid && prev.iid !== cur.iid) {
      const jump = (cur.o * f) / prev.c;
      if (Math.abs(jump - 1) <= DATABENTO.maxRollJump) f = jump;
    }
  }
  return out;
}

/** 1 / price for a futures contract quoted the other way round to the spot pair (high ↔ low). Pure. */
export const invertBars = (bars: readonly Bar[]): Bar[] => bars.map((b) => ({ t: b.t, o: 1 / b.o, h: 1 / b.l, l: 1 / b.h, c: 1 / b.c, ...(b.v ? { v: b.v } : {}) }));

/**
 * v28.14: Databento's older currency-futures hours in front of Yahoo's spot candles: rolls back-adjusted, inverted for
 * USD/JPY, USD/CAD, USD/CHF, then scaled onto spot at the seam (the last futures hour ≤ 4 days before Yahoo's first,
 * within `maxSpotGap`). Volume is dropped (spot FX has none, the lab's volume rules must stay silent). Pure.
 */
export function stitchSpot(id: string, yahoo: readonly Bar[], db: readonly DbBar[], now: number, days = DATABENTO.historyDays): Bar[] {
  if (!yahoo.length || !db.length) return [...yahoo];
  const first = yahoo[0]!.t;
  let fut = backAdjust(db.filter((b) => b.t < first && b.t >= now - days * DAY));
  if (!fut.length) return [...yahoo];
  if (DATABENTO.invert.has(id)) fut = invertBars(fut);
  const seam = fut[fut.length - 1]!;
  if (first - seam.t > 4 * DAY) return [...yahoo];
  const k = yahoo[0]!.o / seam.c;
  if (!Number.isFinite(k) || Math.abs(k - 1) > DATABENTO.maxSpotGap) return [...yahoo];
  return [...fut.map((b) => ({ t: b.t, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k })), ...yahoo];
}

/** v28.15: hourly while a market's history is still filling (or a market was never fetched), else every 6 h. Pure. */
export function everyMs(meta: DbMeta | null): number {
  const behind = !meta || Object.keys(DATABENTO.symbols).some((id) => !meta.ids[id]?.full);
  return (behind ? DATABENTO.catchUpHours : DATABENTO.everyHours) * HOUR;
}

/** The main process's 6-hourly refresh (+ a daily order-flow price check). Needs a key; does nothing without one. */
export class DatabentoSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  constructor(private redis: Redis, private fetcher: DbFetch = fetch as never) {}
  start(firstDelayMs = 120_000): void {
    this.stop();
    this.stopped = false;
    this.timer = setTimeout(() => void this.tick(), firstDelayMs);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** run now (after a key was saved); the next run follows `everyHours` later */
  async tick(force = false): Promise<DbMeta | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const key = databentoConf().key;
      if (!key) return null;
      const prev = await loadDbMeta(this.redis);
      if (!force && prev && Date.now() - prev.at < everyMs(prev) - 60_000) return prev;
      const meta = await refreshDatabento(this.redis, key, Date.now(), this.fetcher);
      if (meta.availEnd && (!meta.estimatedAt || Date.now() - meta.estimatedAt > DAY)) {
        meta.estimates = await orderFlowEstimates(key, meta.availEnd, this.fetcher);
        meta.estimatedAt = Date.now();
        await this.redis.set(DB_META, JSON.stringify(meta)).catch(() => undefined);
      }
      return meta;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'databento refresh failed');
      return null;
    } finally {
      this.running = false;
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        const meta = await loadDbMeta(this.redis).catch(() => null);
        if (!this.stopped) this.timer = setTimeout(() => void this.tick(), everyMs(meta));
      }
    }
  }
}
