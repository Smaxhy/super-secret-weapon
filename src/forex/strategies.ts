/**
 * Forex strategy library (v12). Each strategy reads the bar CLOSE at index i (and earlier) and may return a
 * Signal; the engine fills it at the NEXT bar's open. Every rule is mirrored long / short. `random` is the
 * yardstick: a strategy has to beat random entries with the same exits to mean anything.
 */
import { STRETCH } from './stretch';
import type { Ctx } from './ta';
import type { Signal } from './types';

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

export type Family = 'trend' | 'breakout' | 'session' | 'reversion' | 'pattern' | 'news' | 'intermarket' | 'flow' | 'control';
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

/** v16: crosses of closely linked currencies — where a stretched price tends to come back (the stat-arb candidates) */
export const STAT_ARB_PAIRS = ['EURGBP', 'AUDNZD', 'EURCHF'];
/** v16: the "big figure" step of a market: 100 pips for FX (1.1700, 150.00), $10 for gold, $0.50 for silver */
export function roundStep(pair: string): number {
  if (pair === 'XAUUSD') return 10;
  if (pair === 'XAGUSD') return 0.5;
  return pair.endsWith('JPY') ? 1 : 0.01;
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
      if (p.length < 6 || p.startsWith('XA')) return null;
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
      if (!p.includes('USD') || p.startsWith('XA')) return null;
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
      if (!c.ext || !p.includes('USD') || p.startsWith('XA')) return null;
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
export function runsOn(s: Pick<Strategy, 'onlyHourly' | 'slow'>, tf: string): boolean {
  if (s.onlyHourly) return tf === '1h';
  if (s.slow) return tf === '1h' || tf === '4h';
  return true;
}
