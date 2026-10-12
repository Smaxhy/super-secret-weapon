/**
 * Policy search: find entry rules in the data with honest statistics, instead of guessing them.
 *
 * The idea in plain words:
 *   1. Put every trade (real + shadow trades it would have taken) in time order. The OLDEST 70% is where we look
 *      for patterns, the NEWEST 30% is kept aside to check them later ("holdout").
 *   2. Per strategy (and once for all strategies together) try simple rules on every feature most trades have:
 *      "feature below / above its 10%, 20% … 90% level". Then pair up the 10 best ones ("A and B").
 *   3. A rule is interesting when the trades it matches did clearly worse ('avoid') or clearly better ('prefer')
 *      than the rest — at least 5 points, and an avoid must still lose after its uncertainty, a prefer must still
 *      beat the +3% fee break-even.
 *   4. Honesty: results are winsorised (one +500% trade can't carry a rule), a rule must survive dropping its single
 *      most helpful trade, the p-value (Welch t-test) is corrected for EVERY rule tried (Benjamini–Hochberg, q 0.1 —
 *      try 5,000 rules on noise and ~250 look "significant" by luck; BH removes them), and finally the newest 30%
 *      must show the same effect at ≥ half the size.
 *   5. Near-duplicates are dropped and at most 6 rules come out, strongest first. They have the AI-rule shape
 *      (ai-coach.ts), so they go into the same testing → live lifecycle and still have to prove themselves forward.
 * Pure parts are exported for tests; the class only loads rows, runs it every hour and keeps the last result.
 */
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('policy-search');

export interface LearnRow {
  /** Flat numeric entry features, e.g. 'market.marketCapUsd', 'crowd.buyRatio2m', 'shape.run3m', 'entry.score', 'entry.hourUtc' (see flattenFeatures in src/learner/ai-coach.ts). */
  flat: Record<string, number>;
  strategy: string; // CURVE_SNIPE | SOON | MIGRATION_MOMENTUM | SMART_MONEY_COPY | SWING | RUNNER
  atMs: number; // when the entry decision was made (use for TIME-ORDERED splits only — never shuffle across time)
  pnlPct: number; // result after all costs, % of the position (e.g. +25, -14)
  peakX: number; // best multiple reached after entry (1 = never up)
  weight: number; // 1 = real paper trade, 0.5 = shadow trade it would have taken, lower for weaker labels
  source: 'real' | 'shadow' | 'outcome';
}

export interface PolicyCondition {
  feature: string;
  op: 'lt' | 'gt';
  value: number;
}

export interface PolicyEvidence {
  n: number;
  avgPct: number;
  restAvgPct: number;
  winRatePct: number;
  pValue: number;
  qValue: number;
  holdoutN: number;
  holdoutAvgPct: number;
  holdoutRestAvgPct: number;
}

export interface PolicyRule {
  title: string;
  why: string;
  strategy: string | null;
  action: 'avoid' | 'prefer';
  conditions: PolicyCondition[];
  evidence: PolicyEvidence;
}

export interface PolicySearchOptions {
  /** Benjamini–Hochberg false discovery rate. */
  q: number;
  /** Matched vs rest difference needed (percentage points). */
  minEffectPts: number;
  /** Win / prefer line after fees (%). */
  breakEvenPct: number;
  /** Newest share of rows kept aside for confirmation. */
  holdoutFrac: number;
  /** Matched subset needs weighted n ≥ max(minN, minFrac × scope); the rest ≥ minN. */
  minN: number;
  minFrac: number;
  /** Holdout needs this weighted n on both sides, else the rule can't be confirmed (discarded). */
  holdoutMinN: number;
  /** A feature must be present in this share of a scope's rows. */
  minPresence: number;
  /** Quantile levels tried as thresholds. */
  quantiles: number[];
  /** Best single conditions per scope that get paired up. */
  topSingles: number;
  maxRules: number;
  /** Winsorise results at these percentiles. */
  winsorLo: number;
  winsorHi: number;
  /** Strategies with fewer discovery rows than this are only covered by the all-strategies scope. */
  minScopeRows: number;
}

