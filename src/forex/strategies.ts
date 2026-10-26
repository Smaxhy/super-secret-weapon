/**
 * Forex strategy library (v12). Each strategy reads the bar CLOSE at index i (and earlier) and may return a
 * Signal; the engine fills it at the NEXT bar's open. Every rule is mirrored long / short. `random` is the
 * yardstick: a strategy has to beat random entries with the same exits to mean anything.
 */
import { STRETCH } from './stretch';
import type { Ctx } from './ta';
import { isCrypto, isFutures, isIndex, type Signal } from './types';
import { nyOffsetMs } from './ny-time';
import { absorptionAt, flowOf } from './flow';
import { strictStopDist } from './exits';

/**
 * v13: a "shock" candle = what a big news release looks like on an hourly chart: range ≥ 2.2× the normal hourly range
 * (ATR before it), a solid body (≥ 60% of the range) closing in the outer quarter. +1 up, −1 down, 0 none. Pure.
 */
export function shockDir(c: Ctx, i: number, k = 2.2): 1 | -1 | 0 {
  if (i < 15) return 0;
  const b = c.bars[i]!;
  const a = c.atr14[i - 1]!;
  const range = b.h - b.l;
  if (!Number.isFinite(a) || a <= 0 || range < k * a) return 0;
  if (Math.abs(b.c - b.o) < 0.6 * range) return 0;
  if (b.c > b.o && b.c >= b.h - 0.25 * range) return 1;
  if (b.c < b.o && b.c <= b.l + 0.25 * range) return -1;
  return 0;
}

export type Family = 'trend' | 'breakout' | 'session' | 'reversion' | 'pattern' | 'news' | 'intermarket' | 'flow' | 'ict' | 'deviation' | 'volume' | 'control';
/**
 * v14: what market a strategy needs (the regime check): 'trend' = a clean directional market, 'revert' = a choppy one,
 * 'pullback' = buys dips inside a bigger trend (the bigger-chart check covers it), 'neutral' = timing / flow rules.
 */
export type Style = 'trend' | 'revert' | 'pullback' | 'neutral';

export interface Strategy {
  id: string;
  name: string;
  family: Family;
  /** one line, plain words */
  desc: string;
  /** session strategies need hourly bars */
  onlyHourly?: boolean;
  /** v15: a multi-day rule — 1h / 4h charts only (not run on 15m / 1m) */
  slow?: boolean;
  /** v14: the market it needs (defaults from the family) */
  style?: Style;
  /** v23: the only charts this rule runs on (session rules built on the quarter-hours); unset = every chart */
  charts?: string[];
  signal(c: Ctx, i: number): Signal | null;
}

const STYLE_OVERRIDES: Record<string, Style> = {
  ema_pullback: 'pullback',
  fib_pullback: 'pullback',
  stoch_trend: 'pullback',
  williams_r: 'pullback',
  rsi_dip: 'pullback',
  rsi2: 'pullback',
  momentum_bar: 'trend',
  news_drift: 'trend',
  news_fade: 'revert',
  bb_squeeze: 'neutral',
  donchian20: 'neutral',
  donchian55: 'neutral',
  keltner: 'neutral',
  inside_bar: 'neutral',
  breakout_retest: 'neutral',
  cci_break: 'neutral',
};
/** The market a strategy needs (pure). */
export function styleOf(s: Pick<Strategy, 'id' | 'family' | 'style'>): Style {
  if (s.style) return s.style;
  if (STYLE_OVERRIDES[s.id]) return STYLE_OVERRIDES[s.id]!;
  return s.family === 'trend' ? 'trend' : s.family === 'reversion' || s.family === 'pattern' ? 'revert' : 'neutral';
}

/** The pair's own move over the last `hours`, in normal moves (ATR-scaled, like the strength meter). NaN if unknown. */
export function pairZ(c: Ctx, i: number, hours = 24): number {
  const L = Math.max(1, Math.round((hours * 60) / c.barMin));
  if (i - L < 0) return NaN;
  const px = c.close[i]!;
  const vol = c.atr14[i]! / px;
  if (!(vol > 0)) return NaN;
  return Math.log(px / c.close[i - L]!) / (vol * Math.sqrt(L));
}

/** Last UTC weekday of its month (holidays ignored). Pure. */
export function lastWeekdayOfMonth(t: number): boolean {
  const d = new Date(t);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (dow === 5 ? 3 : 1)));
  return next.getUTCMonth() !== d.getUTCMonth();
}

const ok = (...xs: number[]) => xs.every((x) => Number.isFinite(x));
const crossUp = (a: number[], b: number[], i: number) => a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
const crossDn = (a: number[], b: number[], i: number) => a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;
/** stop k ATR away; target r × the stop distance (null = trail only) */
function atrSig(c: Ctx, i: number, side: 1 | -1, k: number, r: number | null, extra: Partial<Signal> = {}): Signal | null {
  const a = c.atr14[i]!;
  const px = c.close[i]!;
  if (!ok(a, px) || a <= 0) return null;
  const stop = px - side * k * a;
  return { side, stop, target: r === null ? null : px + side * r * k * a, ...extra };
}
/** stop at a price level, target r × risk */
function levelSig(c: Ctx, i: number, side: 1 | -1, stop: number, r: number | null, extra: Partial<Signal> = {}): Signal | null {
  const px = c.close[i]!;
  const risk = (px - stop) * side;
  const a = c.atr14[i]!;
  if (!(risk > 0) || !ok(a) || risk > 4 * a || risk < 0.3 * a) return null;
  return { side, stop, target: r === null ? null : px + side * r * risk, ...extra };
}
/** the last n swing highs / lows already confirmed at bar i (oldest first) */
const lastHighs = (c: Ctx, i: number, n: number) => c.sw.highs.slice(Math.max(0, c.hiPtr[i]! - n + 1), c.hiPtr[i]! + 1);
const lastLows = (c: Ctx, i: number, n: number) => c.sw.lows.slice(Math.max(0, c.loPtr[i]! - n + 1), c.loPtr[i]! + 1);
const body = (c: Ctx, i: number) => Math.abs(c.bars[i]!.c - c.bars[i]!.o);

/** v27.5: opening-range breakout clock (minutes since New York midnight, by candle close) */
export const ORB = { from: 570, rangeTo: 600, until: 690, r: 1.5 };
/** v23: the ICT clock, minutes since New York midnight. */
export const ICT = {
  /** the pre-open range starts with London (3:00 am NY) */
  preOpenFrom: 3 * 60,
  /** 9:30 am New York: the stock-market open */
  nyOpen: 9 * 60 + 30,
  /** the Judas window: the first hour after the open */
  judasUntil: 10 * 60 + 30,
  /** 4:00 pm New York: the open-session trades are flat */
  nyFlat: 16 * 60,
  nyNoon: 12 * 60,
  /** quarterly theory, New York morning session 6:00–12:00 in 90-minute quarters */
  q1Start: 6 * 60,
  q2Start: 7 * 60 + 30,
  q3Start: 9 * 60,
  /** daily AMD: Asia from 6:00 pm NY, the decision at the 6:00 am close */
  asiaStart: 18 * 60,
  amdDecide: 6 * 60,
  /** a displacement candle's body in ATRs; how many candles a gap stays valid; how far back a sweep counts */
  fvgBodyAtr: 1.2,
  fvgValidBars: 6,
  sweepLook: 10,
  mssBars: 6,
  /** a sweep must reach this far past the range (in ATRs) — a wick a fraction of a pip over it is noise */
  sweepAtr: 0.05,
  /** v27.14 IFVG: how many candles back the opposing gap may sit; the inversion candle's body in ATRs */
  ifvgLook: 12,
  ifvgBodyAtr: 1.0,
  /** v27.14 FVG CE: how far back the gap that gets inverted may sit */
  ceInvLook: 20,
} as const;

interface SessionRange {
  h: number;
  l: number;
  /** the extremes of the decision window so far (up to bar i) */
  winHi: number;
  winLo: number;
  /** an earlier bar of the window already gave the short / long signal (first close back inside after the sweep) */
  hiSignalled: boolean;
  loSignalled: boolean;
}
/**
 * A session range and the decision window after it, in New York minutes. A bar belongs to a block when its CLOSE
 * minute (open + bar length) lies in (from, to] — so the hourly bar 9:00–10:00 sits in a window opening at 9:30, and
 * the 15-minute bar 9:30–9:45 does too. The range is read on the same NY day as bar i, or on the previous NY day
 * with `wrap` (Asia 18:00 → 24:00 for a decision this morning). Bar i must be inside the window; the range needs at
 * least 2 bars. `depth` = how far past the range a sweep must reach to count (noise doesn't). Null when the data
 * doesn't reach back. Pure, causal (only bars ≤ i).
 */
export function sessionRange(c: Ctx, i: number, rFrom: number, rTo: number, wFrom: number, wTo: number, wrap = false, depth = 0): SessionRange | null {
  const cm = (j: number) => c.nyMin[j]! + c.barMin;
  if (!(cm(i) > wFrom && cm(i) <= wTo)) return null;
  const dayOf = (t: number) => Math.floor((t + nyOffsetMs(t)) / 86_400_000);
  const today = dayOf(c.bars[i]!.t);
  const rDay = wrap ? today - 1 : today;
  const inWin = (j: number) => dayOf(c.bars[j]!.t) === today && cm(j) > wFrom && cm(j) <= wTo;
  const inRng = (j: number) => dayOf(c.bars[j]!.t) === rDay && cm(j) > rFrom && cm(j) <= rTo;
  let start = i;
  while (start > 0 && inWin(start - 1)) start--;
  let h = -Infinity;
  let l = Infinity;
  let n = 0;
  const maxBack = Math.ceil((36 * 60) / c.barMin);
  for (let j = start - 1; j >= 0 && i - j <= maxBack; j--) {
    if (inRng(j)) {
      h = Math.max(h, c.bars[j]!.h);
      l = Math.min(l, c.bars[j]!.l);
      n++;
      continue;
    }
    if (n > 0) break;
    const dj = dayOf(c.bars[j]!.t);
    if (dj < rDay || (dj === rDay && cm(j) <= rFrom)) break;
  }
  if (n < 2 || !Number.isFinite(h) || !Number.isFinite(l) || h <= l) return null;
  let winHi = -Infinity;
  let winLo = Infinity;
  let hiSignalled = false;
  let loSignalled = false;
  for (let j = start; j <= i; j++) {
    const b = c.bars[j]!;
    winHi = Math.max(winHi, b.h);
    winLo = Math.min(winLo, b.l);
    if (j < i) {
      if (winHi > h + depth && b.c < h && b.c > l) hiSignalled = true;
      if (winLo < l - depth && b.c > l && b.c < h) loSignalled = true;
    }
  }
  return { h, l, winHi, winLo, hiSignalled, loSignalled };
}

/** v23: ICT fair-value-gap entry (see `fvg_entry`). Pure. */
export function fvgSignal(c: Ctx, i: number): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || i < ICT.sweepLook + ICT.fvgValidBars + 4) return null;
  for (let k = i - 1; k >= i - ICT.fvgValidBars; k--) {
    // gap between bar k−2 and bar k, displacement = bar k−1
    const g0 = c.bars[k - 2]!;
    const d = c.bars[k - 1]!;
    const g1 = c.bars[k]!;
    const bodyD = Math.abs(d.c - d.o);
    if (bodyD < ICT.fvgBodyAtr * c.atr14[k - 1]!) continue;
    const lowBefore = Math.min(...c.bars.slice(k - 2 - ICT.sweepLook, k - 2).map((b) => b.l));
    const highBefore = Math.max(...c.bars.slice(k - 2 - ICT.sweepLook, k - 2).map((b) => b.h));
    if (d.c > d.o && g0.h < g1.l) {
      // bullish gap [g0.h, g1.l]; needs a sweep of the recent lows just before it
      if (Math.min(g0.l, d.l) >= lowBefore) continue;
      let dead = false;
      let touched = false;
      for (let j = k + 1; j <= i; j++) {
        if (c.bars[j]!.l < g0.h) dead = true;
        if (j < i && c.bars[j]!.l <= g1.l && c.close[j]! > g1.l) touched = true; // an earlier bar already signalled
      }
      const b = c.bars[i]!;
      if (dead || touched || !(b.l <= g1.l && b.c > g1.l)) continue;
      return levelSig(c, i, 1, g0.h - 0.1 * a, 2);
    }
    if (d.c < d.o && g0.l > g1.h) {
      if (Math.max(g0.h, d.h) <= highBefore) continue;
      let dead = false;
      let touched = false;
      for (let j = k + 1; j <= i; j++) {
        if (c.bars[j]!.h > g0.l) dead = true;
        if (j < i && c.bars[j]!.h >= g1.h && c.close[j]! < g1.h) touched = true;
      }
      const b = c.bars[i]!;
      if (dead || touched || !(b.h >= g1.h && b.c < g1.h)) continue;
      return levelSig(c, i, -1, g0.l + 0.1 * a, 2);
    }
  }
  return null;
}

