/**
 * Forex indicators. All causal: value i uses bars ≤ i only. Swings are reported at the bar where they
 * become CONFIRMED (k bars later), never at the pivot itself — no look-ahead.
 */
import { buildQuant, type Quant } from './quant';
import type { Flow } from './flow';
import { bollinger, emaSeries, macd, rsiSeries, sma } from '../evaluator/ta/indicators';
import type { Bar } from './types';
import { nyMinOfDay } from './ny-time';

export function atr(b: readonly Bar[], n = 14): number[] {
  const out: number[] = [];
  let a = NaN;
  for (let i = 0; i < b.length; i++) {
    const tr = i === 0 ? b[i]!.h - b[i]!.l : Math.max(b[i]!.h - b[i]!.l, Math.abs(b[i]!.h - b[i - 1]!.c), Math.abs(b[i]!.l - b[i - 1]!.c));
    if (i < n) a = i === 0 ? tr : (a * i + tr) / (i + 1);
    else a = (a * (n - 1) + tr) / n;
    out.push(i >= n - 1 ? a : NaN);
  }
  return out;
}

export function highest(v: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) {
      out.push(NaN);
      continue;
    }
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) m = Math.max(m, v[j]!);
    out.push(m);
  }
  return out;
}
export function lowest(v: readonly number[], n: number): number[] {
  return highest(v.map((x) => -x), n).map((x) => -x);
}

export function supertrend(b: readonly Bar[], n = 10, m = 3): { dir: number[]; line: number[] } {
  const a = atr(b, n);
  const dir: number[] = [];
  const line: number[] = [];
  let up = NaN;
  let dn = NaN;
  let d = 1;
  for (let i = 0; i < b.length; i++) {
    if (!Number.isFinite(a[i]!)) {
      dir.push(NaN);
      line.push(NaN);
      continue;
    }
    const mid = (b[i]!.h + b[i]!.l) / 2;
    const bu = mid - m * a[i]!;
    const bd = mid + m * a[i]!;
    const pc = b[i - 1]?.c ?? b[i]!.c;
    up = Number.isFinite(up) && pc > up ? Math.max(bu, up) : bu;
    dn = Number.isFinite(dn) && pc < dn ? Math.min(bd, dn) : bd;
    if (d === 1 && b[i]!.c < up) d = -1;
    else if (d === -1 && b[i]!.c > dn) d = 1;
    dir.push(d);
    line.push(d === 1 ? up : dn);
  }
  return { dir, line };
}

/** ADX + directional indicators (Wilder). */
export function adx(b: readonly Bar[], n = 14): { adx: number[]; pdi: number[]; mdi: number[] } {
  const a = atr(b, n);
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let i = 1; i < b.length; i++) {
    const upM = b[i]!.h - b[i - 1]!.h;
    const dnM = b[i - 1]!.l - b[i]!.l;
    pdm.push(upM > dnM && upM > 0 ? upM : 0);
    mdm.push(dnM > upM && dnM > 0 ? dnM : 0);
  }
  const sp = emaSeries(pdm, 2 * n - 1);
  const sm = emaSeries(mdm, 2 * n - 1);
  const pdi = sp.map((x, i) => (a[i]! > 0 ? (100 * x) / a[i]! : NaN));
  const mdi = sm.map((x, i) => (a[i]! > 0 ? (100 * x) / a[i]! : NaN));
  const dx = pdi.map((p, i) => (p + mdi[i]! > 0 ? (100 * Math.abs(p - mdi[i]!)) / (p + mdi[i]!) : 0));
  const ad = emaSeries(dx.map((x) => (Number.isFinite(x) ? x : 0)), 2 * n - 1);
  return { adx: ad.map((x, i) => (i >= 2 * n ? x : NaN)), pdi, mdi };
}

export interface Swing {
  /** pivot bar */
  i: number;
  /** bar at which it is known */
  at: number;
  p: number;
}

/** Confirmed swing highs / lows (k bars each side). */
export function swings(b: readonly Bar[], k = 3): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let j = k; j < b.length - k; j++) {
    let isH = true;
    let isL = true;
    for (let x = j - k; x <= j + k; x++) {
      if (x === j) continue;
      if (b[x]!.h >= b[j]!.h) isH = false;
      if (b[x]!.l <= b[j]!.l) isL = false;
    }
    if (isH) highs.push({ i: j, at: j + k, p: b[j]!.h });
    if (isL) lows.push({ i: j, at: j + k, p: b[j]!.l });
  }
  return { highs, lows };
}