export const DEFAULT_POLICY_OPTIONS: PolicySearchOptions = {
  q: 0.1,
  minEffectPts: 5,
  breakEvenPct: 3,
  holdoutFrac: 0.3,
  minN: 15,
  minFrac: 0.08,
  holdoutMinN: 5,
  minPresence: 0.4,
  quantiles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  topSingles: 10,
  maxRules: 6,
  winsorLo: 0.02,
  winsorHi: 0.98,
  minScopeRows: 30,
};

export interface PolicySearchResult {
  /** Every candidate that was statistically tested (the BH denominator). */
  tested: number;
  rules: PolicyRule[];
  ranAt: string;
  rows: number;
  holdoutRows: number;
  ms: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// Small statistics helpers (pure)
// ---------------------------------------------------------------------------

/** Pure: weighted quantile (q in 0..1) of values. */
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!idx.length || total <= 0) return NaN;
  const target = q * total;
  let cum = 0;
  for (const i of idx) {
    cum += weights[i]!;
    if (cum >= target) return values[i]!;
  }
  return values[idx[idx.length - 1]!]!;
}

/** Pure: round to 3 significant digits (thresholds people can read; stats use the rounded value). */
export function niceValue(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const p = Math.pow(10, Math.floor(Math.log10(Math.abs(x))) - 2);
  return Math.round(x / p) * p;
}

function fmt(x: number): string {
  const a = Math.abs(x);
  if (a >= 1000) return String(Math.round(x));
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  return x.toFixed(2);
}
const pct = (x: number) => `${x >= 0 ? '+' : ''}${r1(x)}%`;

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.000000000190015;
  for (const ci of c) s += ci / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function erfc(x: number): number {
  // Numerical Recipes erfcc (fractional error < 1.2e-7).
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Pure: two-sided p-value of a t statistic (Student t with df degrees of freedom; normal when df is huge). */
export function twoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return t !== t ? 1 : 0;
  if (!Number.isFinite(df) || df > 1e5) return Math.min(1, erfc(Math.abs(t) / Math.SQRT2));
  const d = Math.max(1, df);
  return Math.min(1, Math.max(0, ibeta(d / (d + t * t), d / 2, 0.5)));
}

/** Weighted sufficient statistics: Σw, Σw², Σwy, Σwy². */
export interface Sums {
  w: number;
  w2: number;
  wy: number;
  wy2: number;
}
const ZERO: Sums = { w: 0, w2: 0, wy: 0, wy2: 0 };
const sub = (a: Sums, b: Sums): Sums => ({ w: a.w - b.w, w2: a.w2 - b.w2, wy: a.wy - b.wy, wy2: a.wy2 - b.wy2 });
const addRow = (s: Sums, w: number, y: number): Sums => ({ w: s.w + w, w2: s.w2 + w * w, wy: s.wy + w * y, wy2: s.wy2 + w * y * y });

export interface GroupStats {
  /** Weighted n (Σw). */
  n: number;
  /** Effective n (Σw)²/Σw² — used for standard errors. */
  neff: number;
  mean: number;
  /** Unbiased weighted variance. */
  variance: number;
  se: number;
}

/** Pure: weighted mean / variance / SE from sums. */
export function groupStats(s: Sums): GroupStats {
  if (s.w <= 1e-12) return { n: 0, neff: 0, mean: 0, variance: 0, se: Infinity };
  const mean = s.wy / s.w;
  const neff = s.w2 > 0 ? (s.w * s.w) / s.w2 : 0;
  const pop = Math.max(0, s.wy2 / s.w - mean * mean);
  const variance = neff > 1 ? (pop * neff) / (neff - 1) : 0;
  const se = neff > 1 ? Math.sqrt(variance / neff) : Infinity;
  return { n: s.w, neff, mean, variance, se };
}

