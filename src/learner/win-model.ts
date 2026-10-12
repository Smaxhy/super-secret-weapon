/**
 * Win model ("Phase 8-lite"): a small, self-checking win-probability model over the entry features.
 *
 * The idea in plain words: every trade (real, and shadow trades it would have taken at half weight) is a
 * row of numbers seen at the moment of the buy (`flat`, see flattenFeatures in ai-coach.ts) plus how it
 * ended. A "win" = more than +3% after all costs (fees make break-even ≈ +3%). The model learns which
 * numbers go with wins, and then — before it is ever allowed to touch a decision — it has to PROVE itself:
 *
 *   1. Time-ordered exam: rows are sorted by time, it learns on the oldest 75% and is graded on the newest
 *      25% it has never seen (no shuffling across time — markets change, so the exam is "the future").
 *      Everything it learns (which features, their medians / spreads) comes from the oldest 75% only.
 *   2. It must beat the bot's existing score at ranking trades WITHIN a strategy: stratified exam AUC (weighted
 *      average of the per-strategy AUCs — predict() is relative to each strategy's base rate, so knowing that one
 *      strategy wins more often earns nothing) ≥ 0.58 AND ≥ the stratified AUC of `entry.score` alone on the same
 *      rows + 0.02. Plus enough data: ≥ 150 effective rows (Σ weights) and ≥ 15 effective winners in the exam.
 *   3. Only then it is refitted on ALL rows (same λ, same validated features / flags / strategies; only medians /
 *      spreads recomputed) and becomes ACTIVE: predict() turns its win
 *      probability into −10…+10 score points vs the usual win rate of that strategy. Not active → 0 points.
 *
 * Model: L2-regularised logistic regression (Newton / IRLS, row weights), robust scaling (median / IQR,
 * clipped to ±5), missing values → 0 after scaling plus a "was missing" flag for the top 15 features
 * (missing ≠ 0), one intercept per strategy. The L2 strength is picked from {0.1, 1, 10} by log-loss on an inner
 * time-ordered split INSIDE the training rows (never on the exam). Only the newest 4,000 rows are used, and the
 * fit yields to the event loop regularly so training never blocks trading.
 * Pure parts are exported for tests; the class does the Redis work (`model:win`).
 */
import type { Redis } from 'ioredis';
import { moduleLogger } from '../lib/logger';

import { FittedTreeModel, trainTreeModel, type TreeReport } from './tree-model';
const log = moduleLogger('win-model');

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

export interface WinModelOptions {
  /** A win = pnlPct above this (fees make break-even ≈ +3%). */
  winPct: number;
  minRows: number;
  minValPositives: number;
  minValAuc: number;
  /** Must beat the AUC of `entry.score` alone by this much. */
  minAucGain: number;
  /** Share of (time-sorted) rows used for training; the newest rest is the exam. */
  trainShare: number;
  /** A feature must be present in at least this share of the training rows. */
  minPresence: number;
  maxFeatures: number;
  maxMissingFlags: number;
  /** A strategy gets its own intercept only with this many training rows. */
  minStrategyRows: number;
  l2Grid: number[];
  /** points = clamp(round((p − baseRate) × pointsScale), ±maxPoints). */
  pointsScale: number;
  maxPoints: number;
  /** Strategy base rates are shrunk towards the overall rate with this many pseudo-rows. */
  baseShrinkRows: number;
  scoreFeature: string;
  /** Only the newest this many rows (by atMs) are used (bounds CPU / memory). */
  maxTrainRows: number;
  /** Share of the training rows (oldest) used to fit while choosing λ; the newest rest of TRAIN picks λ. */
  innerTrainShare: number;
}

export const DEFAULT_WIN_MODEL_OPTIONS: WinModelOptions = {
  winPct: 3,
  minRows: 150,
  minValPositives: 15,
  minValAuc: 0.58,
  minAucGain: 0.02,
  trainShare: 0.75,
  minPresence: 0.25,
  maxFeatures: 60,
  maxMissingFlags: 15,
  minStrategyRows: 10,
  l2Grid: [0.1, 1, 10],
  pointsScale: 40,
  maxPoints: 10,
  baseShrinkRows: 20,
  scoreFeature: 'entry.score',
  maxTrainRows: 4000,
  innerTrainShare: 0.8,
};

const CLIP = 5;
const EPS = 1e-12;
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export const isWin = (r: Pick<LearnRow, 'pnlPct'>, winPct = DEFAULT_WIN_MODEL_OPTIONS.winPct): boolean => r.pnlPct > winPct;
const rowW = (r: LearnRow): number => (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 0);

/**
 * Pure: weighted ROC AUC (probability a random winner scores above a random loser; ties count half). 0.5 when undefined.
 * Rows with a non-finite score or a non-finite / non-positive weight are ignored.
 */
export function weightedAuc(scores: ArrayLike<number>, labels: ArrayLike<number>, weights?: ArrayLike<number>): number {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const w = weights ? weights[i]! : 1;
    if (Number.isFinite(scores[i]!) && Number.isFinite(w) && w > 0) idx.push(i);
  }
  idx.sort((a, b) => scores[a]! - scores[b]!);
  const n = idx.length;
  let negBelow = 0;
  let totPos = 0;
  let totNeg = 0;
  let acc = 0;
  let i = 0;
  while (i < n) {
    const s0 = scores[idx[i]!]!;
    let j = i;
    let pos = 0;
    let neg = 0;
    // Every tie group takes at least one element, so the loop always advances.
    do {
      const k = idx[j]!;
      const w = weights ? weights[k]! : 1;
      if (labels[k]! > 0.5) pos += w;
      else neg += w;
      j++;
    } while (j < n && scores[idx[j]!] === s0);
    acc += pos * (negBelow + neg / 2);
    negBelow += neg;
    totPos += pos;
    totNeg += neg;
    i = j;
  }
  return totPos > 0 && totNeg > 0 ? acc / (totPos * totNeg) : 0.5;
}

