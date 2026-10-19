/**
 * v17 price stretch — a stand-in for hedge-fund positioning that needs no outside feed. Per currency: its 3-month
 * momentum in normal-move units (63 days of log return ÷ the volatility of those days, averaged over its pairs), ranked
 * within its own last ~2 years: −1 = it has never run down this hard, +1 = never run up this hard. A pair's reading =
 * base − quote (−2 … +2, the same scale as the CFTC score). It measures how far and how long a currency has run, which
 * positioning mostly follows; it cannot see positions that differ from price (what the CFTC report adds). Causal: a
 * bar only sees days that ended by its close. Pure.
 */
import { toDaily } from './mtf';
import type { Bar } from './types';

/** fixed before any real result */
export const STRETCH = { momDays: 63, rankDays: 520, minRank: 120, minPairs: 3, maxAgeDays: 4, crowdMax: 1.2, squeezeAt: 1.5 };

const DAY = 86_400_000;

export interface StretchBook {
  /** day end times (22:00 UTC), ascending */
  ends: number[];
  /** per currency: rank score −1 … +1 per day (NaN = unknown) */
  crowd: Record<string, Float64Array>;
}

/** Build from hourly bars of currency pairs (metals and anything not 6 letters ignored). */
export function buildStretch(pairsH1: Readonly<Record<string, readonly Bar[]>>): StretchBook {
  const daily = new Map<string, Map<number, number>>();
  const endSet = new Set<number>();
  for (const [id, bars] of Object.entries(pairsH1)) {
    if (id.length !== 6 || id.startsWith('XA') || bars.length < 24 * 70) continue;
    const m = new Map<number, number>();
    for (const d of toDaily(bars)) {
      m.set(d.end, d.c);
      endSet.add(d.end);
    }
    daily.set(id, m);
  }
  const ends = [...endSet].sort((a, b) => a - b);
  const N = ends.length;
  // per pair: z63 on its own days, then laid onto the shared day list
  const zOf = new Map<string, Float64Array>();
  for (const [id, m] of daily) {
    const days = [...m.entries()].sort((a, b) => a[0] - b[0]);
    const z = new Map<number, number>();
    const L = STRETCH.momDays;
    for (let k = L; k < days.length; k++) {
      let s = 0;
      let s2 = 0;
      for (let j = k - L + 1; j <= k; j++) {
        const r = Math.log(days[j]![1] / days[j - 1]![1]);
        s += r;
        s2 += r * r;
      }
      const mean = s / L;
      const sd = Math.sqrt(Math.max(0, s2 / L - mean * mean));
      if (sd > 0) z.set(days[k]![0], Math.log(days[k]![1] / days[k - L]![1]) / (sd * Math.sqrt(L)));
    }
    const arr = new Float64Array(N).fill(NaN);
    for (let k = 0; k < N; k++) arr[k] = z.get(ends[k]!) ?? NaN;
    zOf.set(id, arr);
  }
  // per currency: average of its pairs' z (+ as the base, − as the quote), then the rank within its own past
  const ccys = new Set<string>();
  for (const id of zOf.keys()) {
    ccys.add(id.slice(0, 3));
    ccys.add(id.slice(3, 6));
  }
  const crowd: Record<string, Float64Array> = {};
  for (const ccy of ccys) {
    const mom = new Float64Array(N).fill(NaN);
    for (let k = 0; k < N; k++) {
      let s = 0;
      let n = 0;
      for (const [id, z] of zOf) {
        const v = z[k]!;
        if (!Number.isFinite(v)) continue;
        if (id.startsWith(ccy)) {
          s += v;
          n++;
        } else if (id.endsWith(ccy)) {
          s -= v;
          n++;
        }
      }
      if (n >= STRETCH.minPairs) mom[k] = s / n;
    }
    const out = new Float64Array(N).fill(NaN);
    for (let k = 0; k < N; k++) {
      const now = mom[k]!;
      if (!Number.isFinite(now)) continue;
      let below = 0;
      let cnt = 0;
      for (let j = Math.max(0, k - STRETCH.rankDays); j < k; j++) {
        const v = mom[j]!;
        if (!Number.isFinite(v)) continue;
        cnt++;
        if (v < now) below++;
      }
      if (cnt >= STRETCH.minRank) out[k] = (2 * below) / cnt - 1;
    }
    crowd[ccy] = out;
  }
  return { ends, crowd };
}

/** A pair's stretch at each bar's close: base − quote (−2 … +2); NaN for metals, unknown or > 4 days old. Pure. */
export function crowdPxSeries(book: StretchBook | null | undefined, pair: string, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!book || pair.startsWith('XA')) return out;
  const b = book.crowd[pair.slice(0, 3)];
  const q = book.crowd[pair.slice(3, 6)];
  if (!b || !q) return out;
  let k = -1;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i]!.t + barMin * 60_000;
    while (k + 1 < book.ends.length && book.ends[k + 1]! <= close) k++;
    if (k < 0 || close - book.ends[k]! > STRETCH.maxAgeDays * DAY) continue;
    const v = b[k]! - q[k]!;
    if (Number.isFinite(v)) out[i] = v;
  }
  return out;
}