/** v23: liquidity sweep + market structure shift (see `mss_sweep`). Pure. */
export function mssSignal(c: Ctx, i: number): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || i < 30) return null;
  const b = c.bars[i]!;
  const lo = c.sw.lows[c.loPtr[i]!];
  const hi = c.sw.highs[c.hiPtr[i]!];
  if (!lo || !hi) return null;
  // bullish: an old swing low (confirmed before the sweep window), a lower swing high after it, the sweep, the close above the high
  if (lo.at <= i - ICT.mssBars && hi.i > lo.i && hi.at <= i && b.c > hi.p && c.close[i - 1]! <= hi.p) {
    let sweepLo = Infinity;
    for (let j = i - ICT.mssBars; j <= i; j++) sweepLo = Math.min(sweepLo, c.bars[j]!.l);
    if (sweepLo < lo.p) return levelSig(c, i, 1, sweepLo - 0.1 * a, 2);
  }
  if (hi.at <= i - ICT.mssBars && lo.i > hi.i && lo.at <= i && b.c < lo.p && c.close[i - 1]! >= lo.p) {
    let sweepHi = -Infinity;
    for (let j = i - ICT.mssBars; j <= i; j++) sweepHi = Math.max(sweepHi, c.bars[j]!.h);
    if (sweepHi > hi.p) return levelSig(c, i, -1, sweepHi + 0.1 * a, 2);
  }
  return null;
}

/**
 * Prices seen from one side: for a short everything is mirrored (high ↔ −low), so each rule below is written once,
 * as the long, and `side` turns it into the short.
 */
function sided(c: Ctx, side: 1 | -1) {
  const B = c.bars;
  return {
    h: (j: number) => (side > 0 ? B[j]!.h : -B[j]!.l),
    l: (j: number) => (side > 0 ? B[j]!.l : -B[j]!.h),
    o: (j: number) => side * B[j]!.o,
    c: (j: number) => side * B[j]!.c,
  };
}

/**
 * v27.14 (owner's friend's long): IFVG + CISD + displacement. A gap AGAINST the trade (bearish fair-value gap for a
 * long) formed in the last 12 candles while the price ran down and took out the lows before it (a sweep). Then one
 * candle with a real body (≥ 1 ATR) closes above the gap's top — the gap is inverted — and above the open of the
 * down-candles that made the low (change in state of delivery). Only the first close through counts. Stop under the
 * low of the move, 2R (the engine lets a winner run past it on a trailing stop). Pure, causal.
 */
export function ifvgSignal(c: Ctx, i: number): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || i < ICT.sweepLook + ICT.ifvgLook + 4) return null;
  for (const side of [1, -1] as const) {
    const p = sided(c, side);
    if (!(p.c(i) > p.o(i)) || Math.abs(p.c(i) - p.o(i)) < ICT.ifvgBodyAtr * a) continue;
    for (let k = i - 1; k >= i - ICT.ifvgLook && k >= ICT.sweepLook + 2; k--) {
      // a gap against the trade: candle k−2's low sits above candle k's high, made by a falling candle k−1
      const top = p.l(k - 2);
      const bot = p.h(k);
      if (!(top > bot) || !(p.c(k - 1) < p.o(k - 1))) continue;
      if (!(p.c(i) > top)) continue;
      let first = true;
      for (let j = k + 1; j < i; j++) if (p.c(j) > top) first = false;
      if (!first) break; // the nearest gap was inverted earlier — this close is not the first one
      // the move into the low took out the lows before the gap (liquidity)
      let lowBefore = Infinity;
      for (let j = k - 2 - ICT.sweepLook; j < k - 2; j++) lowBefore = Math.min(lowBefore, p.l(j));
      let low = Infinity;
      let lowAt = k;
      for (let j = k - 2; j < i; j++) if (p.l(j) < low) { low = p.l(j); lowAt = j; }
      if (!(low < lowBefore)) break;
      // CISD: close above the open of the run of falling candles that delivered the low
      let m = lowAt;
      while (m > 0 && p.c(m) >= p.o(m)) m--;
      while (m > 0 && p.c(m - 1) < p.o(m - 1)) m--;
      if (!(p.c(i) > p.o(m))) break;
      return levelSig(c, i, side, side * (low - 0.1 * a), 2);
    }
  }
  return null;
}

/**
 * v27.14 (owner's friend's short): inversion, then the retrace into the CE. A displacement candle (body ≥ 1.2 ATR)
 * closes through the far side of a gap that was still holding (a bullish gap broken down = inverted) and leaves its
 * own gap the other way. Within 6 candles the price comes back to that new gap's middle (consequent encroachment)
 * and closes back on the trade's side of it → enter. Stop past the gap's far edge (or the retrace high), 2R. A gap
 * the price closes through is dead; only the first touch of the middle counts. Written as the long; mirrored. Pure.
 */
export function fvgCeSignal(c: Ctx, i: number): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || i < ICT.ceInvLook + ICT.fvgValidBars + 6) return null;
  for (const side of [1, -1] as const) {
    const p = sided(c, side);
    for (let k = i - 1; k >= i - ICT.fvgValidBars; k--) {
      const d = k - 1;
      // the displacement candle k−1 rises and leaves a gap: candle k−2's high under candle k's low
      if (!(p.c(d) > p.o(d)) || p.c(d) - p.o(d) < ICT.fvgBodyAtr * c.atr14[d]!) continue;
      const bot = p.h(k - 2);
      const top = p.l(k);
      if (!(top > bot)) continue;
      // it inverted a gap the other way: a bearish gap (q−2 low over q high) still unbroken until d, whose top d closed above
      let inverted = false;
      for (let q = k - 3; q >= k - 2 - ICT.ceInvLook && q >= 2 && !inverted; q--) {
        const gTop = p.l(q - 2);
        const gBot = p.h(q);
        if (!(gTop > gBot) || !(p.c(d) > gTop)) continue;
        let held = true;
        for (let j = q + 1; j < d; j++) if (p.c(j) > gTop) held = false;
        inverted = held;
      }
      if (!inverted) continue;
      const ce = (top + bot) / 2;
      let dead = false;
      let touched = false;
      for (let j = k + 1; j <= i; j++) {
        if (p.c(j) < bot) dead = true;
        if (j < i && p.l(j) <= ce) touched = true;
      }
      if (dead || touched || !(p.l(i) <= ce && p.c(i) > ce)) continue;
      let low = bot;
      for (let j = k + 1; j <= i; j++) low = Math.min(low, p.l(j));
      return levelSig(c, i, side, side * (low - 0.1 * a), 2);
    }
  }
  return null;
}

/** v27.16 pivot ladder: how tight the stop sits past the level (ATRs) and the least room to the target (R) */
export const LADDER = { stopAtr: 0.5, minR: 1.5 };
/**
 * v27.16 (owner's friend's MNQ trades, Oct 22: three longs bought at the day's pivot levels — P 29,834.50, S1 29,770.75 and
 * a level between — each with a ~10-point stop, all aiming at yesterday's high ~29,899). The classic daily pivots from
 * yesterday's high / low / close: P = (H+L+C)/3, S1 = 2P−H, S2 = P−(H−L), R1 = 2P−L, R2 = P+(H−L). Long: the candle comes
 * DOWN into a support (P, S1 or S2 under the previous close, the previous candle still above it), trades through it and
 * closes back above → buy, stop ½ ATR under the level, target yesterday's HIGH (needs ≥ 1.5R of room). Short mirrored with
 * P / R1 / R2 and yesterday's LOW. The highest support touched wins. Pure, causal (yesterday is a finished day).
 * v27.17 (the owner's second level list: 29,813.75 ≈ the middle of yesterday's range, (29,601.25) ≈ S3): also the 50% of
 * yesterday's range (both sides) and S3 = L − 2(H−P) / R3 = H + 2(P−L).
 */
export function pivotLadderSignal(c: Ctx, i: number): Signal | null {
  const d = c.prevDay[i];
  const a = c.atr14[i]!;
  if (!d || i < 1 || !ok(a) || a <= 0) return null;
  const pv = (d.h + d.l + d.c) / 3;
  const rng = d.h - d.l;
  const b = c.bars[i]!;
  const pb = c.bars[i - 1]!;
  const mid = (d.h + d.l) / 2;
  const longs = [pv, mid, 2 * pv - d.h, pv - rng, d.l - 2 * (d.h - pv)].sort((x, y) => y - x);
  for (const lv of longs) {
    if (pb.l > lv && b.l <= lv && b.c > lv && d.h > b.c) {
      const s = levelSig(c, i, 1, lv - LADDER.stopAtr * a, null);
      if (s && (d.h - b.c) >= LADDER.minR * (b.c - s.stop)) return { ...s, target: d.h };
      return null;
    }
  }
  const shorts = [pv, mid, 2 * pv - d.l, pv + rng, d.h + 2 * (pv - d.l)].sort((x, y) => x - y);
  for (const lv of shorts) {
    if (pb.h < lv && b.h >= lv && b.c < lv && d.l < b.c) {
      const s = levelSig(c, i, -1, lv + LADDER.stopAtr * a, null);
      if (s && (b.c - d.l) >= LADDER.minR * (s.stop - b.c)) return { ...s, target: d.l };
      return null;
    }
  }
  return null;
}

/** v16: crosses of closely linked currencies — where a stretched price tends to come back (the stat-arb candidates) */
export const STAT_ARB_PAIRS = ['EURGBP', 'AUDNZD', 'EURCHF'];
/** v16: the "big figure" step of a market: 100 pips for FX (1.1700, 150.00), $10 for gold, $0.50 for silver */
export function roundStep(pair: string): number {
  if (pair === 'XAUUSD') return 10;
  if (pair === 'XAGUSD') return 0.5;
  // v27: index round numbers (stops and take-profits cluster there too)
  if (pair === 'NDXUSD') return 100;
  if (pair === 'SPXUSD') return 25;
  if (pair === 'DJIUSD') return 250;
  if (pair === 'RUTUSD') return 10;
  if (pair === 'BTCUSD') return 1000;
  if (pair === 'XRPUSD' || pair === 'ADAUSD') return 0.1;
  if (pair === 'DOGEUSD') return 0.01;
  if (pair === 'LINKUSD' || pair === 'AVAXUSD') return 1;
  if (pair === 'ETHUSD') return 100;
  if (pair === 'SOLUSD') return 10;
  return pair.endsWith('JPY') ? 1 : 0.01;
}

/** v27.35 thresholds for the deviation / volume-profile / order-flow rules */
export const DEV = {
  /** regression channel: "flat" = the line moves less than this many residual SDs over its 50 bars */
  flatSd: 1.5,
  revertIn: 2.2,
  revertOut: 2,
  trendR2: 0.6,
  pullZ: 1.8,
  breakZ: 2.5,
  quietR2: 0.3,
  balanceBars: 12,
  absorbLook: 20,
  absorbCmf: 0.05,
  thrustCmf: 0.15,
  thrustRelVol: 1.3,
  climaxRelVol: 3,
  climaxRange: 1.8,
};

/** the lowest sided low of the last n bars up to i, minus 0.2 ATR → a stop in real price. */
function swingStop(c: Ctx, i: number, side: 1 | -1, n = 3): number {
  const p = sided(c, side);
  let lo = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) lo = Math.min(lo, p.l(j));
  return side * (lo - 0.2 * c.atr14[i]!);
}
/** a stop-level signal with a price target that must be ≥ minR away. */
function toTarget(c: Ctx, i: number, side: 1 | -1, stop: number, target: number, minR = 1): Signal | null {
  const s = levelSig(c, i, side, stop, null);
  if (!s) return null;
  const px = c.close[i]!;
  const risk = (px - stop) * side;
  if (!((target - px) * side >= minR * risk)) return null;
  return { ...s, target };
}

/** Flat regression channel, the close came back inside after ≥ 2.2 SD away → back to the line. Pure. */
export function sdRevertSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  if (i < 3 || !ok(f.lrZ[i]!, f.lrSd[i]!, f.lrSlope[i]!)) return null;
  if (Math.abs(f.lrSlope[i]! * 49) > DEV.flatSd * f.lrSd[i]!) return null;
  for (const side of [1, -1] as const) {
    const z = side * f.lrZ[i]!;
    const prev = Math.min(side * f.lrZ[i - 1]!, side * f.lrZ[i - 2]!, side * f.lrZ[i - 3]!);
    if (!(prev <= -DEV.revertIn && z > -DEV.revertOut && side * f.lrZ[i - 1]! <= -DEV.revertOut)) continue;
    return toTarget(c, i, side, swingStop(c, i, side), f.lrMid[i]!);
  }
  return null;
}

/** Clean rising channel (R² ≥ 0.6), the price dipped to the lower 1.8-SD band and turns up → target 1 SD over the line. */
export function lrChannelSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  if (i < 3 || !ok(f.lrZ[i]!, f.lrR2[i]!, f.lrSlope[i]!, f.lrSd[i]!) || f.lrR2[i]! < DEV.trendR2) return null;
  const side: 1 | -1 = f.lrSlope[i]! > 0 ? 1 : -1;
  const p = sided(c, side);
  const touched = Math.min(side * f.lrZ[i - 1]!, side * f.lrZ[i - 2]!) <= -DEV.pullZ;
  if (!touched || !(side * f.lrZ[i]! > -1.5) || !(p.c(i) > p.o(i))) return null;
  return toTarget(c, i, side, swingStop(c, i, side), f.lrMid[i]! + side * f.lrSd[i]!);
}

/** A quiet, trendless channel (R² < 0.3) and the close jumps 2.5 SD off the line → follow it; stop at the line, 2R. */
export function sdBreakoutSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  if (i < 2 || !ok(f.lrZ[i]!, f.lrZ[i - 1]!, f.lrR2[i - 1]!) || f.lrR2[i - 1]! >= DEV.quietR2) return null;
  const b = c.bars[i]!;
  if (!(b.h > b.l) || Math.abs(b.c - b.o) < 0.5 * (b.h - b.l)) return null;
  for (const side of [1, -1] as const) {
    if (side * f.lrZ[i]! >= DEV.breakZ && side * f.lrZ[i - 1]! < 2 && side * (b.c - b.o) > 0) return levelSig(c, i, side, f.lrMid[i]!, 2);
  }
  return null;
}

