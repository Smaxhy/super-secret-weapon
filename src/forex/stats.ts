/**
 * v18 honest statistics (pure). The lab tests hundreds of strategy × chart × filter × exit combinations and grades them
 * on the unseen 30% — with that many trials some pass by luck. These are the standard quant answers to "how much of
 * this is luck?":
 *  - Probabilistic / Deflated Sharpe ratio (Bailey & López de Prado 2012 / 2014): the chance a row's true Sharpe is
 *    above the Sharpe the BEST of N noise trials would show (skew / fat tails / track length taken into account).
 *  - Probability of Backtest Overfitting (Bailey, Borwein, López de Prado, Zhu 2017, CSCV): split the history into S
 *    blocks, for every half-and-half split pick the best row on one half and see where it ranks on the other; PBO =
 *    the share of splits where the in-sample winner is below the median out of sample.
 *  - White's Reality Check (2000) and Hansen's SPA test (2005): a stationary bootstrap of the rows' excess returns over
 *    a benchmark — does the best row beat the benchmark once every row tried is accounted for?
 *  - Minimum track record length: how many observations a row needs before its Sharpe is trusted at a given confidence.
 * Everything is a plain function of return series; nothing here touches a trade.
 */

const EULER = 0.5772156649015329;

/** Φ(x): standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). Pure. */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : x < 0 ? 0 : NaN;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
  const p = 0.5 * (1 + y);
  return x >= 0 ? p : 1 - p;
}

/** Φ⁻¹(p): inverse normal (Acklam's algorithm, relative error < 1.2e-9). Pure. */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : p >= 1 ? Infinity : NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export interface Moments {
  n: number;
  mean: number;
  /** sample standard deviation (n − 1) */
  sd: number;
  skew: number;
  /** non-excess kurtosis (a normal has 3) */
  kurt: number;
}

/** Mean, sd, skew, kurtosis of a series. Pure. */
export function moments(xs: readonly number[]): Moments {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, sd: 0, skew: 0, kurt: 3 };
  let s = 0;
  for (const x of xs) s += x;
  const mean = s / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const v = m2 / n;
  const sd = Math.sqrt(m2 / (n - 1));
  if (!(v > 0)) return { n, mean, sd: 0, skew: 0, kurt: 3 };
  return { n, mean, sd, skew: m3 / n / Math.pow(v, 1.5), kurt: m4 / n / (v * v) };
}

/** Sharpe ratio per observation (mean ÷ sample sd; 0 when flat). Pure. */
export function sharpe(xs: readonly number[]): number {
  const m = moments(xs);
  return m.sd > 0 ? m.mean / m.sd : 0;
}

/** Standard error of an estimated Sharpe ratio (Bailey & López de Prado 2012, eq. 6 — skew and fat tails widen it). */
export function sharpeSe(sr: number, n: number, skew: number, kurt: number): number {
  if (n < 2) return Infinity;
  const inner = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  return Math.sqrt(Math.max(1e-12, inner) / (n - 1));
}

/** Probabilistic Sharpe ratio: P(true SR > srStar | the observed SR). Pure. */
export function psr(sr: number, n: number, skew: number, kurt: number, srStar = 0): number {
  const se = sharpeSe(sr, n, skew, kurt);
  if (!Number.isFinite(se)) return 0.5;
  return normCdf((sr - srStar) / se);
}

/**
 * The Sharpe ratio the BEST of `nTrials` strategies with no edge would show, given the variance of the trials' Sharpe
 * ratios (Bailey & López de Prado 2014, eq. 1). 0 for one trial.
 */
export function expectedMaxSharpe(nTrials: number, varSr: number): number {
  if (!(nTrials > 1) || !(varSr > 0)) return 0;
  return Math.sqrt(varSr) * ((1 - EULER) * normInv(1 - 1 / nTrials) + EULER * normInv(1 - 1 / (nTrials * Math.E)));
}

export interface Deflated {
  /** the observed Sharpe per observation */
  sr: number;
  /** what the best of the trials would show by luck */
  srStar: number;
  se: number;
  /** P(true Sharpe > srStar): ≥ 0.95 is the usual "real" bar; < 0.5 means luck explains it as well */
  dsr: number;
  /** P(true Sharpe > 0) with no multiple-testing correction */
  psr0: number;
}

/** Deflated Sharpe ratio of one series given how many trials were run and how spread out their Sharpes were. Pure. */
export function deflatedSharpe(xs: readonly number[], trials: { n: number; varSr: number }): Deflated {
  const m = moments(xs);
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const srStar = expectedMaxSharpe(trials.n, trials.varSr);
  return { sr, srStar, se: sharpeSe(sr, m.n, m.skew, m.kurt), dsr: psr(sr, m.n, m.skew, m.kurt, srStar), psr0: psr(sr, m.n, m.skew, m.kurt, 0) };
}

