/**
 * Market mood (v13): is the wider market in "risk-on" (stocks up, fear down) or "risk-off" (stocks down, fear up)?
 * Inputs from Yahoo, hourly: S&P 500 futures, the VIX fear index, the US dollar index, the US 10-year yield and oil.
 * Score = average of the S&P's 24-hour move and the VIX's 24-hour move (inverted), each in "normal days" units
 * (S&P 1%, VIX 7%), clamped to ±3: above +0.5 = risk-on, under −0.5 = risk-off.
 * Currencies react differently: AUD / NZD / CAD rise with risk-on, JPY / CHF / gold with risk-off — so in a clear
 * risk-off the bot avoids buying AUD against JPY and the like. Causal: values at hour t use bars opened ≤ t.
 */
import type { Bar } from './types';
import { gridIndex } from './strength';

const HOUR = 3_600_000;
const STALE = 4 * 86_400_000;

export interface MoodBook {
  times: number[];
  score: Float64Array;
  spx: Float64Array;
  vix: Float64Array;
  dxy: Float64Array;
  /** 10-year yield change in basis points */
  tnxBp: Float64Array;
  oil: Float64Array;
  /** last values (for display) */
  last: { spx: number | null; vix: number | null; dxy: number | null; tnx: number | null; oil: number | null };
}

/** Risk class per currency: + rises in risk-on, − in risk-off. */
export const RISK_CLASS: Record<string, number> = { AUD: 1, NZD: 1, CAD: 0.6, GBP: 0.2, EUR: 0, USD: -0.5, CHF: -1, JPY: -1, XAU: -1, XAG: 0, BTC: 1, ETH: 1, SOL: 1, XRP: 1, DOGE: 1, ADA: 1, LINK: 1, AVAX: 1 };

/** How "risk-on" buying this pair is (+ = a risk-on trade, − = a safe-haven trade). */
export function riskOfLong(pair: string): number {
  return (RISK_CLASS[pair.slice(0, 3)] ?? 0) - (RISK_CLASS[pair.slice(3, 6)] ?? 0);
}

/** % change of a series over 24 hours at time t (last bar ≤ t vs last bar ≤ t − 24h). */
function change24(bars: readonly Bar[], ptr: { k: number; j: number }, t: number): { pct: number; now: number } | null {
  while (ptr.k + 1 < bars.length && bars[ptr.k + 1]!.t <= t) ptr.k++;
  while (ptr.j + 1 < bars.length && bars[ptr.j + 1]!.t <= t - 24 * HOUR) ptr.j++;
  if (ptr.k < 0 || ptr.j < 0 || ptr.j >= ptr.k) return null;
  const now = bars[ptr.k]!;
  if (t - now.t > STALE) return null;
  return { pct: (now.c / bars[ptr.j]!.c - 1) * 100, now: now.c };
}

/** Yahoo quotes the 10-year yield in % (4.25); older data used ×10 (42.5). */
const yieldPct = (x: number) => (x > 20 ? x / 10 : x);