/** Pure: Welch t-test of matched vs rest (weighted). */
export function welch(a: GroupStats, b: GroupStats): { t: number; df: number; p: number } {
  if (a.neff <= 1 || b.neff <= 1) return { t: 0, df: 1, p: 1 };
  const va = a.variance / a.neff;
  const vb = b.variance / b.neff;
  const den = Math.sqrt(va + vb);
  if (den <= 1e-12) {
    const diff = a.mean - b.mean;
    return Math.abs(diff) < 1e-9 ? { t: 0, df: 1, p: 1 } : { t: Math.sign(diff) * 1e6, df: a.neff + b.neff - 2, p: 0 };
  }
  const t = (a.mean - b.mean) / den;
  const dfDen = (va * va) / (a.neff - 1) + (vb * vb) / (b.neff - 1);
  const df = dfDen > 0 ? ((va + vb) * (va + vb)) / dfDen : a.neff + b.neff - 2;
  return { t, df, p: twoSidedP(t, df) };
}

/** Pure: Benjamini–Hochberg q-values (same order as the input p-values). */
export function bhQValues(p: readonly number[]): number[] {
  const m = p.length;
  const order = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const q = new Array<number>(m).fill(1);
  let min = 1;
  for (let k = m - 1; k >= 0; k--) {
    const i = order[k]!;
    min = Math.min(min, (p[i]! * m) / (k + 1));
    q[i] = min;
  }
  return q;
}

/** Pure: which action (if any) the effect supports. */
export function effectAction(m: GroupStats, rest: GroupStats, o: Pick<PolicySearchOptions, 'minEffectPts' | 'breakEvenPct'>): 'avoid' | 'prefer' | null {
  const diff = m.mean - rest.mean;
  if (diff <= -o.minEffectPts && m.mean + m.se < 0) return 'avoid';
  if (diff >= o.minEffectPts && m.mean - m.se > o.breakEvenPct) return 'prefer';
  return null;
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

const comboExcluded = (f: string) => f === 'entry.score' || f.startsWith('entry.hourUtc') || f.startsWith('entry.dowUtc');

interface Prepared {
  /** Discovery rows (oldest), holdout rows (newest). */
  disc: LearnRow[];
  hold: LearnRow[];
}

/** Pure: time-ordered split (never shuffled): oldest (1 − holdoutFrac) for discovery, newest for confirmation. */
export function timeSplit(rows: readonly LearnRow[], holdoutFrac: number): Prepared {
  const sorted = rows.filter((r) => Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs) && r.weight > 0).sort((a, b) => a.atMs - b.atMs);
  const cut = Math.round(sorted.length * (1 - holdoutFrac));
  return { disc: sorted.slice(0, cut), hold: sorted.slice(cut) };
}

interface Candidate {
  scope: string | null;
  conditions: PolicyCondition[];
  m: GroupStats;
  rest: GroupStats;
  p: number;
  t: number;
  action: 'avoid' | 'prefer' | null;
  /** Effect still there without the single most helpful matched trade. */
  robust: boolean;
  q?: number;
}

interface Scope {
  key: string | null;
  disc: LearnRow[];
  hold: LearnRow[];
  /** Winsorised result per discovery / holdout row. */
  y: Float64Array;
  yHold: Float64Array;
  total: Sums;
  /** Variance of the (winsorised) results over the whole scope. */
  variance: number;
  lo: number;
  hi: number;
}

function matches(conds: readonly PolicyCondition[], flat: Readonly<Record<string, number>>): boolean {
  for (const c of conds) {
    const v = flat[c.feature];
    if (v === undefined || !Number.isFinite(v) || !(c.op === 'lt' ? v < c.value : v > c.value)) return false;
  }
  return true;
}

