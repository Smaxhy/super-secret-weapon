/**
 * Signal judge (v14): meta-labeling. Every signal the strategies make comes with its context: currency strength,
 * bigger-chart trend, market mood, regime, how wild the market is, time of day, distance from the averages, how the
 * strategy itself has done lately… A small boosted-tree model (the crypto learner's GBDT, reused) learns from the
 * FIRST 70% of the history which contexts win, picks how picky to be on the newest part of that 70%, and then has to
 * prove itself ONCE on the unseen 30%. Only a judge that passes is used by the bot (it skips the signals it scores
 * low). Pure apart from the yields inside the tree training.
 */
import { boost, cutPoints, DEFAULT_TREE_OPTIONS, sigmoid, treeValue, type Matrix, type TreeNode } from '../lib/gbdt';
import type { FilterEnv } from './filters';
import type { Ctx } from './ta';
import { volRatioAt } from './engine';
import { TF_MIN, type Timeframe } from './types';

export const JUDGE_FEATURES = [
  'side',
  'strength',
  'trend4h',
  'trendD',
  'mood',
  'volRatio',
  'adx',
  'rsi',
  'er',
  'atrPct',
  'ema50Dist',
  'ema200Dist',
  'squeeze',
  'hour',
  'dow',
  'lastRange',
  'style',
  'prior',
  'form',
  'jpy',
  'metal',
  'tf',
  'stopAtr',
  'targetR',
] as const;
export type JudgeFeature = (typeof JUDGE_FEATURES)[number];

export const JUDGE_LABEL: Record<JudgeFeature, string> = {
  side: 'buy or sell',
  strength: 'currency strength on its side',
  trend4h: '4-hour trend on its side',
  trendD: 'daily trend on its side',
  mood: 'market mood on its side',
  volRatio: 'how wild the market is vs normal',
  adx: 'trend strength (ADX)',
  rsi: 'RSI on its side',
  er: 'clean trend vs chop',
  atrPct: 'hourly range size',
  ema50Dist: 'distance from the 50 average',
  ema200Dist: 'distance from the 200 average',
  squeeze: 'how tight the bands are',
  hour: 'hour of the day',
  dow: 'day of the week',
  lastRange: 'size of the signal candle',
  style: 'trend / dip / fade strategy',
  prior: "strategy's tested record",
  form: "strategy's last 10 trades",
  jpy: 'yen pair',
  metal: 'gold / silver',
  tf: 'hourly or 4-hour',
  stopAtr: 'stop distance',
  targetR: 'target size',
};

export const JUDGE_CONFIG = {
  /** in-sample trades needed before it trains */
  minTrain: 400,
  maxTrainRows: 15_000,
  rounds: 200,
  /** keep shares tried on the newest part of the first 70% (1 = no gate) */
  keepShares: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
  /** the unseen exam */
  minAuc: 0.53,
  minGainR: 0.03,
  minKept: 60,
};

const fin = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x : NaN);
const STYLE_CODE: Record<string, number> = { trend: 1, pullback: 0.5, neutral: 0, revert: -1 };

/** Context of one signal at bar i (the bar whose close made it). NaN = unknown. Pure. */
export function judgeFeatures(c: Ctx, env: FilterEnv | null, i: number, side: 1 | -1, stop: number, target: number | null, extra: { style: string; prior: number; form: number; tf: Timeframe }): Float64Array {
  const x = new Float64Array(JUDGE_FEATURES.length).fill(NaN);
  const a = c.atr14[i]!;
  const px = c.close[i]!;
  const okA = Number.isFinite(a) && a > 0;
  const set = (f: JudgeFeature, v: number) => {
    x[JUDGE_FEATURES.indexOf(f)] = v;
  };
  set('side', side);
  if (env) {
    set('strength', side * fin(env.gap[i]));
    set('trend4h', env.tf !== '4h' ? side * (env.h4[i] ?? 0) : NaN);
    set('trendD', side * (env.d1[i] ?? 0));
    set('mood', side * env.riskLong * fin(env.mood[i]));
    set('er', fin(env.er?.[i]));
  }
  set('volRatio', fin(volRatioAt(c, i)));
  set('adx', fin(c.adx.adx[i]));
  set('rsi', side * (fin(c.rsi14[i]) - 50));
  if (okA) {
    set('atrPct', (a / px) * 100);
    set('ema50Dist', (side * (px - fin(c.ema50[i]))) / a);
    set('ema200Dist', (side * (px - fin(c.ema200[i]))) / a);
    const b = c.bars[i]!;
    const pa = fin(c.atr14[i - 1]);
    set('lastRange', pa > 0 ? (b.h - b.l) / pa : NaN);
    set('stopAtr', Math.abs(px - stop) / a);
  }
  const w = fin(c.bb.width[i]);
  const wl = fin(c.bbWidthLow100[i]);
  set('squeeze', wl > 0 ? w / wl : NaN);
  set('hour', c.hour[i]!);
  set('dow', new Date(c.bars[i]!.t).getUTCDay());
  set('style', STYLE_CODE[extra.style] ?? 0);
  set('prior', extra.prior);
  set('form', extra.form);
  set('jpy', c.pair.includes('JPY') ? 1 : 0);
  set('metal', c.pair.startsWith('XA') ? 1 : 0);
  set('tf', TF_MIN[extra.tf] / 60);
  const risk = Math.abs(px - stop);
  set('targetR', target === null || !(risk > 0) ? 0 : Math.abs(target - px) / risk);
  return x;
}

