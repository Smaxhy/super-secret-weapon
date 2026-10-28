/**
 * v27.89 coin derivatives data (owner: "get all the data you can and build it properly"). Free, no account, public APIs:
 *  - funding rates (what longs pay shorts every 8 h on the perpetual futures): Binance, fallback Bybit — years of history;
 *  - open interest (how many contracts are open), hourly: Bybit (pages back), fallback Binance (last 30 days only);
 *  - the long / short account ratio (share of accounts long vs short), hourly: Bybit, fallback Binance (30 days);
 *  - liquidations (positions force-closed), live only — no free history: Binance `!forceOrder@arr` + Bybit
 *    `allLiquidation.<SYM>` WebSockets, summed per coin per hour (`LiquidationLive`).
 * Stored in Redis per coin (`fx:deriv:<kind>:<id>`, rows [t, value]); read by the coin lab as causal per-bar series
 * (`derivSeriesFor`: a bar only sees rows stamped at or before its close) for filters, strategies and the judge. Graded
 * like everything else — nothing here trades until the lab finds it helps on unseen data. Sources can't be reached from
 * the build sandbox: the Setup → Data feeds card says what arrived on the server.
 */
import type Redis from 'ioredis';
import WebSocket from 'ws';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import type { Bar, Instrument } from './types';
import type { LiveSocket, SocketFactory } from './yahoo-live';

const log = moduleLogger('forex-derivs');
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const DERIVS = {
  historyDays: 1100,
  /** a refresh stops paging back after this long (the deep history fills over a few hourly runs) */
  budgetMs: 90_000,
  pauseMs: 120,
  timeoutMs: 15_000,
  /** z-scores: funding vs its last 90 settlements (≈ 30 days), OI change / long-short vs the last 30 days of hours */
  fundLookback: 90,
  fundMin: 30,
  hourLookback: 720,
  hourMin: 168,
  /** a reading older than this at a bar's close counts as missing (the feed died) */
  fundMaxAgeMs: 12 * HOUR,
  hourMaxAgeMs: 3 * HOUR,
  liqKeepDays: 120,
  liqFlushMs: 60_000,
  watchdogMs: 90_000,
  /** v27.91: Binance's liquidation stream only speaks when something is liquidated (and pings every ~3 min at the
   *  protocol level, which we don't see) — a quiet 90 s is normal there, so it gets a longer leash */
  watchdogMsBySrc: { binance: 15 * 60_000 } as Partial<Record<'binance' | 'bybit', number>>,
};

export type DerivKind = 'fund' | 'oi' | 'ls' | 'liq';
export type DerivSource = 'binance' | 'bybit';
/** [time ms, value]: funding % per 8 h, open interest in coins, long ÷ short account ratio */
export type Row = [number, number];
/** [hour start ms, long USD liquidated, short USD liquidated] */
export type LiqRow = [number, number, number];
export const derivKey = (kind: DerivKind, id: string) => `fx:deriv:${kind}:${id}`;
export const DERIV_META = 'fx:deriv:meta';
export interface SeriesMeta {
  src: DerivSource | null;
  full: boolean;
  okAt: number | null;
  error: string | null;
}
export type DerivMeta = Record<string, Partial<Record<Exclude<DerivKind, 'liq'>, SeriesMeta>>>;

/** BTCUSD → BTCUSDT (the USDT perpetual on Binance / Bybit). */
export const perpOf = (id: string) => id.replace(/USD$/, 'USDT');
export const idOfPerp = (sym: string) => sym.replace(/USDT$/, 'USD');

