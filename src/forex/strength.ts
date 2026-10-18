/**
 * Currency strength meter (v13). Every FX pair we load (the 10 traded ones + 10 crosses read only for this) gives a
 * volatility-normalised return over a lookback; a currency's strength = the average of its pairs' returns (+ when it
 * is the base, − when it is the quote). Two lookbacks: 24 hourly bars ("today") and 120 ("this week").
 * Units: roughly standard deviations, so 0 = average, +1 = clearly strong, −1 = clearly weak.
 * Causal: the value at hour t uses only closes of bars that opened at or before t.
 */
import type { Bar } from './types';
import { atr } from './ta';

export const STRENGTH_CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'] as const;
export const SHORT_BARS = 24;
export const LONG_BARS = 120;
const HOUR = 3_600_000;

export interface StrengthBook {
  /** hourly grid (bar open times), ascending */
  times: number[];
  short: Record<string, Float64Array>;
  long: Record<string, Float64Array>;
}

const isFxPair = (id: string) => id.length === 6 && (STRENGTH_CCYS as readonly string[]).includes(id.slice(0, 3)) && (STRENGTH_CCYS as readonly string[]).includes(id.slice(3, 6));

/** Build the strength book from hourly bars per pair id (pure). */
export function buildStrength(pairs: Record<string, readonly Bar[]>, shortBars = SHORT_BARS, longBars = LONG_BARS): StrengthBook {
  const ids = Object.keys(pairs).filter((id) => isFxPair(id) && pairs[id]!.length > longBars + 20);
  const grid = new Set<number>();
  for (const id of ids) for (const b of pairs[id]!) grid.add(b.t);
  const times = [...grid].sort((a, b) => a - b);
  const n = times.length;
  const mk = () => Object.fromEntries(STRENGTH_CCYS.map((c) => [c, new Float64Array(n)])) as Record<string, Float64Array>;
  const sumS = mk();
  const sumL = mk();
  const cntS = mk();
  const cntL = mk();
  for (const id of ids) {
    const bars = pairs[id]!;
    const a = atr(bars, 14);
    const bS = sumS[id.slice(0, 3)]!;
    const qS = sumS[id.slice(3, 6)]!;
    const bL = sumL[id.slice(0, 3)]!;
    const qL = sumL[id.slice(3, 6)]!;
    const bSc = cntS[id.slice(0, 3)]!;
    const qSc = cntS[id.slice(3, 6)]!;
    const bLc = cntL[id.slice(0, 3)]!;
    const qLc = cntL[id.slice(3, 6)]!;
    let k = -1;
    for (let g = 0; g < n; g++) {
      const t = times[g]!;
      while (k + 1 < bars.length && bars[k + 1]!.t <= t) k++;
      if (k < 0 || t - bars[k]!.t > 3 * HOUR) continue; // no fresh bar for this pair at this hour
      const c = bars[k]!.c;
      const vol = a[k]! / c;
      if (!(vol > 0)) continue;
      if (k - shortBars >= 0) {
        const z = Math.log(c / bars[k - shortBars]!.c) / (vol * Math.sqrt(shortBars));
        if (Number.isFinite(z)) {
          bS[g] = bS[g]! + z;
          qS[g] = qS[g]! - z;
          bSc[g] = bSc[g]! + 1;
          qSc[g] = qSc[g]! + 1;
        }
      }
      if (k - longBars >= 0) {
        const z = Math.log(c / bars[k - longBars]!.c) / (vol * Math.sqrt(longBars));
        if (Number.isFinite(z)) {
          bL[g] = bL[g]! + z;
          qL[g] = qL[g]! - z;
          bLc[g] = bLc[g]! + 1;
          qLc[g] = qLc[g]! + 1;
        }
      }
    }
  }
  const avg = (sum: Record<string, Float64Array>, cnt: Record<string, Float64Array>) => {
    const out = mk();
    for (const c of STRENGTH_CCYS) for (let g = 0; g < n; g++) out[c]![g] = cnt[c]![g]! > 0 ? sum[c]![g]! / cnt[c]![g]! : NaN;
    return out;
  };
  return { times, short: avg(sumS, cntS), long: avg(sumL, cntL) };
}

/** Index of the last grid hour ≤ t (−1 = none). */
export function gridIndex(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Combined score (half today, half this week) of one currency at grid index g. NaN = unknown. */
export function scoreAt(book: StrengthBook, ccy: string, g: number): number {
  if (g < 0) return NaN;
  const s = book.short[ccy]?.[g];
  const l = book.long[ccy]?.[g];
  if (s === undefined || l === undefined) return NaN;
  if (Number.isFinite(s) && Number.isFinite(l)) return 0.5 * s + 0.5 * l;
  return Number.isFinite(s) ? s : Number.isFinite(l) ? l : NaN;
}

/**
 * Strength gap of a pair (base − quote) at grid index g: positive = the base is the stronger one, so buying the pair
 * goes WITH the strength. Metals: the opposite of the dollar's strength (gold rises when USD is weak).
 */
export function pairGap(book: StrengthBook, pair: string, g: number): number {
  const base = pair.slice(0, 3);
  const quote = pair.slice(3, 6);
  if (base === 'XAU' || base === 'XAG') {
    const u = scoreAt(book, 'USD', g);
    return Number.isFinite(u) ? -u : NaN;
  }
  const b = scoreAt(book, base, g);
  const q = scoreAt(book, quote, g);
  return Number.isFinite(b) && Number.isFinite(q) ? b - q : NaN;
}

/**
 * Gap per bar of a series, read at each bar's decision time (its close) from the last hourly value already known.
 * `barMin` 60 or 240. Pure.
 */
export function gapSeries(book: StrengthBook, pair: string, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!book.times.length) return out;
  let g = -1;
  for (let i = 0; i < bars.length; i++) {
    const at = bars[i]!.t + barMin * 60_000 - HOUR;
    while (g + 1 < book.times.length && book.times[g + 1]! <= at) g++;
    out[i] = pairGap(book, pair, g);
  }
  return out;
}

export interface StrengthNow {
  at: number | null;
  ccys: Array<{ ccy: string; score: number; today: number; week: number }>;
}

/** The latest reading, strongest first (for the dashboard). */
export function strengthNow(book: StrengthBook): StrengthNow {
  const g = book.times.length - 1;
  if (g < 0) return { at: null, ccys: [] };
  const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
  const ccys = STRENGTH_CCYS.map((c) => ({ ccy: c, score: r2(scoreAt(book, c, g)), today: r2(book.short[c]![g]!), week: r2(book.long[c]![g]!) }));
  ccys.sort((a, b) => b.score - a.score);
  return { at: book.times[g]!, ccys };
}