/**
 * Pure: stratified AUC = weighted average of the per-group (per-strategy) AUCs, over the groups that have both
 * winners and losers; a group's weight = its total row weight. Ranking ACROSS groups (e.g. one strategy simply
 * wins more often) earns nothing — only ranking within a strategy counts. 0.5 when no group qualifies.
 */
export function stratifiedAuc(
  scores: ArrayLike<number>,
  labels: ArrayLike<number>,
  weights: ArrayLike<number>,
  groups: ArrayLike<string>,
): { auc: number; groups: number } {
  const by = new Map<string, number[]>();
  for (let i = 0; i < scores.length; i++) {
    const g = groups[i]!;
    let e = by.get(g);
    if (!e) by.set(g, (e = []));
    e.push(i);
  }
  let W = 0;
  let acc = 0;
  let used = 0;
  for (const ids of by.values()) {
    let pos = 0;
    let neg = 0;
    const s: number[] = [];
    const y: number[] = [];
    const w: number[] = [];
    for (const i of ids) {
      const wi = weights[i]!;
      if (!Number.isFinite(wi) || wi <= 0 || !Number.isFinite(scores[i]!)) continue;
      s.push(scores[i]!);
      y.push(labels[i]!);
      w.push(wi);
      if (labels[i]! > 0.5) pos += wi;
      else neg += wi;
    }
    if (!(pos > 0 && neg > 0)) continue;
    const gw = pos + neg;
    acc += gw * weightedAuc(s, y, w);
    W += gw;
    used++;
  }
  return { auc: W > 0 ? acc / W : 0.5, groups: used };
}

/** Pure: weighted log-loss, Brier score and a 5-bin calibration table (equal-weight bins by predicted p). */
export function probabilityMetrics(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>, bins = 5) {
  let W = 0;
  let ll = 0;
  let br = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i]!));
    W += w[i]!;
    ll -= w[i]! * (y[i]! > 0.5 ? Math.log(q) : Math.log(1 - q));
    br += w[i]! * (q - y[i]!) ** 2;
  }
  const idx = Array.from({ length: p.length }, (_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const calibration: Array<{ pMean: number; winRate: number; n: number }> = [];
  let k = 0;
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    const target = (W * (b + 1)) / bins;
    let sw = 0;
    let sp = 0;
    let sy = 0;
    let n = 0;
    while (k < idx.length && (cum < target - 1e-9 || b === bins - 1)) {
      const i = idx[k++]!;
      cum += w[i]!;
      sw += w[i]!;
      sp += w[i]! * p[i]!;
      sy += w[i]! * y[i]!;
      n++;
    }
    if (n) calibration.push({ pMean: round3(sp / Math.max(sw, EPS)), winRate: round3(sy / Math.max(sw, EPS)), n });
  }
  return { logLoss: W > 0 ? ll / W : NaN, brier: W > 0 ? br / W : NaN, calibration };
}

/** Pure: sort by time and split into the oldest `trainShare` and the newest rest. */
export function timeSplit<T extends { atMs: number }>(rows: readonly T[], trainShare = 0.75): { train: T[]; val: T[] } {
  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs);
  const cut = Math.max(1, Math.min(sorted.length - 1, Math.floor(sorted.length * trainShare)));
  return { train: sorted.slice(0, cut), val: sorted.slice(cut) };
}

export interface FeatureStat {
  name: string;
  median: number;
  /** Robust spread (IQR; falls back to 1.349 × SD when the IQR is 0). */
  scale: number;
  presence: number;
  /** Weighted point-biserial correlation with winning (on the rows that have it). */
  corr: number;
}

export interface Pipeline {
  features: FeatureStat[];
  /** Features that also get a "was missing" flag. */
  missingFlags: string[];
  strategies: string[];
}

/** Growable per-feature column: which rows have it (Int32Array) and their values (Float64Array). */
interface Column {
  idx: Int32Array;
  val: Float64Array;
  n: number;
}

function pushCol(c: Column, i: number, v: number): void {
  if (c.n === c.idx.length) {
    const cap = c.idx.length * 2;
    const idx = new Int32Array(cap);
    idx.set(c.idx);
    const val = new Float64Array(cap);
    val.set(c.val);
    c.idx = idx;
    c.val = val;
  }
  c.idx[c.n] = i;
  c.val[c.n] = v;
  c.n++;
}

