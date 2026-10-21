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
  /** v27.6: the VIX level itself and its rank within the previous year of daily closes (0 = calmest, 1 = most fearful) */
  vixLvl: Float64Array;
  vixRank: Float64Array;
  /** last values (for display) */
  last: { spx: number | null; vix: number | null; dxy: number | null; tnx: number | null; oil: number | null };
}

/** Risk class per currency: + rises in risk-on, − in risk-off. */
export const RISK_CLASS: Record<string, number> = { AUD: 1, NZD: 1, CAD: 0.6, GBP: 0.2, EUR: 0, USD: -0.5, CHF: -1, JPY: -1, XAU: -1, XAG: 0, NDX: 1, SPX: 0.8, DJI: 0.6, RUT: 1, BTC: 1, ETH: 1, SOL: 1, XRP: 1, DOGE: 1, ADA: 1, LINK: 1, AVAX: 1 };

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
  const book: MoodBook = { times, score: f(), spx: f(), vix: f(), dxy: f(), tnxBp: f(), oil: f(), vixLvl: f(), vixRank: f(), last: { spx: null, vix: null, dxy: null, tnx: null, oil: null } };
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
  // v27.6: VIX level + its rank among the previous ~year of daily closes (days that ended before this hour's day)
  const vb = series.VIX ?? [];
  if (vb.length) {
    const dayOf = (t: number) => Math.floor(t / 86_400_000);
    const daily: Array<[number, number]> = [];
    for (const b of vb) {
      const d = dayOf(b.t);
      if (daily.length && daily[daily.length - 1]![0] === d) daily[daily.length - 1]![1] = b.c;
      else daily.push([d, b.c]);
    }
    let k = -1;
    let dEnd = 0;
    for (let g = 0; g < n; g++) {
      const t = times[g]!;
      while (k + 1 < vb.length && vb[k + 1]!.t <= t) k++;
      if (k < 0 || t - vb[k]!.t > STALE) continue;
      const lvl = vb[k]!.c;
      book.vixLvl[g] = lvl;
      const today = dayOf(t);
      while (dEnd < daily.length && daily[dEnd]![0] < today) dEnd++;
      const from = Math.max(0, dEnd - VIX.rankDays);
      if (dEnd - from < VIX.minRankDays) continue;
      let below = 0;
      for (let j = from; j < dEnd; j++) if (daily[j]![1] < lvl) below++;
      book.vixRank[g] = below / (dEnd - from);
    }
  }
  const lastOf = (b?: readonly Bar[]) => (b?.length ? b[b.length - 1]!.c : null);
  const tn = lastOf(series.US10Y);
  book.last = { spx: lastOf(series.SPX), vix: lastOf(series.VIX), dxy: lastOf(series.DXY), tnx: tn === null ? null : yieldPct(tn), oil: lastOf(series.OIL) };
  return book;
}

/** Mood score per bar of a series, read at each bar's close from the last hourly value known. Pure. */
export function moodSeries(book: MoodBook, bars: readonly Bar[], barMin: number, which: 'score' | 'vixLvl' | 'vixRank' = 'score'): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  const src = book[which] as Float64Array | undefined;
  if (!book.times.length || !src) return out;
  let g = -1;
  for (let i = 0; i < bars.length; i++) {
    const at = bars[i]!.t + barMin * 60_000 - HOUR;
    while (g + 1 < book.times.length && book.times[g + 1]! <= at) g++;
    if (g >= 0 && at - book.times[g]! <= STALE) out[i] = src[g]!;
  }
  return out;
}

/**
 * v27.6 (owner: "look at the VIX so you can see the expected volatility"). The VIX is the market's own price of the next
 * 30 days' S&P 500 swings, as a yearly %: VIX ÷ √252 ≈ the expected daily move (VIX 16 → about ±1% a day), ÷ √52 a
 * week. Uses: the expected-move read on the dashboard, a size brake (`vixFactor`), and the 'vix' filter the lab tests
 * like every other (no new trade in the VIX's top 10% of the past year — panic markets).
 */
export const VIX = { rankDays: 252, minRankDays: 60, panicRank: 0.9, brake: [[35, 0.5], [25, 0.75]] as Array<[number, number]> };
export type VixRegime = 'calm' | 'normal' | 'high' | 'extreme';
export const vixRegime = (lvl: number): VixRegime => (lvl < 15 ? 'calm' : lvl < 20 ? 'normal' : lvl < 30 ? 'high' : 'extreme');
/** expected S&P 500 move implied by the VIX, % (one standard deviation) */
export const vixMove = (lvl: number) => ({ dayPct: Math.round((lvl / Math.sqrt(252)) * 100) / 100, weekPct: Math.round((lvl / Math.sqrt(52)) * 100) / 100 });
/** v27.6 size brake: VIX ≥ 25 → 0.75×, ≥ 35 → 0.5× the normal risk (a safety rule, not a tested edge); unknown → 1 */
export function vixFactor(lvl: number | null | undefined): number {
  if (lvl === null || lvl === undefined || !Number.isFinite(lvl)) return 1;
  for (const [at, f] of VIX.brake) if (lvl >= at) return f;
  return 1;
}
/** the newest known VIX level in a book (null = none) */
export function vixNowOf(book: MoodBook | null | undefined, t = Number.POSITIVE_INFINITY): number | null {
  if (!book?.vixLvl) return null;
  const g = gridIndex(book.times, t);
  for (let j = g; j >= 0 && j > g - 72; j--) if (Number.isFinite(book.vixLvl[j]!)) return book.vixLvl[j]!;
  return null;
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
  /** v27.6: the VIX read — level, its rank in the past year, regime, the S&P move it implies, the size brake in force */
  vix?: { level: number; change: number | null; rank: number | null; regime: VixRegime; dayPct: number; weekPct: number; sizeFactor: number; note: string } | null;
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
    vix: (() => {
      const lvl = vixNowOf(book, t);
      if (lvl === null) return null;
      const rk = g >= 0 && Number.isFinite(book.vixRank?.[g] ?? NaN) ? Math.round(book.vixRank[g]! * 100) / 100 : null;
      const reg = vixRegime(lvl);
      const mv = vixMove(lvl);
      const f = vixFactor(lvl);
      const words = { calm: 'Calm market: small daily swings expected.', normal: 'Normal market.', high: 'Nervous market: bigger swings than usual.', extreme: 'Panic-level fear: very big swings expected.' }[reg];
      return { level: Math.round(lvl * 10) / 10, change: pick(book.vix), rank: rk, regime: reg, dayPct: mv.dayPct, weekPct: mv.weekPct, sizeFactor: f, note: `${words} The VIX prices the S&P 500 at about ±${mv.dayPct}% a day (±${mv.weekPct}% a week).${f < 1 ? ` The bot trades at ${f}× its normal size until it calms down.` : ''}${rk !== null && rk >= VIX.panicRank ? ' It is in its most fearful 10% of the past year.' : ''}` };
    })(),
    note:
      label === 'risk-off'
        ? 'Risk-off: stocks falling, fear rising. The bot skips buying AUD, NZD and CAD against JPY, CHF or the dollar, and skips selling gold.'
        : label === 'risk-on'
          ? 'Risk-on: stocks up, fear down. The bot skips safe-haven trades (buying JPY, CHF or gold against AUD / NZD / CAD).'
          : 'Calm: no strong risk mood, so the mood check lets every trade through.',
  };
}
