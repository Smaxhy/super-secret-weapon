/**
 * Technical indicators on candles — the building blocks of the chart strategies
 * (src/evaluator/ta/strategies.ts). All pure, all return series aligned with the input
 * (index i = value at candle i; NaN where there isn't enough history yet).
 */
import type { Candle } from '../chart-reader';

export const closes = (c: readonly Candle[]) => c.map((x) => x.c);

/** Simple moving average. */
export function sma(v: readonly number[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]!;
    if (i >= n) sum -= v[i - n]!;
    out.push(i >= n - 1 ? sum / n : NaN);
  }
  return out;
}

/** Exponential moving average (seeded with the first value). */
export function emaSeries(v: readonly number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1]! * (1 - k)));
  return out;
}

/** Wilder's RSI series. */
export function rsiSeries(v: readonly number[], n = 14): number[] {
  const out: number[] = v.map(() => NaN);
  if (v.length < n + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i]! - v[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
    out[i] = val();
  }
  return out;
}

/** MACD (fast EMA − slow EMA), its signal line and histogram. */
export function macd(v: readonly number[], fast = 12, slow = 26, signal = 9): { line: number[]; signal: number[]; hist: number[] } {
  const f = emaSeries(v, fast);
  const s = emaSeries(v, slow);
  const line = v.map((_, i) => (i >= slow - 1 ? f[i]! - s[i]! : NaN));
  const firstValid = line.findIndex((x) => Number.isFinite(x));
  const sig = line.map(() => NaN);
  if (firstValid >= 0) {
    const e = emaSeries(line.slice(firstValid), signal);
    e.forEach((x, k) => (sig[firstValid + k] = k >= signal - 1 ? x : NaN));
  }
  return { line, signal: sig, hist: line.map((x, i) => (Number.isFinite(x) && Number.isFinite(sig[i]!) ? x - sig[i]! : NaN)) };
}

/** Bollinger bands: middle SMA ± k standard deviations, and the band width (upper − lower) ÷ middle. */
export function bollinger(v: readonly number[], n = 20, k = 2): { mid: number[]; upper: number[]; lower: number[]; width: number[] } {
  const mid = sma(v, n);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(mid[i]!)) {
      upper.push(NaN);
      lower.push(NaN);
      width.push(NaN);
      continue;
    }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(s / n);
    upper.push(mid[i]! + k * sd);
    lower.push(mid[i]! - k * sd);
    width.push(mid[i]! > 0 ? (2 * k * sd) / mid[i]! : NaN);
  }
  return { mid, upper, lower, width };
}

/** True range and Wilder's average true range. */
export function atr(c: readonly Candle[], n = 14): number[] {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]!.c), Math.abs(x.l - c[i - 1]!.c))));
  const out: number[] = c.map(() => NaN);
  if (c.length < n) return out;
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = a;
  for (let i = n; i < c.length; i++) {
    a = (a * (n - 1) + tr[i]!) / n;
    out[i] = a;
  }
  return out;
}

/** Anchored VWAP from candle `from` (typical price × SOL volume), plus its ±1σ / ±2σ volume-weighted bands. */
export function vwapBands(c: readonly Candle[], from = 0): { vwap: number[]; sd: number[] } {
  const vwap: number[] = [];
  const sd: number[] = [];
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (let i = 0; i < c.length; i++) {
    if (i < from) {
      vwap.push(NaN);
      sd.push(NaN);
      continue;
    }
    const x = c[i]!;
    const tp = (x.h + x.l + x.c) / 3;
    const w = Math.max(x.v, 1e-9);
    pv += tp * w;
    pv2 += tp * tp * w;
    vol += w;
    const m = pv / vol;
    vwap.push(m);
    sd.push(Math.sqrt(Math.max(0, pv2 / vol - m * m)));
  }
  return { vwap, sd };
}

/** On-balance volume (SOL): + volume on up closes, − on down closes. */
export function obv(c: readonly Candle[]): number[] {
  const out: number[] = [];
  c.forEach((x, i) => out.push(i === 0 ? 0 : out[i - 1]! + (x.c > c[i - 1]!.c ? x.v : x.c < c[i - 1]!.c ? -x.v : 0)));
  return out;
}

/** Cumulative volume delta (SOL): running buy volume − sell volume. */
export function cvd(c: readonly Candle[]): number[] {
  const out: number[] = [];
  c.forEach((x, i) => out.push((i === 0 ? 0 : out[i - 1]!) + x.bv - x.sv));
  return out;
}

