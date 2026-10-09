/**
 * Pure maths behind the weight adjuster (no DB, no Redis) — easy to test.
 *
 * For each feature compare its (weighted) average value on winners vs losers.
 * Higher on winners → weight up, higher on losers → weight down. Each sample's
 * weight = recency (exponential decay, half-life ~24h) × 3 for our own buys.
 * The step is scaled by how much evidence there is (effective sample size),
 * cuts on "loser" features are 1.5× stronger than raises, every weight stays
 * within 0.4×–2.5× of its default, and the result is normalised to sum 1.
 */
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS, type FeatureName, type Weights } from '../config/default';
import { scoreFeatures, type FeatureVector } from '../evaluator/scorer';

export interface TuningSample {
  features: Partial<Record<FeatureName, number>>;
  win: boolean;
  /** Explicit extra weight (overrides ownBuy). */
  weight?: number;
  /** Our own buy → ownBuyWeight. */
  ownBuy?: boolean;
  /** How old the outcome is (hours) → recency decay. */
  ageHours?: number;
}

export interface TuningOptions {
  maxStep: number;
  sensitivity: number;
  halfLifeHours: number;
  lossWeight: number;
  ownBuyWeight: number;
  fullEvidenceAt: number;
  minSamples: number;
  minPerClass: number;
  minWeightFactor: number;
  maxWeightFactor: number;
}

export function tuningOptions(src: Partial<TuningOptions> = {}): TuningOptions {
  const d = DEFAULT_CONFIG.learning;
  return {
    maxStep: src.maxStep ?? d.maxStep,
    sensitivity: src.sensitivity ?? d.sensitivity,
    halfLifeHours: src.halfLifeHours ?? d.halfLifeHours,
    lossWeight: src.lossWeight ?? d.lossWeight,
    ownBuyWeight: src.ownBuyWeight ?? d.ownBuyWeight,
    fullEvidenceAt: src.fullEvidenceAt ?? d.fullEvidenceAt,
    minSamples: src.minSamples ?? d.minSamples,
    minPerClass: src.minPerClass ?? d.minPerClass,
    minWeightFactor: src.minWeightFactor ?? d.minWeightFactor,
    maxWeightFactor: src.maxWeightFactor ?? d.maxWeightFactor,
  };
}

export interface WeightChange {
  feature: FeatureName;
  from: number;
  to: number;
  winnersAvg: number;
  losersAvg: number;
}

export interface TuningResult {
  weights: Weights;
  changes: WeightChange[];
  wins: number;
  total: number;
  /** 0-1: how much of a full step the data justified. */
  evidence: number;
}

/** Recency × own-buy weight of one sample. */
export function sampleWeight(s: TuningSample, o: TuningOptions): number {
  const base = s.weight ?? (s.ownBuy ? o.ownBuyWeight : 1);
  const decay = s.ageHours !== undefined && o.halfLifeHours > 0 ? Math.pow(0.5, Math.max(0, s.ageHours) / o.halfLifeHours) : 1;
  return base * decay;
}

/** Kish effective sample size: (Σw)² / Σw². */
export function effectiveN(ws: number[]): number {
  const s = ws.reduce((a, b) => a + b, 0);
  const s2 = ws.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}

