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

export interface TreeOptions {
  winPct: number;
  trainShare: number;
  innerTrainShare: number;
  minRows: number;
  minValPositives: number;
  minValAuc: number;
  minAucGain: number;
  minPresence: number;
  maxFeatures: number;
  maxTrainRows: number;
  bins: number;
  depth: number;
  rounds: number;
  learningRate: number;
  l2: number;
  minChildWeight: number;
  colSample: number;
  earlyStop: number;
  pointsScale: number;
  maxPoints: number;
  scoreFeature: string;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = {
  winPct: 3,
  trainShare: 0.75,
  innerTrainShare: 0.8,
  minRows: 150,
  minValPositives: 15,
  minValAuc: 0.58,
  minAucGain: 0.02,
  minPresence: 0.2,
  maxFeatures: 120,
  maxTrainRows: 12_000,
  bins: 32,
  depth: 3,
  rounds: 250,
  learningRate: 0.08,
  l2: 3,
  minChildWeight: 2,
  colSample: 0.7,
  earlyStop: 25,
  pointsScale: 40,
  maxPoints: 10,
  scoreFeature: 'entry.score',
};

/** One split node or leaf. Leaf: f = -1, v = value. Split: x[f] < cut → l, else r; missing → miss ('l' | 'r'). */
export interface TreeNode {
  f: number;
  cut: number;
  miss: 0 | 1;
  l: number;
  r: number;
  v: number;
}

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

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rowW = (r: LearnRow): number => (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 0);
const STRAT_PREFIX = 'strategy=';

/** Seeded PRNG (mulberry32) — column sampling must be reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

interface Matrix {
  n: number;
  F: number;
  /** column-major raw values (NaN = missing) */
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
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

/** Pure: quantile cut points per feature from the training matrix (≤ bins−1 cuts; distinct). */
function cutPoints(m: Matrix, bins: number): Float64Array[] {
  const cuts: Float64Array[] = [];
  for (let f = 0; f < m.F; f++) {
    const vals: number[] = [];
    for (let i = 0; i < m.n; i++) {
      const v = m.x[f * m.n + i]!;
      if (v === v) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const out: number[] = [];
    for (let b = 1; b < bins; b++) {
      const q = vals[Math.floor((b / bins) * vals.length)];
      if (q !== undefined && (out.length === 0 || q > out[out.length - 1]!)) out.push(q);
    }
    cuts.push(Float64Array.from(out));
  }
  return cuts;
}

/** Bin index per (feature, row): 0…k for values (k = #cuts), 255 = missing. Value v goes to bin = #cuts ≤ v. */
function binMatrix(m: Matrix, cuts: readonly Float64Array[]): Uint8Array {
  const out = new Uint8Array(m.n * m.F);
  for (let f = 0; f < m.F; f++) {
    const c = cuts[f]!;
    for (let i = 0; i < m.n; i++) {
      const v = m.x[f * m.n + i]!;
      if (v !== v) {
        out[f * m.n + i] = 255;
        continue;
      }
      let lo = 0;
      let hi = c.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (c[mid]! <= v) lo = mid + 1;
        else hi = mid;
      }
      out[f * m.n + i] = lo;
    }
  }
  return out;
}

interface Built {
  nodes: TreeNode[];
  gain: Float64Array;
}

/** Grow one tree on rows `idx` with gradients g / hessians h (all weighted). */
function growTree(
  bins: Uint8Array,
  n: number,
  F: number,
  cuts: readonly Float64Array[],
  g: Float64Array,
  h: Float64Array,
  idx: Uint32Array,
  cols: readonly number[],
  o: Pick<TreeOptions, 'depth' | 'l2' | 'minChildWeight' | 'bins'>,
): Built {
  const nodes: TreeNode[] = [];
  const gain = new Float64Array(F);
  const histG = new Float64Array(o.bins + 1);
  const histH = new Float64Array(o.bins + 1);
  const leaf = (G: number, H: number) => -G / (H + o.l2);
  const score = (G: number, H: number) => (G * G) / (H + o.l2);
  const build = (rows: Uint32Array, depth: number): number => {
    let G = 0;
    let H = 0;
    for (let k = 0; k < rows.length; k++) {
      G += g[rows[k]!]!;
      H += h[rows[k]!]!;
    }
    const id = nodes.length;
    nodes.push({ f: -1, cut: 0, miss: 0, l: -1, r: -1, v: leaf(G, H) });
    if (depth >= o.depth || H < 2 * o.minChildWeight || rows.length < 4) return id;
    const parent = score(G, H);
    let best = { gain: 1e-9, f: -1, bin: -1, missLeft: true };
    for (const f of cols) {
      const k = cuts[f]!.length; // value bins 0…k
      if (k === 0) continue;
      histG.fill(0, 0, k + 1);
      histH.fill(0, 0, k + 1);
      let mG = 0;
      let mH = 0;
      const base = f * n;
      for (let t = 0; t < rows.length; t++) {
        const i = rows[t]!;
        const b = bins[base + i]!;
        if (b === 255) {
          mG += g[i]!;
          mH += h[i]!;
        } else {
          histG[b]! += g[i]!;
          histH[b]! += h[i]!;
        }
      }
      // split "bin < s" goes left (s = 1…k); missing tried on both sides
      let lG = 0;
      let lH = 0;
      for (let s = 1; s <= k; s++) {
        lG += histG[s - 1]!;
        lH += histH[s - 1]!;
        const rG = G - mG - lG;
        const rH = H - mH - lH;
        for (const missLeft of [true, false]) {
          const LG = missLeft ? lG + mG : lG;
          const LH = missLeft ? lH + mH : lH;
          const RG = missLeft ? rG : rG + mG;
          const RH = missLeft ? rH : rH + mH;
          if (LH < o.minChildWeight || RH < o.minChildWeight) continue;
          const gn = score(LG, LH) + score(RG, RH) - parent;
          if (gn > best.gain) best = { gain: gn, f, bin: s, missLeft };
        }
      }
    }
    if (best.f < 0) return id;
    const f = best.f;
    const left: number[] = [];
    const right: number[] = [];
    for (let t = 0; t < rows.length; t++) {
      const i = rows[t]!;
      const b = bins[f * n + i]!;
      if (b === 255 ? best.missLeft : b < best.bin) left.push(i);
      else right.push(i);
    }
    if (!left.length || !right.length) return id;
    gain[f]! += best.gain;
    const node = nodes[id]!;
    node.f = f;
    // raw-value threshold: bin < s  ⇔  value < cuts[s-1]
    node.cut = cuts[f]![best.bin - 1]!;
    node.miss = best.missLeft ? 0 : 1;
    node.l = build(Uint32Array.from(left), depth + 1);
    node.r = build(Uint32Array.from(right), depth + 1);
    return id;
  };
  build(idx, 0);
  return { nodes, gain };
}

/** Pure: one tree's output for a feature vector (raw values; NaN = missing). */
export function treeValue(nodes: readonly TreeNode[], get: (f: number) => number): number {
  let id = 0;
  for (let guard = 0; guard < 64; guard++) {
    const nd = nodes[id];
    if (!nd) return 0;
    if (nd.f < 0) return nd.v;
    const v = get(nd.f);
    const goLeft = v !== v ? nd.miss === 0 : v < nd.cut;
    id = goLeft ? nd.l : nd.r;
  }
  return 0;
}

function logLoss(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>): number {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p[i]!));
    s += -w[i]! * (y[i]! ? Math.log(q) : Math.log(1 - q));
    sw += w[i]!;
  }
  return sw > 0 ? s / sw : NaN;
}