/** Robust stats of one feature column; null when they are unusable (constant, overflowed, non-finite). */
function columnStat(name: string, c: Column, w: Float64Array, y: Float64Array, nRows: number): FeatureStat | null {
  const n = c.n;
  const sorted = Float64Array.from(c.val.subarray(0, n)).sort();
  const q = (x: number): number => {
    const pos = (n - 1) * x;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };
  const median = q(0.5);
  let scale = q(0.75) - q(0.25);
  // Weighted Pearson between the feature and the 0/1 target = point-biserial correlation.
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) {
    const i = c.idx[k]!;
    sw += w[i]!;
    mx += w[i]! * c.val[k]!;
    my += w[i]! * y[i]!;
  }
  if (!(sw > 0)) return null;
  mx /= sw;
  my /= sw;
  let cxy = 0;
  let cxx = 0;
  let cyy = 0;
  for (let k = 0; k < n; k++) {
    const i = c.idx[k]!;
    const dx = c.val[k]! - mx;
    const dy = y[i]! - my;
    cxy += w[i]! * dx * dy;
    cxx += w[i]! * dx * dx;
    cyy += w[i]! * dy * dy;
  }
  if (!(scale > 0)) scale = 1.349 * Math.sqrt(cxx / sw);
  if (!Number.isFinite(median) || !Number.isFinite(scale) || !(scale > 0)) return null; // constant / overflowed
  let corr = cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : 0;
  if (!Number.isFinite(corr)) corr = 0;
  return { name, median, scale, presence: n / Math.max(1, nRows), corr };
}

interface Collector {
  kept: LearnRow[];
  n: number;
  w: Float64Array;
  y: Float64Array;
  cols: Map<string, Column>;
  only?: ReadonlySet<string>;
  init: number;
}

/** Per-row weights / labels once (Float64Array); feature columns are filled by collectRows. */
function newCollector(rows: readonly LearnRow[], winPct: number, only?: ReadonlySet<string>): Collector {
  const kept = rows.filter((r) => rowW(r) > 0);
  const n = kept.length;
  const w = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = rowW(kept[i]!);
    y[i] = isWin(kept[i]!, winPct) ? 1 : 0;
  }
  return { kept, n, w, y, cols: new Map(), only, init: Math.max(4, Math.min(n, 64)) };
}

/** Adds the finite values of rows [from, to) to the compact columns. */
function collectRows(c: Collector, from: number, to: number): void {
  const only = c.only;
  for (let i = from; i < to; i++) {
    const flat = c.kept[i]!.flat;
    for (const k in flat) {
      if (only && !only.has(k)) continue;
      const v = flat[k]!;
      if (!Number.isFinite(v)) continue;
      let col = c.cols.get(k);
      if (!col) c.cols.set(k, (col = { idx: new Int32Array(c.init), val: new Float64Array(c.init), n: 0 }));
      pushCol(col, i, v);
    }
  }
}

function selectFeatures(c: Collector, opts: WinModelOptions, stats: FeatureStat[]): Pipeline {
  stats.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr) || a.name.localeCompare(b.name));
  const features = stats.slice(0, opts.maxFeatures);
  const missingFlags = features
    .slice(0, opts.maxMissingFlags)
    .filter((f) => f.presence < 0.99)
    .map((f) => f.name);
  const counts = new Map<string, number>();
  for (const r of c.kept) counts.set(r.strategy, (counts.get(r.strategy) ?? 0) + 1);
  const strategies = [...counts].filter(([, n]) => n >= opts.minStrategyRows).map(([s]) => s).sort();
  return { features, missingFlags, strategies };
}

const candidateStat = (c: Collector, opts: WinModelOptions, name: string, col: Column): FeatureStat | null =>
  col.n / Math.max(1, c.n) < opts.minPresence || col.n < 5 ? null : columnStat(name, col, c.w, c.y, c.n);

const refitStat = (c: Collector, name: string): FeatureStat | null => {
  const col = c.cols.get(name);
  return col && col.n >= 2 ? columnStat(name, col, c.w, c.y, c.n) : null;
};

/** Pure: choose features + their scaling stats from the TRAINING rows only (no peeking at the exam). */
export function buildPipeline(train: readonly LearnRow[], opts: WinModelOptions = DEFAULT_WIN_MODEL_OPTIONS): Pipeline {
  const c = newCollector(train, opts.winPct);
  collectRows(c, 0, c.n);
  const stats: FeatureStat[] = [];
  for (const [name, col] of c.cols) {
    const st = candidateStat(c, opts, name, col);
    if (st) stats.push(st);
  }
  return selectFeatures(c, opts, stats);
}

const ROW_CHUNK = 500;
const FEATURE_CHUNK = 25;

/** Same as buildPipeline, but yields to the event loop every few hundred rows / few dozen features. */
async function buildPipelineAsync(train: readonly LearnRow[], opts: WinModelOptions): Promise<Pipeline> {
  const c = newCollector(train, opts.winPct);
  for (let i = 0; i < c.n; i += ROW_CHUNK) {
    collectRows(c, i, Math.min(c.n, i + ROW_CHUNK));
    await yieldNow();
  }
  const stats: FeatureStat[] = [];
  let k = 0;
  for (const [name, col] of c.cols) {
    const st = candidateStat(c, opts, name, col);
    if (st) stats.push(st);
    if (++k % FEATURE_CHUNK === 0) await yieldNow();
  }
  return selectFeatures(c, opts, stats);
}

/**
 * Pure: the SAME validated feature list / missing flags / strategy set, with medians / scales (and presence / corr,
 * for info) recomputed on `rows`. A feature whose stats become unusable on `rows` is dropped (never re-selected).
 */
export function refitPipelineStats(p: Pipeline, rows: readonly LearnRow[], winPct: number = DEFAULT_WIN_MODEL_OPTIONS.winPct): Pipeline {
  const c = newCollector(rows, winPct, new Set(p.features.map((f) => f.name)));
  collectRows(c, 0, c.n);
  const features: FeatureStat[] = [];
  for (const f of p.features) {
    const st = refitStat(c, f.name);
    if (st) features.push(st);
  }
  return { features, missingFlags: [...p.missingFlags], strategies: [...p.strategies] };
}