// ── fetching ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type GetJson = (url: string) => Promise<unknown>;
const realGet: GetJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(DERIVS.timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN);
const asc = (rows: Row[]) => rows.filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1])).sort((a, b) => a[0] - b[0]);
function bybitList(j: unknown): Array<Record<string, unknown>> {
  const o = j as { retCode?: number; retMsg?: string; result?: { list?: Array<Record<string, unknown>> } };
  if (o?.retCode !== undefined && o.retCode !== 0) throw new Error(`Bybit ${o.retCode} ${o.retMsg ?? ''}`.trim());
  return Array.isArray(o?.result?.list) ? o.result!.list! : [];
}
function binanceArr(j: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(j)) return j as Array<Record<string, unknown>>;
  const o = j as { code?: number; msg?: string };
  throw new Error(`Binance ${o?.code ?? ''} ${o?.msg ?? 'bad answer'}`.trim());
}

/** One page of rows strictly before `beforeT`, oldest first (empty = nothing older). */
type Older = (sym: string, beforeT: number, get: GetJson) => Promise<Row[]>;

const SOURCES: Record<Exclude<DerivKind, 'liq'>, Array<[DerivSource, Older]>> = {
  fund: [
    [
      'binance',
      async (sym, beforeT, get) => {
        // v27.90 (code review): a 1000-hour window — Binance returns the FIRST `limit` rows from startTime, so an 8-hour window
        // could miss the newest rows of a symbol that ever settled hourly
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${beforeT - 1000 * HOUR}&endTime=${beforeT - 1}&limit=1000`;
        return asc(binanceArr(await get(url)).map((r) => [num(r.fundingTime), num(r.fundingRate) * 100] as Row)).filter((r) => r[0] < beforeT);
      },
    ],
    [
      'bybit',
      async (sym, beforeT, get) => {
        const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&endTime=${beforeT - 1}&limit=200`;
        return asc(bybitList(await get(url)).map((r) => [num(r.fundingRateTimestamp), num(r.fundingRate) * 100] as Row)).filter((r) => r[0] < beforeT);
      },
    ],
  ],
  oi: [
    [
      'bybit',
      async (sym, beforeT, get) => {
        const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&startTime=${beforeT - 200 * HOUR}&endTime=${beforeT - 1}&limit=200`;
        return asc(bybitList(await get(url)).map((r) => [num(r.timestamp), num(r.openInterest)] as Row)).filter((r) => r[0] < beforeT);
      },
    ],
    [
      'binance',
      async (sym, beforeT, get) => {
        if (beforeT < Date.now() - 29 * DAY) return []; // Binance keeps 30 days only
        const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&endTime=${beforeT - 1}&limit=500`;
        return asc(binanceArr(await get(url)).map((r) => [num(r.timestamp), num(r.sumOpenInterest)] as Row)).filter((r) => r[0] < beforeT);
      },
    ],
  ],
  ls: [
    [
      'bybit',
      async (sym, beforeT, get) => {
        const url = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&startTime=${beforeT - 500 * HOUR}&endTime=${beforeT - 1}&limit=500`;
        return asc(bybitList(await get(url)).map((r) => [num(r.timestamp), num(r.buyRatio) / num(r.sellRatio)] as Row)).filter((r) => r[0] < beforeT && r[1] > 0);
      },
    ],
    [
      'binance',
      async (sym, beforeT, get) => {
        if (beforeT < Date.now() - 29 * DAY) return [];
        const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&endTime=${beforeT - 1}&limit=500`;
        return asc(binanceArr(await get(url)).map((r) => [num(r.timestamp), num(r.longShortRatio)] as Row)).filter((r) => r[0] < beforeT && r[1] > 0);
      },
    ],
  ],
};

/** Merge rows by time (newer value wins), sorted. Pure. */
export function mergeRows(a: readonly Row[], b: readonly Row[]): Row[] {
  const m = new Map<number, number>();
  for (const r of a) m.set(r[0], r[1]);
  for (const r of b) m.set(r[0], r[1]);
  return [...m].sort((x, y) => x[0] - y[0]);
}

