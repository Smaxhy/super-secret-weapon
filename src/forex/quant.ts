/**
 * v16 quant readings, all causal (bar i uses closes up to i only) and O(n) with running sums:
 *  - volF:  volatility forecast ratio. HAR model (Corsi 2009): tomorrow's variance ≈ 0.4 × the last day's + 0.35 × the
 *           last week's + 0.25 × the last month's (fixed published-style weights, no fitting → nothing to overfit).
 *           volF = forecast ÷ the last day's, as a volatility ratio: > 1 = moves expected to get BIGGER (a quiet
 *           stretch is about to end), < 1 = expected to calm down.
 *  - hurst: trend vs chop from the variance ratio over the last 120 bars (k = 8): ≈ 0.5 random, > 0.5 trending
 *           (moves continue), < 0.5 mean-reverting (moves snap back).
 *  - z120 / hl120: Ornstein–Uhlenbeck view of the log price over 120 bars — how many standard deviations it sits from
 *           its average, and the half-life (bars) in which a gap from that average has halved in the past
 *           (NaN = it does not revert in that window).
 */
export interface Quant {
  volF: Float64Array;
  hurst: Float64Array;
  z120: Float64Array;
  hl120: Float64Array;
  /** average log price over the same 120 bars (exp() = the price it reverts to) */
  m120: Float64Array;
}

/** Bars per trading day for a chart. */
export const barsPerDay = (barMin: number) => Math.max(1, Math.round(1440 / barMin));

/** HAR volatility forecast ratio per bar (NaN until a month of bars exists). Pure. */
export function harVolRatio(close: readonly number[], barMin: number): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  const d = barsPerDay(barMin);
  const w = 5 * d;
  const m = 22 * d;
  if (n <= m + 1) return out;
  const pre = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) {
    const r = Math.log(close[i]! / close[i - 1]!);
    pre[i + 1] = pre[i]! + (Number.isFinite(r) ? r * r : 0);
  }
  const rv = (i: number, len: number) => (pre[i + 1]! - pre[i + 1 - len]!) / len;
  for (let i = m; i < n; i++) {
    const v1 = rv(i, d);
    const fc = 0.4 * v1 + 0.35 * rv(i, w) + 0.25 * rv(i, m);
    out[i] = v1 > 0 ? Math.sqrt(fc / v1) : NaN;
  }
  return out;
}

/** Rolling Hurst exponent from the variance ratio (window w, horizon k). Pure. */
export function hurstVR(close: readonly number[], w = 120, k = 8): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= w + k) return out;
  const lc = close.map((x) => Math.log(x));
  const p1 = new Float64Array(n + 1);
  const q1 = new Float64Array(n + 1);
  const pk = new Float64Array(n + 1);
  const qk = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const r1 = i >= 1 ? lc[i]! - lc[i - 1]! : 0;
    const rk = i >= k ? lc[i]! - lc[i - k]! : 0;
    p1[i + 1] = p1[i]! + r1;
    q1[i + 1] = q1[i]! + r1 * r1;
    pk[i + 1] = pk[i]! + rk;
    qk[i + 1] = qk[i]! + rk * rk;
  }
  for (let i = w + k; i < n; i++) {
    const a = i - w + 1;
    const s1 = p1[i + 1]! - p1[a]!;
    const v1 = (q1[i + 1]! - q1[a]!) / w - (s1 / w) ** 2;
    const sk = pk[i + 1]! - pk[a]!;
    const vk = (qk[i + 1]! - qk[a]!) / w - (sk / w) ** 2;
    if (!(v1 > 0) || !(vk > 0)) continue;
    const vr = vk / (k * v1);
    out[i] = Math.min(1, Math.max(0, 0.5 + Math.log(vr) / (2 * Math.log(k))));
  }
  return out;
}

/** Rolling z-score of the log price and its OU half-life (window w). Pure. */
export function ouStats(close: readonly number[], w = 120): { z: Float64Array; hl: Float64Array; m: Float64Array } {
  const n = close.length;
  const z = new Float64Array(n).fill(NaN);
  const hl = new Float64Array(n).fill(NaN);
  const mm = new Float64Array(n).fill(NaN);
  if (n <= w + 1) return { z, hl, m: mm };
  const x = close.map((c) => Math.log(c));
  // running sums over x (level), and over the pairs (x[t−1], Δx[t]) for the half-life regression
  const sx = new Float64Array(n + 1);
  const sxx = new Float64Array(n + 1);
  const sl = new Float64Array(n + 1);
  const sll = new Float64Array(n + 1);
  const sd = new Float64Array(n + 1);
  const sld = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sx[i + 1] = sx[i]! + x[i]!;
    sxx[i + 1] = sxx[i]! + x[i]! * x[i]!;
    const lag = i >= 1 ? x[i - 1]! : 0;
    const dx = i >= 1 ? x[i]! - x[i - 1]! : 0;
    sl[i + 1] = sl[i]! + lag;
    sll[i + 1] = sll[i]! + lag * lag;
    sd[i + 1] = sd[i]! + dx;
    sld[i + 1] = sld[i]! + lag * dx;
  }
  for (let i = w; i < n; i++) {
    const a = i - w + 1;
    const mean = (sx[i + 1]! - sx[a]!) / w;
    const v = (sxx[i + 1]! - sxx[a]!) / w - mean * mean;
    mm[i] = mean;
    if (v > 0) z[i] = (x[i]! - mean) / Math.sqrt(v);
    const ml = (sl[i + 1]! - sl[a]!) / w;
    const md = (sd[i + 1]! - sd[a]!) / w;
    const cov = (sld[i + 1]! - sld[a]!) / w - ml * md;
    const vl = (sll[i + 1]! - sll[a]!) / w - ml * ml;
    if (vl > 0) {
      const beta = cov / vl;
      if (beta < 0 && beta > -1) hl[i] = -Math.LN2 / Math.log(1 + beta);
    }
  }
  return { z, hl, m: mm };
}

export function buildQuant(close: readonly number[], barMin: number): Quant {
  const { z, hl, m } = ouStats(close, 120);
  return { volF: harVolRatio(close, barMin), hurst: hurstVR(close, 120, 8), z120: z, hl120: hl, m120: m };
}