/** Closed outside the value area, now back inside → rotate to the POC (the "80% rule"). Pure. */
export function vpReentrySignal(c: Ctx, i: number): Signal | null {
  const vp = flowOf(c).vp(i - 1);
  if (!vp || i < 2) return null;
  for (const side of [1, -1] as const) {
    const p = sided(c, side);
    const edge = side > 0 ? vp.val : -vp.vah;
    const far = side > 0 ? vp.vah : -vp.val;
    if (!(p.c(i - 1) < edge && p.c(i) > edge && p.c(i) < far)) continue;
    return toTarget(c, i, side, swingStop(c, i, side), vp.poc);
  }
  return null;
}

/** 12 closes balanced inside the value area, then a solid close out of it → follow the break; stop half an ATR back inside. */
export function vpBreakoutSignal(c: Ctx, i: number): Signal | null {
  const vp = flowOf(c).vp(i - 1);
  const a = c.atr14[i]!;
  if (!vp || !ok(a) || i < DEV.balanceBars + 1) return null;
  const b = c.bars[i]!;
  if (!(b.h > b.l) || Math.abs(b.c - b.o) < 0.5 * (b.h - b.l)) return null;
  for (let j = i - DEV.balanceBars; j < i; j++) if (c.close[j]! > vp.vah || c.close[j]! < vp.val) return null;
  for (const side of [1, -1] as const) {
    const edge = side > 0 ? vp.vah : vp.val;
    if (side * (b.c - edge) > 0 && side * (b.c - b.o) > 0) return levelSig(c, i, side, edge - side * 0.5 * a, 2);
  }
  return null;
}

/** New 20-bar low, yet money flow is positive and rising, candle closed in its upper half → absorption, buy. Volume only. */
export function ofAbsorbSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  if (!f.hasVol || i < DEV.absorbLook + 10 || !ok(f.cmf[i]!, f.cmf[i - 10]!)) return null;
  for (const side of [1, -1] as const) {
    const p = sided(c, side);
    let lo = Infinity;
    for (let j = i - DEV.absorbLook; j < i; j++) lo = Math.min(lo, p.l(j));
    const range = p.h(i) - p.l(i);
    if (!(p.l(i) < lo) || !(range > 0) || p.c(i) - p.l(i) < 0.5 * range) continue;
    if (!(side * f.cmf[i]! > DEV.absorbCmf && side * f.cmf[i]! > side * f.cmf[i - 10]!)) continue;
    return levelSig(c, i, side, side * (p.l(i) - 0.2 * c.atr14[i]!), 2);
  }
  return null;
}

/** Money flow crosses +0.15 on above-normal volume, price above its 50 average → go with the buyers. Volume only. */
export function ofThrustSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  if (!f.hasVol || i < 1 || !ok(f.cmf[i]!, f.cmf[i - 1]!, f.relVol[i]!, c.ema50[i]!)) return null;
  if (f.relVol[i]! < DEV.thrustRelVol) return null;
  for (const side of [1, -1] as const) {
    if (side * f.cmf[i - 1]! < DEV.thrustCmf && side * f.cmf[i]! >= DEV.thrustCmf && side * (c.close[i]! - c.ema50[i]!) > 0) return atrSig(c, i, side, 1.5, 2);
  }
  return null;
}

/** Selling climax: 3× normal volume, a candle ≥ 1.8 ATR to a 20-bar low that closes in its top 40% → buy, 1.5R. Volume only. */
export function ofClimaxSignal(c: Ctx, i: number): Signal | null {
  const f = flowOf(c);
  const pa = c.atr14[i - 1]!;
  if (!f.hasVol || i < DEV.absorbLook + 1 || !ok(f.relVol[i]!, pa) || f.relVol[i]! < DEV.climaxRelVol) return null;
  for (const side of [1, -1] as const) {
    const p = sided(c, side);
    const range = p.h(i) - p.l(i);
    if (range < DEV.climaxRange * pa || p.c(i) - p.l(i) < 0.6 * range) continue;
    let lo = Infinity;
    for (let j = i - DEV.absorbLook; j < i; j++) lo = Math.min(lo, p.l(j));
    if (!(p.l(i) < lo)) continue;
    return levelSig(c, i, side, side * (p.l(i) - 0.1 * c.atr14[i]!), 1.5);
  }
  return null;
}

/**
 * v27.36 the owner's friend: "I only trade the Asia open and wait until my level gets hit. If sellers or buyers get
 * absorbed there, I enter. I check every timeframe and enter on the 1-minute." His levels (the bigger charts): yesterday's
 * and last week's high / low and the untouched major swing points (the extreme of the 40 candles before them, never
 * traded through since). The level is hit for the first time in 12 candles, the candle that tags it shows absorption
 * (`absorptionAt`) without blowing more than ½ ATR through it → enter at the close; stop just past that candle; target
 * the nearest level on the other side at least 2R away (the draw on liquidity, ≤ 8R), else 3R; flat after a day.
 */
export const ASIA = { from: 18 * 60, to: 23 * 60, fresh: 12, swingLook: 40, maxSwings: 8, through: 0.5, minR: 2, maxR: 20, fallbackR: 3 };

/** the friend's levels seen from `side` (sided prices): `near` = support for a long, `far` = the targets above. */
function friendLevels(c: Ctx, i: number, side: 1 | -1, beforeBar: number): { near: number[]; far: number[] } {
  const near: number[] = [];
  const far: number[] = [];
  const pd = c.prevDay[i];
  const wk = flowOf(c).week[i];
  for (const x of [pd, wk]) {
    if (!x) continue;
    near.push(side > 0 ? x.l : -x.h);
    far.push(side > 0 ? x.h : -x.l);
  }
  const major = (list: typeof c.sw.lows, ptr: number, low: boolean, into: number[]) => {
    for (let k = ptr; k >= 0 && k > ptr - ASIA.maxSwings; k--) {
      const sw = list[k]!;
      let extreme = true;
      for (let j = Math.max(0, sw.i - ASIA.swingLook); j < sw.i && extreme; j++) if (low ? c.bars[j]!.l < sw.p : c.bars[j]!.h > sw.p) extreme = false;
      if (!extreme) continue;
      let untouched = true;
      for (let j = sw.i + 1; j < beforeBar && untouched; j++) if (low ? c.bars[j]!.l < sw.p : c.bars[j]!.h > sw.p) untouched = false;
      if (untouched) into.push(side * sw.p);
    }
  };
  // support for a long = swing lows; for a short the swing highs (mirrored) — and the other kind are the targets
  major(side > 0 ? c.sw.lows : c.sw.highs, side > 0 ? c.loPtr[i]! : c.hiPtr[i]!, side > 0, near);
  major(side > 0 ? c.sw.highs : c.sw.lows, side > 0 ? c.hiPtr[i]! : c.loPtr[i]!, side < 0, far);
  return { near, far };
}

/** Level hit + absorption → enter (see ASIA). `asiaOnly` = only when the candle closes 18:00–23:00 New York. Pure. */
export function levelAbsorbSignal(c: Ctx, i: number, asiaOnly: boolean): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || i < ASIA.swingLook + ASIA.fresh) return null;
  if (asiaOnly) {
    const closeMin = (c.nyMin[i]! + c.barMin) % 1440;
    if (closeMin <= ASIA.from || closeMin > ASIA.to) return null;
  }
  for (const side of [1, -1] as const) {
    const ab = absorptionAt(c, i, side);
    if (!ab) continue;
    const before = absorptionAt(c, i - 1, side);
    if (before && before.j === ab.j) continue; // already signalled on this absorption
    const p = sided(c, side);
    const low = side * ab.extreme;
    const lv = friendLevels(c, i, side, ab.j);
    const hit = lv.near.find((L) => low <= L + 0.1 * a && low >= L - ASIA.through * a && (() => {
      for (let j = Math.max(0, ab.j - ASIA.fresh); j < ab.j; j++) if (p.l(j) <= L) return false;
      return true;
    })());
    if (hit === undefined) continue;
    // v27.37 his very strict stop: just past the absorbing candle, but never wider than his 10 Nasdaq points (scaled per
    // market) — on a 15-minute / hourly candle that often puts it inside the candle, where his 1-minute entry would sit
    const px = p.c(i);
    const risk = Math.min(px - (low - 0.1 * a), strictStopDist(c.pair, c.close[i]!));
    if (!(risk > 0)) continue;
    const stop = side * (px - risk);
    const tgt = lv.far.filter((T) => T - px >= ASIA.minR * risk && T - px <= ASIA.maxR * risk).sort((x, y) => x - y)[0];
    const target = side * (tgt ?? px + ASIA.fallbackR * risk);
    return { side, stop, target, maxBars: Math.max(4, Math.round(1440 / c.barMin)) };
  }
  return null;
}

/** v27.51: trade levels posted by a signal provider (Kojiro's "Levels" list). The newest candle is the absorption candle
 * at one of `levels` (same test as `level_absorb`: a new 10-candle low that closes strong, ≤ ½ ATR through the level,
 * first touch since the post) → enter at its close, stop 0.15 ATR past the candle's extreme (at least 0.3 ATR — not the
 * 10-point strict stop: the venue fee is a share of the position and would eat a stop that tight), target = his next
 * level the other way at least 1R off (none → no target; the profit lock trails it). Only candles after `postedT`.
 * His daily plan: `onlySide` (bias) keeps only his direction, `dol` is the target when ≥ 1R away. Pure. */
export function postedLevelSignal(c: Ctx, i: number, levels: readonly number[], postedT: number, onlySide: 1 | -1 | 0 = 0, dol: number | null = null): Signal | null {
  const a = c.atr14[i]!;
  if (!ok(a) || a <= 0 || !levels.length || c.bars[i]!.t < postedT) return null;
  for (const side of [1, -1] as const) {
    if (onlySide && side !== onlySide) continue; // his bias: only his way
    const ab = absorptionAt(c, i, side);
    if (!ab || c.bars[ab.j]!.t < postedT) continue;
    const before = absorptionAt(c, i - 1, side);
    if (before && before.j === ab.j) continue;
    const p = sided(c, side);
    const low = side * ab.extreme;
    const firstAfter = c.bars.findIndex((b) => b.t >= postedT);
    const hit = levels
      .map((L) => side * L)
      .find((L) => low <= L + 0.1 * a && low >= L - ASIA.through * a && (() => {
        for (let j = Math.max(firstAfter, ab.j - ASIA.fresh); j < ab.j; j++) if (p.l(j) <= L) return false;
        return true;
      })());
    if (hit === undefined) continue;
    const px = p.c(i);
    const risk = Math.max(px - (low - 0.15 * a), 0.3 * a);
    // his DOL (draw on liquidity) is the target when it is at least 1R his way, else his next level
    const tgt = dol !== null && side * dol - px >= risk ? side * dol : levels.map((L) => side * L).filter((T) => T - px >= risk).sort((x, y) => x - y)[0];
    return { side, stop: side * (px - risk), target: tgt === undefined ? null : side * tgt, maxBars: Math.max(4, Math.round(1440 / c.barMin)) };
  }
  return null;
}

