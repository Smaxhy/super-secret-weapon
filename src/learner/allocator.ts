/**
 * Adaptive budget per strategy (owner: "make it smarter — money should flow to what actually works").
 *
 * The config splits the budget across strategies with fixed fractions (NEW 20 / MIG 30 / RUNNER 20 …).
 * This module keeps those fractions as the starting point and nudges them with the evidence:
 *
 *   1. For every strategy it keeps a BELIEF about its true average result per trade (a Bayesian
 *      Normal-Inverse-Gamma posterior). The belief starts sceptical — "about −2% a trade (the fees)",
 *      worth ~10 trades — so a handful of lucky trades can't move money.
 *   2. Results are winsorised (the top / bottom 2% are clipped, so one +300% coin doesn't decide
 *      everything) and weighted by recency (7-day half-life) × the row weight (shadow trades count less).
 *   3. Thompson-style: 2,000 draws from all beliefs at once (fixed-seed PRNG → reproducible) give the
 *      chance each strategy is really the best one (pBest) and the chance it makes money at all (pPos).
 *   4. score = 0.6 × pPos + 0.4 × (its share of pBest among the strategies with evidence). Each
 *      strategy's raw budget = base × (0.5 … 1.6 by score); they are then rescaled to a TOTAL that
 *      depends on the evidence itself: eligible base × clamp(0.6 + 0.8 × base-weighted mean pPos, 0.6, 1)
 *      — when everything is probably losing the total shrinks (down to 60%), it never grows above the
 *      base. The unspent share is reported as `reserved`. Two equally losing strategies therefore both
 *      get < 1× (not one 1.35× / one 0.65× by rank). Strategies with < 10 effective trades keep 1×
 *      and nothing ever drops below half its base or above 1.6× (exploration floor / cap).
 *
 * Pure parts (`allocate`, `posteriorFor`, …) are exported for tests; the class does the Redis I/O.
 */
import type { Redis } from 'ioredis';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('allocator');

export interface LearnRow {
  /** Flat numeric entry features, e.g. 'market.marketCapUsd', 'crowd.buyRatio2m', 'shape.run3m', 'entry.score', 'entry.hourUtc' (see flattenFeatures in src/learner/ai-coach.ts). */
  flat: Record<string, number>;
  strategy: string; // CURVE_SNIPE | SOON | MIGRATION_MOMENTUM | SMART_MONEY_COPY | SWING | RUNNER
  atMs: number; // when the entry decision was made (use for TIME-ORDERED splits only — never shuffle across time)
  pnlPct: number; // result after all costs, % of the position (e.g. +25, -14)
  peakX: number; // best multiple reached after entry (1 = never up)
  weight: number; // 1 = real paper trade, 0.5 = shadow trade it would have taken, lower for weaker labels
  source: 'real' | 'shadow';
}

export interface AllocatorOptions {
  /** Prior belief about the mean result per trade (%): sceptical, the fees. */
  priorMeanPct: number;
  /** Prior strength in trades (κ0 for the mean, 2·α0 for the spread). */
  priorTrades: number;
  /** Recency half-life (days). */
  halfLifeDays: number;
  /** Winsorise at this percentile on each side (pooled over all rows). */
  winsorPct: number;
  /** Below this effective trade count a strategy keeps multiplier 1. */
  minEffTrades: number;
  draws: number;
  seed: number;
  multMin: number;
  multMax: number;
  /** Weight of "share of being best" in the score; the rest is P(mean > 0) (0–1). */
  blend: number;
}

export const DEFAULT_ALLOC_OPTS: AllocatorOptions = {
  priorMeanPct: -2,
  priorTrades: 10,
  halfLifeDays: 7,
  winsorPct: 2,
  minEffTrades: 10,
  draws: 2000,
  seed: 1234567,
  multMin: 0.5,
  multMax: 1.6,
  blend: 0.4,
};

export interface StrategyAllocation {
  strategy: string;
  /** Rows seen (raw count). */
  n: number;
  /** Effective trades: Σ weight × recency. */
  effN: number;
  /** Posterior mean of the average result per trade (%). */
  meanPct: number;
  /** 5th / 95th percentile of the posterior of the mean (%). */
  lowerPct: number;
  upperPct: number;
  /** Chance it has the best true mean of all strategies. */
  pBest: number;
  /** Chance its true mean is above 0. */
  pPos: number;
  multiplier: number;
  /** Base fraction and the new fraction of the budget. */
  base: number;
  fraction: number;
  why: string;
}