export interface JudgeModel {
  trees: TreeNode[][];
  base: number;
  /** take a signal only when its win probability is at least this */
  threshold: number;
  keepShare: number;
}

export function judgeProb(m: Pick<JudgeModel, 'trees' | 'base'>, x: ArrayLike<number>): number {
  let z = m.base;
  for (const t of m.trees) z += treeValue(t, (f) => x[f]!);
  return sigmoid(z);
}

export interface JudgeRow {
  x: Float64Array;
  r: number;
  /** entry time */
  t: number;
  /** v17: exit time — a row only teaches the first 70% if it finished before the boundary (default: the entry time) */
  exitT?: number;
}

/** v17 purge: finished before `t` (rows without an exit time count by their entry). Pure. */
export const doneBefore = (r: { t: number; exitT?: number }, t: number) => (r.exitT ?? r.t) < t;

export interface JudgeReport {
  active: boolean;
  why: string;
  trainedOn: number;
  tested: number;
  /** unseen exam */
  auc: number | null;
  threshold: number | null;
  keepPct: number;
  allR: number;
  keptR: number;
  skippedR: number;
  allWinPct: number;
  keptWinPct: number;
  importance: Array<{ feature: JudgeFeature; label: string; share: number }>;
}

/** Rank AUC (Mann–Whitney), ties averaged. Pure. */
export function auc(p: ArrayLike<number>, y: ArrayLike<number>): number | null {
  const idx = Array.from({ length: p.length }, (_, i) => i).sort((a, b) => p[a]! - p[b]!);
  let pos = 0;
  let neg = 0;
  let rankSum = 0;
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && p[idx[j + 1]!] === p[idx[k]!]) j++;
    const avgRank = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) {
      if (y[idx[m]!]) {
        pos++;
        rankSum += avgRank;
      } else neg++;
    }
    k = j + 1;
  }
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

function toMatrix(rows: readonly JudgeRow[]): Matrix {
  const n = rows.length;
  const F = JUDGE_FEATURES.length;
  const x = new Float64Array(n * F);
  const y = new Float64Array(n);
  const w = new Float64Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    y[i] = r.r > 0 ? 1 : 0;
    for (let f = 0; f < F; f++) x[f * n + i] = r.x[f]!;
  }
  return { n, F, x, y, w };
}

/**
 * Train on rows finished before `oosFrom` (v17 purge), choose how picky to be on the newest 20% of those, then grade
 * once on the rows entered from `oosFrom` on. Returns the model (null when there is too little data) and the report.
 */
