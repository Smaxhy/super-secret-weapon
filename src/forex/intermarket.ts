/**
 * Cross-market readings for the strategies (v14): how far oil, the US 10-year yield, S&P futures and the dollar index
 * moved in the last 24 hours in "normal 24-hour moves" (z), the S&P's month-to-date return, and each currency's rank on
 * the 5-day strength meter — all aligned to a series' bars at each bar's close, from data already known then. Pure.
 */
import type { Bar } from './types';
import { STRENGTH_CCYS, type StrengthBook } from './strength';

const HOUR = 3_600_000;
const STALE = 4 * 86_400_000;

export interface TimeSeries {
  t: number[];
  v: Float64Array;
}

/**
 * 24-hour log change at each bar ÷ the spread of that change over the previous ~400 readings (causal z). Works for
 * series that trade 24 h (futures) and ones that only trade US hours (VIX, yields): the change is measured in TIME.
 */
export function z24Series(bars: readonly Bar[], window = 400, minSamples = 50): TimeSeries {
  const n = bars.length;
  const v = new Float64Array(n).fill(NaN);
  const ring: number[] = [];
  let sum = 0;
  let sum2 = 0;
  let j = -1;
  for (let k = 0; k < n; k++) {
    const t = bars[k]!.t;
    while (j + 1 < k && bars[j + 1]!.t <= t - 24 * HOUR) j++;
    if (j < 0 || t - bars[j]!.t > STALE) continue;
    const ch = Math.log(bars[k]!.c / bars[j]!.c);
    if (!Number.isFinite(ch)) continue;
    if (ring.length >= minSamples) {
      const m = sum / ring.length;
      const sd = Math.sqrt(Math.max(0, sum2 / ring.length - m * m));
      if (sd > 0) v[k] = ch / sd;
    }
    ring.push(ch);
    sum += ch;
    sum2 += ch * ch;
    if (ring.length > window) {
      const old = ring.shift()!;
      sum -= old;
      sum2 -= old * old;
    }
  }
  return { t: bars.map((b) => b.t), v };
}

/** Return since the last close of the previous month, % (NaN in the first month). */
export function mtdSeries(bars: readonly Bar[]): TimeSeries {
  const v = new Float64Array(bars.length).fill(NaN);
  let month = -1;
  let ref = NaN;
  let lastClose = NaN;
  for (let k = 0; k < bars.length; k++) {
    const d = new Date(bars[k]!.t);
    const m = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (m !== month) {
      ref = lastClose;
      month = m;
    }
    if (Number.isFinite(ref) && ref > 0) v[k] = (bars[k]!.c / ref - 1) * 100;
    lastClose = bars[k]!.c;
  }
  return { t: bars.map((b) => b.t), v };
}

/** Value of `src` at each bar's close (last hourly reading opened ≤ close − 1 h; stale → NaN). */
export function alignAt(src: TimeSeries | null, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!src || !src.t.length) return out;
  let g = -1;
  for (let i = 0; i < bars.length; i++) {
    const at = bars[i]!.t + barMin * 60_000 - HOUR;
    while (g + 1 < src.t.length && src.t[g + 1]! <= at) g++;
    if (g >= 0 && at - src.t[g]! <= STALE) out[i] = src.v[g]!;
  }
  return out;
}

/** Rank (0 = strongest) of every currency on the 5-day strength at each hour of the book. */
export function strengthRanks(book: StrengthBook): Record<string, Float64Array> {
  const n = book.times.length;
  const out: Record<string, Float64Array> = Object.fromEntries(STRENGTH_CCYS.map((c) => [c, new Float64Array(n).fill(NaN)]));
  for (let g = 0; g < n; g++) {
    const vals = STRENGTH_CCYS.map((c) => ({ c, v: book.long[c]![g]! })).filter((x) => Number.isFinite(x.v));
    if (vals.length < STRENGTH_CCYS.length) continue;
    vals.sort((a, b) => b.v - a.v);
    vals.forEach((x, k) => {
      out[x.c]![g] = k;
    });
  }
  return out;
}

/** Ranks of a pair's two currencies at each bar's close (metals: base NaN, quote = USD). */
export function pairRanks(book: StrengthBook, ranks: Record<string, Float64Array>, pair: string, bars: readonly Bar[], barMin: number): { base: Float64Array; quote: Float64Array } {
  const metal = pair.startsWith('XA');
  const b = metal ? null : { t: book.times, v: ranks[pair.slice(0, 3)] ?? new Float64Array(book.times.length).fill(NaN) };
  const q = { t: book.times, v: ranks[pair.slice(3, 6)] ?? new Float64Array(book.times.length).fill(NaN) };
  return { base: b ? alignAt(b, bars, barMin) : new Float64Array(bars.length).fill(NaN), quote: alignAt(q, bars, barMin) };
}