/** Parabolic SAR (0.02 step, 0.2 max): value + direction (1 up / −1 down). */
export function psar(b: readonly Bar[], step = 0.02, max = 0.2): { sar: number[]; dir: number[] } {
  const sar: number[] = [];
  const dir: number[] = [];
  if (!b.length) return { sar, dir };
  let d = 1;
  let af = step;
  let ep = b[0]!.h;
  let s = b[0]!.l;
  for (let i = 0; i < b.length; i++) {
    if (i > 0) {
      s = s + af * (ep - s);
      if (d === 1) {
        s = Math.min(s, b[i - 1]!.l, b[i - 2]?.l ?? b[i - 1]!.l);
        if (b[i]!.l < s) {
          d = -1;
          s = ep;
          ep = b[i]!.l;
          af = step;
        } else if (b[i]!.h > ep) {
          ep = b[i]!.h;
          af = Math.min(max, af + step);
        }
      } else {
        s = Math.max(s, b[i - 1]!.h, b[i - 2]?.h ?? b[i - 1]!.h);
        if (b[i]!.h > s) {
          d = 1;
          s = ep;
          ep = b[i]!.h;
          af = step;
        } else if (b[i]!.l < ep) {
          ep = b[i]!.l;
          af = Math.min(max, af + step);
        }
      }
    }
    sar.push(s);
    dir.push(d);
  }
  return { sar, dir };
}

/** Stochastic %K (n) smoothed (k) and %D (d). */
export function stochastic(b: readonly Bar[], n = 14, k = 3, d = 3): { k: number[]; d: number[] } {
  const raw = b.map((_, i) => {
    if (i < n - 1) return NaN;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, b[j]!.h);
      lo = Math.min(lo, b[j]!.l);
    }
    return hi > lo ? ((b[i]!.c - lo) / (hi - lo)) * 100 : 50;
  });
  const kk = sma(raw.map((x) => (Number.isFinite(x) ? x : 50)), k).map((x, i) => (i >= n + k - 2 ? x : NaN));
  const dd = sma(kk.map((x) => (Number.isFinite(x) ? x : 50)), d).map((x, i) => (i >= n + k + d - 3 ? x : NaN));
  return { k: kk, d: dd };
}

/** Commodity Channel Index. */
export function cci(b: readonly Bar[], n = 20): number[] {
  const tp = b.map((x) => (x.h + x.l + x.c) / 3);
  const m = sma(tp, n);
  return tp.map((v, i) => {
    if (i < n - 1) return NaN;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j]! - m[i]!);
    md /= n;
    return md > 0 ? (v - m[i]!) / (0.015 * md) : 0;
  });
}

/** v14: cross-market readings aligned to a series' bars (read at each bar's close). Set by the lab. */
export interface CtxExt {
  /** strength gap base − quote (≈ normal moves) */
  gap: Float64Array;
  /** rank of the base / quote currency on 5-day strength: 0 = strongest … 7 = weakest (NaN = unknown; metals: base NaN) */
  rankBase: Float64Array;
  rankQuote: Float64Array;
  /** 24-hour move of the linked markets in normal 24-hour moves (z): oil, US 10-year yield, S&P futures, dollar index */
  zOil: Float64Array;
  zYield: Float64Array;
  zStocks: Float64Array;
  zDollar: Float64Array;
  /** S&P futures return since the start of the month, % */
  spxMtd: Float64Array;
  /** v16: carry = policy rate of the base − the quote, % (NaN = no rates feed) */
  carry?: Float64Array;
  /** v16: CFTC positioning of the pair, base − quote, −2 (crowd very short) … +2 (very long) (NaN = unknown) */
  cot?: Float64Array;
  /** v17: price stretch (positioning stand-in from prices only), same scale (NaN = unknown) */
  crowdPx?: Float64Array;
}

/** Everything a strategy may read at bar i, computed once per series. */
export interface Ctx {
  bars: Bar[];
  close: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  sma5: number[];
  rsi14: number[];
  rsi2: number[];
  atr14: number[];
  bb: { mid: number[]; upper: number[]; lower: number[]; width: number[] };
  bbWidthLow100: number[];
  macd: { line: number[]; signal: number[]; hist: number[] };
  hi20: number[];
  lo20: number[];
  hi55: number[];
  lo55: number[];
  hi10: number[];
  lo10: number[];
  st: { dir: number[]; line: number[] };
  adx: { adx: number[]; pdi: number[]; mdi: number[] };
  sw: { highs: Swing[]; lows: Swing[] };
  /** index into sw.highs / sw.lows of the last swing known at bar i (−1 = none) */
  hiPtr: number[];
  loPtr: number[];
  /** previous UTC day's high / low / close at bar i (null on day 1) */
  prevDay: Array<{ h: number; l: number; c: number } | null>;
  /** today's Asian range (00–07 UTC) once complete, else null */
  asia: Array<{ h: number; l: number } | null>;
  /** hour UTC of the bar */
  hour: number[];
  /** v23: minutes since New York midnight at the bar's OPEN (the ICT session rules read the clock in New York time) */
  nyMin: number[];
  /** minutes per bar */
  barMin: number;
  /** instrument id (EURUSD…) — for session / currency rules */
  pair: string;
  psar: { sar: number[]; dir: number[] };
  stoch: { k: number[]; d: number[] };
  cci20: number[];
  /** v14: efficiency ratio over 20 bars = |net move| ÷ path length (≈1 straight line, ≈0 chop) */
  er20: number[];
  /** v14: yesterday's range was the narrowest of the last 7 days (NR7) */
  nr7: boolean[];
  /** v14: cross-market readings (absent in plain backtests → strategies that need them stay silent) */
  ext?: CtxExt;
  /** v16: volatility forecast, Hurst exponent, OU z-score / half-life (see quant.ts) */
  quant?: Quant;
  /** memo for `volRatioAt` (−1 = not computed yet, NaN = unknown) */
  vrCache?: Float64Array;
  /** v27.35: deviation channel, volume profile, order flow (built on first use, `flowOf`) */
  flow?: Flow;
}

