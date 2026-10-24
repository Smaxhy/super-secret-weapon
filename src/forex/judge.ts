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
import { instrument, isFutures, TF_MIN, type Timeframe } from './types';
import { roundStep } from './strategies';
import { spreadMultAt } from './spreads';
import { flowOf } from './flow';

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
  // v17: the quant readings and costs
  'volF',
  'hurst',
  'ouZ',
  'carry',
  'cot',
  'mom3',
  'roundAtr',
  'costR',
  // v27.35: standard deviation, volume profile, order flow (appended: stored models keep their feature indices)
  'lrZ',
  'lrR2',
  'vpPoc',
  'vaPos',
  'cmf',
  'relVol',
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
  volF: 'volatility forecast',
  hurst: 'moves continue vs snap back',
  ouZ: 'stretch from its 120-bar mean, on its side',
  carry: 'interest-rate gap on its side',
  cot: 'hedge-fund positioning on its side',
  mom3: 'momentum on 1 / 5 / 20 days, on its side',
  roundAtr: 'room to the next round number',
  costR: 'spread cost vs the stop',
  lrZ: 'standard deviations from the regression line, on its side',
  lrR2: 'how straight the 50-candle channel is',
  vpPoc: 'distance to the busiest price (POC)',
  vaPos: 'where it sits in the value area, on its side',
  cmf: 'money flow (buy − sell volume), on its side',
  relVol: 'volume vs normal',
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
  set('metal', isFutures(c.pair) ? 1 : 0); // v27: indices share the metals' group (no strength / positioning)
  set('tf', TF_MIN[extra.tf] / 60);
  const risk = Math.abs(px - stop);
  set('targetR', target === null || !(risk > 0) ? 0 : Math.abs(target - px) / risk);
  // v17: quant readings (NaN = not known at that bar; the presence mask in `trainJudge` decides which ones it may use)
  set('volF', fin(env?.volF?.[i]));
  set('hurst', fin(env?.hurst?.[i]));
  set('ouZ', side * fin(c.quant?.z120[i]));
  set('carry', side * fin(env?.carry?.[i]));
  set('cot', side * fin(env?.cot?.[i]));
  const hs = [24, 120, 480].map((h) => Math.max(2, Math.round((h * 60) / c.barMin)));
  if (i >= hs[2]!) set('mom3', side * hs.reduce((s, n) => s + Math.sign(c.close[i]! - c.close[i - n]!), 0));
  const step = roundStep(c.pair);
  if (step && okA) {
    const next = side === 1 ? Math.floor(px / step) * step + step : Math.ceil(px / step) * step - step;
    set('roundAtr', Math.abs(next - px) / a);
  }
  const inst = instrument(c.pair);
  // v27.35: deviation channel, volume profile, order flow (NaN where unknown; no-volume markets get the time profile)
  const fl = flowOf(c);
  set('lrZ', side * fin(fl.lrZ[i]));
  set('lrR2', fin(fl.lrR2[i]));
  const vp = fl.vp(i);
  if (vp && okA) set('vpPoc', (side * (px - vp.poc)) / a);
  if (vp && vp.vah > vp.val) set('vaPos', (side * (px - (vp.vah + vp.val) / 2)) / ((vp.vah - vp.val) / 2));
  set('cmf', side * fin(fl.cmf[i]));
  set('relVol', fin(fl.relVol[i]));
  if (inst && risk > 0) set('costR', (inst.spreadPips * inst.pip * spreadMultAt(c.pair, c.bars[i]!.t, i > 0 ? c.bars[i - 1]!.t : null)) / risk);
  return x;
}

/** v17: the backup model (soft outside feeds blanked too), with its own pickiness picked on the first 70% */
export interface JudgeFallback {
  trees: TreeNode[][];
  base: number;
  threshold: number;
  keepShare: number;
}

export interface JudgeModel {
  trees: TreeNode[][];
  base: number;
  /** take a signal only when its win probability is at least this */
  threshold: number;
  keepShare: number;
  /**
   * v17 presence mask per group (chart × metal): features known in < 90% of that group's training trades are blanked
   * (so "the feed was missing" can't stand for an older period), and the ones known in ≥ 90% are required live
   * (missing live → the judge can't score it → the trade waits).
   */
  masked?: Record<string, number[]>;
  required?: Record<string, number[]>;
  /**
   * v17: backup model for signals missing ONLY soft outside feeds (`JUDGE_SOFT`): trained on the same rows with those
   * blanked as well and graded on its own unseen exam — stored only when it passed (absent = such signals wait).
   * v17.8: it never counts toward the main judge's exam; live it is used only while the main judge is active.
   */
  fallback?: JudgeFallback | null;
}