export const STRATEGIES: Strategy[] = [
  // ── trend ──
  {
    id: 'ema_cross',
    name: 'EMA 20/50 cross',
    family: 'trend',
    desc: 'Fast average crosses the slow one in the direction of the 200; trail 3 ATR.',
    signal(c, i) {
      if (!ok(c.ema200[i]!)) return null;
      if (crossUp(c.ema20, c.ema50, i) && c.close[i]! > c.ema200[i]!) return atrSig(c, i, 1, 2, null, { trailAtr: 3 });
      if (crossDn(c.ema20, c.ema50, i) && c.close[i]! < c.ema200[i]!) return atrSig(c, i, -1, 2, null, { trailAtr: 3 });
      return null;
    },
  },
  {
    id: 'ema_pullback',
    name: 'Trend pullback to the 20 EMA',
    family: 'trend',
    desc: 'Uptrend (20 > 50 > 200), price dips to the 20 EMA and closes back above it; 2R target.',
    signal(c, i) {
      const b = c.bars[i]!;
      if (!ok(c.ema200[i]!, c.ema50[i]!, c.ema20[i]!)) return null;
      if (c.ema20[i]! > c.ema50[i]! && c.ema50[i]! > c.ema200[i]! && b.l <= c.ema20[i]! && b.c > c.ema20[i]! && b.c > b.o) return levelSig(c, i, 1, Math.min(b.l, c.lo10[i]!) - 0.2 * c.atr14[i]!, 2);
      if (c.ema20[i]! < c.ema50[i]! && c.ema50[i]! < c.ema200[i]! && b.h >= c.ema20[i]! && b.c < c.ema20[i]! && b.c < b.o) return levelSig(c, i, -1, Math.max(b.h, c.hi10[i]!) + 0.2 * c.atr14[i]!, 2);
      return null;
    },
  },
  {
    id: 'supertrend',
    name: 'Supertrend flip',
    family: 'trend',
    desc: 'Supertrend (10, 3) changes direction; stop on the line, trail 3 ATR.',
    signal(c, i) {
      const d = c.st.dir;
      if (!ok(d[i]!, d[i - 1]!)) return null;
      if (d[i - 1] === -1 && d[i] === 1) return levelSig(c, i, 1, c.st.line[i]!, null, { trailAtr: 3 });
      if (d[i - 1] === 1 && d[i] === -1) return levelSig(c, i, -1, c.st.line[i]!, null, { trailAtr: 3 });
      return null;
    },
  },
  {
    id: 'macd_trend',
    name: 'MACD cross with the trend',
    family: 'trend',
    desc: 'MACD crosses its signal line above zero, price above the 200; 2 ATR stop, 2R.',
    signal(c, i) {
      const m = c.macd;
      if (!ok(m.line[i]!, m.signal[i]!, c.ema200[i]!)) return null;
      if (crossUp(m.line, m.signal, i) && m.line[i]! > 0 && c.close[i]! > c.ema200[i]!) return atrSig(c, i, 1, 2, 2);
      if (crossDn(m.line, m.signal, i) && m.line[i]! < 0 && c.close[i]! < c.ema200[i]!) return atrSig(c, i, -1, 2, 2);
      return null;
    },
  },
  {
    id: 'adx_trend',
    name: 'ADX strong trend + pullback',
    family: 'trend',
    desc: 'ADX > 25 with +DI over −DI, RSI pulls back to 40–50 and turns up; 2R.',
    signal(c, i) {
      const { adx, pdi, mdi } = c.adx;
      if (!ok(adx[i]!, pdi[i]!, mdi[i]!, c.rsi14[i]!, c.rsi14[i - 1]!) || adx[i]! < 25) return null;
      if (pdi[i]! > mdi[i]! && c.rsi14[i - 1]! >= 40 && c.rsi14[i - 1]! <= 50 && c.rsi14[i]! > c.rsi14[i - 1]!) return atrSig(c, i, 1, 1.5, 2);
      if (mdi[i]! > pdi[i]! && c.rsi14[i - 1]! >= 50 && c.rsi14[i - 1]! <= 60 && c.rsi14[i]! < c.rsi14[i - 1]!) return atrSig(c, i, -1, 1.5, 2);
      return null;
    },
  },
  {
    id: 'trendline_break',
    name: 'Trendline break',
    family: 'trend',
    desc: 'Line through the last two falling swing highs (or rising lows); close breaks through it; 2R.',
    signal(c, i) {
      const line = (a: { i: number; p: number }, b: { i: number; p: number }) => a.p + ((b.p - a.p) / (b.i - a.i)) * (i - a.i);
      const [h1, h2] = lastHighs(c, i, 2);
      if (h1 && h2 && h2.p < h1.p && i - h1.i <= 80) {
        const now = line(h1, h2);
        const prev = now - (h2.p - h1.p) / (h2.i - h1.i);
        if (c.close[i]! > now && c.close[i - 1]! <= prev) {
          const lo = lastLows(c, i, 1)[0];
          return levelSig(c, i, 1, lo ? Math.min(lo.p, c.bars[i]!.l) : c.bars[i]!.l - c.atr14[i]!, 2);
        }
      }
      const [l1, l2] = lastLows(c, i, 2);
      if (l1 && l2 && l2.p > l1.p && i - l1.i <= 80) {
        const now = line(l1, l2);
        const prev = now - (l2.p - l1.p) / (l2.i - l1.i);
        if (c.close[i]! < now && c.close[i - 1]! >= prev) {
          const hi = lastHighs(c, i, 1)[0];
          return levelSig(c, i, -1, hi ? Math.max(hi.p, c.bars[i]!.h) : c.bars[i]!.h + c.atr14[i]!, 2);
        }
      }
      return null;
    },
  },
  {
    id: 'structure_break',
    name: 'Break of structure',
    family: 'trend',
    desc: 'A higher low forms, then price closes above the last swing high (mirror for shorts); 2R.',
    signal(c, i) {
      const [la, lb] = lastLows(c, i, 2);
      const h = lastHighs(c, i, 1)[0];
      if (la && lb && h && lb.p > la.p && h.i < lb.i + 30 && c.close[i]! > h.p && c.close[i - 1]! <= h.p) return levelSig(c, i, 1, lb.p - 0.2 * c.atr14[i]!, 2);
      const [ha, hb] = lastHighs(c, i, 2);
      const l = lastLows(c, i, 1)[0];
      if (ha && hb && l && hb.p < ha.p && l.i < hb.i + 30 && c.close[i]! < l.p && c.close[i - 1]! >= l.p) return levelSig(c, i, -1, hb.p + 0.2 * c.atr14[i]!, 2);
      return null;
    },
  },
  // ── breakout ──
  {
    id: 'donchian20',
    name: 'Donchian 20 breakout',
    family: 'breakout',
    desc: 'Close above the 20-bar high (turtle style); 2 ATR stop, trail 2.5 ATR.',
    signal(c, i) {
      if (!ok(c.hi20[i - 1]!, c.lo20[i - 1]!)) return null;
      if (c.close[i]! > c.hi20[i - 1]!) return atrSig(c, i, 1, 2, null, { trailAtr: 2.5 });
      if (c.close[i]! < c.lo20[i - 1]!) return atrSig(c, i, -1, 2, null, { trailAtr: 2.5 });
      return null;
    },
  },
  {
    id: 'donchian55',
    name: 'Donchian 55 breakout',
    family: 'breakout',
    desc: 'Close above the 55-bar high; 2 ATR stop, trail 3 ATR. Slower, fewer false breaks.',
    signal(c, i) {
      if (!ok(c.hi55[i - 1]!, c.lo55[i - 1]!)) return null;
      if (c.close[i]! > c.hi55[i - 1]!) return atrSig(c, i, 1, 2, null, { trailAtr: 3 });
      if (c.close[i]! < c.lo55[i - 1]!) return atrSig(c, i, -1, 2, null, { trailAtr: 3 });
      return null;
    },
  },
  {
    id: 'bb_squeeze',
    name: 'Bollinger squeeze breakout',
    family: 'breakout',
    desc: 'Bands at their tightest in 100 bars, then a close outside a band; 1.5 ATR stop, 2R.',
    signal(c, i) {
      const w = c.bb.width;
      if (!ok(w[i - 1]!, c.bbWidthLow100[i - 1]!, c.bb.upper[i]!)) return null;
      const squeezed = w[i - 1]! <= c.bbWidthLow100[i - 1]! * 1.05;
      if (!squeezed) return null;
      if (c.close[i]! > c.bb.upper[i]!) return atrSig(c, i, 1, 1.5, 2);
      if (c.close[i]! < c.bb.lower[i]!) return atrSig(c, i, -1, 1.5, 2);
      return null;
    },
  },
  {
    id: 'keltner',
    name: 'Keltner channel breakout',
    family: 'breakout',
    desc: 'Close more than 2 ATR above the 20 EMA (strong impulse); trail 2 ATR.',
    signal(c, i) {
      const a = c.atr14[i]!;
      if (!ok(a, c.ema20[i]!)) return null;
      const up = c.ema20[i]! + 2 * a;
      const dn = c.ema20[i]! - 2 * a;
      if (c.close[i]! > up && c.close[i - 1]! <= c.ema20[i - 1]! + 2 * c.atr14[i - 1]!) return atrSig(c, i, 1, 1.5, null, { trailAtr: 2 });
      if (c.close[i]! < dn && c.close[i - 1]! >= c.ema20[i - 1]! - 2 * c.atr14[i - 1]!) return atrSig(c, i, -1, 1.5, null, { trailAtr: 2 });
      return null;
    },
  },
  {
    id: 'inside_bar',
    name: 'Inside bar breakout',
    family: 'breakout',
    desc: 'An inside bar, then a close beyond the mother bar in the trend direction; stop the other side, 2R.',
    signal(c, i) {
      const m = c.bars[i - 2];
      const ib = c.bars[i - 1];
      if (!m || !ib || !ok(c.ema50[i]!) || !(ib.h < m.h && ib.l > m.l)) return null;
      if (c.close[i]! > m.h && c.close[i]! > c.ema50[i]!) return levelSig(c, i, 1, m.l, 2);
      if (c.close[i]! < m.l && c.close[i]! < c.ema50[i]!) return levelSig(c, i, -1, m.h, 2);
      return null;
    },
  },
  {
    id: 'breakout_retest',
    name: 'Breakout + retest',
    family: 'breakout',
    desc: 'Breaks the 20-bar high, pulls back to it within 6 bars and closes above again; 2R.',
    signal(c, i) {
      for (let k = 2; k <= 6; k++) {
        const j = i - k;
        if (j < 21 || !ok(c.hi20[j - 1]!, c.lo20[j - 1]!)) continue;
        const lvl = c.hi20[j - 1]!;
        if (c.close[j]! > lvl && c.bars[i]!.l <= lvl && c.close[i]! > lvl && c.close[i]! > c.bars[i]!.o) return levelSig(c, i, 1, lvl - c.atr14[i]!, 2);
        const lv2 = c.lo20[j - 1]!;
        if (c.close[j]! < lv2 && c.bars[i]!.h >= lv2 && c.close[i]! < lv2 && c.close[i]! < c.bars[i]!.o) return levelSig(c, i, -1, lv2 + c.atr14[i]!, 2);
      }
      return null;
    },
  },
  // ── session (hourly only) ──
  {
    id: 'london_breakout',
    name: 'London breakout',
    family: 'session',
    desc: 'Asian range (00–07 UTC); first close outside it 07–11 UTC; stop the other side, 1.5R, out by 20 UTC.',
    onlyHourly: true,
    signal(c, i) {
      const h = c.hour[i]!;
      const r = c.asia[i];
      if (!r || h < 7 || h > 10) return null;
      // only the FIRST break of the day
      for (let j = i - 1; j >= 0 && c.hour[j]! >= 7 && c.asia[j]; j--) if (c.close[j]! > r.h || c.close[j]! < r.l) return null;
      const bars = 20 - h;
      if (c.close[i]! > r.h) return levelSig(c, i, 1, r.l, 1.5, { maxBars: bars });
      if (c.close[i]! < r.l) return levelSig(c, i, -1, r.h, 1.5, { maxBars: bars });
      return null;
    },
  },
  {
    id: 'ny_open',
    name: 'New York open breakout',
    family: 'session',
    desc: 'Range of the 12–13 UTC hour; first close outside it 13–16 UTC; stop the other side, 1.5R, out by 21 UTC.',
    onlyHourly: true,
    signal(c, i) {
      const h = c.hour[i]!;
      if (h < 13 || h > 16) return null;
      let j0 = -1;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) if (c.hour[j] === 12) j0 = j;
      if (j0 < 0) return null;
      const rh = c.bars[j0]!.h;
      const rl = c.bars[j0]!.l;
      for (let j = j0 + 1; j < i; j++) if (c.close[j]! > rh || c.close[j]! < rl) return null;
      if (c.close[i]! > rh) return levelSig(c, i, 1, rl, 1.5, { maxBars: 21 - h });
      if (c.close[i]! < rl) return levelSig(c, i, -1, rh, 1.5, { maxBars: 21 - h });
      return null;
    },
  },
  {
    id: 'pdh_pdl',
    name: 'Previous day high / low break',
    family: 'session',
    desc: "Close beyond yesterday's high or low during London/NY (07–17 UTC); 1.5 ATR stop, 2R.",
    onlyHourly: true,
    signal(c, i) {
      const p = c.prevDay[i];
      const h = c.hour[i]!;
      if (!p || h < 7 || h > 17) return null;
      if (c.close[i]! > p.h && c.close[i - 1]! <= p.h) return atrSig(c, i, 1, 1.5, 2);
      if (c.close[i]! < p.l && c.close[i - 1]! >= p.l) return atrSig(c, i, -1, 1.5, 2);
      return null;
    },
  },
  // ── mean reversion ──
  {
    id: 'rsi_dip',
    name: 'RSI dip in an uptrend',
    family: 'reversion',
    desc: 'Above the 200 EMA, RSI(14) falls under 30 then crosses back up; out at the 20 EMA or 1.5R.',
    signal(c, i) {
      if (!ok(c.rsi14[i]!, c.rsi14[i - 1]!, c.ema200[i]!)) return null;
      if (c.close[i]! > c.ema200[i]! && c.rsi14[i - 1]! < 30 && c.rsi14[i]! >= 30) return atrSig(c, i, 1, 1.5, 1.5, { exitWhen: 'ema20' });
      if (c.close[i]! < c.ema200[i]! && c.rsi14[i - 1]! > 70 && c.rsi14[i]! <= 70) return atrSig(c, i, -1, 1.5, 1.5, { exitWhen: 'ema20' });
      return null;
    },
  },
  {
    id: 'rsi2',
    name: 'RSI(2) pullback (Connors)',
    family: 'reversion',
    desc: 'Above the 200, RSI(2) under 10 → buy; out when price closes above the 5 SMA; 3 ATR safety stop.',
    signal(c, i) {
      if (!ok(c.rsi2[i]!, c.ema200[i]!)) return null;
      if (c.close[i]! > c.ema200[i]! && c.rsi2[i]! < 10) return atrSig(c, i, 1, 3, null, { exitWhen: 'aboveSma5', maxBars: 20 });
      if (c.close[i]! < c.ema200[i]! && c.rsi2[i]! > 90) return atrSig(c, i, -1, 3, null, { exitWhen: 'aboveSma5', maxBars: 20 });
      return null;
    },
  },
  {
    id: 'bb_reversion',
    name: 'Bollinger band reversion',
    family: 'reversion',
    desc: 'Close outside the lower band, next close back inside; target the middle band, 1.5 ATR stop.',
    signal(c, i) {
      const { upper, lower } = c.bb;
      if (!ok(upper[i]!, lower[i]!, upper[i - 1]!, lower[i - 1]!)) return null;
      if (c.close[i - 1]! < lower[i - 1]! && c.close[i]! > lower[i]!) return atrSig(c, i, 1, 1.5, null, { exitWhen: 'midBand', maxBars: 30 });
      if (c.close[i - 1]! > upper[i - 1]! && c.close[i]! < upper[i]!) return atrSig(c, i, -1, 1.5, null, { exitWhen: 'midBand', maxBars: 30 });
      return null;
    },
  },
  {
    id: 'pivot_ladder',
    name: 'Pivot ladder: buy the day\'s pivot levels, aim for yesterday\'s high',
    family: 'reversion',
    desc: 'The daily pivot levels from yesterday\'s high / low / close (P, S1, S2, S3 under the price; P, R1, R2, R3 above) plus the middle of yesterday\'s range. Price comes down into a support level, pokes through and closes back above it → buy with a tight stop ½ ATR under the level, target yesterday\'s high (needs at least 1.5R of room), then a trailing stop. Mirrored for shorts toward yesterday\'s low. The trade your friend took on the Nasdaq.',
    signal(c, i) {
      return pivotLadderSignal(c, i);
    },
  },
  {
    id: 'pivot_bounce',
    name: 'Daily pivot S1/R1 bounce',
    family: 'reversion',
    desc: 'Price tags S1 (from yesterday) and closes back above it; target the pivot, stop 1 ATR under S1.',
    signal(c, i) {
      const p = c.prevDay[i];
      if (!p) return null;
      const pv = (p.h + p.l + p.c) / 3;
      const s1 = 2 * pv - p.h;
      const r1 = 2 * pv - p.l;
      const b = c.bars[i]!;
      const a = c.atr14[i]!;
      if (b.l <= s1 && b.c > s1 && b.c < pv) {
        const s = levelSig(c, i, 1, s1 - a, null);
        return s ? { ...s, target: pv } : null;
      }
      if (b.h >= r1 && b.c < r1 && b.c > pv) {
        const s = levelSig(c, i, -1, r1 + a, null);
        return s ? { ...s, target: pv } : null;
      }
      return null;
    },
  },
  {
    id: 'fib_pullback',
    name: 'Fibonacci 50–61.8% pullback',
    family: 'reversion',
    desc: 'Uptrend; last swing low→high; price retraces into 0.5–0.618 and closes bullish; stop under 0.786, target the high.',
    signal(c, i) {
      if (!ok(c.ema50[i]!, c.ema200[i]!)) return null;
      const lo = lastLows(c, i, 1)[0];
      const hi = lastHighs(c, i, 1)[0];
      if (!lo || !hi) return null;
      const b = c.bars[i]!;
      if (c.ema50[i]! > c.ema200[i]! && lo.i < hi.i) {
        const range = hi.p - lo.p;
        const z1 = hi.p - 0.5 * range;
        const z2 = hi.p - 0.618 * range;
        if (b.l <= z1 && b.l >= z2 - 0.05 * range && b.c > b.o && b.c > z2) {
          const s = levelSig(c, i, 1, hi.p - 0.786 * range, null);
          return s ? { ...s, target: hi.p } : null;
        }
      }
      if (c.ema50[i]! < c.ema200[i]! && hi.i < lo.i) {
        const range = hi.p - lo.p;
        const z1 = lo.p + 0.5 * range;
        const z2 = lo.p + 0.618 * range;
        if (b.h >= z1 && b.h <= z2 + 0.05 * range && b.c < b.o && b.c < z2) {
          const s = levelSig(c, i, -1, lo.p + 0.786 * range, null);
          return s ? { ...s, target: lo.p } : null;
        }
      }
      return null;
    },
  },
  // ── patterns ──
  {
    id: 'engulfing',
    name: 'Engulfing at a 20-bar extreme',
    family: 'pattern',
    desc: 'Bullish engulfing candle near the 20-bar low (bearish at the high); stop past the pattern, 2R.',
    signal(c, i) {
      const p = c.bars[i - 1]!;
      const b = c.bars[i]!;
      const a = c.atr14[i]!;
      if (!ok(a, c.lo20[i]!, c.hi20[i]!)) return null;
      if (p.c < p.o && b.c > b.o && b.c >= p.o && b.o <= p.c && Math.min(p.l, b.l) <= c.lo20[i]! + 0.3 * a) return levelSig(c, i, 1, Math.min(p.l, b.l) - 0.2 * a, 2);
      if (p.c > p.o && b.c < b.o && b.c <= p.o && b.o >= p.c && Math.max(p.h, b.h) >= c.hi20[i]! - 0.3 * a) return levelSig(c, i, -1, Math.max(p.h, b.h) + 0.2 * a, 2);
      return null;
    },
  },
  {
    id: 'pin_bar',
    name: 'Pin bar (hammer) at support',
    family: 'pattern',
    desc: 'Long lower wick (2× the body), close in the top third, at the 20-bar low in an uptrend; 2R.',
    signal(c, i) {
      const b = c.bars[i]!;
      const a = c.atr14[i]!;
      const range = b.h - b.l;
      if (!ok(a, c.ema200[i]!) || range < 0.8 * a) return null;
      const bd = Math.max(body(c, i), range * 0.05);
      const lowerW = Math.min(b.o, b.c) - b.l;
      const upperW = b.h - Math.max(b.o, b.c);
      if (lowerW >= 2 * bd && b.c >= b.l + (2 / 3) * range && b.l <= c.lo20[i]! && c.close[i]! > c.ema200[i]!) return levelSig(c, i, 1, b.l - 0.2 * a, 2);
      if (upperW >= 2 * bd && b.c <= b.h - (2 / 3) * range && b.h >= c.hi20[i]! && c.close[i]! < c.ema200[i]!) return levelSig(c, i, -1, b.h + 0.2 * a, 2);
      return null;
    },
  },
  {
    id: 'double_bottom',
    name: 'Double bottom / top',
    family: 'pattern',
    desc: 'Two swing lows within 0.3 ATR of each other, then a close above the high between them; 2R.',
    signal(c, i) {
      const a = c.atr14[i]!;
      const [l1, l2] = lastLows(c, i, 2);
      if (l1 && l2 && ok(a) && Math.abs(l1.p - l2.p) <= 0.3 * a && l2.i - l1.i >= 5) {
        let neck = -Infinity;
        for (let j = l1.i; j <= l2.i; j++) neck = Math.max(neck, c.bars[j]!.h);
        if (c.close[i]! > neck && c.close[i - 1]! <= neck) return levelSig(c, i, 1, Math.min(l1.p, l2.p) - 0.2 * a, 2);
      }
      const [h1, h2] = lastHighs(c, i, 2);
      if (h1 && h2 && ok(a) && Math.abs(h1.p - h2.p) <= 0.3 * a && h2.i - h1.i >= 5) {
        let neck = Infinity;
        for (let j = h1.i; j <= h2.i; j++) neck = Math.min(neck, c.bars[j]!.l);
        if (c.close[i]! < neck && c.close[i - 1]! >= neck) return levelSig(c, i, -1, Math.max(h1.p, h2.p) + 0.2 * a, 2);
      }
      return null;
    },
  },
  {
    id: 'momentum_bar',
    name: 'Momentum candle follow-through',
    family: 'pattern',
    desc: 'A candle over 2 ATR long closing in its top 20%, with the trend; stop mid-candle, trail 2 ATR.',
    signal(c, i) {
      const b = c.bars[i]!;
      const a = c.atr14[i - 1]!;
      const range = b.h - b.l;
      if (!ok(a, c.ema50[i]!) || range < 2 * a) return null;
      if (b.c >= b.h - 0.2 * range && b.c > c.ema50[i]!) return levelSig(c, i, 1, b.l + range / 2, null, { trailAtr: 2, maxBars: 24 });
      if (b.c <= b.l + 0.2 * range && b.c < c.ema50[i]!) return levelSig(c, i, -1, b.h - range / 2, null, { trailAtr: 2, maxBars: 24 });
      return null;
    },
  },
  // ── researched (v12.2: rules with published FX evidence first, then well-known ones tested against random) ──
  {
    id: 'tsmom',
    name: 'Time-series momentum (5 days)',
    family: 'trend',
    desc: 'Evidence-backed (Moskowitz et al.): hold the direction of the last ~120-bar return; enter when it flips; 3 ATR stop, 4 ATR trail.',
    signal(c, i) {
      const n = 120;
      if (i < n + 1) return null;
      const now = c.close[i]! - c.close[i - n]!;
      const prev = c.close[i - 1]! - c.close[i - 1 - n]!;
      if (now > 0 && prev <= 0) return atrSig(c, i, 1, 3, null, { trailAtr: 4 });
      if (now < 0 && prev >= 0) return atrSig(c, i, -1, 3, null, { trailAtr: 4 });
      return null;
    },
  },
  {
    id: 'tsmom_long',
    name: 'Time-series momentum (20 days)',
    family: 'trend',
    desc: 'Same rule on a ~480-bar lookback (closer to the 1-month horizon in the papers); 3 ATR stop, 5 ATR trail.',
    signal(c, i) {
      const n = 480;
      if (i < n + 1) return null;
      const now = c.close[i]! - c.close[i - n]!;
      const prev = c.close[i - 1]! - c.close[i - 1 - n]!;
      if (now > 0 && prev <= 0) return atrSig(c, i, 1, 3, null, { trailAtr: 5 });
      if (now < 0 && prev >= 0) return atrSig(c, i, -1, 3, null, { trailAtr: 5 });
      return null;
    },
  },
  {
    id: 'local_hours',
    name: 'Local-hours effect',
    family: 'session',
    desc: "Evidence-backed (SNB working paper): a currency tends to weaken in its own trading hours. Sell EUR/GBP/CHF 07–12 UTC, sell JPY/AUD/NZD 00–06 UTC; out at the session end.",
    onlyHourly: true,
    signal(c, i) {
      const p = c.pair;
      if (p.length < 6 || isFutures(p)) return null;
      const base = p.slice(0, 3);
      const quote = p.slice(3, 6);
      const closeHour = (c.hour[i]! + 1) % 24; // this bar closes at the next hour
      const sess = (ccy: string): [number, number] | null => (['EUR', 'GBP', 'CHF'].includes(ccy) ? [7, 12] : ['JPY', 'AUD', 'NZD'].includes(ccy) ? [0, 6] : null);
      const bs = sess(base);
      const qs = sess(quote);
      if (bs && qs) return null; // both in the same kind of session (crosses): skip
      if (bs && closeHour === bs[0]) return atrSig(c, i, -1, 2, null, { maxBars: bs[1] - bs[0] });
      if (qs && closeHour === qs[0]) return atrSig(c, i, 1, 2, null, { maxBars: qs[1] - qs[0] });
      return null;
    },
  },
  {
    id: 'fix_flow',
    name: 'London fix dollar flow',
    family: 'session',
    desc: 'Evidence-backed (Journal of Finance 2024): the dollar tends to rise into the 16:00 London fix. Long USD from 14:00 to 16:00 UTC.',
    onlyHourly: true,
    signal(c, i) {
      const p = c.pair;
      if (!p.includes('USD') || isFutures(p)) return null;
      if ((c.hour[i]! + 1) % 24 !== 14) return null;
      return atrSig(c, i, p.startsWith('USD') ? 1 : -1, 1.5, null, { maxBars: 2 });
    },
  },
  {
    id: 'turtle_soup',
    name: 'Turtle Soup (false breakout)',
    family: 'reversion',
    desc: 'Connors & Raschke: a new 20-bar low when the previous one is 4+ bars old, then a close back above it → buy; stop under the new low, 2R.',
    signal(c, i) {
      if (i < 30) return null;
      const b = c.bars[i]!;
      const look = (from: number, n: number, hi: boolean) => {
        let best = hi ? -Infinity : Infinity;
        let at = from;
        for (let j = from - n + 1; j <= from; j++) {
          const v = hi ? c.bars[j]!.h : c.bars[j]!.l;
          if (hi ? v > best : v < best) {
            best = v;
            at = j;
          }
        }
        return { v: best, at };
      };
      const prevLow = look(i - 1, 20, false);
      if (i - 1 - prevLow.at >= 4 && b.l < prevLow.v && b.c > prevLow.v) return levelSig(c, i, 1, b.l - 0.2 * c.atr14[i]!, 2);
      const prevHigh = look(i - 1, 20, true);
      if (i - 1 - prevHigh.at >= 4 && b.h > prevHigh.v && b.c < prevHigh.v) return levelSig(c, i, -1, b.h + 0.2 * c.atr14[i]!, 2);
      return null;
    },
  },
  {
    id: 'asian_fade',
    name: 'Asian range fade',
    family: 'session',
    desc: 'London (07–10 UTC) pokes outside the Asian range and the next close is back inside → fade it toward the other side; stop past the poke.',
    onlyHourly: true,
    signal(c, i) {
      const r = c.asia[i];
      const h = c.hour[i]!;
      if (!r || h < 7 || h > 10) return null;
      const p = c.bars[i - 1]!;
      const b = c.bars[i]!;
      if (p.h > r.h && b.c < r.h && b.c > r.l) {
        const s = levelSig(c, i, -1, Math.max(p.h, b.h) + 0.1 * c.atr14[i]!, null, { maxBars: 20 - h });
        return s ? { ...s, target: r.l } : null;
      }
      if (p.l < r.l && b.c > r.l && b.c < r.h) {
        const s = levelSig(c, i, 1, Math.min(p.l, b.l) - 0.1 * c.atr14[i]!, null, { maxBars: 20 - h });
        return s ? { ...s, target: r.h } : null;
      }
      return null;
    },
  },
  {
    id: 'psar_adx',
    name: 'Parabolic SAR flip + ADX',
    family: 'trend',
    desc: 'SAR flips with ADX above 20 (a trend, not chop); stop at the SAR, trail 2.5 ATR.',
    signal(c, i) {
      const d = c.psar.dir;
      if (!ok(c.adx.adx[i]!) || c.adx.adx[i]! < 20) return null;
      if (d[i - 1] === -1 && d[i] === 1) return levelSig(c, i, 1, c.psar.sar[i]!, null, { trailAtr: 2.5 });
      if (d[i - 1] === 1 && d[i] === -1) return levelSig(c, i, -1, c.psar.sar[i]!, null, { trailAtr: 2.5 });
      return null;
    },
  },
  {
    id: 'stoch_trend',
    name: 'Stochastic cross with the trend',
    family: 'reversion',
    desc: 'Above the 200 EMA, Stochastic %K crosses %D up from under 20 (mirror for shorts); 1.5 ATR stop, 2R.',
    signal(c, i) {
      const { k, d } = c.stoch;
      if (!ok(k[i]!, d[i]!, k[i - 1]!, d[i - 1]!, c.ema200[i]!)) return null;
      if (c.close[i]! > c.ema200[i]! && k[i - 1]! < 20 && crossUp(k, d, i)) return atrSig(c, i, 1, 1.5, 2);
      if (c.close[i]! < c.ema200[i]! && k[i - 1]! > 80 && crossDn(k, d, i)) return atrSig(c, i, -1, 1.5, 2);
      return null;
    },
  },
  {
    id: 'cci_break',
    name: 'CCI ±100 breakout',
    family: 'breakout',
    desc: 'CCI(20) crosses above +100 in an uptrend (below −100 in a downtrend); 2 ATR stop, trail 2.5 ATR.',
    signal(c, i) {
      const x = c.cci20;
      if (!ok(x[i]!, x[i - 1]!, c.ema50[i]!)) return null;
      if (x[i - 1]! <= 100 && x[i]! > 100 && c.close[i]! > c.ema50[i]!) return atrSig(c, i, 1, 2, null, { trailAtr: 2.5 });
      if (x[i - 1]! >= -100 && x[i]! < -100 && c.close[i]! < c.ema50[i]!) return atrSig(c, i, -1, 2, null, { trailAtr: 2.5 });
      return null;
    },
  },
  {
    id: 'williams_r',
    name: 'Williams %R reversal',
    family: 'reversion',
    desc: 'Above the 200 EMA, %R(14) leaves the bottom zone (crosses −80 upward); out at the 20 EMA or 1.5R.',
    signal(c, i) {
      const wr = (j: number) => c.stoch.k[j]! - 100;
      if (!ok(c.stoch.k[i]!, c.stoch.k[i - 1]!, c.ema200[i]!)) return null;
      // %R = %K − 100 (same range math); using the smoothed %K keeps it from flickering
      if (c.close[i]! > c.ema200[i]! && wr(i - 1) < -80 && wr(i) >= -80) return atrSig(c, i, 1, 1.5, 1.5, { exitWhen: 'ema20' });
      if (c.close[i]! < c.ema200[i]! && wr(i - 1) > -20 && wr(i) <= -20) return atrSig(c, i, -1, 1.5, 1.5, { exitWhen: 'ema20' });
      return null;
    },
  },
  // ── news (v13): what happens AFTER a big release, read from the candle itself ──
  {
    id: 'news_drift',
    name: 'News drift (follow the shock)',
    family: 'news',
    desc: 'After a shock candle (2.2× the normal hourly range, closing near its extreme) the move often keeps going: enter its way on the next open, stop at the candle middle, 2R target or out after 24 hours.',
    onlyHourly: true,
    signal(c, i) {
      const d = shockDir(c, i);
      if (!d) return null;
      const b = c.bars[i]!;
      return levelSig(c, i, d, (b.h + b.l) / 2, 2, { maxBars: 24 });
    },
  },
  {
    id: 'news_fade',
    name: 'News fade (shock that fails)',
    family: 'news',
    desc: 'A shock candle followed by a candle that gives back over a third of it: bet on the full give-back. Stop past the shock extreme, target the shock candle open.',
    onlyHourly: true,
    signal(c, i) {
      const d = shockDir(c, i - 1);
      if (!d) return null;
      const s0 = c.bars[i - 1]!;
      const b = c.bars[i]!;
      const range = s0.h - s0.l;
      const a = c.atr14[i]!;
      if (d === 1 && b.c < s0.c - 0.35 * range) {
        const sig = levelSig(c, i, -1, Math.max(s0.h, b.h) + 0.15 * a, null, { maxBars: 12 });
        return sig && s0.o < b.c ? { ...sig, target: s0.o } : null;
      }
      if (d === -1 && b.c > s0.c + 0.35 * range) {
        const sig = levelSig(c, i, 1, Math.min(s0.l, b.l) - 0.15 * a, null, { maxBars: 12 });
        return sig && s0.o > b.c ? { ...sig, target: s0.o } : null;
      }
      return null;
    },
  },
  // ── v14: cross-sectional currency momentum ──
  {
    id: 'ccy_momentum',
    name: 'Strongest vs weakest currency',
    family: 'trend',
    style: 'trend',
    slow: true,
    desc: 'Evidence-backed (Menkhoff et al. 2012, currency momentum): when the pair becomes one of the 2 strongest currencies against one of the 2 weakest (5-day strength, all 20 pairs), go with it; 2.5 ATR stop, 3.5 ATR trail, out after about 5 days.',
    signal(c, i) {
      const e = c.ext;
      if (!e || i < 1) return null;
      const rb = e.rankBase[i]!;
      const rq = e.rankQuote[i]!;
      const pb = e.rankBase[i - 1]!;
      const pq = e.rankQuote[i - 1]!;
      if (!ok(rb, rq, pb, pq)) return null;
      const maxBars = c.barMin === 60 ? 120 : 30;
      if (rb <= 1 && rq >= 6 && !(pb <= 1 && pq >= 6)) return atrSig(c, i, 1, 2.5, null, { trailAtr: 3.5, maxBars });
      if (rq <= 1 && rb >= 6 && !(pq <= 1 && pb >= 6)) return atrSig(c, i, -1, 2.5, null, { trailAtr: 3.5, maxBars });
      return null;
    },
  },
  // ── v14: intermarket (a linked market moved hard, this pair hasn't followed yet) ──
  {
    id: 'oil_cad',
    name: 'Oil → Canadian dollar catch-up',
    family: 'intermarket',
    style: 'neutral',
    desc: 'The Canadian dollar tends to follow oil. Oil makes a big 24-hour move (1.5+ normal moves) while USD/CAD has not moved its way yet: trade the catch-up; 1.5 ATR stop, 2R, out after a day.',
    onlyHourly: true,
    signal(c, i) {
      if (c.pair !== 'USDCAD' || !c.ext) return null;
      const z = c.ext.zOil;
      const zp = pairZ(c, i);
      if (!ok(z[i]!, z[i - 1]!, zp)) return null;
      if (z[i]! >= 1.5 && z[i - 1]! < 1.5 && zp > -0.3) return atrSig(c, i, -1, 1.5, 2, { maxBars: 24 });
      if (z[i]! <= -1.5 && z[i - 1]! > -1.5 && zp < 0.3) return atrSig(c, i, 1, 1.5, 2, { maxBars: 24 });
      return null;
    },
  },
  {
    id: 'yield_jpy',
    name: 'US yields → USD/JPY catch-up',
    family: 'intermarket',
    style: 'neutral',
    desc: 'USD/JPY tracks the US 10-year yield. The yield makes a big 24-hour move while USD/JPY has not followed: trade the catch-up; 1.5 ATR stop, 2R, out after a day.',
    onlyHourly: true,
    signal(c, i) {
      if (c.pair !== 'USDJPY' || !c.ext) return null;
      const z = c.ext.zYield;
      const zp = pairZ(c, i);
      if (!ok(z[i]!, z[i - 1]!, zp)) return null;
      if (z[i]! >= 1.5 && z[i - 1]! < 1.5 && zp < 0.3) return atrSig(c, i, 1, 1.5, 2, { maxBars: 24 });
      if (z[i]! <= -1.5 && z[i - 1]! > -1.5 && zp > -0.3) return atrSig(c, i, -1, 1.5, 2, { maxBars: 24 });
      return null;
    },
  },
  {
    id: 'stocks_jpy',
    name: 'Stocks → yen crosses catch-up',
    family: 'intermarket',
    style: 'neutral',
    desc: 'Yen pairs rise with stocks (risk-on) and fall with them. S&P futures make a big 24-hour move while the yen pair has not followed: trade the catch-up; 1.5 ATR stop, 2R, out after a day.',
    onlyHourly: true,
    signal(c, i) {
      if (!c.pair.endsWith('JPY') || !c.ext) return null;
      const z = c.ext.zStocks;
      const zp = pairZ(c, i);
      if (!ok(z[i]!, z[i - 1]!, zp)) return null;
      if (z[i]! >= 1.5 && z[i - 1]! < 1.5 && zp < 0.3) return atrSig(c, i, 1, 1.5, 2, { maxBars: 24 });
      if (z[i]! <= -1.5 && z[i - 1]! > -1.5 && zp > -0.3) return atrSig(c, i, -1, 1.5, 2, { maxBars: 24 });
      return null;
    },
  },
  {
    id: 'dollar_gold',
    name: 'Dollar → gold catch-up',
    family: 'intermarket',
    style: 'neutral',
    desc: 'Gold usually moves against the dollar. The dollar index makes a big 24-hour move while gold has not reacted: trade the catch-up; 1.5 ATR stop, 2R, out after a day.',
    onlyHourly: true,
    signal(c, i) {
      if (c.pair !== 'XAUUSD' || !c.ext) return null;
      const z = c.ext.zDollar;
      const zp = pairZ(c, i);
      if (!ok(z[i]!, z[i - 1]!, zp)) return null;
      if (z[i]! <= -1.5 && z[i - 1]! > -1.5 && zp < 0.3) return atrSig(c, i, 1, 1.5, 2, { maxBars: 24 });
      if (z[i]! >= 1.5 && z[i - 1]! < 1.5 && zp > -0.3) return atrSig(c, i, -1, 1.5, 2, { maxBars: 24 });
      return null;
    },
  },
  // ── v14: calendar flows and range patterns ──
  {
    id: 'weekend_gap',
    name: 'Weekend gap fill',
    family: 'flow',
    style: 'neutral',
    desc: "Monday's open often gaps away from Friday's close and drifts back. A gap of half a normal hour or more that is still open after the first hour → trade back toward Friday's close; stop past the gap's extreme.",
    onlyHourly: true,
    signal(c, i) {
      if (i < 2) return null;
      const b = c.bars[i]!;
      const p = c.bars[i - 1]!;
      if (b.t - p.t <= 30 * 3_600_000) return null;
      const a = c.atr14[i - 1]!;
      const gap = b.o - p.c;
      if (!ok(a) || Math.abs(gap) < 0.5 * a) return null;
      if (gap > 0 && b.c > p.c + 0.25 * gap) {
        const sig = levelSig(c, i, -1, b.h + 0.5 * a, null, { maxBars: 24 });
        return sig ? { ...sig, target: p.c } : null;
      }
      if (gap < 0 && b.c < p.c + 0.25 * gap) {
        const sig = levelSig(c, i, 1, b.l - 0.5 * a, null, { maxBars: 24 });
        return sig ? { ...sig, target: p.c } : null;
      }
      return null;
    },
  },
  {
    id: 'month_end_flow',
    name: 'Month-end dollar rebalancing',
    family: 'flow',
    style: 'neutral',
    desc: 'Evidence-backed (Melvin & Prins 2015, London 4pm fix): on the last trading day of a month foreign investors re-hedge their US stocks. After a strong S&P month (+2%) the dollar tends to weaken into the 16:00 fix, after a weak one it tends to rise. 14:00 → 16:00 UTC.',
    onlyHourly: true,
    signal(c, i) {
      const p = c.pair;
      if (!c.ext || !p.includes('USD') || isFutures(p)) return null;
      if ((c.hour[i]! + 1) % 24 !== 14 || !lastWeekdayOfMonth(c.bars[i]!.t)) return null;
      const m = c.ext.spxMtd[i]!;
      if (!ok(m) || Math.abs(m) < 2) return null;
      const sellUsd = m > 0;
      const side: 1 | -1 = p.startsWith('USD') ? (sellUsd ? -1 : 1) : sellUsd ? 1 : -1;
      return atrSig(c, i, side, 1.5, null, { maxBars: 2 });
    },
  },
  {
    id: 'nr7_break',
    name: 'NR7 breakout (narrowest day)',
    family: 'breakout',
    style: 'neutral',
    desc: "Crabel's NR7: when yesterday was the narrowest day of the last 7, today's break of its high (or low) during London / New York often runs. Stop mid-range, 2R, flat by 22:00 UTC.",
    onlyHourly: true,
    signal(c, i) {
      const pd = c.prevDay[i];
      const h = c.hour[i]!;
      if (!pd || !c.nr7[i] || h < 7 || h > 16 || i < 1) return null;
      const mid = (pd.h + pd.l) / 2;
      const maxBars = 22 - h;
      if (c.close[i]! > pd.h && c.close[i - 1]! <= pd.h) return levelSig(c, i, 1, mid, 2, { maxBars });
      if (c.close[i]! < pd.l && c.close[i - 1]! >= pd.l) return levelSig(c, i, -1, mid, 2, { maxBars });
      return null;
    },
  },
  // ── v16 quant pack: momentum + carry, volatility forecast, stat-arb, round numbers, positioning ──
  {
    id: 'mom_blend',
    name: 'Momentum blend (1, 5, 20 days)',
    family: 'trend',
    style: 'trend',
    slow: true,
    desc: 'Evidence-backed (time-series momentum, several horizons): go with the trend only when the 1-day, 5-day and 20-day returns all point the same way, the moment the last one joins; 3 ATR stop, 4 ATR trail, out after about 2 weeks.',
    signal(c, i) {
      const hs = [24, 120, 480].map((h) => Math.max(2, Math.round((h * 60) / c.barMin)));
      const L = hs[2]!;
      if (i < L + 1) return null;
      const score = (k: number) => hs.reduce((a, n) => a + Math.sign(c.close[k]! - c.close[k - n]!), 0);
      const now = score(i);
      const prev = score(i - 1);
      const maxBars = Math.round((14 * 1440) / c.barMin);
      if (now === 3 && prev < 3) return atrSig(c, i, 1, 3, null, { trailAtr: 4, maxBars });
      if (now === -3 && prev > -3) return atrSig(c, i, -1, 3, null, { trailAtr: 4, maxBars });
      return null;
    },
  },
  {
    id: 'carry_trend',
    name: 'Carry + trend',
    family: 'trend',
    style: 'trend',
    slow: true,
    desc: 'Evidence-backed (carry and momentum are the two best-documented currency factors): buy the higher-interest currency (rate gap ≥ 1%) when its 5-day trend turns its way, sell it when it turns against; needs the central-bank rates feed; 3 ATR stop, 5 ATR trail.',
    signal(c, i) {
      const cr = c.ext?.carry?.[i];
      const n = Math.max(2, Math.round((120 * 60) / c.barMin));
      if (cr === undefined || !Number.isFinite(cr) || i < n + 1) return null;
      const now = c.close[i]! - c.close[i - n]!;
      const prev = c.close[i - 1]! - c.close[i - 1 - n]!;
      if (cr >= 1 && now > 0 && prev <= 0) return atrSig(c, i, 1, 3, null, { trailAtr: 5 });
      if (cr <= -1 && now < 0 && prev >= 0) return atrSig(c, i, -1, 3, null, { trailAtr: 5 });
      return null;
    },
  },
  {
    id: 'vol_breakout',
    name: 'Volatility forecast breakout',
    family: 'breakout',
    style: 'neutral',
    desc: 'The volatility forecast (HAR model) says moves are about to get at least 25% bigger and price breaks the 20-bar high / low: go with the break; 1.5 ATR stop, 2.5 ATR trail, out after about 2 days.',
    signal(c, i) {
      const v = c.quant?.volF[i];
      if (v === undefined || !Number.isFinite(v) || v < 1.25 || i < 21) return null;
      const hi = c.hi20[i - 1]!;
      const lo = c.lo20[i - 1]!;
      const px = c.close[i]!;
      const maxBars = Math.round((2 * 1440) / c.barMin);
      if (ok(hi) && px > hi && c.close[i - 1]! <= hi) return atrSig(c, i, 1, 1.5, null, { trailAtr: 2.5, maxBars });
      if (ok(lo) && px < lo && c.close[i - 1]! >= lo) return atrSig(c, i, -1, 1.5, null, { trailAtr: 2.5, maxBars });
      return null;
    },
  },
  {
    id: 'stat_arb',
    name: 'Stat-arb snap-back (linked crosses)',
    family: 'reversion',
    style: 'revert',
    desc: 'On crosses of closely linked currencies (EUR/GBP, AUD/NZD, EUR/CHF): when the price sits 2.2+ standard deviations from its 120-bar average, the market has been snapping back (Hurst < 0.5) and a gap has halved within 60 bars in the past, bet on it returning to the average; 2 ATR stop, target the average, out after 3 half-lives.',
    signal(c, i) {
      if (!STAT_ARB_PAIRS.includes(c.pair)) return null;
      const q = c.quant;
      if (!q) return null;
      const z = q.z120[i]!;
      const hl = q.hl120[i]!;
      const h = q.hurst[i]!;
      if (!ok(z, hl, h) || Math.abs(z) < 2.2 || hl > 60 || h >= 0.5) return null;
      const prevZ = q.z120[i - 1]!;
      if (ok(prevZ) && Math.abs(prevZ) >= 2.2) return null; // only on the bar it first stretches that far
      const side: 1 | -1 = z > 0 ? -1 : 1;
      const target = Math.exp(q.m120[i]!);
      const a = c.atr14[i]!;
      const px = c.close[i]!;
      if (!ok(a, target) || !(a > 0) || (target - px) * side < 0.8 * a) return null;
      return { side, stop: px - side * 2 * a, target, maxBars: Math.max(6, Math.min(120, Math.round(3 * hl))) };
    },
  },
  {
    id: 'round_break',
    name: 'Round-number break',
    family: 'breakout',
    style: 'neutral',
    desc: 'Researched (Osler 2003, NY Fed): stop-loss orders cluster just beyond big round numbers (1.1700, 150.00, gold $10 steps), so a close through one tends to run on; stop 1 ATR back behind the level, 2R target.',
    signal(c, i) {
      if (i < 2) return null;
      const step = roundStep(c.pair);
      const a = c.atr14[i]!;
      const px = c.close[i]!;
      const prev = c.close[i - 1]!;
      if (!ok(a, px, prev) || !(a > 0) || !step) return null;
      const up = Math.floor(px / step) * step;
      if (prev <= up && px > up + 0.1 * a && px - up < 1.5 * a) return levelSig(c, i, 1, up - a, 2);
      const dn = Math.ceil(px / step) * step;
      if (prev >= dn && px < dn - 0.1 * a && dn - px < 1.5 * a) return levelSig(c, i, -1, dn + a, 2);
      return null;
    },
  },
  {
    id: 'round_fade',
    name: 'Round-number first touch fade',
    family: 'reversion',
    style: 'revert',
    desc: 'Researched (Osler 2000/2003): take-profit orders cluster AT round numbers, so the first touch after a day away tends to bounce off; enter on the close back away from it; stop 1 ATR beyond the level, 2R target.',
    signal(c, i) {
      const L = Math.max(4, Math.round(1440 / c.barMin));
      if (i < L + 1) return null;
      const step = roundStep(c.pair);
      const a = c.atr14[i]!;
      const b = c.bars[i]!;
      if (!step || !ok(a) || !(a > 0)) return null;
      // resistance: touched from below, closed back under, and the day before stayed well under it
      const r = Math.ceil(b.c / step) * step;
      if (b.h >= r - 0.15 * a && b.c <= r - 0.25 * a) {
        let fresh = true;
        for (let k = i - L; k < i; k++) if (c.bars[k]!.h >= r - 0.5 * a) fresh = false;
        if (fresh) return levelSig(c, i, -1, r + a, 2);
      }
      const s2 = Math.floor(b.c / step) * step;
      if (b.l <= s2 + 0.15 * a && b.c >= s2 + 0.25 * a) {
        let fresh = true;
        for (let k = i - L; k < i; k++) if (c.bars[k]!.l <= s2 + 0.5 * a) fresh = false;
        if (fresh) return levelSig(c, i, 1, s2 - a, 2);
      }
      return null;
    },
  },
  {
    id: 'cot_squeeze',
    name: 'Crowded positioning squeeze',
    family: 'flow',
    style: 'neutral',
    slow: true,
    desc: 'CFTC data: when hedge funds are near their most-short on the pair (positioning ≤ −1.5 of ±2) and the 5-day trend turns up, the short-covering squeeze tends to run (and the mirror for crowded longs); 3 ATR stop, 4 ATR trail, out after about 2 weeks.',
    signal(c, i) {
      const pos = c.ext?.cot?.[i];
      const n = Math.max(2, Math.round((120 * 60) / c.barMin));
      if (pos === undefined || !Number.isFinite(pos) || i < n + 1) return null;
      const now = c.close[i]! - c.close[i - n]!;
      const prev = c.close[i - 1]! - c.close[i - 1 - n]!;
      const maxBars = Math.round((14 * 1440) / c.barMin);
      if (pos <= -1.5 && now > 0 && prev <= 0) return atrSig(c, i, 1, 3, null, { trailAtr: 4, maxBars });
      if (pos >= 1.5 && now < 0 && prev >= 0) return atrSig(c, i, -1, 3, null, { trailAtr: 4, maxBars });
      return null;
    },
  },
  {
    id: 'stretch_squeeze',
    name: 'Overstretched run turns',
    family: 'flow',
    style: 'neutral',
    slow: true,
    desc: 'No outside data: when a pair has run further down over 3 months than almost ever in its last 2 years (price stretch ≤ −1.5 of ±2) and the 5-day trend turns up, the snap-back tends to run (and the mirror after a record run up); 3 ATR stop, 4 ATR trail, out after about 2 weeks.',
    signal(c, i) {
      const pos = c.ext?.crowdPx?.[i];
      const n = Math.max(2, Math.round((120 * 60) / c.barMin));
      if (pos === undefined || !Number.isFinite(pos) || i < n + 1) return null;
      const now = c.close[i]! - c.close[i - n]!;
      const prev = c.close[i - 1]! - c.close[i - 1 - n]!;
      const maxBars = Math.round((14 * 1440) / c.barMin);
      if (pos <= -STRETCH.squeezeAt && now > 0 && prev <= 0) return atrSig(c, i, 1, 3, null, { trailAtr: 4, maxBars });
      if (pos >= STRETCH.squeezeAt && now < 0 && prev >= 0) return atrSig(c, i, -1, 3, null, { trailAtr: 4, maxBars });
      return null;
    },
  },
  // ── v23 ICT / smart-money concepts (owner: "ICT quarterly theory, order flow, a Judas swing at the New York open") ──
  // All read the clock in New York time (`c.nyMin` = minutes since NY midnight at the bar's open). Graded like every
  // other rule: picked on the first 70%, judged on the unseen 30%; nothing trades until it clears the quality bar.
  {
    id: 'judas_swing',
    name: 'Judas swing (New York open)',
    family: 'ict',
    style: 'revert',
    charts: ['15m', '1h'],
    desc: 'ICT: in the first hour after the 9:30 New York open the price runs past the pre-open range (3:00–9:30 NY, the London session) to take the stops there, then closes back inside — the "Judas" move. Fade it: stop just past the sweep, target the other side of the range, flat by 4:00 pm New York. 15-minute (first signal at the 9:45 close) and hourly charts.',
    signal(c, i) {
      const a = c.atr14[i]!;
      if (!ok(a) || a <= 0) return null;
      const d = ICT.sweepAtr * a;
      const r = sessionRange(c, i, ICT.preOpenFrom, ICT.nyOpen, ICT.nyOpen, ICT.judasUntil, false, d);
      if (!r) return null;
      const b = c.bars[i]!;
      const maxBars = Math.max(1, Math.floor((ICT.nyFlat - (c.nyMin[i]! + c.barMin)) / c.barMin));
      // the first close back inside after a sweep of the high → short toward the low (mirror for a sweep of the low)
      if (r.winHi > r.h + d && b.c < r.h && b.c > r.l && !r.hiSignalled) {
        const s = levelSig(c, i, -1, r.winHi + 0.1 * a, null, { maxBars });
        return s ? { ...s, target: r.l } : null;
      }
      if (r.winLo < r.l - d && b.c > r.l && b.c < r.h && !r.loSignalled) {
        const s = levelSig(c, i, 1, r.winLo - 0.1 * a, null, { maxBars });
        return s ? { ...s, target: r.h } : null;
      }
      return null;
    },
  },
  {
    // v27.5 (owner: "look up Investopedia and what could help"): the classic opening-range breakout on the real 9:30 New
    // York open (DST-aware, unlike the older `ny_open`, which uses fixed UTC hours)
    id: 'orb_ny',
    name: 'Opening range breakout (NY 9:30)',
    family: 'session',
    style: 'trend',
    charts: ['15m'],
    desc: 'The first 30 minutes after the 9:30 New York open (two 15-minute candles) set the opening range. The first 15-minute close outside it before 11:30 is traded that way: stop at the other side of the range (the middle when the range is wide), 1.5R target, flat by 4:00 pm New York. Only the first break of the day counts — a second break is usually a false one.',
    signal(c, i) {
      const r = sessionRange(c, i, ORB.from, ORB.rangeTo, ORB.rangeTo, ORB.until);
      if (!r) return null;
      const dayOf = (t: number) => Math.floor((t + nyOffsetMs(t)) / 86_400_000);
      const today = dayOf(c.bars[i]!.t);
      for (let j = i - 1; j >= 0 && dayOf(c.bars[j]!.t) === today && c.nyMin[j]! + c.barMin > ORB.rangeTo; j--) {
        if (c.bars[j]!.c > r.h || c.bars[j]!.c < r.l) return null; // not the first break
      }
      const b = c.bars[i]!;
      const side: 1 | -1 | 0 = b.c > r.h ? 1 : b.c < r.l ? -1 : 0;
      if (!side) return null;
      const maxBars = Math.max(1, Math.floor((ICT.nyFlat - (c.nyMin[i]! + c.barMin)) / c.barMin));
      const far = side === 1 ? r.l : r.h;
      const mid = (r.h + r.l) / 2;
      return levelSig(c, i, side, far, ORB.r, { maxBars }) ?? levelSig(c, i, side, mid, ORB.r, { maxBars });
    },
  },
  {
    id: 'ny_q3',
    name: 'Quarterly theory: New York Q3',
    family: 'ict',
    style: 'revert',
    charts: ['15m'],
    desc: 'Quarterly theory (Daye / ICT): the New York morning (6:00–12:00 NY) splits into four 90-minute quarters — Q1 accumulation 6:00–7:30, Q2 manipulation 7:30–9:00 (the 8:30 news), Q3 distribution 9:00–10:30, Q4 continuation. At the 9:00 close: if Q2 ran past Q1\'s high (or low) and closed back inside Q1\'s range, Q3 is traded the other way — stop past the Q2 extreme, 2R, flat by noon New York. 15-minute chart only (the quarters sit on the quarter-hours).',
    signal(c, i) {
      if (c.nyMin[i]! + c.barMin !== ICT.q3Start) return null;
      const a = c.atr14[i]!;
      if (!ok(a) || a <= 0) return null;
      const d = ICT.sweepAtr * a;
      const r = sessionRange(c, i, ICT.q1Start, ICT.q2Start, ICT.q2Start, ICT.q3Start, false, d);
      if (!r) return null;
      const b = c.bars[i]!;
      const maxBars = Math.max(1, Math.floor((ICT.nyNoon - ICT.q3Start) / c.barMin));
      if (r.winHi > r.h + d && b.c < r.h && b.c > r.l) return levelSig(c, i, -1, r.winHi + 0.1 * a, 2, { maxBars });
      if (r.winLo < r.l - d && b.c > r.l && b.c < r.h) return levelSig(c, i, 1, r.winLo - 0.1 * a, 2, { maxBars });
      return null;
    },
  },
  {
    id: 'amd_daily',
    name: 'Daily cycle: accumulation → manipulation → distribution',
    family: 'ict',
    style: 'revert',
    charts: ['15m', '1h'],
    desc: 'ICT daily AMD, quarterly theory on the day: Asia (6:00 pm–midnight NY) builds the range, London (midnight–6:00 am NY) runs past one side of it and comes back — the manipulation — and New York (6:00 am–noon) distributes the other way. At the 6:00 am New York close: London swept Asia\'s high and closed back inside → short (mirror for the low); stop past the London extreme, target Asia\'s other side, flat by noon.',
    signal(c, i) {
      if (c.nyMin[i]! + c.barMin !== ICT.amdDecide) return null;
      // Asia = the bars from 18:00 the previous NY day to midnight; London = midnight to 6:00 am (today)
      const a = c.atr14[i]!;
      if (!ok(a) || a <= 0) return null;
      const d = ICT.sweepAtr * a;
      const r = sessionRange(c, i, ICT.asiaStart, 24 * 60, 0, ICT.amdDecide, true, d);
      if (!r) return null;
      const b = c.bars[i]!;
      const maxBars = Math.max(1, Math.floor((ICT.nyNoon - ICT.amdDecide) / c.barMin));
      if (r.winHi > r.h + d && b.c < r.h && b.c > r.l) {
        const s = levelSig(c, i, -1, r.winHi + 0.1 * a, null, { maxBars });
        return s ? { ...s, target: r.l } : null;
      }
      if (r.winLo < r.l - d && b.c > r.l && b.c < r.h) {
        const s = levelSig(c, i, 1, r.winLo - 0.1 * a, null, { maxBars });
        return s ? { ...s, target: r.h } : null;
      }
      return null;
    },
  },
  {
    id: 'fvg_entry',
    name: 'Order flow: sweep, displacement, fair-value gap',
    family: 'ict',
    style: 'pullback',
    desc: 'ICT order flow: the price takes out a recent low (liquidity), then a displacement candle (body ≥ 1.2 ATR) leaves a fair-value gap — three candles where the first\'s high never meets the third\'s low. Within 6 candles the price comes back into the gap and closes back above it → buy; stop under the gap, 2R. A gap the price falls through is dead. Mirrored for shorts. Any chart, any market.',
    signal(c, i) {
      return fvgSignal(c, i);
    },
  },
  {
    id: 'mss_sweep',
    name: 'Liquidity sweep + market structure shift',
    family: 'ict',
    style: 'revert',
    desc: 'ICT: the price dips under an old confirmed swing low (takes the stops there) and within 6 candles closes above the last lower swing high — the structure has shifted. Buy; stop under the sweep low, 2R. Mirrored for shorts. Any chart, any market.',
    signal(c, i) {
      return mssSignal(c, i);
    },
  },
  {
    id: 'ifvg_cisd',
    name: 'Inverted gap + change of delivery (IFVG + CISD)',
    family: 'ict',
    style: 'revert',
    desc: 'ICT, the trade your friend took long: the price runs down through the recent lows (takes the liquidity), leaving a bearish fair-value gap. Then one strong candle (body ≥ 1 ATR) closes above that gap (the gap is inverted) and above the open of the down-candles that made the low (change in state of delivery). Buy at that close; stop under the low, 2R, then a trailing stop lets it run. Mirrored for shorts. Any chart, any market.',
    signal(c, i) {
      return ifvgSignal(c, i);
    },
  },
  {
    id: 'fvg_ce',
    name: 'Inversion, then retrace to the gap middle (FVG CE)',
    family: 'ict',
    style: 'pullback',
    desc: 'ICT, the trade your friend took short: a strong candle (body ≥ 1.2 ATR) breaks through a gap that was holding (inverts it) and leaves its own gap. Within 6 candles the price comes back to the middle of that new gap (consequent encroachment) and closes back away from it → enter with the move. Stop past the gap / retrace extreme, 2R, then a trailing stop. Mirrored. Any chart, any market.',
    signal(c, i) {
      return fvgCeSignal(c, i);
    },
  },
  // ── v27.35 standard deviation ──
  {
    id: 'sd_revert',
    name: 'Standard deviation snap-back (flat regression channel)',
    family: 'deviation',
    style: 'revert',
    desc: 'A 50-candle linear-regression line that is going nowhere (moves less than 1.5 standard deviations end to end). The close strayed 2.2+ standard deviations under it, now closes back inside 2 → buy back to the line. Stop under the last 3 candles, needs ≥ 1R to the line. Mirrored.',
    signal: sdRevertSignal,
  },
  {
    id: 'lr_channel',
    name: 'Regression channel pullback',
    family: 'deviation',
    style: 'pullback',
    desc: 'A clean 50-candle trend channel (R² ≥ 0.6). The price dipped to the lower 1.8-standard-deviation band and the candle closes up → buy with the trend, target 1 standard deviation over the line. Stop under the last 3 candles. Mirrored in a falling channel.',
    signal: lrChannelSignal,
  },
  {
    id: 'sd_breakout',
    name: 'Standard deviation breakout (quiet → 2.5 SD)',
    family: 'deviation',
    style: 'trend',
    desc: 'A quiet, trendless stretch (regression R² under 0.3), then a solid candle closes 2.5 standard deviations off the line → follow it. Stop at the regression line, 2R. Mirrored.',
    signal: sdBreakoutSignal,
  },
  // ── v27.35 volume profile + order flow ──
  {
    id: 'vp_reentry',
    name: 'Volume profile: back into value → POC',
    family: 'volume',
    style: 'revert',
    desc: 'Profile of the last 96 candles (traded volume per price; time at price where the market has no volume). A close below the value area (where 70% traded), then a close back inside it → buy toward the point of control (the busiest price), needs ≥ 1R. Stop under the last 3 candles. Mirrored.',
    signal: vpReentrySignal,
  },
  {
    id: 'vp_breakout',
    name: 'Volume profile: balance → breakout',
    family: 'volume',
    style: 'trend',
    desc: '12 closes in a row inside the value area (a balanced market), then a solid candle closes out of it → follow the break. Stop half an ATR back inside the value area, 2R. Mirrored.',
    signal: vpBreakoutSignal,
  },
  {
    id: 'of_absorb',
    name: 'Order flow: absorption at a new low',
    family: 'volume',
    style: 'revert',
    desc: 'The price makes a new 20-candle low but the money flow (20-candle estimated buy − sell volume) is positive and rising, and the candle closes in its upper half — buyers are soaking up the selling → buy, stop under the low, 2R. Only markets with real volume (coins, indices, metals). Mirrored.',
    signal: ofAbsorbSignal,
  },
  {
    id: 'of_thrust',
    name: 'Order flow: money-flow thrust',
    family: 'volume',
    style: 'trend',
    desc: 'The money flow crosses above +0.15 on a candle with at least 1.3× its normal volume, price above the 50 average → go with the buyers, 1.5 ATR stop, 2R. Only markets with real volume. Mirrored.',
    signal: ofThrustSignal,
  },
  {
    id: 'of_climax',
    name: 'Order flow: selling climax reversal',
    family: 'volume',
    style: 'revert',
    desc: 'A candle with 3× normal volume and a range of 1.8+ ATR makes a new 20-candle low but closes in its top 40% — the last sellers are out → buy, stop under the low, 1.5R. Only markets with real volume. Mirrored.',
    signal: ofClimaxSignal,
  },
  // ── v27.36 the friend's Asia-open level + absorption ──
  {
    id: 'asia_absorb',
    name: 'Asia open: level hit + absorption',
    family: 'ict',
    style: 'revert',
    charts: ['15m', '1h'],
    desc: "Your friend's setup: only the Asia open (candles closing 18:00–23:00 New York). Wait until a level from the bigger charts is hit — yesterday's or last week's high / low, or an untouched major swing point — for the first time in 12 candles. The candle that tags it must show the sellers (or buyers) being absorbed: a new 10-candle low that closes in the top half on 1.5× normal volume (no volume: a long lower wick, close in the top third), and no lower low after it. Enter at the close, stop just past that candle, target the nearest level on the other side at least 2R away (≤ 8R), else 3R; out after a day. He enters on the 1-minute — the bot's smallest chart is 15 minutes.",
    signal(c, i) {
      return levelAbsorbSignal(c, i, true);
    },
  },
  {
    id: 'level_absorb',
    name: 'Level hit + absorption (any session)',
    family: 'ict',
    style: 'revert',
    desc: 'The same level-plus-absorption entry as the Asia-open rule, at any hour — the yardstick that shows whether the Asia timing itself adds anything. Every chart, every market.',
    signal(c, i) {
      return levelAbsorbSignal(c, i, false);
    },
  },
  // ── control ──
  {
    id: 'random',
    name: 'Random entry (yardstick)',
    family: 'control',
    desc: 'Random side about once every 40 bars, 1.5 ATR stop, 1.5R target. Anything that cannot beat this has no edge.',
    signal(c, i) {
      // deterministic hash of the bar time → same "random" trades every run
      const x = Math.sin(c.bars[i]!.t / 3_600_000) * 10_000;
      const f = x - Math.floor(x);
      if (f > 0.025) return null;
      return atrSig(c, i, f < 0.0125 ? 1 : -1, 1.5, 1);
    },
  },
];

