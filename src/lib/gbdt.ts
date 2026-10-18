/**
 * Gradient-boosted decision trees, the generic core (histogram GBDT: quantile bins, learned missing direction, logistic
 * loss, weighted rows, shrinkage, L2 on leaves, min child weight, column subsampling, early stopping; async with a
 * yield after every tree). Shared by the crypto tree model (learner/tree-model.ts) and the forex signal judge
 * (forex/judge.ts) — kept in lib so the two programs depend on the same small file, not on each other. Pure apart from
 * the yields.
 */
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

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
export const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Seeded PRNG (mulberry32) — column sampling must be reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Column-major training matrix (exported for other learners, e.g. the forex signal judge). */
export interface Matrix {
  n: number;
  F: number;
  /** column-major raw values (NaN = missing) */
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
}

/** Pure: quantile cut points per feature from the training matrix (≤ bins−1 cuts; distinct). */
export function cutPoints(m: Matrix, bins: number): Float64Array[] {
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
export function binMatrix(m: Matrix, cuts: readonly Float64Array[]): Uint8Array {
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
export function growTree(
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

export function logLoss(p: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>): number {
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
export async function boost(
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