export interface AllocationResult {
  atMs: number;
  rows: number;
  strategies: StrategyAllocation[];
  /** Budget fraction held back (Σ base − Σ fraction ≥ 0): the strategies with evidence are probably losing. */
  reserved: number;
}

/* ---------------------------------------------------------------- maths helpers */

/** mulberry32: small deterministic PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rnd: () => number): number {
  // Box–Muller (one value; u1 kept away from 0).
  const u1 = Math.max(rnd(), 1e-12);
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape, 1) — Marsaglia–Tsang (shape < 1 boosted). */
function gamma(shape: number, rnd: () => number): number {
  if (shape < 1) return gamma(shape + 1, rnd) * Math.pow(Math.max(rnd(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Unweighted percentile (linear interpolation) of a sorted array. */
function pctSorted(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Clip limits for winsorising (pooled over all rows). */
export function winsorLimits(values: number[], pct: number): { lo: number; hi: number } {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 5 || pct <= 0) return { lo: -Infinity, hi: Infinity };
  return { lo: pctSorted(s, pct), hi: pctSorted(s, 100 - pct) };
}

export const recencyWeight = (ageMs: number, halfLifeDays: number) => Math.pow(0.5, Math.max(0, ageMs) / (halfLifeDays * 86_400_000));

/* ---------------------------------------------------------------- posterior */

export interface Posterior {
  /** Normal-Inverse-Gamma parameters after the update. */
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
  effN: number;
}

/**
 * Weighted Normal-Inverse-Gamma update. Prior: mean μ0 worth κ0 trades, spread σ² ~ InvGamma(α0, β0)
 * with α0 = κ0/2 and β0 = (α0 − 1)·s0² (prior mean of σ² = s0², the pooled spread of all trades).
 * Weighted samples are treated as `w` fractional observations (n = Σw).
 */
export function posteriorFor(samples: Array<{ x: number; w: number }>, priorMean: number, priorTrades: number, priorVar: number): Posterior {
  const kappa0 = priorTrades;
  const alpha0 = Math.max(1.5, priorTrades / 2);
  const beta0 = (alpha0 - 1) * priorVar;
  let n = 0;
  let sx = 0;
  for (const s of samples) {
    if (!(s.w > 0) || !Number.isFinite(s.x)) continue;
    n += s.w;
    sx += s.w * s.x;
  }
  if (n <= 0) return { mu: priorMean, kappa: kappa0, alpha: alpha0, beta: beta0, effN: 0 };
  const xbar = sx / n;
  let ss = 0;
  for (const s of samples) if (s.w > 0 && Number.isFinite(s.x)) ss += s.w * (s.x - xbar) ** 2;
  const kappa = kappa0 + n;
  return {
    mu: (kappa0 * priorMean + n * xbar) / kappa,
    kappa,
    alpha: alpha0 + n / 2,
    beta: beta0 + ss / 2 + (kappa0 * n * (xbar - priorMean) ** 2) / (2 * kappa),
    effN: n,
  };
}

/** One draw of the true mean: σ² ~ InvGamma(α, β), μ ~ N(mu, σ²/κ). */
function drawMean(p: Posterior, rnd: () => number): number {
  const sigma2 = p.beta / gamma(p.alpha, rnd);
  return p.mu + Math.sqrt(sigma2 / p.kappa) * normal(rnd);
}

/**
 * Fractions with per-strategy bounds [lo, hi] that sum to `target`: find c with
 * Σ clamp(c·raw_s, lo_s, hi_s) = target (monotone in c → bisection).
 */
export function rescaleWithBounds(raw: number[], lo: number[], hi: number[], target: number): number[] {
  const at = (c: number) => raw.map((r, i) => Math.min(hi[i]!, Math.max(lo[i]!, c * r)));
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  if (sum(lo) >= target) return lo.slice();
  if (sum(hi) <= target) return hi.slice();
  let a = 0;
  let b = 1;
  while (sum(at(b)) < target && b < 1e9) b *= 2;
  for (let k = 0; k < 60; k++) {
    const m = (a + b) / 2;
    if (sum(at(m)) < target) a = m;
    else b = m;
  }
  return at(b);
}

const fmtPct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const fmtRange = (lo: number, hi: number) => `${fmtPct(lo)}…${fmtPct(hi)}`;

/* ---------------------------------------------------------------- allocation */

/**
 * New budget fractions per strategy. `base` = the configured fractions (sum ~1); the sum of the
 * returned fractions is at most the sum of `base` (the difference is `reserved`: when the strategies
 * with evidence are probably losing, part of their budget is held back). Strategies in rows but not
 * in `base` are ignored.
 */
export function allocate(rows: LearnRow[], base: Record<string, number>, now = Date.now(), opts: Partial<AllocatorOptions> = {}): AllocationResult {
  const o: AllocatorOptions = { ...DEFAULT_ALLOC_OPTS, ...opts };
  const names = Object.keys(base)
    .filter((s) => Number.isFinite(base[s]) && base[s]! >= 0)
    .sort();
  const known = new Set(names);
  const usable = rows.filter((r) => known.has(r.strategy) && Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs) && r.weight > 0);

  // Pooled clip limits + pooled spread (empirical-Bayes prior variance).
  const { lo: clipLo, hi: clipHi } = winsorLimits(
    usable.map((r) => r.pnlPct),
    o.winsorPct,
  );
  const byStrat = new Map<string, Array<{ x: number; w: number }>>();
  const rawCount = new Map<string, number>();
  let pw = 0;
  let px = 0;
  for (const r of usable) {
    const x = Math.min(clipHi, Math.max(clipLo, r.pnlPct));
    const w = r.weight * recencyWeight(now - r.atMs, o.halfLifeDays);
    if (!(w > 0)) continue;
    const list = byStrat.get(r.strategy) ?? [];
    list.push({ x, w });
    byStrat.set(r.strategy, list);
    rawCount.set(r.strategy, (rawCount.get(r.strategy) ?? 0) + 1);
    pw += w;
    px += w * x;
  }
  let priorVar = 400; // 20% spread until there is data
  if (pw > 5) {
    const m = px / pw;
    let v = 0;
    for (const list of byStrat.values()) for (const s of list) v += s.w * (s.x - m) ** 2;
    priorVar = Math.max(25, v / pw);
  }

  const posts = names.map((s) => posteriorFor(byStrat.get(s) ?? [], o.priorMeanPct, o.priorTrades, priorVar));

  // Thompson draws: who has the best true mean, how often positive, credible band.
  const rnd = prng(o.seed);
  const draws = Math.max(100, Math.round(o.draws));
  const wins = new Array<number>(names.length).fill(0);
  const pos = new Array<number>(names.length).fill(0);
  const samples = names.map(() => new Array<number>(draws));
  // Only strategies with a budget compete for "best".
  const competing = names.map((s) => base[s]! > 0);
  for (let d = 0; d < draws; d++) {
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < names.length; i++) {
      const v = drawMean(posts[i]!, rnd);
      samples[i]![d] = v;
      if (v > 0) pos[i]!++;
      if (competing[i] && v > bestV) {
        bestV = v;
        best = i;
      }
    }
    if (best >= 0) wins[best]!++;
  }

  const eligible = names.map((s, i) => competing[i]! && posts[i]!.effN >= o.minEffTrades);
  const eligBase = names.reduce((a, s, i) => a + (eligible[i] ? base[s]! : 0), 0);
  const eligPBest = names.reduce((a, _s, i) => a + (eligible[i] ? wins[i]! / draws : 0), 0);

  // Score from the posterior itself: P(mean > 0) blended with the share of being best (among the eligible).
  const blend = Math.min(1, Math.max(0, o.blend));
  const score = names.map((_s, i) => {
    if (!eligible[i]) return 0;
    const share = eligPBest > 0 ? wins[i]! / draws / eligPBest : 0;
    return (1 - blend) * (pos[i]! / draws) + blend * share;
  });
  // Total for the eligible ones: shrinks when they are probably losing, never grows above their base.
  const eligPPos = eligBase > 0 ? names.reduce((a, s, i) => a + (eligible[i] ? base[s]! * (pos[i]! / draws) : 0), 0) / eligBase : 0;
  const totalFactor = Math.min(1, Math.max(0.6, 0.6 + 0.8 * eligPPos));
  const target = eligBase * totalFactor;

  // Raw budget = base × (multMin … multMax by score), then rescaled to the target within [multMin, multMax] × base.
  const idx = names.map((_s, i) => i).filter((i) => eligible[i] && base[names[i]!]! > 0);
  const fractions = names.map((s) => base[s]!);
  if (idx.length) {
    const scaled = rescaleWithBounds(
      idx.map((i) => base[names[i]!]! * (o.multMin + (o.multMax - o.multMin) * score[i]!)),
      idx.map((i) => o.multMin * base[names[i]!]!),
      idx.map((i) => o.multMax * base[names[i]!]!),
      target,
    );
    idx.forEach((i, k) => (fractions[i] = scaled[k]!));
  }
  const baseTotal = names.reduce((a, s) => a + base[s]!, 0);
  const reserved = Math.max(0, baseTotal - fractions.reduce((a, f) => a + f, 0));
  const reservedNote = reserved > 1e-9 ? ` ${(reserved * 100).toFixed(1)}% of the budget held back (the tested strategies are probably losing).` : '';

  const strategies: StrategyAllocation[] = names.map((s, i) => {
    const sorted = samples[i]!.slice().sort((a, b) => a - b);
    const lowerPct = pctSorted(sorted, 5);
    const upperPct = pctSorted(sorted, 95);
    const b = base[s]!;
    const multiplier = b > 0 ? fractions[i]! / b : 1;
    const n = rawCount.get(s) ?? 0;
    const effN = posts[i]!.effN;
    const meanPct = posts[i]!.mu;
    let why: string;
    if (b <= 0) why = `${s}: no budget in the config — left at 0.`;
    else if (!eligible[i]) why = `${s}: ${n} trades (${effN.toFixed(1)} counting recency) — not enough evidence yet, keeps its normal budget.`;
    else why = `${s}: ${n} trades, likely ${fmtPct(meanPct)} a trade (${fmtRange(lowerPct, upperPct)}) → ${multiplier.toFixed(2)}× budget.${reservedNote}`;
    return {
      strategy: s,
      n,
      effN: round(effN, 2),
      meanPct: round(meanPct, 2),
      lowerPct: round(lowerPct, 2),
      upperPct: round(upperPct, 2),
      pBest: round(wins[i]! / draws, 4),
      pPos: round(pos[i]! / draws, 4),
      multiplier: round(multiplier, 4),
      base: b,
      fraction: fractions[i]!,
      why,
    };
  });
  return { atMs: now, rows: usable.length, strategies, reserved: round(reserved, 6) };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/* ---------------------------------------------------------------- I/O */

const KEY = 'alloc:last';

export class Allocator {
  private last: AllocationResult | null = null;
  private mult = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly loadRows: () => Promise<LearnRow[]>,
    private readonly baseAlloc: () => Record<string, number>,
    private readonly opts: Partial<AllocatorOptions> = {},
  ) {}

  private apply(r: AllocationResult): void {
    this.last = r;
    this.mult = new Map(r.strategies.map((s) => [s.strategy, s.multiplier]));
  }

  async refresh(now = Date.now()): Promise<AllocationResult | null> {
    if (this.running) return this.last;
    this.running = true;
    try {
      const rows = await this.loadRows();
      // Let pending I/O run before the (short, < 50 ms) CPU part.
      await new Promise((r) => setImmediate(r));
      const res = allocate(rows, this.baseAlloc(), now, this.opts);
      this.apply(res);
      await this.redis.set(KEY, JSON.stringify(res), 'EX', 7 * 86_400);
      return res;
    } finally {
      this.running = false;
    }
  }

  /** Budget multiplier for a strategy (sync, cached; 1 until the first run). */
  multiplierFor(strategy: string): number {
    const m = this.mult.get(strategy);
    return m !== undefined && Number.isFinite(m) && m > 0 ? m : 1;
  }

  snapshot(): AllocationResult | null {
    return this.last;
  }

  async restore(): Promise<void> {
    try {
      const raw = await this.redis.get(KEY);
      if (raw && !this.last) {
        const r = JSON.parse(raw) as AllocationResult;
        if (Array.isArray(r?.strategies)) this.apply({ ...r, reserved: Number.isFinite(r.reserved) ? r.reserved : 0 });
      }
    } catch {
      /* ignore — first refresh fills it */
    }
  }

  start(): void {
    void this.restore();
    const tick = () => void this.refresh().catch((err: Error) => log.warn({ err: err.message }, 'allocator refresh failed'));
    const t1 = setTimeout(tick, 3 * 60_000);
    const t2 = setInterval(tick, 30 * 60_000);
    t1.unref();
    t2.unref();
    this.timers.push(t1, t2);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
