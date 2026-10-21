/**
 * v16 macro data (free, no account): (1) CFTC Commitments of Traders — the weekly positions of leveraged funds (hedge
 * funds / CTAs) in the CME currency futures, from the Traders in Financial Futures report; (2) central-bank policy rates
 * from the BIS (Bank for International Settlements) for carry = the interest-rate gap between a pair's two currencies.
 * Both are read only at the moment they became public (COT: Friday 15:30 New York for the Tuesday positions; BIS
 * monthly rates: from the start of the next month), so a backtest never sees them early. Redis `fx:macro`.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { feeds } from './feeds';
import type { Bar } from './types';

const log = moduleLogger('forex-macro');
const DAY = 86_400_000;
export const FX_MACRO = 'fx:macro';
export const MACRO = {
  refreshHours: 12,
  /** v17: after a failed refresh, try again this soon (it used to wait the full 12 h) */
  retryHours: 2,
  cotYears: 4,
  cotLookbackWeeks: 156,
  minWeeks: 26,
  /** v17: a positioning report older than this no longer counts (e.g. CFTC stops publishing in a US shutdown) */
  cotMaxAgeDays: 17,
  /** v17: policy rates older than this no longer count (carry goes quiet instead of trusting a dead feed) */
  rateMaxAgeDays: 100,
};

/** Currencies with a CME future in the TFF report (USD itself has none: its score is 0). */
const COT_MARKETS: Array<[string, RegExp]> = [
  ['EUR', /^EURO FX\b/i],
  ['JPY', /^JAPANESE YEN\b/i],
  ['GBP', /^(BRITISH POUND|POUND STERLING)\b/i],
  ['CHF', /^SWISS FRANC\b/i],
  ['CAD', /^CANADIAN DOLLAR\b/i],
  ['AUD', /^AUSTRALIAN DOLLAR\b/i],
  ['NZD', /^(NZ|NEW ZEALAND) DOLLAR\b/i],
];
const BIS_AREAS: Record<string, string> = { US: 'USD', XM: 'EUR', JP: 'JPY', GB: 'GBP', CH: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD' };

export interface MacroData {
  /** last attempt */
  at: number;
  /** v17: last time each feed really worked */
  cotOkAt?: number | null;
  ratesOkAt?: number | null;
  /** per currency: [public from (ms), leveraged funds net ÷ open interest] */
  cot: Record<string, Array<[number, number]>>;
  /** per currency: [in force from (ms), policy rate %] */
  rates: Record<string, Array<[number, number]>>;
  errors: string[];
}

/** When a COT report for Tuesday `reportT` became public: the Friday after, 15:30 New York ≈ 20:30 UTC. Pure. */
export const cotPublicAt = (reportT: number) => reportT + 3 * DAY + 20.5 * 3_600_000;

/** Socrata JSON rows of the TFF report → per-currency net positioning. Field names matched loosely. Pure. */
export function parseCotRows(rows: ReadonlyArray<Record<string, unknown>>): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const r of rows) {
    const name = String(r.market_and_exchange_names ?? r.Market_and_Exchange_Names ?? '');
    const ccy = COT_MARKETS.find(([, re]) => re.test(name))?.[0];
    if (!ccy) continue;
    const keys = Object.keys(r);
    const num = (re: RegExp) => {
      const k = keys.find((x) => re.test(x));
      const v = k ? Number(r[k]) : NaN;
      return Number.isFinite(v) ? v : NaN;
    };
    const long = num(/^lev_money_positions_long/i);
    const short = num(/^lev_money_positions_short/i);
    const oi = num(/^open_interest_all$|^open_interest$/i);
    const t = Date.parse(String(r.report_date_as_yyyy_mm_dd ?? r.Report_Date_as_YYYY_MM_DD ?? '').slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(t) || !(oi > 0) || !Number.isFinite(long) || !Number.isFinite(short)) continue;
    (out[ccy] ??= []).push([cotPublicAt(t), (long - short) / oi]);
  }
  for (const k of Object.keys(out)) out[k] = dedupeSort(out[k]!);
  return out;
}