/** v17: share of training rows a feature must be known in, per group, to be used (else blanked) */
export const JUDGE_PRESENCE = 0.9;
/**
 * v17: outside feeds that can go quiet for days (CFTC positioning: no report for 17+ days → NaN; BIS rates: 100+ days;
 * the Yahoo mood symbols). A signal missing only these is scored by the backup model instead of waiting, so a
 * reporting halt can't stop every trade.
 */
export const JUDGE_SOFT: JudgeFeature[] = ['mood', 'carry', 'cot'];
const SOFT_IDX = JUDGE_SOFT.map((f) => JUDGE_FEATURES.indexOf(f));
const isSoft = (f: number) => SOFT_IDX.includes(f);
const TF_IDX = JUDGE_FEATURES.indexOf('tf');
const METAL_IDX = JUDGE_FEATURES.indexOf('metal');
/** the presence group of a feature row: chart (hours) × metal */
export const judgeGroup = (x: ArrayLike<number>) => `${x[TF_IDX]}:${x[METAL_IDX]}`;

/** v17: masks from the training rows (pure). */
export function presenceMasks(rows: ReadonlyArray<{ x: ArrayLike<number> }>, share = JUDGE_PRESENCE): { masked: Record<string, number[]>; required: Record<string, number[]> } {
  const n = new Map<string, number>();
  const known = new Map<string, Float64Array>();
  for (const r of rows) {
    const g = judgeGroup(r.x);
    n.set(g, (n.get(g) ?? 0) + 1);
    const k = known.get(g) ?? known.set(g, new Float64Array(JUDGE_FEATURES.length)).get(g)!;
    for (let f = 0; f < JUDGE_FEATURES.length; f++) if (Number.isFinite(r.x[f]!)) k[f]!++;
  }
  const masked: Record<string, number[]> = {};
  const required: Record<string, number[]> = {};
  for (const [g, k] of known) {
    const total = n.get(g)!;
    masked[g] = [];
    required[g] = [];
    for (let f = 0; f < JUDGE_FEATURES.length; f++) (k[f]! / total >= share ? required[g]! : masked[g]!).push(f);
  }
  return { masked, required };
}

/** a copy of x with that group's blanked features set to NaN */
function applyMask(x: ArrayLike<number>, masked: readonly number[] | undefined): Float64Array {
  const out = Float64Array.from(x as ArrayLike<number>);
  for (const f of masked ?? []) out[f] = NaN;
  return out;
}

/** v17: the backup model's input: the group's mask plus every soft feature blanked */
function softMask(x: ArrayLike<number>, masked: readonly number[] | undefined): Float64Array {
  const out = applyMask(x, masked);
  for (const f of SOFT_IDX) out[f] = NaN;
  return out;
}

const labelsOf = (fs: readonly number[]) => fs.map((f) => JUDGE_LABEL[JUDGE_FEATURES[f]!]).join(', ');

export interface JudgeView {
  /** win probability, null = it can't score this signal now */
  p: number | null;
  /** what it relies on that is missing right now (null when it scored) */
  missing: string | null;
  /** v17: the score p must reach — the backup model's own when it scored the signal */
  threshold: number;
  /** v17: which model scored it */
  via?: 'main' | 'fallback';
}

/** v17.8: `backup: false` = the main model alone (a signal missing a soft feed is then unscorable, as before v17.7) */
export interface JudgeViewOpts {
  backup?: boolean;
}

/**
 * v17: the judge's view of one signal: its win probability and the bar it must reach, or why it can't score it (a
 * reading it relies on is missing right now, or a chart × metal group it never trained on). Missing only soft outside
 * feeds → the backup model scores it (when one passed its exam, and unless `opts.backup` is false). Pure.
 */