async function refitPipelineStatsAsync(p: Pipeline, rows: readonly LearnRow[], winPct: number): Promise<Pipeline> {
  const c = newCollector(rows, winPct, new Set(p.features.map((f) => f.name)));
  for (let i = 0; i < c.n; i += ROW_CHUNK) {
    collectRows(c, i, Math.min(c.n, i + ROW_CHUNK));
    await yieldNow();
  }
  const features: FeatureStat[] = [];
  for (let k = 0; k < p.features.length; k++) {
    const st = refitStat(c, p.features[k]!.name);
    if (st) features.push(st);
    if ((k + 1) % FEATURE_CHUNK === 0) await yieldNow();
  }
  return { features, missingFlags: [...p.missingFlags], strategies: [...p.strategies] };
}

/** Columns: [bias, features…, missing flags…, strategy intercepts…]. */
export const pipelineDim = (p: Pipeline): number => 1 + p.features.length + p.missingFlags.length + p.strategies.length;

/** Pure: one row → its model inputs (writes into `out`, length pipelineDim). */
export function encodeRow(p: Pipeline, flat: Readonly<Record<string, number>>, strategy: string, out: Float64Array, offset = 0): void {
  out[offset] = 1;
  let j = offset + 1;
  for (const f of p.features) {
    const v = flat[f.name];
    const x = v === undefined || !Number.isFinite(v) ? 0 : (v - f.median) / f.scale;
    // Non-finite (e.g. 0/0 from a bad scale) → 0, like a missing value.
    out[j++] = Number.isFinite(x) ? Math.max(-CLIP, Math.min(CLIP, x)) : 0;
  }
  for (const name of p.missingFlags) {
    const v = flat[name];
    out[j++] = v === undefined || !Number.isFinite(v) ? 1 : 0;
  }
  for (const s of p.strategies) out[j++] = s === strategy ? 1 : 0;
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/**
 * Pure: L2-regularised weighted logistic regression by Newton steps (IRLS).
 * Minimises Σ wᵢ·logloss + λ/2·‖β‖² (the bias, column 0, is not penalised). X is row-major n × d.
 * Async only to yield to the event loop (after every Newton step and every `yieldEvery` rows of the Hessian)
 * so a big fit never blocks trading for long.
 */
export async function fitLogistic(
  X: Float64Array,
  y: ArrayLike<number>,
  w: ArrayLike<number>,
  n: number,
  d: number,
  l2: number,
  maxIter = 25,
  tol = 1e-5,
  yieldEvery = 1000,
): Promise<Float64Array> {
  const beta = new Float64Array(d);
  // Start the bias at the weighted base rate (fast convergence, stable with few winners).
  let sw = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i]!;
    sy += w[i]! * y[i]!;
  }
  const base = Math.min(0.99, Math.max(0.01, sy / Math.max(sw, EPS)));
  beta[0] = Math.log(base / (1 - base));
  const H = new Float64Array(d * d);
  const g = new Float64Array(d);
  for (let it = 0; it < maxIter; it++) {
    H.fill(0);
    g.fill(0);
    for (let i = 0; i < n; i++) {
      if (i > 0 && i % yieldEvery === 0) await yieldNow();
      const o = i * d;
      let z = 0;
      for (let a = 0; a < d; a++) z += X[o + a]! * beta[a]!;
      const p = sigmoid(z);
      const wi = w[i]!;
      if (wi <= 0) continue;
      const r = wi * (p - y[i]!);
      const h = wi * Math.max(p * (1 - p), 1e-6);
      for (let a = 0; a < d; a++) {
        const xa = X[o + a]!;
        if (xa === 0) continue;
        g[a] = g[a]! + r * xa;
        const hx = h * xa;
        const row = a * d;
        for (let b = 0; b <= a; b++) H[row + b] = H[row + b]! + hx * X[o + b]!;
      }
    }
    for (let a = 1; a < d; a++) {
      g[a] = g[a]! + l2 * beta[a]!;
      H[a * d + a] = H[a * d + a]! + l2;
    }
    H[0] = H[0]! + 1e-6;
    const step = choleskySolve(H, g, d);
    if (!step) break;
    let maxStep = 0;
    for (let a = 0; a < d; a++) {
      // Damp huge steps (near-separation with a tiny λ).
      const s = Math.max(-5, Math.min(5, step[a]!));
      beta[a] = beta[a]! - s;
      maxStep = Math.max(maxStep, Math.abs(s));
    }
    if (maxStep < tol) break;
    await yieldNow();
  }
  return beta;
}

/** Solves H x = g for a symmetric positive-definite H (lower triangle filled). Returns null if not PD. */
function choleskySolve(H: Float64Array, g: Float64Array, d: number): Float64Array | null {
  const L = new Float64Array(d * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let s = H[i * d + j]!;
      for (let k = 0; k < j; k++) s -= L[i * d + k]! * L[j * d + k]!;
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * d + i] = Math.sqrt(s);
      } else L[i * d + j] = s / L[j * d + j]!;
    }
  }
  const z = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = g[i]!;
    for (let k = 0; k < i; k++) s -= L[i * d + k]! * z[k]!;
    z[i] = s / L[i * d + i]!;
  }
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let s = z[i]!;
    for (let k = i + 1; k < d; k++) s -= L[k * d + i]! * x[k]!;
    x[i] = s / L[i * d + i]!;
  }
  return x;
}