/** Fit boosted trees on `tr`; optionally watch `va` for early stopping. Returns trees, base, best round count, gains. */
async function boost(
  tr: Matrix,
  cuts: readonly Float64Array[],
  o: TreeOptions,
  rounds: number,
  va: Matrix | null,
  seed = 7,
): Promise<{ trees: TreeNode[][]; base: number; best: number; gain: Float64Array }> {
  let sw = 0;
  let sy = 0;
  for (let i = 0; i < tr.n; i++) {
    sw += tr.w[i]!;
    sy += tr.w[i]! * tr.y[i]!;
  }
  const p0 = Math.min(0.99, Math.max(0.01, sw > 0 ? sy / sw : 0.5));
  const base = Math.log(p0 / (1 - p0));
  const bins = binMatrix(tr, cuts);
  const z = new Float64Array(tr.n).fill(base);
  const g = new Float64Array(tr.n);
  const h = new Float64Array(tr.n);
  const idx = Uint32Array.from({ length: tr.n }, (_, i) => i);
  const zv = va ? new Float64Array(va.n).fill(base) : null;
  const trees: TreeNode[][] = [];
  const gain = new Float64Array(tr.F);
  const rand = rng(seed);
  let bestLoss = Infinity;
  let best = 0;
  for (let t = 0; t < rounds; t++) {
    for (let i = 0; i < tr.n; i++) {
      const p = sigmoid(z[i]!);
      g[i] = tr.w[i]! * (p - tr.y[i]!);
      h[i] = tr.w[i]! * Math.max(1e-6, p * (1 - p));
    }
    const cols: number[] = [];
    for (let f = 0; f < tr.F; f++) if (rand() < o.colSample) cols.push(f);
    if (!cols.length) cols.push(Math.floor(rand() * tr.F));
    const built = growTree(bins, tr.n, tr.F, cuts, g, h, idx, cols, o);
    // shrinkage baked into the leaves
    for (const nd of built.nodes) if (nd.f < 0) nd.v *= o.learningRate;
    trees.push(built.nodes);
    for (let f = 0; f < tr.F; f++) gain[f]! += built.gain[f]!;
    for (let i = 0; i < tr.n; i++) z[i]! += treeValue(built.nodes, (f) => tr.x[f * tr.n + i]!);
    if (va && zv) {
      for (let i = 0; i < va.n; i++) zv[i]! += treeValue(built.nodes, (f) => va.x[f * va.n + i]!);
      const loss = logLoss(Array.from(zv, sigmoid), va.y, va.w);
      if (loss < bestLoss - 1e-6) {
        bestLoss = loss;
        best = t + 1;
      } else if (t + 1 - best >= o.earlyStop) break;
    } else best = t + 1;
    await yieldNow();
  }
  return { trees: trees.slice(0, Math.max(1, best)), base, best: Math.max(1, best), gain };
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