export function judgeView(m: JudgeModel, x: ArrayLike<number>, opts: JudgeViewOpts = {}): JudgeView {
  if (!m.masked || !m.required) return { p: judgeProb(m, x), missing: null, threshold: m.threshold, via: 'main' };
  const g = judgeGroup(x);
  const req = m.required[g];
  if (!req) return { p: null, missing: 'no training trades like this one (chart / market type)', threshold: m.threshold };
  const gone = req.filter((f) => !Number.isFinite(x[f]!));
  if (!gone.length) return { p: judgeProb(m, applyMask(x, m.masked[g])), missing: null, threshold: m.threshold, via: 'main' };
  if (m.fallback && opts.backup !== false && gone.every(isSoft)) return { p: judgeProb(m.fallback, softMask(x, m.masked[g])), missing: null, threshold: m.fallback.threshold, via: 'fallback' };
  return { p: null, missing: labelsOf(gone), threshold: m.threshold };
}

/**
 * v17: does the judge keep this signal (unscorable = not kept; the backup's score against its own bar)? v17.8: the
 * honest-test "judged" row passes `{ backup: false }` — the backup was picked on those same unseen trades. Pure.
 */
export const judgeKeeps = (m: JudgeModel, x: ArrayLike<number>, opts: JudgeViewOpts = {}) => {
  const v = judgeView(m, x, opts);
  return v.p !== null && v.p >= v.threshold;
};

/**
 * v17: the main model's own score, for the conviction / sniper cut points (they were graded on its scores) — null when
 * it can't score the signal itself (unscorable, or only the backup could). Pure.
 */
export function judgeMainP(m: JudgeModel, x: ArrayLike<number>): number | null {
  const v = judgeView(m, x);
  return v.via === 'main' ? v.p : null;
}

/** v17: main-model scores for `judgeCuts`: signals it can't score are dropped, never counted as 0. Pure. */
export function judgeScores(m: JudgeModel, xs: Iterable<ArrayLike<number> | undefined>): number[] {
  const out: number[] = [];
  for (const x of xs) {
    const p = x ? judgeMainP(m, x) : null;
    if (p !== null) out.push(p);
  }
  return out;
}