/** The legacy weekly text file (FinFutWk.txt, latest week only; TFF column order). Pure. */
export function parseCotText(txt: string): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const line of txt.split(/\r?\n/)) {
    const cols = line.match(/("([^"]*)"|[^,]+)/g)?.map((c) => c.replace(/^"|"$/g, '').trim());
    if (!cols || cols.length < 16) continue;
    const ccy = COT_MARKETS.find(([, re]) => re.test(cols[0]!))?.[0];
    if (!ccy) continue;
    const t = Date.parse(`${cols[2]}T00:00:00Z`);
    const oi = Number(cols[7]);
    const long = Number(cols[14]);
    const short = Number(cols[15]);
    if (!Number.isFinite(t) || !(oi > 0) || !(long >= 0) || !(short >= 0) || long > oi || short > oi) continue;
    (out[ccy] ??= []).push([cotPublicAt(t), (long - short) / oi]);
  }
  return out;
}

/** BIS SDMX CSV (columns REF_AREA, TIME_PERIOD, OBS_VALUE; monthly) → rates in force from the next month. Pure. */
export function parseBisCsv(csv: string): Record<string, Array<[number, number]>> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const split = (l: string) => l.match(/("([^"]*)"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').trim()) ?? [];
  const head = split(lines[0]!).map((h) => h.toUpperCase());
  const ia = head.findIndex((h) => h === 'REF_AREA' || h.endsWith(':REF_AREA') || h.startsWith('REF_AREA'));
  const it = head.findIndex((h) => h === 'TIME_PERIOD' || h.startsWith('TIME_PERIOD'));
  const iv = head.findIndex((h) => h === 'OBS_VALUE' || h.startsWith('OBS_VALUE'));
  if (ia < 0 || it < 0 || iv < 0) return {};
  const out: Record<string, Array<[number, number]>> = {};
  for (const l of lines.slice(1)) {
    const c = split(l);
    const area = (c[ia] ?? '').split(':')[0]!.trim();
    const ccy = BIS_AREAS[area];
    const v = Number(c[iv]);
    const m = /^(\d{4})-(\d{2})/.exec(c[it] ?? '');
    if (!ccy || !Number.isFinite(v) || !m) continue;
    const from = Date.UTC(Number(m[1]), Number(m[2]), 1); // month is 1-based → this is the 1st of the NEXT month
    (out[ccy] ??= []).push([from, v]);
  }
  for (const k of Object.keys(out)) out[k] = dedupeSort(out[k]!);
  return out;
}

function dedupeSort(xs: Array<[number, number]>): Array<[number, number]> {
  const m = new Map(xs.map((x) => [x[0], x]));
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

/** Index of the last entry public at time t (−1 = none). Pure. */
export function lastIdx(xs: ReadonlyArray<readonly [number, number]>, t: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]![0] <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** The last value public at time t (binary search), or NaN; v17: NaN when it is older than `maxAgeMs`. Pure. */
export function valueAt(xs: ReadonlyArray<readonly [number, number]> | undefined, t: number, maxAgeMs = Infinity): number {
  if (!xs?.length || t < xs[0]![0]) return NaN;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid]![0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return t - xs[lo]![0] > maxAgeMs ? NaN : xs[lo]![1];
}

/**
 * Positioning score of one currency at time t: where leveraged funds' latest public net position sits within its own
 * last `lookback` weeks, −1 (most short ever) … +1 (most long ever). NaN with < `MACRO.minWeeks` of history. Pure.
 */
export function cotScoreAt(xs: ReadonlyArray<readonly [number, number]> | undefined, t: number, lookback = MACRO.cotLookbackWeeks): number {
  if (!xs?.length) return NaN;
  const k = lastIdx(xs, t);
  if (k < 0) return NaN;
  // v17: the same age limit in a backtest and live (a gap in the reports means no reading, not an old one)
  if (t - xs[k]![0] > MACRO.cotMaxAgeDays * DAY) return NaN;
  const from = Math.max(0, k - lookback + 1);
  if (k - from + 1 < MACRO.minWeeks) return NaN;
  const now = xs[k]![1];
  let below = 0;
  for (let i = from; i <= k; i++) if (xs[i]![1] < now) below++;
  return (below / (k - from)) * 2 - 1;
}

const legs = (pair: string): [string, string] => [pair.slice(0, 3), pair.slice(3, 6)];
/** v27: bases with no policy rate or CFTC currency row: metals and the US indices (financed at −USD, like a CFD) */
const NO_RATE = new Set(['XAU', 'XAG', 'NDX', 'SPX', 'DJI', 'RUT']);

/** Carry of a pair (base rate − quote rate, %) at each bar's close; metals pay nothing (−USD rate). NaN = unknown. Pure. */
export function carrySeries(m: MacroData | null, pair: string, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!m) return out;
  const [b, q] = legs(pair);
  const rb = NO_RATE.has(b) ? null : m.rates[b];
  const rq = m.rates[q];
  if ((!rb && !NO_RATE.has(b)) || !rq) return out;
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i]!.t + barMin * 60_000;
    const vb = rb ? valueAt(rb, t, MACRO.rateMaxAgeDays * DAY) : 0;
    const vq = valueAt(rq, t, MACRO.rateMaxAgeDays * DAY);
    out[i] = Number.isFinite(vb) && Number.isFinite(vq) ? vb - vq : NaN;
  }
  return out;
}