function design(p: Pipeline, rows: readonly LearnRow[], winPct: number) {
  const d = pipelineDim(p);
  const kept = rows.filter((r) => rowW(r) > 0);
  const n = kept.length;
  const X = new Float64Array(n * d);
  const y = new Float64Array(n);
  const w = new Float64Array(n);
  kept.forEach((r, i) => {
    encodeRow(p, r.flat, r.strategy, X, i * d);
    y[i] = isWin(r, winPct) ? 1 : 0;
    w[i] = rowW(r);
  });
  return { X, y, w, n, d, rows: kept };
}

export interface ValidationReport {
  n: number;
  /** Σ weights of the rows used (the row minimum is checked on this). */
  nEffective: number;
  nTrain: number;
  nVal: number;
  /** Σ weight × win in the exam (effective winners). */
  valPositives: number;
  features: number;
  l2: number;
  /** STRATIFIED exam AUC: weighted average of the per-strategy AUCs (what the activation exam uses). */
  valAuc: number;
  /** Pooled exam AUC across strategies (info only — strategy base rates alone can inflate it). */
  valAucPooled: number;
  /** Strategies with both winners and losers in the exam (the ones the stratified AUC averages). */
  valStrata: number;
  valLogLoss: number;
  /** Log-loss of always guessing the training win rate (the model should be lower). */
  valBaseLogLoss: number;
  valBrier: number;
  calibration: Array<{ pMean: number; winRate: number; n: number }>;
  /** Stratified AUC of `entry.score` alone on the same exam rows (missing score → the median score, a neutral tie). */
  baselineAuc: number;
  baselineAucPooled: number;
  /** Exam rows that actually had the score. */
  baselineN: number;
  active: boolean;
  reason: string;
}

export interface WinModelJSON {
  version: 1;
  trainedAtMs: number;
  active: boolean;
  l2: number;
  pipeline: Pipeline;
  beta: number[];
  baseRate: number;
  strategyBase: Record<string, number>;
  report: ValidationReport;
}

export interface WinPrediction {
  /** Model win probability (0…1). */
  p: number;
  /** The usual win rate of this strategy (shrunk towards the overall rate). */
  baseRate: number;
  /** Score points to add (0 when the model is not active). */
  points: number;
}

/** A fitted model: fast predict(), explain(), JSON round trip. */
export class FittedWinModel {
  private readonly names: string[];
  private readonly med: Float64Array;
  private readonly inv: Float64Array;
  private readonly fw: Float64Array;
  private readonly mw: Float64Array;
  private readonly sw: Map<string, number>;
  private readonly baseOf: Map<string, number>;

  constructor(
    readonly json: WinModelJSON,
    private readonly opts: Pick<WinModelOptions, 'pointsScale' | 'maxPoints'> = DEFAULT_WIN_MODEL_OPTIONS,
  ) {
    const p = json.pipeline;
    const F = p.features.length;
    this.names = p.features.map((f) => f.name);
    this.med = Float64Array.from(p.features, (f) => f.median);
    this.inv = Float64Array.from(p.features, (f) => 1 / f.scale);
    this.fw = Float64Array.from(json.beta.slice(1, 1 + F));
    this.mw = Float64Array.from(json.beta.slice(1 + F, 1 + F + p.missingFlags.length));
    this.sw = new Map(p.strategies.map((s, i) => [s, json.beta[1 + F + p.missingFlags.length + i] ?? 0]));
    this.baseOf = new Map(Object.entries(json.strategyBase));
  }

  get active(): boolean {
    return this.json.active;
  }

  /** Win probability only (no allocation). */
  prob(flat: Readonly<Record<string, number>>, strategy: string): number {
    let z = this.json.beta[0] ?? 0;
    const names = this.names;
    for (let i = 0; i < names.length; i++) {
      const v = flat[names[i]!];
      if (v === undefined || !Number.isFinite(v)) continue;
      let x = (v - this.med[i]!) * this.inv[i]!;
      if (x !== x) continue; // NaN → like missing
      if (x > CLIP) x = CLIP;
      else if (x < -CLIP) x = -CLIP;
      z += x * this.fw[i]!;
    }
    const flags = this.json.pipeline.missingFlags;
    for (let i = 0; i < flags.length; i++) {
      const v = flat[flags[i]!];
      if (v === undefined || !Number.isFinite(v)) z += this.mw[i]!;
    }
    z += this.sw.get(strategy) ?? 0;
    return sigmoid(z);
  }

  predict(flat: Readonly<Record<string, number>>, strategy: string): WinPrediction {
    const p = this.prob(flat, strategy);
    const baseRate = this.baseOf.get(strategy) ?? this.json.baseRate;
    if (!this.json.active) return { p, baseRate, points: 0 };
    const raw = Math.round((p - baseRate) * this.opts.pointsScale);
    return { p, baseRate, points: Math.max(-this.opts.maxPoints, Math.min(this.opts.maxPoints, raw)) || 0 };
  }

