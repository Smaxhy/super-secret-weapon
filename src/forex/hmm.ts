/**
 * v18 hidden-Markov regime model (pure). A Gaussian HMM on a series' bar-to-bar returns: K hidden states (ordered by
 * their volatility: quiet … wild), each with its own mean and variance, and a matrix of switching probabilities.
 * Fitted by Baum-Welch (EM) on the FIRST 70% of a series only; then the states are read CAUSALLY with the forward
 * filter — P(state at bar i | returns up to bar i) — so the reading at a bar never sees a later bar. Used by the
 * 'hmm' trade filter: no new trades while the wild state is likely (news / crisis regime), fades only when the quiet
 * state has real weight, trend rules not in a dead-quiet market. Graded like every other filter (picked on the first
 * 70%, graded on the unseen 30%).
 */

export const HMM = {
  states: 3,
  iters: 40,
  /** bars needed to fit a model */
  minBars: 600,
  /** a state's sd may not fall under this share of the series' sd (keeps EM from collapsing on a few outliers) */
  sigmaFloorFrac: 0.15,
  /** the 'hmm' filter: the wild state's probability above this → no new trades */
  crisis: 0.6,
  /** fades need at least this much weight on the quiet state; trend rules need the market not this quiet */
  quietMin: 0.35,
  quietMax: 0.8,
};

export interface HmmModel {
  k: number;
  /** per state: mean and sd of the return (same units as the input) */
  mu: number[];
  sigma: number[];
  /** A[s][s'] = P(next state s' | state s) */
  A: number[][];
  pi: number[];
  logLik: number;
  iters: number;
  /** index of the wildest / quietest state */
  hi: number;
  lo: number;
}

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const logPdf = (x: number, mu: number, sigma: number) => {
  const z = (x - mu) / sigma;
  return -0.5 * z * z - Math.log(sigma) - LOG_SQRT_2PI;
};

/** Bar-to-bar returns of a close series in basis points (the first is 0). Pure. */
export function hmmReturns(close: readonly number[]): number[] {
  const out = new Array<number>(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const a = close[i - 1]!;
    const b = close[i]!;
    out[i] = a > 0 && b > 0 ? 1e4 * Math.log(b / a) : 0;
  }
  return out;
}

/** Per-bar emission likelihoods, shifted per bar so the largest is 1 (underflow-safe); the shifts are returned. */
function emissions(x: readonly number[], mu: readonly number[], sigma: readonly number[]): { b: Float64Array; shift: Float64Array } {
  const k = mu.length;
  const n = x.length;
  const b = new Float64Array(n * k);
  const shift = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let mx = -Infinity;
    for (let s = 0; s < k; s++) {
      const v = logPdf(x[t]!, mu[s]!, sigma[s]!);
      b[t * k + s] = v;
      if (v > mx) mx = v;
    }
    shift[t] = mx;
    for (let s = 0; s < k; s++) b[t * k + s] = Math.exp(b[t * k + s]! - mx);
  }
  return { b, shift };
}

/**
 * Fit a K-state Gaussian HMM on `x` by Baum-Welch. Deterministic: the states start from the thirds of |x| (quiet,
 * normal, wild), uniform start probabilities, 0.9 on staying put. Null when the data is too short or flat.
 */