function buildScope(key: string | null, disc: LearnRow[], hold: LearnRow[], o: PolicySearchOptions): Scope {
  const lo = weightedQuantile(disc.map((r) => r.pnlPct), disc.map((r) => r.weight), o.winsorLo);
  const hi = weightedQuantile(disc.map((r) => r.pnlPct), disc.map((r) => r.weight), o.winsorHi);
  const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
  const y = Float64Array.from(disc, (r) => clamp(r.pnlPct));
  const yHold = Float64Array.from(hold, (r) => clamp(r.pnlPct));
  let total = ZERO;
  disc.forEach((r, i) => (total = addRow(total, r.weight, y[i]!)));
  return { key, disc, hold, y, yHold, total, variance: groupStats(total).variance, lo, hi };
}

/** Evaluate one condition set directly on a scope (used for pairs, holdout, overlap). */
function evalDirect(s: Scope, conds: readonly PolicyCondition[], o: PolicySearchOptions): Candidate & { mask: Uint8Array } {
  const mask = new Uint8Array(s.disc.length);
  let ms = ZERO;
  let bestI = -1;
  let worstI = -1;
  s.disc.forEach((r, i) => {
    if (!matches(conds, r.flat)) return;
    mask[i] = 1;
    ms = addRow(ms, r.weight, s.y[i]!);
    if (bestI < 0 || s.y[i]! > s.y[bestI]!) bestI = i;
    if (worstI < 0 || s.y[i]! < s.y[worstI]!) worstI = i;
  });
  return { ...scoreCandidate(s, conds, ms, bestI, worstI, o), mask };
}

function scoreCandidate(s: Scope, conds: readonly PolicyCondition[], ms: Sums, bestI: number, worstI: number, o: PolicySearchOptions): Candidate {
  const m = robustSe(groupStats(ms), s);
  const rest = groupStats(sub(s.total, ms));
  const w = welch(m, rest);
  // Fat tails: a small group that happens to miss the rare big winners has a low mean AND a tiny spread, so
  // Welch alone calls it "significant". Also test with the whole scope's spread (the null) and keep the larger p.
  const pNull = nullVarianceP(m, rest, s);
  const action = effectAction(m, rest, o);
  let robust = false;
  if (action) {
    // Drop the trade that helps the rule most (best one for prefer, worst one for avoid) and re-check.
    const i = action === 'prefer' ? bestI : worstI;
    if (i >= 0) {
      const r = s.disc[i]!;
      const ms2 = sub(ms, addRow(ZERO, r.weight, s.y[i]!));
      robust = effectAction(robustSe(groupStats(ms2), s), rest, o) === action;
    }
  }
  return { scope: s.key, conditions: conds.map((c) => ({ ...c })), m, rest, p: Math.max(w.p, pNull), t: w.t, action, robust };
}

/** The matched group's SE is never smaller than the whole scope's spread would give (skew guard). */
function robustSe(g: GroupStats, s: Scope): GroupStats {
  if (g.neff <= 1) return g;
  return { ...g, se: Math.max(g.se, Math.sqrt(s.variance / g.neff)) };
}

/** Two-sample test with the scope's (null) variance for both groups. */
function nullVarianceP(m: GroupStats, rest: GroupStats, s: Scope): number {
  if (m.neff <= 1 || rest.neff <= 1 || s.variance <= 0) return 1;
  const t = (m.mean - rest.mean) / Math.sqrt(s.variance * (1 / m.neff + 1 / rest.neff));
  return twoSidedP(t, m.neff + rest.neff - 2);
}

function supported(s: Scope, mW: number, o: PolicySearchOptions): boolean {
  return mW >= Math.max(o.minN, o.minFrac * s.total.w) && s.total.w - mW >= o.minN;
}

interface Survivor {
  c: Candidate;
  mask: Uint8Array;
  scopeRows: number[];
  hN: number;
  hAvg: number;
  hRest: number;
}

