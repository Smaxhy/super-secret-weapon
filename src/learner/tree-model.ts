/**
 * Tree model (owner: "make the learning more advanced"): gradient-boosted decision trees on the same flat entry features
 * and the same training rows as the logistic win model (win-model.ts), graded the same way.
 *
 * Why trees: the logistic model only learns "more of X → more / fewer wins". Trees learn COMBINATIONS and thresholds
 * ("lots of buyers only helps when the dev has sold", "a +20% minute is fine on a fresh coin, deadly on a migrated one").
 *
 *   - histogram GBDT: every feature is cut into ≤ 32 quantile bins (training rows only); missing values get their own
 *     learned direction at every split; strategies are 0/1 features, so trees can split per strategy
 *   - logistic loss, weighted rows (real 1 / learning 0.8 / shadow 0.5 / coin outcomes 0.25), shrinkage, L2 on leaves,
 *     min child weight, depth 3, column subsampling (seeded → reproducible)
 *   - number of trees picked by early stopping on the newest part of the TRAINING rows; the exam (newest 25%) is graded
 *     ONCE, stratified per strategy, and must beat the plain score — exactly like the win model
 *   - async: yields to the event loop after every tree (trading never waits on it)
 * Pure apart from the yields. The Brain uses it next to the logistic model (win-model.ts → WinModel).
 */
import { stratifiedAuc, timeSplit, weightedAuc, isWin, type LearnRow } from './win-model';
import { binMatrix, boost, cutPoints, DEFAULT_TREE_OPTIONS, growTree, logLoss, rng, sigmoid, treeValue, type Matrix, type TreeNode, type TreeOptions } from '../lib/gbdt';
// the generic core moved to lib/gbdt.ts (v15.4); re-exported so existing imports keep working
export { boost, cutPoints, DEFAULT_TREE_OPTIONS, sigmoid, treeValue, type Matrix, type TreeNode, type TreeOptions };

export interface TreeModelJSON {
  version: 1;
  trainedAtMs: number;
  active: boolean;
  features: string[];
  base: number;
  lr: number;
  trees: TreeNode[][];
  baseRate: number;
  strategyBase: Record<string, number>;
  importance: Array<{ feature: string; gain: number }>;
  report: TreeReport;
}

export interface TreeReport {
  n: number;
  nEffective: number;
  nTrain: number;
  nVal: number;
  valPositives: number;
  features: number;
  trees: number;
  valAuc: number;
  valAucPooled: number;
  valStrata: number;
  valLogLoss: number;
  valBaseLogLoss: number;
  baselineAuc: number;
  active: boolean;
  reason: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rowW = (r: LearnRow): number => (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 0);
const STRAT_PREFIX = 'strategy=';

/** Pure: feature list from the training rows (present in ≥ minPresence of rows and not constant), + strategy flags. */
export function chooseFeatures(rows: readonly LearnRow[], o: Pick<TreeOptions, 'minPresence' | 'maxFeatures'>): string[] {
  const count = new Map<string, number>();
  const first = new Map<string, number>();
  const varies = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.flat)) {
      if (!Number.isFinite(v)) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
      const f = first.get(k);
      if (f === undefined) first.set(k, v);
      else if (f !== v) varies.add(k);
    }
  }
  const n = rows.length || 1;
  const feats = [...count.entries()]
    .filter(([k, c]) => c / n >= o.minPresence && varies.has(k))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, o.maxFeatures)
    .map(([k]) => k)
    .sort();
  const strats = [...new Set(rows.map((r) => r.strategy))].sort().map((s) => STRAT_PREFIX + s);
  return [...feats, ...strats];
}

/** Pure: the value of feature `name` for a row (strategy flags are 0/1; missing → NaN). */
function valueOf(name: string, flat: Readonly<Record<string, number>>, strategy: string): number {
  if (name.startsWith(STRAT_PREFIX)) return name.slice(STRAT_PREFIX.length) === strategy ? 1 : 0;
  const v = flat[name];
  return v === undefined || !Number.isFinite(v) ? NaN : v;
}

function matrix(rows: readonly LearnRow[], features: readonly string[], winPct: number): Matrix {
  const n = rows.length;
  const F = features.length;
  const x = new Float64Array(n * F);
  const y = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    y[i] = isWin(r, winPct) ? 1 : 0;
    w[i] = rowW(r);
    for (let f = 0; f < F; f++) x[f * n + i] = valueOf(features[f]!, r.flat, r.strategy);
  }
  return { n, F, x, y, w };
}