/** Observations needed before an observed Sharpe `sr` beats `srStar` at confidence 1 − alpha (∞ when it never can). */
export function minTrackRecord(sr: number, skew: number, kurt: number, srStar = 0, alpha = 0.05): number {
  if (!(sr > srStar)) return Infinity;
  const z = normInv(1 - alpha);
  const inner = Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr);
  return 1 + inner * Math.pow(z / (sr - srStar), 2);
}

/** Variance of a set of Sharpe ratios (the "V" of the deflated Sharpe). Pure. */
export function varianceOf(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}

/** mulberry32 — a small seeded generator (pure, deterministic). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PboResult {
  /** share of the splits where the in-sample winner ranked below the median out of sample (0 = never, 1 = always) */
  pbo: number;
  /** number of half-and-half splits tried */
  combos: number;
  blocks: number;
  trials: number;
  /** out-of-sample Sharpe of the in-sample winner vs its in-sample Sharpe (OLS over the splits) */
  degradation: { slope: number; intercept: number };
  /** share of splits where the in-sample winner LOST out of sample */
  pLossOos: number;
  /** the winner's out-of-sample rank as a logit: 10th / 50th / 90th percentile across splits */
  logit: { p10: number; median: number; p90: number };
}

/** Enumerate every subset of `s` elements out of `n` (Gosper's hack). Pure. */
function* subsets(n: number, s: number): Generator<number> {
  const limit = 1 << n;
  let x = (1 << s) - 1;
  while (x < limit) {
    yield x;
    const c = x & -x;
    const r = x + c;
    x = (((r ^ x) >>> 2) / c) | r;
  }
}

/**
 * Probability of Backtest Overfitting by CSCV. `trials[k]` = the k-th row's return per period (all the same length T,
 * aligned in time; zeros for periods without a trade are fine). S blocks (even, ≤ 20); every choice of S/2 blocks is
 * the in-sample half. Null when the data is too short (needs ≥ 4 periods a block) or there are fewer than 2 trials.
 */
export function pbo(trials: ReadonlyArray<ArrayLike<number>>, blocks = 16): PboResult | null {
  const N = trials.length;
  if (N < 2) return null;
  const S = Math.max(2, Math.min(20, blocks - (blocks % 2)));
  const T = Math.min(...trials.map((t) => t.length));
  const per = Math.floor(T / S);
  if (per < 4) return null;
  // per trial × block: count, Σr, Σr²
  const sum = new Float64Array(N * S);
  const sq = new Float64Array(N * S);
  for (let k = 0; k < N; k++) {
    const r = trials[k]!;
    for (let b = 0; b < S; b++) {
      let s1 = 0;
      let s2 = 0;
      for (let i = b * per; i < (b + 1) * per; i++) {
        const v = r[i]!;
        s1 += v;
        s2 += v * v;
      }
      sum[k * S + b] = s1;
      sq[k * S + b] = s2;
    }
  }
  const srOf = (k: number, mask: number, cnt: number) => {
    let s1 = 0;
    let s2 = 0;
    for (let b = 0; b < S; b++) if (mask & (1 << b)) {
      s1 += sum[k * S + b]!;
      s2 += sq[k * S + b]!;
    }
    const m = s1 / cnt;
    const v = s2 / cnt - m * m;
    return v > 1e-18 ? m / Math.sqrt(v) : 0;
  };
  const full = (1 << S) - 1;
  const cnt = (S / 2) * per;
  const logits: number[] = [];
  const pairs: Array<[number, number]> = [];
  let overfit = 0;
  let loss = 0;
  const test = new Float64Array(N);
  for (const mask of subsets(S, S / 2)) {
    const out = full ^ mask;
    let best = 0;
    let bestSr = -Infinity;
    for (let k = 0; k < N; k++) {
      const sr = srOf(k, mask, cnt);
      if (sr > bestSr) {
        bestSr = sr;
        best = k;
      }
    }
    for (let k = 0; k < N; k++) test[k] = srOf(k, out, cnt);
    const tb = test[best]!;
    let below = 0;
    for (let k = 0; k < N; k++) if (test[k]! < tb) below++;
    const w = (below + 1) / (N + 1);
    const lg = Math.log(w / (1 - w));
    logits.push(lg);
    if (lg < 0) overfit++;
    if (tb < 0) loss++;
    pairs.push([bestSr, tb]);
  }
  const combos = logits.length;
  // OLS of the winner's out-of-sample Sharpe on its in-sample Sharpe
  let mx = 0;
  let my = 0;
  for (const [x, y] of pairs) {
    mx += x;
    my += y;
  }
  mx /= combos;
  my /= combos;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) * (x - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const sorted = [...logits].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { pbo: r3(overfit / combos), combos, blocks: S, trials: N, degradation: { slope: r3(slope), intercept: r3(my - slope * mx) }, pLossOos: r3(loss / combos), logit: { p10: r3(q(0.1)), median: r3(q(0.5)), p90: r3(q(0.9)) } };
}

