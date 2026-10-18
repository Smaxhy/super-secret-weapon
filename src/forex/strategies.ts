/**
 * Forex strategy library (v12). Each strategy reads the bar CLOSE at index i (and earlier) and may return a
 * Signal; the engine fills it at the NEXT bar's open. Every rule is mirrored long / short. `random` is the
 * yardstick: a strategy has to beat random entries with the same exits to mean anything.
 */
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

export type Family = 'trend' | 'breakout' | 'session' | 'reversion' | 'pattern' | 'news' | 'control';

export interface Strategy {
  id: string;
  name: string;
  family: Family;
  /** one line, plain words */
  desc: string;
  /** session strategies need hourly bars */
  onlyHourly?: boolean;
  signal(c: Ctx, i: number): Signal | null;
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