function baseRates(rows: readonly LearnRow[], winPct: number, shrink = 20): { baseRate: number; strategyBase: Record<string, number> } {
  let sw = 0;
  let sy = 0;
  const by = new Map<string, { w: number; y: number }>();
  for (const r of rows) {
    const w = rowW(r);
    const y = isWin(r, winPct) ? 1 : 0;
    sw += w;
    sy += w * y;
    const b = by.get(r.strategy) ?? { w: 0, y: 0 };
    b.w += w;
    b.y += w * y;
    by.set(r.strategy, b);
  }
  const baseRate = sw > 0 ? sy / sw : 0.5;
  const strategyBase: Record<string, number> = {};
  for (const [s, b] of by) strategyBase[s] = r3((b.y + baseRate * shrink) / (b.w + shrink));
  return { baseRate: r3(baseRate), strategyBase };
}

export class FittedTreeModel {
  private readonly index: Map<string, number>;
  constructor(
    readonly json: TreeModelJSON,
    private readonly opts: Pick<TreeOptions, 'pointsScale' | 'maxPoints'> = DEFAULT_TREE_OPTIONS,
  ) {
    this.index = new Map(json.features.map((f, i) => [f, i]));
  }

  get active(): boolean {
    return this.json.active;
  }

  prob(flat: Readonly<Record<string, number>>, strategy: string): number {
    const feats = this.json.features;
    const get = (f: number) => valueOf(feats[f]!, flat, strategy);
    let z = this.json.base;
    for (const t of this.json.trees) z += treeValue(t, get);
    return sigmoid(z);
  }

  predict(flat: Readonly<Record<string, number>>, strategy: string): { p: number; baseRate: number; points: number } {
    const p = this.prob(flat, strategy);
    const baseRate = this.json.strategyBase[strategy] ?? this.json.baseRate;
    if (!this.json.active) return { p, baseRate, points: 0 };
    const raw = Math.round((p - baseRate) * this.opts.pointsScale);
    return { p, baseRate, points: Math.max(-this.opts.maxPoints, Math.min(this.opts.maxPoints, raw)) || 0 };
  }

  explain(top = 10): Array<{ feature: string; effect: number; text: string }> {
    const tot = this.json.importance.reduce((s, x) => s + x.gain, 0) || 1;
    return this.json.importance.slice(0, top).map((x) => ({ feature: x.feature, effect: r3(x.gain / tot), text: `${x.feature} — ${Math.round((x.gain / tot) * 100)}% of what the trees use` }));
  }

  static fromJSON(raw: string | TreeModelJSON, opts?: Pick<TreeOptions, 'pointsScale' | 'maxPoints'>): FittedTreeModel {
    const j = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TreeModelJSON;
    if (!j || j.version !== 1 || !Array.isArray(j.features) || !Array.isArray(j.trees) || !Number.isFinite(j.base)) throw new Error('bad tree model json');
    for (const t of j.trees) for (const nd of t) if (!Number.isFinite(nd.v) || (nd.f >= 0 && (nd.f >= j.features.length || !Number.isFinite(nd.cut)))) throw new Error('bad tree node');
    return new FittedTreeModel(j, opts);
  }
}