/** Pure: compute new weights from labelled samples. null = not enough data. */
export function adjustWeights(current: Weights, samples: TuningSample[], defaults: Weights = { ...DEFAULT_WEIGHTS }, opts: Partial<TuningOptions> = {}): TuningResult | null {
  const o = tuningOptions(opts);
  const wins = samples.filter((s) => s.win);
  const losses = samples.filter((s) => !s.win);
  if (samples.length < o.minSamples || wins.length < o.minPerClass || losses.length < o.minPerClass) return null;

  const wW = wins.map((s) => sampleWeight(s, o));
  const wL = losses.map((s) => sampleWeight(s, o));
  const evidence = Math.min(1, Math.sqrt(Math.min(effectiveN(wW), effectiveN(wL)) / Math.max(1, o.fullEvidenceAt)));

  const avg = (list: TuningSample[], ws: number[], f: FeatureName) => {
    const tot = ws.reduce((a, b) => a + b, 0) || 1;
    return list.reduce((s, x, i) => s + (x.features[f] ?? 0.5) * (ws[i] ?? 0), 0) / tot;
  };
  const raw = {} as Weights;
  const stats = {} as Record<FeatureName, { w: number; l: number }>;
  for (const f of Object.keys(current) as FeatureName[]) {
    const w = avg(wins, wW, f);
    const l = avg(losses, wL, f);
    stats[f] = { w, l };
    let step = (w - l) * o.sensitivity * evidence;
    // Losses teach more: a feature that shows up on losers is cut faster than a winner feature is raised.
    if (step < 0) step *= o.lossWeight;
    step = Math.max(-o.maxStep, Math.min(o.maxStep, step));
    const d = defaults[f] ?? current[f];
    raw[f] = Math.max(d * o.minWeightFactor, Math.min(d * o.maxWeightFactor, current[f] * (1 + step)));
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const weights = {} as Weights;
  const changes: WeightChange[] = [];
  for (const f of Object.keys(raw) as FeatureName[]) {
    weights[f] = Math.round((raw[f] / total) * 10_000) / 10_000;
    if (Math.abs(weights[f] - current[f]) >= 0.0005) changes.push({ feature: f, from: current[f], to: weights[f], winnersAvg: stats[f].w, losersAvg: stats[f].l });
  }
  changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return { weights, changes, wins: wins.length, total: samples.length, evidence: Math.round(evidence * 1000) / 1000 };
}

/** Area under the ROC curve (rank-based, ties count half). null if one class is missing. */
export function auc(scores: number[], labels: boolean[]): number | null {
  const idx = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  const nPos = idx.filter((x) => x.y).length;
  const nNeg = idx.length - nPos;
  if (!nPos || !nNeg) return null;
  let rankSumPos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.s === idx[i]!.s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (idx[k]!.y) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** AUC of a set of weights on held-out samples (missing features = neutral 0.5). */
export function holdoutAuc(weights: Weights, holdout: TuningSample[]): number | null {
  const scores = holdout.map((s) => {
    const f = {} as FeatureVector;
    for (const k of Object.keys(weights) as FeatureName[]) f[k] = s.features[k] ?? 0.5;
    return scoreFeatures(f, weights).score;
  });
  return auc(scores, holdout.map((s) => s.win));
}

export interface HoldoutVerdict {
  accepted: boolean;
  aucBefore: number | null;
  aucAfter: number | null;
  /** Why the check was skipped (too few held-out winners/losers). */
  skipped?: string;
}

/** Accept new weights only if they rank the held-out tokens at least as well as the old ones. */
export function holdoutCheck(oldW: Weights, newW: Weights, holdout: TuningSample[], minPerClass: number): HoldoutVerdict {
  const pos = holdout.filter((s) => s.win).length;
  const neg = holdout.length - pos;
  if (pos < minPerClass || neg < minPerClass) return { accepted: true, aucBefore: null, aucAfter: null, skipped: `holdout has ${pos} winners / ${neg} losers (need ${minPerClass}+ each)` };
  const before = holdoutAuc(oldW, holdout);
  const after = holdoutAuc(newW, holdout);
  const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);
  if (before === null || after === null) return { accepted: true, aucBefore: r4(before), aucAfter: r4(after), skipped: 'AUC undefined' };
  return { accepted: after + 1e-9 >= before, aucBefore: r4(before), aucAfter: r4(after) };
}

/** Next firing of a `*\/N * * * *` cron after `now` (UTC). */
export function nextCronAt(now: number, everyMinutes: number): number {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  const m = d.getUTCMinutes();
  const n = Math.max(1, Math.floor(everyMinutes));
  const next = Math.floor(m / n) * n + n;
  if (next < 60) d.setUTCMinutes(next);
  else d.setUTCHours(d.getUTCHours() + 1, 0);
  return d.getTime();
}