  /** Top features by effect size (weight per one robust spread of the feature), in plain words. */
  explain(top = 8): Array<{ feature: string; effect: number; text: string }> {
    const items: Array<{ feature: string; effect: number; text: string }> = [];
    this.names.forEach((name, i) => {
      const e = this.fw[i]!;
      items.push({ feature: name, effect: round3(e), text: `higher ${name} → ${e > 0 ? 'more' : 'fewer'} wins` });
    });
    this.json.pipeline.missingFlags.forEach((name, i) => {
      const e = this.mw[i]!;
      items.push({ feature: `${name} (missing)`, effect: round3(e), text: `${name} unknown → ${e > 0 ? 'more' : 'fewer'} wins` });
    });
    return items.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).filter((x) => x.effect !== 0).slice(0, top);
  }

  toJSON(): WinModelJSON {
    return this.json;
  }

  /** Parses + fully validates a stored model; throws on anything corrupt (so callers never run a broken model). */
  static fromJSON(j: WinModelJSON | string, opts?: Pick<WinModelOptions, 'pointsScale' | 'maxPoints'>): FittedWinModel {
    const json = (typeof j === 'string' ? JSON.parse(j) : j) as WinModelJSON;
    const problem = validateModelJson(json);
    if (problem) throw new Error(`bad win model json: ${problem}`);
    return new FittedWinModel(json, opts);
  }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

/** Pure: why a stored model is unusable, or null when it is fine. */
export function validateModelJson(json: unknown): string | null {
  if (!isObj(json)) return 'not an object';
  if (json.version !== 1) return 'version';
  if (typeof json.active !== 'boolean') return 'active';
  if (!isObj(json.report)) return 'report missing';
  const p = json.pipeline;
  if (!isObj(p) || !Array.isArray(p.features) || !isStrArr(p.missingFlags) || !isStrArr(p.strategies)) return 'pipeline';
  for (const f of p.features as unknown[]) {
    if (!isObj(f) || typeof f.name !== 'string') return 'feature name';
    if (typeof f.median !== 'number' || !Number.isFinite(f.median)) return `median of ${f.name}`;
    if (typeof f.scale !== 'number' || !Number.isFinite(f.scale) || !(f.scale > 0)) return `scale of ${f.name}`;
  }
  const beta = json.beta;
  if (!Array.isArray(beta) || beta.length !== pipelineDim(p as unknown as Pipeline)) return 'beta length';
  if (!beta.every((b) => typeof b === 'number' && Number.isFinite(b))) return 'beta not finite';
  if (typeof json.baseRate !== 'number' || !Number.isFinite(json.baseRate)) return 'baseRate';
  if (!isObj(json.strategyBase)) return 'strategyBase';
  for (const v of Object.values(json.strategyBase)) if (typeof v !== 'number' || !Number.isFinite(v)) return 'strategyBase value';
  return null;
}

function baseRates(rows: readonly LearnRow[], opts: WinModelOptions): { baseRate: number; strategyBase: Record<string, number> } {
  let W = 0;
  let Y = 0;
  const by = new Map<string, { w: number; y: number }>();
  for (const r of rows) {
    const w = rowW(r);
    if (w <= 0) continue;
    const y = isWin(r, opts.winPct) ? w : 0;
    W += w;
    Y += y;
    const e = by.get(r.strategy) ?? { w: 0, y: 0 };
    e.w += w;
    e.y += y;
    by.set(r.strategy, e);
  }
  const baseRate = W > 0 ? Y / W : 0;
  const strategyBase: Record<string, number> = {};
  for (const [s, e] of by) strategyBase[s] = round3((e.y + opts.baseShrinkRows * baseRate) / (e.w + opts.baseShrinkRows));
  return { baseRate: round3(baseRate), strategyBase };
}

function predictAll(X: Float64Array, n: number, d: number, beta: Float64Array): Float64Array {
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = 0;
    for (let a = 0; a < d; a++) z += X[i * d + a]! * beta[a]!;
    p[i] = sigmoid(z);
  }
  return p;
}

/** Picks λ by an inner time-ordered split INSIDE the training rows (the exam is never used for this). */
async function chooseL2(train: readonly LearnRow[], opts: WinModelOptions): Promise<number> {
  const fallback = opts.l2Grid.includes(1) ? 1 : (opts.l2Grid[0] ?? 1);
  if (opts.l2Grid.length <= 1 || train.length < 10) return fallback;
  const inner = timeSplit(train, opts.innerTrainShare);
  const pipe = await buildPipelineAsync(inner.train, opts);
  await yieldNow();
  const tr = design(pipe, inner.train, opts.winPct);
  const va = design(pipe, inner.val, opts.winPct);
  if (tr.n < 2 || va.n < 1) return fallback;
  let best: { l2: number; ll: number } | null = null;
  for (const l2 of opts.l2Grid) {
    await yieldNow();
    const beta = await fitLogistic(tr.X, tr.y, tr.w, tr.n, tr.d, l2);
    const ll = probabilityMetrics(predictAll(va.X, va.n, va.d, beta), va.y, va.w).logLoss;
    if (Number.isFinite(ll) && (!best || ll < best.ll)) best = { l2, ll };
  }
  return best?.l2 ?? fallback;
}

/**
 * Pure (async only to yield to the event loop): the whole exam + refit.
 * Returns the fitted model (active or not) — `report` says how it did and why.
 */