export interface SpaResult {
  /** the Reality Check statistic √T × the best mean excess return */
  rcStat: number;
  /** its bootstrap p-value (P[a set of no-edge rows shows a best this good]) */
  pRc: number;
  /** Hansen's SPA statistic (studentised, poor rows' means kept so they don't inflate the null) and its p-value */
  spaStat: number;
  pSpa: number;
  /** the row with the best mean excess return, and that mean */
  best: number;
  bestMean: number;
  draws: number;
  blockLen: number;
  trials: number;
  periods: number;
}

/**
 * White's Reality Check and Hansen's SPA on excess returns per period over a benchmark (`d[k][t]`, all rows the same
 * length T). Stationary bootstrap (Politis & Romano: blocks of random length, mean `blockLen`). Null with fewer than
 * 2 rows or 20 periods.
 */
export function realityCheck(d: ReadonlyArray<ArrayLike<number>>, o: { draws?: number; blockLen?: number; seed?: number } = {}): SpaResult | null {
  const N = d.length;
  if (N < 1) return null;
  const T = Math.min(...d.map((x) => x.length));
  if (T < 20) return null;
  const B = Math.max(50, Math.round(o.draws ?? 500));
  const L = Math.max(2, Math.round(o.blockLen ?? Math.cbrt(T)));
  const p = 1 / L;
  const rnd = rng(o.seed ?? 11);
  const mean = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += d[k]![t]!;
    mean[k] = s / T;
  }
  let best = 0;
  for (let k = 1; k < N; k++) if (mean[k]! > mean[best]!) best = k;
  const sqT = Math.sqrt(T);
  const rcStat = sqT * mean[best]!;
  // bootstrap means per draw × row
  const bm = new Float64Array(B * N);
  const idx = new Int32Array(T);
  for (let b = 0; b < B; b++) {
    // stationary bootstrap index path
    let cur = Math.floor(rnd() * T);
    for (let t = 0; t < T; t++) {
      if (t > 0) cur = rnd() < p ? Math.floor(rnd() * T) : (cur + 1) % T;
      idx[t] = cur;
    }
    for (let k = 0; k < N; k++) {
      const r = d[k]!;
      let s = 0;
      for (let t = 0; t < T; t++) s += r[idx[t]!]!;
      bm[b * N + k] = s / T;
    }
  }
  // ω̂_k = √T × bootstrap sd of the mean (the long-run sd); the studentised statistic
  const omega = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    let s2 = 0;
    for (let b = 0; b < B; b++) {
      const v = bm[b * N + k]!;
      s += v;
      s2 += v * v;
    }
    const m = s / B;
    omega[k] = Math.max(1e-12, sqT * Math.sqrt(Math.max(0, s2 / B - m * m)));
  }
  let spaStat = -Infinity;
  for (let k = 0; k < N; k++) spaStat = Math.max(spaStat, (sqT * mean[k]!) / omega[k]!);
  // Hansen's recentring: a row that is clearly worse than the benchmark keeps its mean under the null (it can't be the
  // best anyway), a row near or above it is centred at 0
  const cut = -Math.sqrt(2 * Math.log(Math.log(T)));
  const keep = new Float64Array(N);
  for (let k = 0; k < N; k++) keep[k] = (sqT * mean[k]!) / omega[k]! <= cut ? mean[k]! : 0;
  let pRc = 0;
  let pSpa = 0;
  for (let b = 0; b < B; b++) {
    let v = -Infinity;
    let z = -Infinity;
    for (let k = 0; k < N; k++) {
      const m = bm[b * N + k]!;
      v = Math.max(v, sqT * (m - mean[k]!));
      z = Math.max(z, (sqT * (m - mean[k]! + keep[k]!)) / omega[k]!);
    }
    if (v >= rcStat) pRc++;
    if (z >= spaStat) pSpa++;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { rcStat: r3(rcStat), pRc: r3(pRc / B), spaStat: r3(spaStat), pSpa: r3(pSpa / B), best, bestMean: mean[best]!, draws: B, blockLen: L, trials: N, periods: T };
}

/** Sum a series of (time, value) pairs into fixed buckets from `from` to `to` (missing buckets = 0). Pure. */
export function bucketSums(items: ReadonlyArray<{ t: number; v: number }>, from: number, to: number, size: number): Float64Array {
  const n = Math.max(1, Math.ceil((to - from) / size));
  const out = new Float64Array(n);
  for (const it of items) {
    if (it.t < from || it.t >= to) continue;
    out[Math.min(n - 1, Math.floor((it.t - from) / size))]! += it.v;
  }
  return out;
}