export async function trainJudge(rows: readonly JudgeRow[], oosFrom: number, cfg = JUDGE_CONFIG): Promise<{ model: JudgeModel | null; report: JudgeReport }> {
  const ins = rows.filter((r) => doneBefore(r, oosFrom)).sort((a, b) => a.t - b.t).slice(-cfg.maxTrainRows);
  const oos = rows.filter((r) => r.t >= oosFrom);
  const empty = (why: string): { model: null; report: JudgeReport } => ({ model: null, report: { active: false, why, trainedOn: ins.length, tested: oos.length, auc: null, threshold: null, keepPct: 100, allR: r2(avg(oos.map((r) => r.r))), keptR: r2(avg(oos.map((r) => r.r))), skippedR: 0, allWinPct: 0, keptWinPct: 0, importance: [] } });
  if (ins.length < cfg.minTrain) return empty(`needs ${cfg.minTrain} trades from the first 70% to learn from (has ${ins.length})`);
  const cut = Math.floor(ins.length * 0.8);
  // the trees learn only from trades finished before the newest 20% starts (same purge, one level down)
  const vFrom = ins[cut]?.t ?? Infinity;
  const tr = toMatrix(ins.slice(0, cut).filter((r) => doneBefore(r, vFrom)));
  const va = toMatrix(ins.slice(cut));
  const opts = { ...DEFAULT_TREE_OPTIONS, depth: 3, learningRate: 0.06, rounds: cfg.rounds, minChildWeight: 20, l2: 5, colSample: 0.8, earlyStop: 25 };
  const cuts = cutPoints(tr, opts.bins);
  const fit = await boost(tr, cuts, opts, cfg.rounds, va, 11);
  const model0 = { trees: fit.trees, base: fit.base };
  // how picky: the keep share that gives the best R × √n on the newest 20% of the first 70%
  const vrows = ins.slice(cut);
  const vp = vrows.map((r) => judgeProb(model0, r.x));
  const score = (keep: number) => {
    const th = quantile(vp, 1 - keep);
    const kept = vrows.filter((_, k) => vp[k]! >= th);
    return { th, s: avg(kept.map((r) => r.r)) * Math.sqrt(kept.length) };
  };
  const all = score(1);
  let best = { keep: 1, th: -Infinity, s: all.s };
  for (const k of cfg.keepShares) {
    const sc = score(k);
    if (sc.s > best.s) best = { keep: k, th: sc.th, s: sc.s };
  }
  // the exam (once) on the unseen 30%
  const op = oos.map((r) => judgeProb(model0, r.x));
  const a = auc(op, oos.map((r) => (r.r > 0 ? 1 : 0)));
  const kept = oos.filter((_, k) => op[k]! >= best.th);
  const skipped = oos.filter((_, k) => op[k]! < best.th);
  const allR = avg(oos.map((r) => r.r));
  const keptR = avg(kept.map((r) => r.r));
  const tot = fit.gain.reduce((s, g) => s + g, 0) || 1;
  const importance = JUDGE_FEATURES.map((f, k) => ({ feature: f, label: JUDGE_LABEL[f], share: Math.round((fit.gain[k]! / tot) * 100) }))
    .filter((x) => x.share > 0)
    .sort((x, y) => y.share - x.share)
    .slice(0, 8);
  const pass = best.keep < 1 && a !== null && a >= cfg.minAuc && keptR >= allR + cfg.minGainR && kept.length >= cfg.minKept;
  const why = best.keep === 1
    ? 'on the newest part of the first 70% no level of pickiness beat taking every signal'
    : a === null
      ? 'not enough unseen trades to grade it'
      : pass
        ? `on the unseen 30% the trades it keeps made ${r2(keptR)}R each vs ${r2(allR)}R for all signals (AUC ${r2(a)})`
        : `failed the unseen test: ${[
            a < cfg.minAuc ? `ranking skill (AUC) ${r2(a)}, needs ${cfg.minAuc}` : null,
            keptR < allR + cfg.minGainR ? `the trades it keeps made ${r2(keptR)}R each vs ${r2(allR)}R for all signals, needs ${cfg.minGainR}R more` : null,
            kept.length < cfg.minKept ? `only ${kept.length} trades kept, needs ${cfg.minKept}` : null,
          ]
            .filter(Boolean)
            .join('; ')}`;
  return {
    model: { trees: fit.trees, base: fit.base, threshold: best.th, keepShare: best.keep },
    report: {
      active: pass,
      why,
      trainedOn: ins.length,
      tested: oos.length,
      auc: a === null ? null : r2(a),
      threshold: Number.isFinite(best.th) ? r2(best.th) : null,
      keepPct: oos.length ? Math.round((kept.length / oos.length) * 100) : 100,
      allR: r2(allR),
      keptR: r2(keptR),
      skippedR: r2(avg(skipped.map((r) => r.r))),
      allWinPct: oos.length ? Math.round((oos.filter((r) => r.r > 0).length / oos.length) * 100) : 0,
      keptWinPct: kept.length ? Math.round((kept.filter((r) => r.r > 0).length / kept.length) * 100) : 0,
      importance,
    },
  };
}

function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return -Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
}