/**
 * Pure-ish: the newest rows must show the SAME action on their own — the absolute condition too (prefer: matched
 * mean − SE above break-even; avoid: matched mean + SE below 0, same skew-guarded SE), an effect ≥ half the
 * discovery size, enough matched trades (effective n ≥ max(10, minFrac × holdout scope)) and a one-sided p < 0.2.
 */
function holdoutCheck(c: Candidate, s: Scope, o: PolicySearchOptions): { hN: number; hAvg: number; hRest: number } | null {
  let hm = ZERO;
  let hr = ZERO;
  s.hold.forEach((r, i) => {
    if (matches(c.conditions, r.flat)) hm = addRow(hm, r.weight, s.yHold[i]!);
    else hr = addRow(hr, r.weight, s.yHold[i]!);
  });
  if (hm.w < o.holdoutMinN || hr.w < o.holdoutMinN) return null;
  const hM = robustSe(groupStats(hm), s);
  const hR = groupStats(hr);
  if (hM.neff < Math.max(10, o.minFrac * (hm.w + hr.w))) return null;
  if (effectAction(hM, hR, o) !== c.action) return null;
  const dDisc = c.m.mean - c.rest.mean;
  const dHold = hM.mean - hR.mean;
  if (Math.sign(dHold) !== Math.sign(dDisc) || Math.abs(dHold) < 0.5 * Math.abs(dDisc)) return null;
  // One-sided p in the rule's direction (larger of Welch and the null-variance test, like discovery).
  const w = welch(hM, hR);
  const p2 = Math.max(w.p, nullVarianceP(hM, hR, s));
  if (p2 / 2 >= 0.2) return null; // the direction already agrees, so one-sided p = two-sided / 2
  return { hN: hm.w, hAvg: hM.mean, hRest: hR.mean };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.1 * Math.max(Math.abs(a), Math.abs(b), 1e-9);

/** `s` says the same thing as the stronger, already kept `k`. */
function isDuplicate(k: Survivor, s: Survivor): boolean {
  if (k.c.scope === s.c.scope && k.c.conditions.length === s.c.conditions.length) {
    if (k.c.action === s.c.action) {
      // Same feature + op with a threshold within 10% (same scope).
      const same = s.c.conditions.every((sc) => k.c.conditions.some((kc) => kc.feature === sc.feature && kc.op === sc.op && near(kc.value, sc.value)));
      if (same) return true;
    } else if (s.c.conditions.length === 1) {
      // The exact complement: 'avoid f < x' vs 'prefer f > x' — one rule, said twice.
      const a = k.c.conditions[0]!;
      const b = s.c.conditions[0]!;
      if (a.feature === b.feature && a.op !== b.op && near(a.value, b.value)) return true;
    }
  }
  if (k.c.action !== s.c.action) return false;
  // ≥ 80% of the smaller rule's trades are shared (symmetric overlap).
  if (!s.scopeRows.length || !k.scopeRows.length) return true;
  const [small, big] = s.scopeRows.length <= k.scopeRows.length ? [s, k] : [k, s];
  let inter = 0;
  for (const i of small.scopeRows) if (big.mask[i]) inter++;
  return inter / small.scopeRows.length >= 0.8;
}

/**
 * Generator core: yields between chunks so the async runner can give the event loop a breath.
 * Returns the final result.
 */
function* searchSteps(rows: readonly LearnRow[], opts: Partial<PolicySearchOptions> = {}, now = Date.now()): Generator<void, PolicySearchResult> {
  const t0 = Date.now();
  const o: PolicySearchOptions = { ...DEFAULT_POLICY_OPTIONS, ...opts };
  const { disc, hold } = timeSplit(rows, o.holdoutFrac);
  const empty: PolicySearchResult = { tested: 0, rules: [], ranAt: new Date(now).toISOString(), rows: disc.length, holdoutRows: hold.length, ms: 0 };
  if (disc.length < 2 * o.minN) return { ...empty, ms: Date.now() - t0 };

  yield;
  // Scopes: all strategies together + each strategy with enough rows.
  const scopes: Scope[] = [buildScope(null, disc, hold, o)];
  yield;
  const strategies = [...new Set(disc.map((r) => r.strategy))].sort();
  if (strategies.length > 1) {
    for (const st of strategies) {
      const d = disc.filter((r) => r.strategy === st);
      if (d.length < o.minScopeRows) continue;
      scopes.push(buildScope(st, d, hold.filter((r) => r.strategy === st), o));
      yield;
    }
  }
  yield;

  const all: Candidate[] = [];
  const singlesByScope = new Map<Scope, Candidate[]>();
  let work = 0;

  for (const s of scopes) {
    const singles: Candidate[] = [];
    // Features present in ≥ minPresence of this scope's rows.
    const presence = new Map<string, number>();
    for (let i = 0; i < s.disc.length; i++) {
      const r = s.disc[i]!;
      for (const k in r.flat) if (Number.isFinite(r.flat[k]!)) presence.set(k, (presence.get(k) ?? 0) + 1);
      if (i % 1000 === 999) yield;
    }
    const features = [...presence.entries()].filter(([, c]) => c >= o.minPresence * s.disc.length).map(([k]) => k).sort();
    yield;

    for (const f of features) {
      // Present rows sorted by value, with prefix sums → every threshold in O(log n).
      const idx: number[] = [];
      s.disc.forEach((r, i) => {
        const v = r.flat[f];
        if (v !== undefined && Number.isFinite(v)) idx.push(i);
      });
      idx.sort((a, b) => s.disc[a]!.flat[f]! - s.disc[b]!.flat[f]!);
      const n = idx.length;
      const vals = new Float64Array(n);
      const pre: Sums[] = [ZERO];
      const preMax = new Int32Array(n + 1).fill(-1);
      const preMin = new Int32Array(n + 1).fill(-1);
      for (let k = 0; k < n; k++) {
        const i = idx[k]!;
        vals[k] = s.disc[i]!.flat[f]!;
        pre.push(addRow(pre[k]!, s.disc[i]!.weight, s.y[i]!));
        const pm = preMax[k]!;
        preMax[k + 1] = pm < 0 || s.y[i]! > s.y[pm]! ? i : pm;
        const pn = preMin[k]!;
        preMin[k + 1] = pn < 0 || s.y[i]! < s.y[pn]! ? i : pn;
      }
      const sufMax = new Int32Array(n + 1).fill(-1);
      const sufMin = new Int32Array(n + 1).fill(-1);
      for (let k = n - 1; k >= 0; k--) {
        const i = idx[k]!;
        const sm = sufMax[k + 1]!;
        sufMax[k] = sm < 0 || s.y[i]! > s.y[sm]! ? i : sm;
        const sn = sufMin[k + 1]!;
        sufMin[k] = sn < 0 || s.y[i]! < s.y[sn]! ? i : sn;
      }
      const lowerBound = (t: number) => {
        let a = 0;
        let b = n;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (vals[mid]! < t) a = mid + 1;
          else b = mid;
        }
        return a;
      };
      const upperBound = (t: number) => {
        let a = 0;
        let b = n;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (vals[mid]! <= t) a = mid + 1;
          else b = mid;
        }
        return a;
      };
      // Weighted quantiles straight off the sorted values (prefix weights).
      const sortedQuantile = (q: number) => {
        const target = q * pre[n]!.w;
        let a = 1;
        let b = n;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (pre[mid]!.w >= target) b = mid;
          else a = mid + 1;
        }
        return vals[Math.max(0, a - 1)]!;
      };
      const thresholds = n ? [...new Set(o.quantiles.map((q) => niceValue(sortedQuantile(q))).filter(Number.isFinite))] : [];
      for (const t of thresholds) {
        // lt: values < t → prefix [0, lb)
        const lb = lowerBound(t);
        const ltSums = pre[lb]!;
        if (supported(s, ltSums.w, o)) {
          const c = scoreCandidate(s, [{ feature: f, op: 'lt', value: t }], ltSums, preMax[lb]!, preMin[lb]!, o);
          all.push(c);
          singles.push(c);
        }
        // gt: values > t → suffix [ub, n)
        const ub = upperBound(t);
        const gtSums = sub(pre[n]!, pre[ub]!);
        if (supported(s, gtSums.w, o)) {
          const c = scoreCandidate(s, [{ feature: f, op: 'gt', value: t }], gtSums, sufMax[ub]!, sufMin[ub]!, o);
          all.push(c);
          singles.push(c);
        }
      }
      work += n;
      if (work > 5_000) {
        work = 0;
        yield;
      }
    }
    singlesByScope.set(s, singles);
  }

  // Pairs ("A and B") of the best single conditions per scope (time-of-day / score left to their own learners).
  for (const s of scopes) {
    const singles = (singlesByScope.get(s) ?? []).filter((c) => !comboExcluded(c.conditions[0]!.feature)).sort((a, b) => a.p - b.p);
    const top: Candidate[] = [];
    for (const c of singles) {
      if (top.length >= o.topSingles) break;
      if (top.some((x) => x.conditions[0]!.feature === c.conditions[0]!.feature)) continue; // one threshold per feature
      top.push(c);
    }
    for (let a = 0; a < top.length; a++) {
      for (let b = a + 1; b < top.length; b++) {
        const conds = [top[a]!.conditions[0]!, top[b]!.conditions[0]!];
        const c = evalDirect(s, conds, o);
        if (!supported(s, c.m.n, o)) continue;
        // A pair must beat both of its parts, else the simpler rule says the same thing.
        const better = c.p < Math.min(top[a]!.p, top[b]!.p);
        all.push({ ...c, robust: c.robust && better });
      }
      yield;
    }
    yield;
  }

  // Multiple-testing honesty: BH over every candidate that was tested.
  const qs = bhQValues(all.map((c) => c.p));
  all.forEach((c, i) => (c.q = qs[i]!));
  const scopeOf = new Map(scopes.map((s) => [s.key ?? '*', s]));

  // Survivors: significant + effect + robust, strongest first (on (near-)ties the simpler rule wins). The holdout and
  // the dedup are checked lazily in that order and stop once maxRules rules are kept (yielding every ~200 candidates).
  const eligible = all.filter((c) => c.action && c.robust && (c.q ?? 1) < o.q);
  eligible.sort((a, b) => {
    const sa = -Math.log10(Math.max(a.p, 1e-300));
    const sb = -Math.log10(Math.max(b.p, 1e-300));
    if (Math.abs(sa - sb) <= 0.05 * Math.max(sa, sb)) return a.conditions.length - b.conditions.length || sb - sa;
    return sb - sa;
  });
  yield;

  const kept: Survivor[] = [];
  let checked = 0;
  for (const c of eligible) {
    if (kept.length >= o.maxRules) break;
    if (++checked % 200 === 0) yield;
    const s = scopeOf.get(c.scope ?? '*')!;
    const h = holdoutCheck(c, s, o);
    if (!h) continue;
    // Matched set over the GLOBAL discovery rows (so overlap works across scopes).
    const mask = new Uint8Array(disc.length);
    const rowsIdx: number[] = [];
    disc.forEach((r, i) => {
      if ((c.scope === null || r.strategy === c.scope) && matches(c.conditions, r.flat)) {
        mask[i] = 1;
        rowsIdx.push(i);
      }
    });
    const cand: Survivor = { c, mask, scopeRows: rowsIdx, ...h };
    if (!kept.some((k) => isDuplicate(k, cand))) kept.push(cand);
  }

  const rules: PolicyRule[] = kept.map(({ c, scopeRows, hN, hAvg, hRest }) => {
    let ww = 0;
    let wins = 0;
    for (const i of scopeRows) {
      const r = disc[i]!;
      ww += r.weight;
      if (r.pnlPct > o.breakEvenPct) wins += r.weight;
    }
    const who = c.scope ?? 'any strategy';
    const condText = c.conditions.map((x) => `${x.feature} ${x.op === 'lt' ? '<' : '>'} ${fmt(x.value)}`).join(' and ');
    const evidence: PolicyEvidence = {
      n: r1(c.m.n),
      avgPct: r1(c.m.mean),
      restAvgPct: r1(c.rest.mean),
      winRatePct: ww > 0 ? Math.round((wins / ww) * 100) : 0,
      pValue: Number(c.p.toPrecision(3)),
      qValue: Number((c.q ?? 1).toPrecision(3)),
      holdoutN: r1(hN),
      holdoutAvgPct: r1(hAvg),
      holdoutRestAvgPct: r1(hRest),
    };
    return {
      title: `${c.action} ${who} when ${condText}`,
      why: `${evidence.n} ${c.scope ?? ''}${c.scope ? ' ' : ''}trades with ${condText} averaged ${pct(evidence.avgPct)} vs ${pct(evidence.restAvgPct)} for the rest (win rate ${evidence.winRatePct}%, q ${evidence.qValue}); newer trades agree: ${pct(evidence.holdoutAvgPct)} vs ${pct(evidence.holdoutRestAvgPct)} (n ${evidence.holdoutN}).`,
      strategy: c.scope,
      action: c.action!,
      conditions: c.conditions,
      evidence,
    };
  });

  return { tested: all.length, rules, ranAt: new Date(now).toISOString(), rows: disc.length, holdoutRows: hold.length, ms: Date.now() - t0 };
}