/** v18: the pair's carry (base rate − quote rate, %) known at time t; NaN = unknown. Pure. */
export function carryAt(m: MacroData | null, pair: string, t: number): number {
  return carrySeries(m, pair, [{ t: t - 60_000, o: 0, h: 0, l: 0, c: 0 }], 1)[0] ?? NaN;
}

/** Positioning of a pair at each bar's close: base score − quote score (USD = 0; metals NaN). −2 … +2. Pure. */
export function cotSeries(m: MacroData | null, pair: string, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!m) return out;
  const [b, q] = legs(pair);
  if (NO_RATE.has(b)) return out;
  const sb = b === 'USD' ? null : m.cot[b];
  const sq = q === 'USD' ? null : m.cot[q];
  if ((b !== 'USD' && !sb) || (q !== 'USD' && !sq)) return out;
  // weekly data: recompute only when a new report became public
  let lastKey = '';
  let val = NaN;
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i]!.t + barMin * 60_000;
    const kb = sb ? lastIdx(sb, t) : -2;
    const kq = sq ? lastIdx(sq, t) : -2;
    // v17: the age limit can switch a reading off between two reports
    const old = (xs: ReadonlyArray<readonly [number, number]> | null | undefined, k: number) => (xs && k >= 0 && t - xs[k]![0] > MACRO.cotMaxAgeDays * DAY ? 1 : 0);
    const key = `${kb}:${kq}:${old(sb, kb)}:${old(sq, kq)}`;
    if (key !== lastKey) {
      lastKey = key;
      const vb = sb ? cotScoreAt(sb, t) : 0;
      const vq = sq ? cotScoreAt(sq, t) : 0;
      val = Number.isFinite(vb) && Number.isFinite(vq) ? vb - vq : NaN;
    }
    out[i] = val;
  }
  return out;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function loadMacro(redis: Redis): Promise<MacroData | null> {
  try {
    return JSON.parse((await redis.get(FX_MACRO)) ?? 'null') as MacroData | null;
  } catch {
    return null;
  }
}