export async function trainWinModel(rows: readonly LearnRow[], now = Date.now(), o: Partial<WinModelOptions> = {}): Promise<FittedWinModel> {
  const opts = { ...DEFAULT_WIN_MODEL_OPTIONS, ...o };
  let usable = rows.filter((r) => rowW(r) > 0 && Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs));
  if (usable.length > opts.maxTrainRows) usable = [...usable].sort((a, b) => a.atMs - b.atMs).slice(-opts.maxTrainRows);
  let nEffective = 0;
  for (const r of usable) nEffective += rowW(r);
  const { train, val } = timeSplit(usable, opts.trainShare);

  // 1) λ from inside the training rows only.
  const l2 = await chooseL2(train, opts);
  await yieldNow();

  // 2) Fit on all training rows with that λ, then grade the exam ONCE.
  const pipe = await buildPipelineAsync(train, opts);
  await yieldNow();
  const tr = design(pipe, train, opts.winPct);
  const va = design(pipe, val, opts.winPct);
  let valPositives = 0;
  for (let i = 0; i < va.n; i++) valPositives += va.w[i]! * va.y[i]!;
  await yieldNow();
  const fitted = tr.n >= 2 && va.n >= 1 ? await fitLogistic(tr.X, tr.y, tr.w, tr.n, tr.d, l2) : null;
  const pVal = fitted ? predictAll(va.X, va.n, va.d, fitted) : null;

  const trainBase = Math.min(0.999, Math.max(0.001, (() => {
    let sw = 0;
    let sy = 0;
    for (let i = 0; i < tr.n; i++) {
      sw += tr.w[i]!;
      sy += tr.w[i]! * tr.y[i]!;
    }
    return sw > 0 ? sy / sw : 0.5;
  })()));
  const baseLl = probabilityMetrics(new Float64Array(va.n).fill(trainBase), va.y, va.w).logLoss;
  const metrics = pVal ? probabilityMetrics(pVal, va.y, va.w) : { logLoss: NaN, brier: NaN, calibration: [] };
  const groups = va.rows.map((r) => r.strategy);
  const strat = pVal ? stratifiedAuc(pVal, va.y, va.w, groups) : { auc: 0.5, groups: 0 };
  const valAuc = strat.auc;
  const valAucPooled = pVal ? weightedAuc(pVal, va.y, va.w) : 0.5;

  // Baseline: the existing score alone, graded on the SAME exam rows the same (stratified) way.
  const present: number[] = [];
  for (const r of va.rows) {
    const s = r.flat[opts.scoreFeature];
    if (s !== undefined && Number.isFinite(s)) present.push(s);
  }
  const baselineN = present.length;
  present.sort((a, b) => a - b);
  const fill = baselineN ? present[Math.floor((baselineN - 1) / 2)]! : 0;
  const bs = va.rows.map((r) => {
    const s = r.flat[opts.scoreFeature];
    return s !== undefined && Number.isFinite(s) ? s : fill;
  });
  const baselineAuc = baselineN ? stratifiedAuc(bs, va.y, va.w, groups).auc : 0.5;
  const baselineAucPooled = baselineN ? weightedAuc(bs, va.y, va.w) : 0.5;

  let reason = 'passed the exam';
  if (nEffective < opts.minRows) reason = `only ${nEffective.toFixed(1)} effective rows (< ${opts.minRows}; ${usable.length} rows)`;
  else if (valPositives < opts.minValPositives) reason = `only ${valPositives.toFixed(1)} effective winners in the exam (< ${opts.minValPositives})`;
  else if (!fitted) reason = 'could not fit';
  else if (strat.groups === 0) reason = 'no strategy has both winners and losers in the exam';
  else if (valAuc < opts.minValAuc) reason = `exam AUC (within strategy) ${valAuc.toFixed(3)} < ${opts.minValAuc}`;
  else if (valAuc < baselineAuc + opts.minAucGain) reason = `exam AUC (within strategy) ${valAuc.toFixed(3)} doesn't beat the score's ${baselineAuc.toFixed(3)} by ${opts.minAucGain}`;
  const active = reason === 'passed the exam';

  // 3) Refit on everything with the chosen λ and the VALIDATED feature list / flags / strategies (only the
  //    medians / scales are recomputed) — only worth the CPU when it will be used.
  let pipeline = pipe;
  let beta: Float64Array = fitted ?? new Float64Array(pipelineDim(pipe));
  if (active) {
    await yieldNow();
    pipeline = await refitPipelineStatsAsync(pipe, usable, opts.winPct);
    await yieldNow();
    const all = design(pipeline, usable, opts.winPct);
    await yieldNow();
    beta = await fitLogistic(all.X, all.y, all.w, all.n, all.d, l2);
  }
  const report: ValidationReport = {
    n: usable.length,
    nEffective: round3(nEffective),
    nTrain: tr.n,
    nVal: va.n,
    valPositives: round3(valPositives),
    features: pipe.features.length,
    l2,
    valAuc: round3(valAuc),
    valAucPooled: round3(valAucPooled),
    valStrata: strat.groups,
    valLogLoss: round3(metrics.logLoss),
    valBaseLogLoss: round3(baseLl),
    valBrier: round3(metrics.brier),
    calibration: metrics.calibration,
    baselineAuc: round3(baselineAuc),
    baselineAucPooled: round3(baselineAucPooled),
    baselineN,
    active,
    reason,
  };
  const { baseRate, strategyBase } = baseRates(active ? usable : train, opts);
  return new FittedWinModel(
    { version: 1, trainedAtMs: now, active, l2, pipeline, beta: Array.from(beta), baseRate, strategyBase, report },
    opts,
  );
}

export interface WinModelStatus {
  trainedAtMs: number;
  /** Either model (logistic or trees) is shifting the bar. */
  active: boolean;
  report: ValidationReport;
  explain: ReturnType<FittedWinModel['explain']>;
  /** The gradient-boosted tree model (tree-model.ts) trained on the same rows. */
  tree: { active: boolean; report: TreeReport; explain: ReturnType<FittedTreeModel['explain']> } | null;
  /** Which model(s) the bot listens to right now. */
  using: 'both' | 'logistic' | 'trees' | 'none';
}