/** Train + grade (one exam on the newest rows) + refit on everything when it passes. */
export async function trainTreeModel(rows: readonly LearnRow[], now = Date.now(), o: Partial<TreeOptions> = {}): Promise<FittedTreeModel> {
  const opts = { ...DEFAULT_TREE_OPTIONS, ...o };
  let usable = rows.filter((r) => rowW(r) > 0 && Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs));
  if (usable.length > opts.maxTrainRows) usable = [...usable].sort((a, b) => a.atMs - b.atMs).slice(-opts.maxTrainRows);
  let nEffective = 0;
  for (const r of usable) nEffective += rowW(r);
  const { train, val } = timeSplit(usable, opts.trainShare);
  const features = chooseFeatures(train, opts);
  const empty = (reason: string): FittedTreeModel =>
    new FittedTreeModel({
      version: 1, trainedAtMs: now, active: false, features, base: 0, lr: opts.learningRate, trees: [], ...baseRates(train, opts.winPct), importance: [],
      report: { n: usable.length, nEffective: r3(nEffective), nTrain: train.length, nVal: val.length, valPositives: 0, features: features.length, trees: 0, valAuc: 0.5, valAucPooled: 0.5, valStrata: 0, valLogLoss: NaN, valBaseLogLoss: NaN, baselineAuc: 0.5, active: false, reason },
    }, opts);
  if (train.length < 20 || val.length < 5 || !features.length) return empty(`only ${usable.length} rows`);

  // 1) number of trees: early stopping on the newest part of TRAIN only (the exam stays unseen).
  const { train: inTr, val: inVa } = timeSplit(train, opts.innerTrainShare);
  const trM = matrix(train, features, opts.winPct);
  const cuts = cutPoints(trM, opts.bins);
  const inner = inTr.length >= 20 && inVa.length >= 5 ? await boost(matrix(inTr, features, opts.winPct), cuts, opts, opts.rounds, matrix(inVa, features, opts.winPct)) : null;
  const nTrees = inner?.best ?? Math.min(60, opts.rounds);

  // 2) fit on all training rows, grade the exam once.
  const fit = await boost(trM, cuts, opts, nTrees, null);
  const vaM = matrix(val, features, opts.winPct);
  const z = new Float64Array(vaM.n).fill(fit.base);
  for (const t of fit.trees) for (let i = 0; i < vaM.n; i++) z[i]! += treeValue(t, (f) => vaM.x[f * vaM.n + i]!);
  const pVal = Array.from(z, sigmoid);
  let valPositives = 0;
  for (let i = 0; i < vaM.n; i++) valPositives += vaM.w[i]! * vaM.y[i]!;
  const groups = val.map((r) => r.strategy);
  const strat = stratifiedAuc(pVal, vaM.y, vaM.w, groups);
  const pooled = weightedAuc(pVal, vaM.y, vaM.w);
  const trBase = sigmoid(fit.base);
  const baseLl = logLoss(new Float64Array(vaM.n).fill(trBase), vaM.y, vaM.w);
  const ll = logLoss(pVal, vaM.y, vaM.w);
  const scores = val.map((r) => r.flat[opts.scoreFeature]);
  const present = scores.filter((s): s is number => s !== undefined && Number.isFinite(s)).sort((a, b) => a - b);
  const fill = present.length ? present[Math.floor((present.length - 1) / 2)]! : 0;
  const baselineAuc = present.length ? stratifiedAuc(scores.map((s) => (s !== undefined && Number.isFinite(s) ? s : fill)), vaM.y, vaM.w, groups).auc : 0.5;

  let reason = 'passed the exam';
  if (nEffective < opts.minRows) reason = `only ${nEffective.toFixed(1)} effective rows (< ${opts.minRows}; ${usable.length} rows)`;
  else if (valPositives < opts.minValPositives) reason = `only ${valPositives.toFixed(1)} effective winners in the exam (< ${opts.minValPositives})`;
  else if (strat.groups === 0) reason = 'no strategy has both winners and losers in the exam';
  else if (strat.auc < opts.minValAuc) reason = `exam AUC (within strategy) ${strat.auc.toFixed(3)} < ${opts.minValAuc}`;
  else if (strat.auc < baselineAuc + opts.minAucGain) reason = `exam AUC (within strategy) ${strat.auc.toFixed(3)} doesn't beat the score's ${baselineAuc.toFixed(3)} by ${opts.minAucGain}`;
  else if (!(ll < baseLl)) reason = `exam log-loss ${ll.toFixed(3)} isn't better than guessing the base rate (${baseLl.toFixed(3)})`;
  const active = reason === 'passed the exam';

  // 3) passed → refit on all rows (new bins too) with the same number of trees.
  let final = fit;
  let finalCuts = cuts;
  if (active) {
    const allM = matrix(usable, features, opts.winPct);
    finalCuts = cutPoints(allM, opts.bins);
    final = await boost(allM, finalCuts, opts, nTrees, null);
  }
  void finalCuts;
  const importance = features
    .map((f, i) => ({ feature: f, gain: r3(final.gain[i]!) }))
    .filter((x) => x.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 25);
  return new FittedTreeModel(
    {
      version: 1,
      trainedAtMs: now,
      active,
      features,
      base: final.base,
      lr: opts.learningRate,
      trees: final.trees,
      ...baseRates(active ? usable : train, opts.winPct),
      importance,
      report: {
        n: usable.length,
        nEffective: r3(nEffective),
        nTrain: train.length,
        nVal: val.length,
        valPositives: r3(valPositives),
        features: features.length,
        trees: final.trees.length,
        valAuc: r3(strat.auc),
        valAucPooled: r3(pooled),
        valStrata: strat.groups,
        valLogLoss: r3(ll),
        valBaseLogLoss: r3(baseLl),
        baselineAuc: r3(baselineAuc),
        active,
        reason,
      },
    },
    opts,
  );
}