/** Fetch COT + policy rates (each with a fallback); keeps the old data for anything that fails. Never throws. */
export async function refreshMacro(redis: Redis, now = Date.now(), fetchers = { json: getJson, text: getText }): Promise<MacroData> {
  const prev = await loadMacro(redis);
  if (prev && now - prev.at < (prev.errors.length ? MACRO.retryHours : MACRO.refreshHours) * 3_600_000) return prev;
  const errors: string[] = [];
  let cot = prev?.cot ?? {};
  let cotOk = false;
  let ratesOk = false;
  const since = new Date(now - MACRO.cotYears * 365 * DAY).toISOString().slice(0, 10);
  try {
    const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$where=${encodeURIComponent(`report_date_as_yyyy_mm_dd >= '${since}T00:00:00'`)}&$limit=50000`;
    const rows = (await fetchers.json(url)) as Array<Record<string, unknown>>;
    const parsed = parseCotRows(Array.isArray(rows) ? rows : []);
    if (Object.keys(parsed).length) {
      cot = parsed;
      cotOk = true;
    } else throw new Error('no currency rows');
  } catch (err) {
    errors.push(`CFTC history: ${(err as Error).message}`);
    try {
      const latest = parseCotText(await fetchers.text('https://www.cftc.gov/dea/newcot/FinFutWk.txt'));
      for (const [k, v] of Object.entries(latest)) cot[k] = dedupeSort([...(cot[k] ?? []), ...v]);
      if (Object.keys(latest).length) cotOk = true;
    } catch (err2) {
      errors.push(`CFTC weekly: ${(err2 as Error).message}`);
    }
  }
  let rates = prev?.rates ?? {};
  const areas = Object.keys(BIS_AREAS).join('+');
  const urls = [
    `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.${areas}?startPeriod=2018-01&format=csv`,
    `https://stats.bis.org/api/v1/data/WS_CBPOL/M.${areas}/all?startPeriod=2018-01&format=csv`,
  ];
  for (const u of urls) {
    try {
      const parsed = parseBisCsv(await fetchers.text(u));
      if (Object.keys(parsed).length >= 4) {
        rates = parsed;
        ratesOk = true;
        break;
      }
      throw new Error('no rates parsed');
    } catch (err) {
      errors.push(`BIS rates: ${(err as Error).message}`);
    }
  }
  // v17: BIS errors are dropped only when THIS attempt got rates (old rates used to hide a dead feed for good)
  if (ratesOk) errors.splice(0, errors.length, ...errors.filter((e) => !e.startsWith('BIS')));
  const out: MacroData = { at: now, cotOkAt: cotOk ? now : prev?.cotOkAt ?? null, ratesOkAt: ratesOk ? now : prev?.ratesOkAt ?? null, cot, rates, errors };
  const newest = (m: Record<string, Array<[number, number]>>) => Math.max(0, ...Object.values(m).map((xs) => xs[xs.length - 1]?.[0] ?? 0)) || null;
  if (cotOk) feeds.ok('cftc', { items: Object.keys(cot).length, asOf: newest(cot) });
  else feeds.fail('cftc', errors.filter((e) => e.startsWith('CFTC')).join('; ') || 'failed');
  if (ratesOk) feeds.ok('bis', { items: Object.keys(rates).length, asOf: newest(rates) });
  else feeds.fail('bis', errors.filter((e) => e.startsWith('BIS')).join('; ') || 'failed');
  await redis.set(FX_MACRO, JSON.stringify(out)).catch(() => undefined);
  if (errors.length) log.warn({ errors }, 'forex macro refresh: some feeds failed');
  return out;
}

/** What the dashboard shows: latest positioning per currency and policy rate per currency. Pure. */
export function macroNow(m: MacroData | null, now = Date.now()): { cot: Array<{ ccy: string; score: number; net: number; asOf: number }>; rates: Array<{ ccy: string; rate: number }>; errors: string[]; at: number | null; cotOkAt?: number | null; ratesOkAt?: number | null } {
  if (!m) return { cot: [], rates: [], errors: [], at: null };
  const cot = Object.entries(m.cot)
    .map(([ccy, xs]) => {
      const last = [...xs].reverse().find((x) => x[0] <= now);
      return last ? { ccy, score: Math.round(cotScoreAt(xs, now) * 100) / 100, net: Math.round(last[1] * 1000) / 10, asOf: last[0] } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && Number.isFinite(x.score));
  const rates = Object.entries(m.rates)
    .map(([ccy, xs]) => ({ ccy, rate: valueAt(xs, now, MACRO.rateMaxAgeDays * DAY) }))
    .filter((x) => Number.isFinite(x.rate))
    .sort((a, b) => b.rate - a.rate);
  return { cot, rates, errors: m.errors, at: m.at, cotOkAt: m.cotOkAt ?? null, ratesOkAt: m.ratesOkAt ?? null };
}