/** Efficiency ratio (Kaufman) over n bars. */
export function efficiencyRatio(close: readonly number[], n = 20): number[] {
  const out: number[] = new Array(close.length).fill(NaN);
  let path = 0;
  for (let i = 1; i < close.length; i++) {
    path += Math.abs(close[i]! - close[i - 1]!);
    if (i > n) path -= Math.abs(close[i - n]! - close[i - n - 1]!);
    if (i >= n) out[i] = path > 0 ? Math.abs(close[i]! - close[i - n]!) / path : 0;
  }
  return out;
}

export function buildCtx(bars: Bar[], barMin: number, pair = ''): Ctx {
  const sw = swings(bars, 3);
  const ptr = (xs: Swing[]) => {
    const out: number[] = [];
    let k = -1;
    for (let i = 0; i < bars.length; i++) {
      while (k + 1 < xs.length && xs[k + 1]!.at <= i) k++;
      out.push(k);
    }
    return out;
  };
  const close = bars.map((b) => b.c);
  const bb = bollinger(close, 20, 2);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const prevDay: Ctx['prevDay'] = [];
  const asia: Ctx['asia'] = [];
  const nr7: boolean[] = [];
  const ranges: number[] = [];
  let nr7Today = false;
  let day = -1;
  let cur = { h: -Infinity, l: Infinity, c: NaN };
  let prev: { h: number; l: number; c: number } | null = null;
  let ah = -Infinity;
  let al = Infinity;
  for (const b of bars) {
    const d = Math.floor(b.t / 86_400_000);
    const hr = new Date(b.t).getUTCHours();
    if (d !== day) {
      if (day >= 0 && Number.isFinite(cur.c)) {
        prev = { ...cur };
        ranges.push(cur.h - cur.l);
        const last7 = ranges.slice(-7);
        nr7Today = last7.length === 7 && ranges[ranges.length - 1]! <= Math.min(...last7);
      }
      day = d;
      cur = { h: -Infinity, l: Infinity, c: NaN };
      ah = -Infinity;
      al = Infinity;
    }
    cur.h = Math.max(cur.h, b.h);
    cur.l = Math.min(cur.l, b.l);
    cur.c = b.c;
    if (hr < 7) {
      ah = Math.max(ah, b.h);
      al = Math.min(al, b.l);
    }
    prevDay.push(prev);
    asia.push(hr >= 7 && Number.isFinite(ah) ? { h: ah, l: al } : null);
    nr7.push(nr7Today);
  }
  return {
    bars,
    close,
    ema20: emaSeries(close, 20),
    ema50: emaSeries(close, 50),
    ema200: emaSeries(close, 200),
    sma5: sma(close, 5),
    rsi14: rsiSeries(close, 14),
    rsi2: rsiSeries(close, 2),
    atr14: atr(bars, 14),
    bb,
    bbWidthLow100: lowest(bb.width.map((x) => (Number.isFinite(x) ? x : Infinity)), 100),
    macd: macd(close),
    hi20: highest(highs, 20),
    lo20: lowest(lows, 20),
    hi55: highest(highs, 55),
    lo55: lowest(lows, 55),
    hi10: highest(highs, 10),
    lo10: lowest(lows, 10),
    st: supertrend(bars, 10, 3),
    adx: adx(bars, 14),
    sw,
    hiPtr: ptr(sw.highs),
    loPtr: ptr(sw.lows),
    prevDay,
    asia,
    hour: bars.map((b) => new Date(b.t).getUTCHours()),
    nyMin: bars.map((b) => nyMinOfDay(b.t)),
    barMin,
    pair,
    psar: psar(bars),
    stoch: stochastic(bars),
    cci20: cci(bars, 20),
    er20: efficiencyRatio(close, 20),
    nr7,
    quant: buildQuant(close, barMin),
  };
}

/** Aggregate 1h bars into 4h bars (UTC buckets 00/04/08/12/16/20). Incomplete last bucket dropped. */
export function to4h(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let count = 0;
  let vol = 0;
  let volOk = true;
  for (const b of bars) {
    const k = Math.floor(b.t / 14_400_000) * 14_400_000;
    if (!cur || cur.t !== k) {
      if (cur && count >= 3) out.push(cur);
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c };
      vol = 0;
      volOk = true;
      count = 0;
    }
    cur.h = Math.max(cur.h, b.h);
    cur.l = Math.min(cur.l, b.l);
    cur.c = b.c;
    // v27.35: the 4-hour candle's volume = the sum of its hours (only when every hour has one)
    if (b.v !== undefined && b.v > 0) vol += b.v;
    else volOk = false;
    if (volOk) cur.v = vol;
    else delete cur.v;
    count++;
  }
  // last bucket only if complete (4 hourly bars) — avoids trading on a half-formed bar
  if (cur && count >= 4) out.push(cur);
  return out;
}