/** Pure: find entry rules in the rows (synchronous). */
export function searchPolicies(rows: readonly LearnRow[], opts: Partial<PolicySearchOptions> = {}, now = Date.now()): PolicySearchResult {
  const g = searchSteps(rows, opts, now);
  for (;;) {
    const s = g.next();
    if (s.done) return s.value;
  }
}

/** Same as searchPolicies, but yields to the event loop between chunks. */
export async function searchPoliciesAsync(rows: readonly LearnRow[], opts: Partial<PolicySearchOptions> = {}, now = Date.now()): Promise<PolicySearchResult> {
  const g = searchSteps(rows, opts, now);
  for (;;) {
    const s = g.next();
    if (s.done) return s.value;
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Runner (thin): load rows, search every hour, keep the last result
// ---------------------------------------------------------------------------

export class PolicySearch {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private lastResult: PolicySearchResult | null = null;
  private running = false;

  constructor(
    private readonly loadRows: () => Promise<LearnRow[]>,
    private readonly opts: () => Partial<PolicySearchOptions> = () => ({}),
    private readonly everyMin = 60,
  ) {}

  /** First run 5 min after start, then every `everyMin` (≥ 30) minutes. */
  start(): void {
    this.first = setTimeout(() => void this.run(), 5 * 60_000);
    this.first.unref?.();
    this.timer = setInterval(() => void this.run(), Math.max(30, this.everyMin) * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  last(): PolicySearchResult | null {
    return this.lastResult;
  }

  async run(): Promise<PolicySearchResult | null> {
    if (this.running) return this.lastResult;
    this.running = true;
    try {
      const rows = await this.loadRows();
      const res = await searchPoliciesAsync(rows, this.opts());
      this.lastResult = res;
      log.info({ rows: res.rows, holdout: res.holdoutRows, tested: res.tested, rules: res.rules.length, ms: res.ms }, 'policy search done');
      return res;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'policy search failed');
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }
}