export function fitHmm(x: readonly number[], k = HMM.states, iters = HMM.iters): HmmModel | null {
  const n = x.length;
  if (n < HMM.minBars || k < 2) return null;
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    s1 += v;
    s2 += v * v;
  }
  const mean = s1 / n;
  const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  if (!(sd > 0)) return null;
  const floor = HMM.sigmaFloorFrac * sd;
  // init: states by the magnitude of the returns
  const byAbs = [...x].map((v, i) => [Math.abs(v - mean), i] as const).sort((a, b) => a[0] - b[0]);
  const mu: number[] = [];
  const sigma: number[] = [];
  for (let s = 0; s < k; s++) {
    const from = Math.floor((s * n) / k);
    const to = Math.floor(((s + 1) * n) / k);
    let m = 0;
    let q = 0;
    for (let j = from; j < to; j++) {
      const v = x[byAbs[j]![1]]!;
      m += v;
      q += v * v;
    }
    const cnt = Math.max(1, to - from);
    m /= cnt;
    mu.push(m);
    sigma.push(Math.max(floor, Math.sqrt(Math.max(0, q / cnt - m * m))));
  }
  const A: number[][] = Array.from({ length: k }, (_, s) => Array.from({ length: k }, (_, t) => (s === t ? 0.9 : 0.1 / (k - 1))));
  const pi = new Array<number>(k).fill(1 / k);
  const alpha = new Float64Array(n * k);
  const beta = new Float64Array(n * k);
  const c = new Float64Array(n);
  let logLik = -Infinity;
  let it = 0;
  for (it = 1; it <= iters; it++) {
    const { b, shift } = emissions(x, mu, sigma);
    // forward (scaled)
    let ll = 0;
    for (let t = 0; t < n; t++) {
      let sum = 0;
      for (let s = 0; s < k; s++) {
        let pr = 0;
        if (t === 0) pr = pi[s]!;
        else for (let r = 0; r < k; r++) pr += alpha[(t - 1) * k + r]! * A[r]![s]!;
        const v = pr * b[t * k + s]!;
        alpha[t * k + s] = v;
        sum += v;
      }
      c[t] = sum > 0 ? sum : 1e-300;
      for (let s = 0; s < k; s++) alpha[t * k + s] = alpha[t * k + s]! / c[t]!;
      ll += Math.log(c[t]!) + shift[t]!;
    }
    // backward (same scaling)
    for (let s = 0; s < k; s++) beta[(n - 1) * k + s] = 1;
    for (let t = n - 2; t >= 0; t--) {
      for (let s = 0; s < k; s++) {
        let v = 0;
        for (let r = 0; r < k; r++) v += A[s]![r]! * b[(t + 1) * k + r]! * beta[(t + 1) * k + r]!;
        beta[t * k + s] = v / c[t + 1]!;
      }
    }
    // M step
    const gSum = new Float64Array(k);
    const gSumT = new Float64Array(k);
    const xi = Array.from({ length: k }, () => new Float64Array(k));
    const muN = new Float64Array(k);
    const sgN = new Float64Array(k);
    for (let t = 0; t < n; t++) {
      for (let s = 0; s < k; s++) {
        const g = alpha[t * k + s]! * beta[t * k + s]!;
        gSum[s] = gSum[s]! + g;
        muN[s] = muN[s]! + g * x[t]!;
        if (t < n - 1) {
          gSumT[s] = gSumT[s]! + g;
          for (let r = 0; r < k; r++) xi[s]![r] = xi[s]![r]! + (alpha[t * k + s]! * A[s]![r]! * b[(t + 1) * k + r]! * beta[(t + 1) * k + r]!) / c[t + 1]!;
        }
      }
    }
    for (let s = 0; s < k; s++) {
      const g = gSum[s]!;
      if (!(g > 1e-9)) continue;
      mu[s] = muN[s]! / g;
    }
    for (let t = 0; t < n; t++) for (let s = 0; s < k; s++) {
      const g = alpha[t * k + s]! * beta[t * k + s]!;
      const d = x[t]! - mu[s]!;
      sgN[s] = sgN[s]! + g * d * d;
    }
    for (let s = 0; s < k; s++) {
      const g = gSum[s]!;
      if (g > 1e-9) sigma[s] = Math.max(floor, Math.sqrt(sgN[s]! / g));
      pi[s] = alpha[s]! * beta[s]!;
      const gt = gSumT[s]!;
      if (gt > 1e-9) for (let r = 0; r < k; r++) A[s]![r] = Math.max(1e-6, xi[s]![r]! / gt);
      const rowSum = A[s]!.reduce((a, v) => a + v, 0);
      for (let r = 0; r < k; r++) A[s]![r] = A[s]![r]! / rowSum;
    }
    const piSum = pi.reduce((a, v) => a + v, 0);
    for (let s = 0; s < k; s++) pi[s] = piSum > 0 ? pi[s]! / piSum : 1 / k;
    if (Number.isFinite(logLik) && ll - logLik < 1e-6 * Math.abs(logLik)) {
      logLik = ll;
      break;
    }
    logLik = ll;
  }
  if (!Number.isFinite(logLik)) return null;
  let hi = 0;
  let lo = 0;
  for (let s = 1; s < k; s++) {
    if (sigma[s]! > sigma[hi]!) hi = s;
    if (sigma[s]! < sigma[lo]!) lo = s;
  }
  if (hi === lo) return null;
  return { k, mu, sigma, A, pi, logLik, iters: Math.min(it, iters), hi, lo };
}