export const strategyById = (id: string) => STRATEGIES.find((s) => s.id === id) ?? null;

/** v15: does a strategy run on this chart? Session rules need hourly bars; multi-day rules skip 15m / 1m. Pure. */
/** v22: rules built on the forex week, its sessions, central-bank rates, the CFTC report or currency baskets have no
 * meaning on a coin that trades 24/7 against the dollar — they never run there. */
/** v26.4 (owner: "aren't you supposed to trade WITH news"): the strategies whose whole job is trading the move a release
 * or headline makes. The news pause (calendar ±30 min, big headlines, a 15-minute price shock) protects every OTHER
 * strategy from that move; these two were being blocked by it too, so they could almost never take the trade they were
 * tested on (the backtest has no news pause). Bank holidays and the clock still apply to them. */
export const NEWS_TRADERS = new Set(['news_drift', 'news_fade']);
export const tradesNews = (strategy: string | undefined): boolean => !!strategy && NEWS_TRADERS.has(strategy);

export const NOT_FOR_CRYPTO = new Set(['london_breakout', 'ny_open', 'orb_ny', 'pdh_pdl', 'judas_swing', 'ny_q3', 'amd_daily', 'asian_fade', 'local_hours', 'fix_flow', 'month_end_flow', 'weekend_gap', 'nr7_break', 'carry_trend', 'cot_squeeze', 'stretch_squeeze', 'ccy_momentum', 'stat_arb', 'mom_blend', 'oil_cad', 'yield_jpy', 'stocks_jpy', 'dollar_gold', 'turtle_soup']);
/** v27: rules built on currency baskets, central-bank rates, the CFTC currency report, FX-only flows (the London fix,
 * month-end re-hedging, local currency hours) or one named cross never run on a stock index. Session / ICT rules do:
 * the New York open is the index market's own open. */
export const NOT_FOR_INDEX = new Set(['local_hours', 'fix_flow', 'month_end_flow', 'carry_trend', 'cot_squeeze', 'stretch_squeeze', 'ccy_momentum', 'stat_arb', 'oil_cad', 'yield_jpy', 'stocks_jpy', 'dollar_gold', 'asian_fade']);
export function runsOn(s: Pick<Strategy, 'onlyHourly' | 'slow' | 'id' | 'charts'>, tf: string, pair?: string): boolean {
  if (pair && isCrypto(pair) && NOT_FOR_CRYPTO.has(s.id)) return false;
  if (pair && isIndex(pair) && NOT_FOR_INDEX.has(s.id)) return false;
  if (s.charts) return s.charts.includes(tf);
  if (s.onlyHourly) return tf === '1h';
  if (s.slow) return tf === '1h' || tf === '4h';
  return true;
}