/** Build the mood book from the five series (any may be missing). Pure. */
export function buildMood(series: Partial<Record<'SPX' | 'VIX' | 'DXY' | 'US10Y' | 'OIL', readonly Bar[]>>): MoodBook {
  const grid = new Set<number>();
  for (const k of ['SPX', 'VIX', 'DXY', 'US10Y', 'OIL'] as const) for (const b of series[k] ?? []) grid.add(b.t);
  const times = [...grid].sort((a, b) => a - b);
  const n = times.length;
  const f = () => new Float64Array(n).fill(NaN);
  const book: MoodBook = { times, score: f(), spx: f(), vix: f(), dxy: f(), tnxBp: f(), oil: f(), last: { spx: null, vix: null, dxy: null, tnx: null, oil: null } };
  const ptr = { SPX: { k: -1, j: -1 }, VIX: { k: -1, j: -1 }, DXY: { k: -1, j: -1 }, US10Y: { k: -1, j: -1 }, OIL: { k: -1, j: -1 } };
  for (let g = 0; g < n; g++) {
    const t = times[g]!;
    const spx = series.SPX ? change24(series.SPX, ptr.SPX, t) : null;
    const vix = series.VIX ? change24(series.VIX, ptr.VIX, t) : null;
    const dxy = series.DXY ? change24(series.DXY, ptr.DXY, t) : null;
    const oil = series.OIL ? change24(series.OIL, ptr.OIL, t) : null;
    const tnx = series.US10Y ? change24(series.US10Y, ptr.US10Y, t) : null;
    if (spx) book.spx[g] = spx.pct;
    if (vix) book.vix[g] = vix.pct;
    if (dxy) book.dxy[g] = dxy.pct;
    if (oil) book.oil[g] = oil.pct;
    if (tnx) {
      const now = yieldPct(tnx.now);
      const before = now / (1 + tnx.pct / 100);
      book.tnxBp[g] = (now - before) * 100;
    }
    const parts: number[] = [];
    if (spx) parts.push(spx.pct / 1);
    if (vix) parts.push(-vix.pct / 7);
    if (parts.length) book.score[g] = Math.max(-3, Math.min(3, parts.reduce((a, b) => a + b, 0) / parts.length));
  }
  const lastOf = (b?: readonly Bar[]) => (b?.length ? b[b.length - 1]!.c : null);
  const tn = lastOf(series.US10Y);
  book.last = { spx: lastOf(series.SPX), vix: lastOf(series.VIX), dxy: lastOf(series.DXY), tnx: tn === null ? null : yieldPct(tn), oil: lastOf(series.OIL) };
  return book;
}

/** Mood score per bar of a series, read at each bar's close from the last hourly value known. Pure. */
export function moodSeries(book: MoodBook, bars: readonly Bar[], barMin: number): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (!book.times.length) return out;
  let g = -1;
  for (let i = 0; i < bars.length; i++) {
    const at = bars[i]!.t + barMin * 60_000 - HOUR;
    while (g + 1 < book.times.length && book.times[g + 1]! <= at) g++;
    if (g >= 0 && at - book.times[g]! <= STALE) out[i] = book.score[g]!;
  }
  return out;
}

export type MoodLabel = 'risk-on' | 'risk-off' | 'calm';
export const MOOD_MIN = 0.5;
export const moodLabel = (score: number): MoodLabel => (score >= MOOD_MIN ? 'risk-on' : score <= -MOOD_MIN ? 'risk-off' : 'calm');

export interface MoodNow {
  at: number | null;
  score: number | null;
  label: MoodLabel;
  inputs: Array<{ id: string; label: string; value: number | null; change: number | null; unit: '%' | 'bp' }>;
  /** plain-words advice */
  note: string;
}

/** The latest reading for the dashboard. */
export function moodNow(book: MoodBook, t = Number.POSITIVE_INFINITY): MoodNow {
  const g = gridIndex(book.times, t);
  const pick = (a: Float64Array) => (g >= 0 && Number.isFinite(a[g]!) ? Math.round(a[g]! * 100) / 100 : null);
  const score = pick(book.score);
  const label = score === null ? 'calm' : moodLabel(score);
  const r = (x: number | null, dp: number) => (x === null ? null : Math.round(x * 10 ** dp) / 10 ** dp);
  return {
    at: g >= 0 ? book.times[g]! : null,
    score,
    label,
    inputs: [
      { id: 'SPX', label: 'S&P 500 futures', value: r(book.last.spx, 0), change: pick(book.spx), unit: '%' },
      { id: 'VIX', label: 'VIX fear index', value: r(book.last.vix, 1), change: pick(book.vix), unit: '%' },
      { id: 'DXY', label: 'US dollar index', value: r(book.last.dxy, 2), change: pick(book.dxy), unit: '%' },
      { id: 'US10Y', label: 'US 10-year yield', value: r(book.last.tnx, 2), change: pick(book.tnxBp), unit: 'bp' },
      { id: 'OIL', label: 'Oil (WTI)', value: r(book.last.oil, 1), change: pick(book.oil), unit: '%' },
    ],
    note:
      label === 'risk-off'
        ? 'Risk-off: stocks falling, fear rising. The bot skips buying AUD, NZD and CAD against JPY, CHF or the dollar, and skips selling gold.'
        : label === 'risk-on'
          ? 'Risk-on: stocks up, fear down. The bot skips safe-haven trades (buying JPY, CHF or gold against AUD / NZD / CAD).'
          : 'Calm: no strong risk mood, so the mood check lets every trade through.',
  };
}