const KEY = 'model:win';
const TREE_KEY = 'model:tree';
const NOT_ACTIVE: WinPrediction = { p: 0, baseRate: 0, points: 0 };

export class WinModel {
  private model: FittedWinModel | null = null;
  private tree: FittedTreeModel | null = null;
  private timers: NodeJS.Timeout[] = [];
  private training = false;

  constructor(
    private readonly redis: Pick<Redis, 'get' | 'set'>,
    private readonly loadRows: () => Promise<LearnRow[]>,
    private readonly opts: Partial<WinModelOptions> = {},
  ) {}

  async train(now = Date.now()): Promise<WinModelStatus | null> {
    if (this.training) return this.snapshot();
    this.training = true;
    try {
      const rows = await this.loadRows();
      const t0 = Date.now();
      const m = await trainWinModel(rows, now, this.opts);
      this.model = m;
      await this.redis.set(KEY, JSON.stringify(m.toJSON()), 'EX', 14 * 86_400);
      const r = m.json.report;
      log.info({ ms: Date.now() - t0, n: r.n, valAuc: r.valAuc, baselineAuc: r.baselineAuc, active: r.active, reason: r.reason }, 'win model trained');
      // The tree model learns combinations the straight-line model can't; same rows, same exam.
      const t1 = Date.now();
      try {
        const t = await trainTreeModel(rows, now, { pointsScale: this.opts.pointsScale ?? DEFAULT_WIN_MODEL_OPTIONS.pointsScale, maxPoints: this.opts.maxPoints ?? DEFAULT_WIN_MODEL_OPTIONS.maxPoints });
        this.tree = t;
        await this.redis.set(TREE_KEY, JSON.stringify(t.json), 'EX', 14 * 86_400);
        const tr = t.json.report;
        log.info({ ms: Date.now() - t1, n: tr.n, trees: tr.trees, valAuc: tr.valAuc, baselineAuc: tr.baselineAuc, active: tr.active, reason: tr.reason }, 'tree model trained');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'tree model training failed');
      }
      return this.snapshot();
    } finally {
      this.training = false;
    }
  }

  /** Which model(s) passed their exam. */
  using(): WinModelStatus['using'] {
    const l = !!this.model?.active;
    const t = !!this.tree?.active;
    return l && t ? 'both' : l ? 'logistic' : t ? 'trees' : 'none';
  }

  /** Both passed → their average (an ensemble beats either alone); one passed → that one; none → 0 points. */
  predict(flat: Readonly<Record<string, number>>, strategy: string): WinPrediction {
    const use = this.using();
    if (use === 'none') return this.model ? this.model.predict(flat, strategy) : NOT_ACTIVE;
    if (use === 'logistic') return this.model!.predict(flat, strategy);
    if (use === 'trees') return this.tree!.predict(flat, strategy);
    const a = this.model!.predict(flat, strategy);
    const b = this.tree!.predict(flat, strategy);
    const p = (a.p + b.p) / 2;
    const baseRate = (a.baseRate + b.baseRate) / 2;
    const scale = this.opts.pointsScale ?? DEFAULT_WIN_MODEL_OPTIONS.pointsScale;
    const max = this.opts.maxPoints ?? DEFAULT_WIN_MODEL_OPTIONS.maxPoints;
    return { p, baseRate, points: Math.max(-max, Math.min(max, Math.round((p - baseRate) * scale))) || 0 };
  }

  snapshot(): WinModelStatus | null {
    const m = this.model;
    const t = this.tree;
    if (!m && !t) return null;
    const tree = t ? { active: t.active, report: t.json.report, explain: t.explain() } : null;
    if (!m) return { trainedAtMs: t!.json.trainedAtMs, active: t!.active, report: null as unknown as ValidationReport, explain: [], tree, using: this.using() };
    return { trainedAtMs: m.json.trainedAtMs, active: m.active || !!t?.active, report: m.json.report, explain: m.explain(), tree, using: this.using() };
  }

  async restore(): Promise<void> {
    const rawTree = await this.redis.get(TREE_KEY);
    if (rawTree && !this.tree) {
      try {
        this.tree = FittedTreeModel.fromJSON(rawTree, { pointsScale: this.opts.pointsScale ?? DEFAULT_WIN_MODEL_OPTIONS.pointsScale, maxPoints: this.opts.maxPoints ?? DEFAULT_WIN_MODEL_OPTIONS.maxPoints });
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'stored tree model rejected');
      }
    }
    const raw = await this.redis.get(KEY);
    if (!raw || this.model) return;
    try {
      this.model = FittedWinModel.fromJSON(raw, { ...DEFAULT_WIN_MODEL_OPTIONS, ...this.opts });
    } catch (err) {
      // Corrupt / old model: stay inactive (0 points) until the next training run replaces it.
      log.warn({ err: (err as Error).message }, 'stored win model rejected');
    }
  }

  start(): void {
    void this.restore().catch((err: Error) => log.warn({ err: err.message }, 'win model restore failed'));
    const tick = () => void this.train().catch((err: Error) => log.warn({ err: err.message }, 'win model training failed'));
    const first = setTimeout(tick, 2 * 60_000);
    first.unref();
    const every = setInterval(tick, 60 * 60_000);
    every.unref();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