/**
 * Causal state probabilities: P(state at t | x[0..t]) for every t, from the forward filter alone (no backward pass, so
 * a reading never changes when later bars arrive). Returns one array per state.
 */
export function filterHmm(m: HmmModel, x: readonly number[]): Float64Array[] {
  const k = m.k;
  const n = x.length;
  const out = Array.from({ length: k }, () => new Float64Array(n));
  const prev = new Float64Array(k);
  for (let t = 0; t < n; t++) {
    const xt = x[t]!;
    let mx = -Infinity;
    const lb = new Array<number>(k);
    for (let s = 0; s < k; s++) {
      lb[s] = logPdf(xt, m.mu[s]!, m.sigma[s]!);
      if (lb[s]! > mx) mx = lb[s]!;
    }
    let sum = 0;
    const cur = new Array<number>(k);
    for (let s = 0; s < k; s++) {
      let pr = 0;
      if (t === 0) pr = m.pi[s]!;
      else for (let r = 0; r < k; r++) pr += prev[r]! * m.A[r]![s]!;
      const v = pr * Math.exp(lb[s]! - mx);
      cur[s] = v;
      sum += v;
    }
    for (let s = 0; s < k; s++) {
      const v = sum > 0 ? cur[s]! / sum : 1 / k;
      prev[s] = v;
      out[s]![t] = v;
    }
  }
  return out;
}

export interface HmmRegime {
  model: HmmModel;
  /** P(wildest state) per bar, causal */
  pHigh: Float64Array;
  /** P(quietest state) per bar, causal */
  pLow: Float64Array;
  /** bars the model was fitted on */
  fitBars: number;
}

/**
 * Regime readings for a close series: the model is fitted on the first `fitBars` bars only, then every bar is read
 * causally. NaN on the first bar (no return yet). Null when the fit window is too short or the series is flat.
 */
export function hmmRegime(close: readonly number[], fitBars: number, k = HMM.states): HmmRegime | null {
  const r = hmmReturns(close);
  const fitN = Math.min(r.length, Math.max(0, Math.floor(fitBars)));
  if (fitN < HMM.minBars) return null;
  const model = fitHmm(r.slice(1, fitN), k);
  if (!model) return null;
  const post = filterHmm(model, r.slice(1));
  const n = close.length;
  const pHigh = new Float64Array(n);
  const pLow = new Float64Array(n);
  pHigh[0] = NaN;
  pLow[0] = NaN;
  for (let i = 1; i < n; i++) {
    pHigh[i] = post[model.hi]![i - 1]!;
    pLow[i] = post[model.lo]![i - 1]!;
  }
  return { model, pHigh, pLow, fitBars: fitN };
}

/** The 'hmm' filter's rule (pure): see the file comment. Missing readings pass. */
export function passHmm(pHigh: number | undefined, pLow: number | undefined, style: 'trend' | 'revert' | 'pullback' | 'neutral'): boolean {
  if (pHigh === undefined || !Number.isFinite(pHigh)) return true;
  if (pHigh >= HMM.crisis) return false;
  const quiet = pLow !== undefined && Number.isFinite(pLow) ? pLow : NaN;
  if (!Number.isFinite(quiet)) return true;
  if (style === 'revert') return quiet >= HMM.quietMin;
  if (style === 'trend') return quiet < HMM.quietMax;
  return true;
}

/** Why the 'hmm' filter blocks (null = allowed). Pure. */
export function hmmBlockReason(pHigh: number | undefined, pLow: number | undefined, style: 'trend' | 'revert' | 'pullback' | 'neutral'): string | null {
  if (passHmm(pHigh, pLow, style)) return null;
  if (pHigh !== undefined && pHigh >= HMM.crisis) return `the regime model reads a wild (news / crisis) state (${Math.round(pHigh * 100)}%)`;
  return style === 'revert' ? 'the regime model does not read a quiet market (fades need one)' : 'the regime model reads a dead-quiet market (trend rules need movement)';
}