/** v17: the backup's score as live would give it when every soft feed is missing (a missing hard reading → null). */
function fallbackScore(m: JudgeModel, fb: JudgeFallback, x: ArrayLike<number>): number | null {
  const g = judgeGroup(x);
  const req = m.required?.[g];
  if (m.required && !req) return null;
  if (req?.some((f) => !isSoft(f) && !Number.isFinite(x[f]!))) return null;
  return judgeProb(fb, softMask(x, m.masked?.[g]));
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
  /** v17: the backup model for signals missing only positioning / rate / mood data (its own unseen exam) */
  fallback?: { active: boolean; why: string; auc: number | null; keepPct: number; keptR: number; allR: number };
  /**
   * v17.8: display only — the unseen 30% kept the way the live bot keeps them (backup filling in for missing positioning /
   * rate / mood data); null when no backup passed. `active` and every number above come from the main judge alone.
   */
  withBackup?: { keepPct: number; keptR: number; keptWinPct: number } | null;
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
 * once on the rows entered from `oosFrom` on. v17: a backup model (soft outside feeds blanked) is trained and graded
 * the same way and kept only when it passes its own exam. Returns the model (null when there is too little data) and
 * the report.
 */
export async function trainJudge(rows: readonly JudgeRow[], oosFrom: number, cfg = JUDGE_CONFIG): Promise<{ model: JudgeModel | null; report: JudgeReport }> {
  const ins = rows.filter((r) => doneBefore(r, oosFrom)).sort((a, b) => a.t - b.t).slice(-cfg.maxTrainRows);
  const oos = rows.filter((r) => r.t >= oosFrom);
  const empty = (why: string): { model: null; report: JudgeReport } => ({ model: null, report: { active: false, why, trainedOn: ins.length, tested: oos.length, auc: null, threshold: null, keepPct: 100, allR: r2(avg(oos.map((r) => r.r))), keptR: r2(avg(oos.map((r) => r.r))), skippedR: 0, allWinPct: 0, keptWinPct: 0, importance: [] } });
  if (ins.length < cfg.minTrain) return empty(`needs ${cfg.minTrain} trades from the first 70% to learn from (has ${ins.length})`);
  // v17: blank the features that were often unknown in training (per chart × metal) — in training AND in the exam
  const masks = presenceMasks(ins);
  const masked = (r: JudgeRow): JudgeRow => ({ ...r, x: applyMask(r.x, masks.masked[judgeGroup(r.x)]) });
  return trainMasked(ins.map(masked), oos, masks, cfg);
}

/** boosted trees on the first 70%: the trees learn from rows finished before its newest 20% (watched for early stop) */
async function fitTrees(ins: readonly JudgeRow[], cfg: typeof JUDGE_CONFIG): Promise<{ trees: TreeNode[][]; base: number; gain: Float64Array; cut: number }> {
  const cut = Math.floor(ins.length * 0.8);
  // the trees learn only from trades finished before the newest 20% starts (same purge, one level down)
  const vFrom = ins[cut]?.t ?? Infinity;
  const tr = toMatrix(ins.slice(0, cut).filter((r) => doneBefore(r, vFrom)));
  const va = toMatrix(ins.slice(cut));
  const opts = { ...DEFAULT_TREE_OPTIONS, depth: 3, learningRate: 0.06, rounds: cfg.rounds, minChildWeight: 20, l2: 5, colSample: 0.8, earlyStop: 25 };
  const cuts = cutPoints(tr, opts.bins);
  const fit = await boost(tr, cuts, opts, cfg.rounds, va, 11);
  return { trees: fit.trees, base: fit.base, gain: fit.gain, cut };
}

/**
 * How picky: the keep share that gives the best R × √n on the newest 20% of the first 70%. v17: only rows the model
 * scores (non-null) take part — a signal it can't score live never reaches its threshold. Pure.
 */
export function pickKeep(rows: ReadonlyArray<{ r: number }>, ps: ReadonlyArray<number | null>, shares: readonly number[]): { keep: number; th: number } {
  const sc: Array<{ r: number; p: number }> = [];
  rows.forEach((x, k) => {
    const p = ps[k];
    if (p !== null && p !== undefined) sc.push({ r: x.r, p });
  });
  const vp = sc.map((x) => x.p);
  const score = (keep: number) => {
    const th = quantile(vp, 1 - keep);
    const kept = sc.filter((x) => x.p >= th);
    return { th, s: avg(kept.map((x) => x.r)) * Math.sqrt(kept.length) };
  };
  let best = { keep: 1, th: -Infinity, s: score(1).s };
  for (const k of shares) {
    const sc2 = score(k);
    if (sc2.s > best.s) best = { keep: k, th: sc2.th, s: sc2.s };
  }
  return { keep: best.keep, th: best.th };
}

/** the exam (once) on the unseen 30%: a row is kept when it was scored and reached its own bar; unscorable = not kept */
function exam(oos: readonly JudgeRow[], score: (x: Float64Array) => { p: number; th: number } | null, keep: number, cfg: typeof JUDGE_CONFIG, what = 'all signals') {
  const s = oos.map((r) => score(r.x));
  const a = auc(s.map((v) => (v ? v.p : -Infinity)), oos.map((r) => (r.r > 0 ? 1 : 0)));
  const keptOf = s.map((v) => v !== null && v.p >= v.th);
  const kept = oos.filter((_, k) => keptOf[k]);
  const skipped = oos.filter((_, k) => !keptOf[k]);
  const allR = avg(oos.map((r) => r.r));
  const keptR = avg(kept.map((r) => r.r));
  const pass = keep < 1 && a !== null && a >= cfg.minAuc && keptR >= allR + cfg.minGainR && kept.length >= cfg.minKept;
  const why = keep === 1
    ? 'on the newest part of the first 70% no level of pickiness beat taking every signal'
    : a === null
      ? 'not enough unseen trades to grade it'
      : pass
        ? `on the unseen 30% the trades it keeps made ${r2(keptR)}R each vs ${r2(allR)}R for ${what} (AUC ${r2(a)})`
        : `failed the unseen test: ${[
            a < cfg.minAuc ? `ranking skill (AUC) ${r2(a)}, needs ${cfg.minAuc}` : null,
            keptR < allR + cfg.minGainR ? `the trades it keeps made ${r2(keptR)}R each vs ${r2(allR)}R for ${what}, needs ${cfg.minGainR}R more` : null,
            kept.length < cfg.minKept ? `only ${kept.length} trades kept, needs ${cfg.minKept}` : null,
          ]
            .filter(Boolean)
            .join('; ')}`;
  return { a, kept, skipped, allR, keptR, pass, why };
}

async function trainMasked(ins: readonly JudgeRow[], oos: readonly JudgeRow[], masks: { masked: Record<string, number[]>; required: Record<string, number[]> }, cfg: typeof JUDGE_CONFIG): Promise<{ model: JudgeModel | null; report: JudgeReport }> {
  const main = await fitTrees(ins, cfg);
  // v17: pickiness picked on the validation rows scored the way live scores them (rows it can't score sit out)
  const vrows = ins.slice(main.cut);
  const view0: JudgeModel = { trees: main.trees, base: main.base, threshold: -Infinity, keepShare: 1, ...masks };
  const pick = pickKeep(vrows, vrows.map((r) => judgeView(view0, r.x).p), cfg.keepShares);
  const model: JudgeModel = { trees: main.trees, base: main.base, threshold: pick.th, keepShare: pick.keep, masked: masks.masked, required: masks.required };
  // v17 backup: same rows with the soft outside feeds blanked too, its own pickiness and its own unseen exam
  let fallback: JudgeReport['fallback'];
  if (!Object.values(masks.required).some((req) => req.some(isSoft))) {
    fallback = { active: false, why: 'not needed: no chart relies on positioning, interest-rate or mood data', auc: null, keepPct: 100, keptR: r2(avg(oos.map((r) => r.r))), allR: r2(avg(oos.map((r) => r.r))) };
  } else {
    const fins = ins.map((r) => ({ ...r, x: softMask(r.x, undefined) }));
    const fb = await fitTrees(fins, cfg);
    const fv = fins.slice(fb.cut);
    // its pickiness on the rows it could score live (a missing hard reading sits out, like the main pick)
    const fb0: JudgeFallback = { trees: fb.trees, base: fb.base, threshold: -Infinity, keepShare: 1 };
    const fpick = pickKeep(fv, fv.map((r) => fallbackScore(model, fb0, r.x)), cfg.keepShares);
    const cand: JudgeFallback = { trees: fb.trees, base: fb.base, threshold: fpick.th, keepShare: fpick.keep };
    const fe = exam(oos, (x) => {
      const p = fallbackScore(model, cand, x);
      return p === null ? null : { p, th: cand.threshold };
    }, fpick.keep, cfg, 'all signals (positioning, rate and mood data blanked)');
    if (fe.pass) model.fallback = cand;
    fallback = { active: fe.pass, why: fe.why, auc: fe.a === null ? null : r2(fe.a), keepPct: oos.length ? Math.round((fe.kept.length / oos.length) * 100) : 100, keptR: r2(fe.keptR), allR: r2(fe.allR) };
  }
  // the exam (once) on the unseen 30% — v17.8: the main model alone (unscorable, incl. missing only a soft feed = not
  // kept). The backup was picked on these same rows by its own exam; letting it fill in here would grade on them twice.
  const e = exam(oos, (x) => {
    const v = judgeView(model, x, { backup: false });
    return v.p === null ? null : { p: v.p, th: v.threshold };
  }, pick.keep, cfg);
  // v17.8: display only — what the live bot keeps with the backup filling in (never decides `active`)
  let withBackup: JudgeReport['withBackup'] = null;
  if (model.fallback) {
    const kept = oos.filter((r) => judgeKeeps(model, r.x));
    withBackup = { keepPct: oos.length ? Math.round((kept.length / oos.length) * 100) : 100, keptR: r2(avg(kept.map((r) => r.r))), keptWinPct: kept.length ? Math.round((kept.filter((r) => r.r > 0).length / kept.length) * 100) : 0 };
  }
  const tot = main.gain.reduce((s, g) => s + g, 0) || 1;
  const importance = JUDGE_FEATURES.map((f, k) => ({ feature: f, label: JUDGE_LABEL[f], share: Math.round((main.gain[k]! / tot) * 100) }))
    .filter((x) => x.share > 0)
    .sort((x, y) => y.share - x.share)
    .slice(0, 8);
  return {
    model,
    report: {
      active: e.pass,
      why: e.why,
      trainedOn: ins.length,
      tested: oos.length,
      auc: e.a === null ? null : r2(e.a),
      threshold: Number.isFinite(pick.th) ? r2(pick.th) : null,
      keepPct: oos.length ? Math.round((e.kept.length / oos.length) * 100) : 100,
      allR: r2(e.allR),
      keptR: r2(e.keptR),
      skippedR: r2(avg(e.skipped.map((r) => r.r))),
      allWinPct: oos.length ? Math.round((oos.filter((r) => r.r > 0).length / oos.length) * 100) : 0,
      keptWinPct: e.kept.length ? Math.round((e.kept.filter((r) => r.r > 0).length / e.kept.length) * 100) : 0,
      importance,
      fallback,
      withBackup,
    },
  };
}

function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return -Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
}