/** Supertrend (ATR `n`, multiplier `m`): direction +1 (bullish) / −1 (bearish) per candle and the line. */
export function supertrend(c: readonly Candle[], n = 10, m = 3): { dir: number[]; line: number[] } {
  const a = atr(c, n);
  const dir: number[] = [];
  const line: number[] = [];
  let upper = NaN;
  let lower = NaN;
  let d = 1;
  for (let i = 0; i < c.length; i++) {
    const x = c[i]!;
    if (!Number.isFinite(a[i]!)) {
      dir.push(NaN);
      line.push(NaN);
      continue;
    }
    const hl2 = (x.h + x.l) / 2;
    const bu = hl2 + m * a[i]!;
    const bl = hl2 - m * a[i]!;
    const prevClose = c[i - 1]?.c ?? x.c;
    upper = Number.isFinite(upper) && (bu < upper || prevClose > upper) ? bu : Number.isFinite(upper) ? upper : bu;
    lower = Number.isFinite(lower) && (bl > lower || prevClose < lower) ? bl : Number.isFinite(lower) ? lower : bl;
    if (d === 1 && x.c < lower) d = -1;
    else if (d === -1 && x.c > upper) d = 1;
    dir.push(d);
    line.push(d === 1 ? lower : upper);
  }
  return { dir, line };
}

/** Heikin-Ashi candles (smoothed: trend candles have no wick on the "wrong" side). */
export function heikinAshi(c: readonly Candle[]): Array<{ o: number; h: number; l: number; c: number }> {
  const out: Array<{ o: number; h: number; l: number; c: number }> = [];
  c.forEach((x, i) => {
    const hc = (x.o + x.h + x.l + x.c) / 4;
    const ho = i === 0 ? (x.o + x.c) / 2 : (out[i - 1]!.o + out[i - 1]!.c) / 2;
    out.push({ o: ho, c: hc, h: Math.max(x.h, ho, hc), l: Math.min(x.l, ho, hc) });
  });
  return out;
}

/** Stochastic RSI: %K (smoothed) and %D, 0–100. */
export function stochRsi(v: readonly number[], rsiN = 14, stochN = 14, kN = 3, dN = 3): { k: number[]; d: number[] } {
  const r = rsiSeries(v, rsiN);
  const raw = r.map((x, i) => {
    if (!Number.isFinite(x) || i < rsiN + stochN - 1) return NaN;
    const win = r.slice(i - stochN + 1, i + 1);
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    return hi > lo ? ((x - lo) / (hi - lo)) * 100 : 50;
  });
  const smooth = (s: number[], n: number) => s.map((_, i) => {
    const w = s.slice(Math.max(0, i - n + 1), i + 1);
    return w.length === n && w.every(Number.isFinite) ? w.reduce((a, b) => a + b, 0) / n : NaN;
  });
  const k = smooth(raw, kN);
  return { k, d: smooth(k, dN) };
}

/** Swing highs / lows: a candle whose high (low) is the highest (lowest) of `k` candles on each side. */
export function swings(c: readonly Candle[], k = 2): { highs: Array<{ i: number; p: number }>; lows: Array<{ i: number; p: number }> } {
  const highs: Array<{ i: number; p: number }> = [];
  const lows: Array<{ i: number; p: number }> = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j]!.h > c[i]!.h || (j > i && c[j]!.h === c[i]!.h)) isH = false;
      if (c[j]!.l < c[i]!.l || (j > i && c[j]!.l === c[i]!.l)) isL = false;
    }
    if (isH) highs.push({ i, p: c[i]!.h });
    if (isL) lows.push({ i, p: c[i]!.l });
  }
  return { highs, lows };
}

/**
 * The last impulse leg, the way a trader draws Fibonacci on it: the highest high of the last
 * `lookback` candles, and the swing low the leg started from — walking back from the high,
 * the lowest point reached before an EARLIER peak at least `minSwingPct`% above it (that peak
 * is where the previous leg ended). No earlier peak → the lowest low in the window.
 * null if there is no up-leg.
 */
export function lastImpulse(c: readonly Candle[], lookback = 60, minSwingPct = 20): { lowIdx: number; low: number; highIdx: number; high: number } | null {
  if (c.length < 5) return null;
  const start = Math.max(0, c.length - lookback);
  let highIdx = start;
  for (let i = start; i < c.length; i++) if (c[i]!.h > c[highIdx]!.h) highIdx = i;
  let lowIdx = highIdx;
  for (let j = highIdx - 1; j >= Math.max(0, highIdx - lookback); j--) {
    if (c[j]!.l < c[lowIdx]!.l) lowIdx = j;
    // An earlier peak well above the running low: the leg we're measuring started at that low.
    if (c[j]!.h >= c[lowIdx]!.l * (1 + minSwingPct / 100) && j < lowIdx) break;
  }
  if (lowIdx >= highIdx) return null;
  return { lowIdx, low: c[lowIdx]!.l, highIdx, high: c[highIdx]!.h };
}

/** Fibonacci levels of an up-leg: retracement r → high − r·(high − low); extension e → low + e·(high − low). */
export function fibLevels(low: number, high: number): { retrace: (r: number) => number; extend: (e: number) => number; depthOf: (price: number) => number } {
  const range = high - low;
  return {
    retrace: (r) => high - r * range,
    extend: (e) => low + e * range,
    depthOf: (p) => (range > 0 ? (high - p) / range : 0),
  };
}