async function loadRows(redis: Redis, kind: DerivKind, id: string): Promise<Row[]> {
  try {
    const raw = await redis.get(derivKey(kind, id));
    const rows = raw ? (JSON.parse(raw) as Row[]) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function loadMeta(redis: Redis): Promise<DerivMeta> {
  try {
    return (JSON.parse((await redis.get(DERIV_META)) ?? '{}') as DerivMeta) ?? {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring every coin's funding / OI / long-short store up to now, then page back toward `historyDays` until the budget
 * runs out. A series keeps the source it started with (two exchanges' open interest don't line up). Never throws.
 */
export async function refreshDerivs(redis: Redis, insts: readonly Instrument[], now = Date.now(), get: GetJson = realGet, budgetMs = DERIVS.budgetMs, pauseMs = DERIVS.pauseMs): Promise<DerivMeta> {
  const deadline = Date.now() + budgetMs; // the budget runs on the real clock (`now` may be injected)
  const coins = insts.filter((i) => i.kind === 'crypto');
  const meta = await loadMeta(redis);
  const kinds = Object.keys(SOURCES) as Array<Exclude<DerivKind, 'liq'>>;
  let ok = 0;
  const errors: string[] = [];
  for (const kind of kinds) {
    for (const inst of coins) {
      const sym = perpOf(inst.id);
      const m: SeriesMeta = meta[inst.id]?.[kind] ?? { src: null, full: false, okAt: null, error: null };
      let rows = await loadRows(redis, kind, inst.id);
      const order = m.src ? SOURCES[kind].filter(([s]) => s === m.src) : SOURCES[kind];
      let done = false;
      const errs: string[] = [];
      for (const [src, older] of order) {
        try {
          // forward: page back from now until the stored newest row
          const newest = rows.length ? rows[rows.length - 1]![0] : 0;
          let before = now + 1;
          let fresh: Row[] = [];
          for (let k = 0; k < 40 && Date.now() < deadline; k++) {
            const page = await older(sym, before, get);
            if (pauseMs) await sleep(pauseMs);
            if (!page.length) break;
            fresh = mergeRows(fresh, page);
            if (page[0]![0] <= newest || !rows.length) break;
            before = page[0]![0];
          }
          if (!rows.length && !fresh.length) throw new Error('empty answer');
          rows = mergeRows(rows, fresh);
          // backward: deeper history until historyDays back or nothing older comes
          const floor = now - DERIVS.historyDays * DAY;
          try {
            for (let pages = 0; pages < 400 && !m.full && rows.length && rows[0]![0] > floor && Date.now() < deadline; pages++) {
              const page = await older(sym, rows[0]![0], get);
              if (pauseMs) await sleep(pauseMs);
              if (!page.length) {
                m.full = true;
                break;
              }
              rows = mergeRows(page, rows);
            }
          } catch (err) {
            // the source refuses older pages: keep what came, stop going back
            m.full = true;
            log.info({ id: inst.id, kind, src, err: (err as Error).message }, 'coin derivatives: no older history from this source');
          }
          if (rows.length && rows[0]![0] <= floor) m.full = true;
          rows = rows.filter((r) => r[0] >= floor);
          await redis.set(derivKey(kind, inst.id), JSON.stringify(rows));
          m.src = src;
          m.okAt = now;
          m.error = null;
          ok++;
          done = true;
          break;
        } catch (err) {
          errs.push(`${src}: ${(err as Error).message}`);
          m.error = errs.join(' · ');
        }
      }
      if (!done) errors.push(`${inst.id} ${kind}: ${m.error}`);
      meta[inst.id] = { ...(meta[inst.id] ?? {}), [kind]: m };
    }
  }
  await redis.set(DERIV_META, JSON.stringify(meta)).catch(() => undefined);
  if (ok) feeds.ok('derivs', { items: ok, asOf: now });
  if (errors.length && !ok) feeds.fail('derivs', errors.slice(0, 3).join('; '));
  else if (errors.length) log.warn({ errors: errors.slice(0, 6) }, 'some coin derivatives series failed');
  return meta;
}

// ── reading (causal) ────────────────────────────────────────────────────────────────────────────────────────────────
export interface DerivData {
  fund: Row[];
  oi: Row[];
  ls: Row[];
  liq: LiqRow[];
}
export type DerivBook = Record<string, DerivData>;

export async function loadDerivs(redis: Redis, ids: readonly string[]): Promise<DerivBook> {
  const out: DerivBook = {};
  for (const id of ids) {
    const liqRaw = await redis.get(derivKey('liq', id)).catch(() => null);
    let liq: LiqRow[] = [];
    try {
      liq = liqRaw ? (JSON.parse(liqRaw) as LiqRow[]) : [];
    } catch {
      liq = [];
    }
    out[id] = { fund: await loadRows(redis, 'fund', id), oi: await loadRows(redis, 'oi', id), ls: await loadRows(redis, 'ls', id), liq };
  }
  return out;
}

/** Rolling z-score of each row's value against the `look` rows before it (NaN under `min`). Pure. */
export function rollingZ(vals: readonly number[], look: number, min: number): Float64Array {
  const out = new Float64Array(vals.length).fill(NaN);
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let k = 0; k < vals.length; k++) {
    if (n >= min) {
      const mean = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      if (sd > 0 && Number.isFinite(vals[k]!)) out[k] = (vals[k]! - mean) / sd;
    }
    const v = vals[k]!;
    if (Number.isFinite(v)) {
      s += v;
      s2 += v * v;
      n++;
    }
    const drop = k - look;
    if (drop >= 0 && Number.isFinite(vals[drop]!)) {
      s -= vals[drop]!;
      s2 -= vals[drop]! * vals[drop]!;
      n--;
    }
  }
  return out;
}

/** OI % change over 24 h at each row (the row at or before t − 24 h; NaN when there is none within 2 h of it). Pure. */
export function change24(rows: readonly Row[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < rows.length; k++) {
    const t = rows[k]![0] - DAY;
    while (j + 1 < k && rows[j + 1]![0] <= t) j++;
    const r = rows[j]!;
    out.push(r[0] <= t && t - r[0] <= 2 * HOUR && r[1] > 0 ? (rows[k]![1] / r[1] - 1) * 100 : NaN);
  }
  return out;
}

/** Per-bar values: the newest row stamped at or before each bar's close, NaN when older than `maxAge`. Pure. */
export function alignRows(times: readonly number[], vals: ArrayLike<number>, bars: readonly Bar[], barMin: number, maxAge: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i]!.t + barMin * 60_000;
    while (j + 1 < times.length && times[j + 1]! <= close) j++;
    if (j >= 0 && close - times[j]! <= maxAge) out[i] = vals[j]!;
  }
  return out;
}

export interface DerivSeries {
  /** funding, % per 8 h */
  fund: Float64Array;
  /** funding vs its last ~30 days (z) */
  fundZ: Float64Array;
  /** open interest change over 24 h, % */
  oiChg: Float64Array;
  /** that change vs the last 30 days of hours (z) */
  oiZ: Float64Array;
  /** log(long ÷ short accounts) vs the last 30 days of hours (z) */
  lsZ: Float64Array;
}

/** The coin's derivative readings at each bar's close (null = no data at all). Pure. */
export function derivSeriesFor(d: DerivData | undefined, bars: readonly Bar[], barMin: number): DerivSeries | null {
  if (!d || (!d.fund.length && !d.oi.length && !d.ls.length)) return null;
  const nan = () => new Float64Array(bars.length).fill(NaN);
  const ft = d.fund.map((r) => r[0]);
  const fv = d.fund.map((r) => r[1]);
  const fund = d.fund.length ? alignRows(ft, fv, bars, barMin, DERIVS.fundMaxAgeMs) : nan();
  const fundZ = d.fund.length ? alignRows(ft, rollingZ(fv, DERIVS.fundLookback, DERIVS.fundMin), bars, barMin, DERIVS.fundMaxAgeMs) : nan();
  // v27.90 (code review): hourly open-interest / account rows may be stamped at the START of their hour — counted only
  // from the hour's end (an hour later at worst, never early)
  const ot = d.oi.map((r) => r[0] + HOUR);
  const oc = change24(d.oi);
  const oiChg = d.oi.length ? alignRows(ot, oc, bars, barMin, DERIVS.hourMaxAgeMs) : nan();
  const oiZ = d.oi.length ? alignRows(ot, rollingZ(oc, DERIVS.hourLookback, DERIVS.hourMin), bars, barMin, DERIVS.hourMaxAgeMs) : nan();
  const lt = d.ls.map((r) => r[0] + HOUR);
  const lsZ = d.ls.length ? alignRows(lt, rollingZ(d.ls.map((r) => Math.log(r[1])), DERIVS.hourLookback, DERIVS.hourMin), bars, barMin, DERIVS.hourMaxAgeMs) : nan();
  return { fund, fundZ, oiChg, oiZ, lsZ };
}

/** What the coin's market card shows now. Pure. */
export interface DerivNow {
  fund: number | null;
  fundAnnPct: number | null;
  fundZ: number | null;
  oiChg24: number | null;
  oiZ: number | null;
  ls: number | null;
  lsZ: number | null;
  liq1h: { long: number; short: number } | null;
  liq24h: { long: number; short: number } | null;
  note: string;
}
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
export function derivNow(d: DerivData | undefined, s: DerivSeries | null, now: number): DerivNow | null {
  if (!d) return null;
  const last = (a: Float64Array | undefined) => (a && a.length ? a[a.length - 1]! : NaN);
  const fund = last(s?.fund);
  const fundZ = last(s?.fundZ);
  const oiChg24 = last(s?.oiChg);
  const oiZ = last(s?.oiZ);
  const lsZ = last(s?.lsZ);
  const lsRow = d.ls[d.ls.length - 1];
  const hourT = Math.floor(now / HOUR) * HOUR;
  const sumLiq = (from: number) => d.liq.filter((r) => r[0] >= from).reduce((a, r) => ({ long: a.long + r[1], short: a.short + r[2] }), { long: 0, short: 0 });
  const liq1h = d.liq.length ? sumLiq(hourT - HOUR) : null;
  const liq24h = d.liq.length ? sumLiq(hourT - 23 * HOUR) : null;
  const bits: string[] = [];
  if (Number.isFinite(fundZ) && fundZ >= 2) bits.push('funding unusually high: longs crowded and paying');
  else if (Number.isFinite(fundZ) && fundZ <= -2) bits.push('funding unusually low: shorts crowded and paying');
  if (Number.isFinite(oiZ) && oiZ <= -2) bits.push('open interest falling fast: positions being flushed');
  else if (Number.isFinite(oiZ) && oiZ >= 2) bits.push('open interest rising fast: new money piling in');
  if (Number.isFinite(lsZ) && Math.abs(lsZ) >= 2) bits.push(`accounts unusually ${lsZ > 0 ? 'long' : 'short'}`);
  if (liq24h && liq24h.long + liq24h.short > 0) bits.push(`liquidated in 24 h: longs $${Math.round(liq24h.long / 1000)}k, shorts $${Math.round(liq24h.short / 1000)}k`);
  return {
    fund: r2(fund),
    fundAnnPct: Number.isFinite(fund) ? Math.round(fund * 3 * 365 * 10) / 10 : null,
    fundZ: r2(fundZ),
    oiChg24: r2(oiChg24),
    oiZ: r2(oiZ),
    ls: lsRow ? r2(lsRow[1]) : null,
    lsZ: r2(lsZ),
    liq1h,
    liq24h,
    note: bits.join(' · ') || 'nothing unusual',
  };
}

// ── live liquidations ───────────────────────────────────────────────────────────────────────────────────────────────
export interface LiqEvent {
  id: string;
  t: number;
  /** 1 = a long was liquidated (forced sell), −1 = a short (forced buy) */
  side: 1 | -1;
  usd: number;
}

/** Binance `forceOrder` message → event. An order SELL closes a long. Pure. */
export function parseBinanceLiq(raw: string, ids: ReadonlySet<string>): LiqEvent[] {
  try {
    const j = JSON.parse(raw) as { data?: unknown } & Record<string, unknown>;
    const msgs = Array.isArray(j) ? j : [j.data ?? j];
    const out: LiqEvent[] = [];
    for (const m of msgs as Array<{ o?: Record<string, unknown> }>) {
      const o = m?.o;
      if (!o) continue;
      const id = idOfPerp(String(o.s ?? ''));
      if (!ids.has(id)) continue;
      const qty = num(o.z) || num(o.q);
      const px = num(o.ap) || num(o.p);
      const usd = qty * px;
      if (!(usd > 0)) continue;
      out.push({ id, t: num(o.T) || Date.now(), side: String(o.S).toUpperCase() === 'SELL' ? 1 : -1, usd });
    }
    return out;
  } catch {
    return [];
  }
}

/** Bybit `allLiquidation` message → events. Bybit: side Buy = a long position was liquidated. Pure. */
export function parseBybitLiq(raw: string, ids: ReadonlySet<string>): LiqEvent[] {
  try {
    const j = JSON.parse(raw) as { topic?: string; data?: Array<Record<string, unknown>> };
    if (!j.topic?.startsWith('allLiquidation') || !Array.isArray(j.data)) return [];
    const out: LiqEvent[] = [];
    for (const d of j.data) {
      const id = idOfPerp(String(d.s ?? ''));
      if (!ids.has(id)) continue;
      const usd = num(d.v) * num(d.p);
      if (!(usd > 0)) continue;
      out.push({ id, t: num(d.T) || Date.now(), side: String(d.S) === 'Buy' ? 1 : -1, usd });
    }
    return out;
  } catch {
    return [];
  }
}

/** Add an event to a coin's hourly rows (kept `liqKeepDays`). Pure. */
export function addLiq(rows: LiqRow[], e: LiqEvent): LiqRow[] {
  const h = Math.floor(e.t / HOUR) * HOUR;
  // v27.90 (code review): a late event for an earlier hour adds to that hour's row (it used to replace it)
  const same = rows.find((r) => r[0] === h);
  if (same) {
    if (e.side === 1) same[1] += e.usd;
    else same[2] += e.usd;
    return rows;
  }
  const out = rows.filter((r) => r[0] >= h - DERIVS.liqKeepDays * DAY && r[0] !== h);
  out.push([h, e.side === 1 ? e.usd : 0, e.side === -1 ? e.usd : 0]);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

const realSocket: SocketFactory = (url) => new WebSocket(url, { handshakeTimeout: 15_000 }) as unknown as LiveSocket;
const LIQ_WS = {
  binance: 'wss://fstream.binance.com/ws/!forceOrder@arr',
  bybit: 'wss://stream.bybit.com/v5/public/linear',
};

/** Live liquidations from Binance + Bybit, summed per coin per hour into Redis (flushed every minute). */
export class LiquidationLive {
  private readonly ids: Set<string>;
  private rows = new Map<string, LiqRow[]>();
  private dirty = new Set<string>();
  private socks: Partial<Record<DerivSource, LiveSocket | null>> = {};
  private lastMsg: Partial<Record<DerivSource, number>> = {};
  private fails: Partial<Record<DerivSource, number>> = {};
  private timers: NodeJS.Timeout[] = [];
  private stopped = true;
  events = 0;

  constructor(
    private readonly redis: Redis,
    insts: readonly Instrument[],
    private readonly makeSocket: SocketFactory = realSocket,
    private readonly clock: () => number = Date.now,
  ) {
    this.ids = new Set(insts.filter((i) => i.kind === 'crypto').map((i) => i.id));
  }

  async start(): Promise<void> {
    if (!this.stopped || !this.ids.size) return;
    this.stopped = false;
    for (const id of this.ids) {
      try {
        const raw = await this.redis.get(derivKey('liq', id));
        this.rows.set(id, raw ? (JSON.parse(raw) as LiqRow[]) : []);
      } catch {
        this.rows.set(id, []);
      }
    }
    this.connect('binance');
    this.connect('bybit');
    const flush = setInterval(() => void this.flush(), DERIVS.liqFlushMs);
    const dog = setInterval(() => {
      const now = this.clock();
      for (const src of ['binance', 'bybit'] as const) {
        const s = this.socks[src];
        if (s && now - (this.lastMsg[src] ?? now) > (DERIVS.watchdogMsBySrc[src] ?? DERIVS.watchdogMs)) this.drop(src, 'silent');
        if (src === 'bybit' && s) {
          try {
            s.send(JSON.stringify({ op: 'ping' }));
          } catch {
            // reconnects on close
          }
        }
      }
    }, 20_000);
    flush.unref?.();
    dog.unref?.();
    this.timers = [flush, dog];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const src of ['binance', 'bybit'] as const) {
      const s = this.socks[src];
      this.socks[src] = null;
      try {
        s?.terminate();
      } catch {
        // closing
      }
    }
    await this.flush();
  }

  onEvents(evs: readonly LiqEvent[]): void {
    for (const e of evs) {
      this.rows.set(e.id, addLiq(this.rows.get(e.id) ?? [], e));
      this.dirty.add(e.id);
      this.events++;
    }
  }

  async flush(): Promise<void> {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) await this.redis.set(derivKey('liq', id), JSON.stringify(this.rows.get(id) ?? [])).catch(() => this.dirty.add(id));
  }

  private connect(src: DerivSource): void {
    if (this.stopped) return;
    let s: LiveSocket;
    try {
      s = this.makeSocket(LIQ_WS[src]);
    } catch (err) {
      this.failed(src, (err as Error).message);
      return;
    }
    this.socks[src] = s;
    this.lastMsg[src] = this.clock();
    s.on('open', () => {
      if (this.socks[src] !== s) return;
      if (src === 'bybit') s.send(JSON.stringify({ op: 'subscribe', args: [...this.ids].map((id) => `allLiquidation.${perpOf(id)}`) }));
    });
    s.on('message', (data) => {
      if (this.socks[src] !== s) return;
      this.lastMsg[src] = this.clock();
      this.fails[src] = 0;
      const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const evs = src === 'binance' ? parseBinanceLiq(raw, this.ids) : parseBybitLiq(raw, this.ids);
      if (evs.length) {
        this.onEvents(evs);
        feeds.ok('liquidations', { items: this.events, asOf: evs[evs.length - 1]!.t });
      }
    });
    s.on('error', (err) => {
      if (this.socks[src] === s) this.failed(src, err.message);
    });
    s.on('close', () => {
      if (this.socks[src] === s) this.failed(src, 'closed');
    });
  }

  private drop(src: DerivSource, why: string): void {
    const s = this.socks[src];
    this.socks[src] = null;
    try {
      s?.terminate();
    } catch {
      // closing
    }
    this.failed(src, why);
  }

  private failed(src: DerivSource, why: string): void {
    if (this.stopped) return;
    this.socks[src] = null;
    const n = (this.fails[src] = (this.fails[src] ?? 0) + 1);
    if (n >= 3) feeds.fail('liquidations', `${src}: ${why}`);
    const t = setTimeout(() => this.connect(src), Math.min(60_000, 1_000 * 2 ** Math.min(6, n - 1)));
    t.unref?.();
  }
}
