/**
 * Scorer — turns all signals into one number and a decision.
 *
 *   combined score = 100 × Σ(weight × feature) / Σ(weight)
 *
 * Every feature is 0-1 (1 = good), so the score is 0-100. The weights live in
 * config (DEFAULT_WEIGHTS, later tuned by the learner).
 *
 * The score alone never buys anything. A token must ALSO pass every hard
 * entry rule (safety minimum, holder minimum, dev %, liquidity, strategy
 * window). Each failed rule becomes a human-readable reason that's stored
 * with the evaluation, so you can always see why the bot passed on something.
 */
import type { Decision } from '@prisma/client';
import type { BotConfigShape, FeatureName, Weights } from '../config/default';
import type { StrategyParams } from '../config/strategies';
import type { MarketRaw } from './market-analyzer';

export type FeatureVector = Record<FeatureName, number>;

export interface ScoreResult {
  score: number;
  /** Points each feature contributed (sums to `score`) — explains the score. */
  contributions: Record<FeatureName, number>;
}

export function scoreFeatures(f: FeatureVector, w: Weights): ScoreResult {
  const names = Object.keys(w) as FeatureName[];
  const totalWeight = names.reduce((s, n) => s + Math.max(0, w[n]), 0) || 1;
  const contributions = {} as Record<FeatureName, number>;
  let score = 0;
  for (const n of names) {
    const c = (100 * Math.max(0, w[n]) * clamp01(f[n] ?? 0)) / totalWeight;
    contributions[n] = round2(c);
    score += c;
  }
  return { score: round2(score), contributions };
}

export interface EntryCheckInput {
  safetyScore: number;
  safetyHardFail: boolean;
  market: MarketRaw;
  strategy: StrategyParams;
  entry: BotConfigShape['entry'];
  /** From the metadata file. undefined = not fetched yet. */
  social?: { hasTwitter: boolean; blockedKeyword: string | null };
}

/** Hard rules. Returns the list of rules that FAILED (empty = all passed). */
export function checkEntryRules(i: EntryCheckInput): string[] {
  const { market: m, entry: e, strategy: s } = i;
  const fails: string[] = [];
  if (i.safetyHardFail) fails.push('safety hard fail');
  if (i.safetyScore < e.minSafetyScore) fails.push(`safety ${i.safetyScore} < ${e.minSafetyScore}`);
  if (m.holders < s.minHolders) fails.push(`holders ${m.holders} < ${s.minHolders}`);
  if (m.devHoldingPct > e.maxDevHoldingPct) fails.push(`dev holds ${m.devHoldingPct.toFixed(1)}% > ${e.maxDevHoldingPct}%`);
  // Anti-rug: concentrated supply means a few wallets can crash the price at will.
  if (m.earlyBuyerPct > e.maxBundlePct) fails.push(`bundlers hold ${m.earlyBuyerPct.toFixed(1)}% > ${e.maxBundlePct}%`);
  if (m.top10HolderPct > e.maxTop10Pct) fails.push(`top 10 hold ${m.top10HolderPct.toFixed(1)}% > ${e.maxTop10Pct}%`);
  if (m.maxHolderPct > e.maxSingleHolderPct) fails.push(`one wallet holds ${m.maxHolderPct.toFixed(1)}% > ${e.maxSingleHolderPct}%`);
  if (m.devSoldFraction > e.maxDevSoldFraction) fails.push(`dev sold ${(m.devSoldFraction * 100).toFixed(0)}% of their bag`);
  if (m.liquiditySol < e.minLiquiditySol) fails.push(`liquidity ${m.liquiditySol.toFixed(2)} SOL < ${e.minLiquiditySol}`);
  const ageMin = m.ageSec / 60;
  if (ageMin < s.entryWindowMinutes.min || ageMin > s.entryWindowMinutes.max) fails.push(`age ${ageMin.toFixed(1)}m outside entry window`);
  if (m.bondingCurvePct < s.curveProgressRange.min || m.bondingCurvePct > s.curveProgressRange.max) {
    fails.push(`curve ${m.bondingCurvePct.toFixed(1)}% outside ${s.curveProgressRange.min}-${s.curveProgressRange.max}%`);
  }
  if (m.complete && s.name === 'CURVE_SNIPE') fails.push('curve already complete');
  // Migration plays need a live PumpSwap price; copy trades too once the token migrated.
  if ((s.name === 'MIGRATION_MOMENTUM' || m.complete) && s.name !== 'CURVE_SNIPE' && !m.onAmm) fails.push('waiting for PumpSwap pool');
  if (i.social?.blockedKeyword) fails.push(`blocked keyword "${i.social.blockedKeyword}"`);
  if (e.requireTwitter && !i.social?.hasTwitter) fails.push(i.social ? 'no X link' : 'socials not checked yet');
  if (m.totalFeesSol < e.minTotalFeesSol) fails.push(`fees ${m.totalFeesSol.toFixed(2)} SOL < ${e.minTotalFeesSol}`);
  // Fail closed: without a SOL price we can't verify the USD minimums.
  if (m.volumeUsd === null || m.marketCapUsd === null) fails.push('SOL/USD price unknown');
  else {
    if (m.volumeUsd < e.minVolumeUsd) fails.push(`volume $${Math.round(m.volumeUsd)} < $${e.minVolumeUsd}`);
    if (m.marketCapUsd < e.minMarketCapUsd) fails.push(`MC $${Math.round(m.marketCapUsd)} < $${e.minMarketCapUsd}`);
  }
  return fails;
}

export interface PatternBelief {
  pattern: string;
  alpha: number;
  beta: number;
  observations: number;
}

export interface OddsOptions {
  minSamples: number;
  priorStrength: number;
  maxPoints: number;
  pointsPerLogit: number;
}

export interface LearnedOdds {
  /** Score points to add (−maxPoints…+maxPoints). */
  points: number;
  /** Pooled (shrunk) win rate of the matching patterns, 0-1. */
  winRate: number;
  /** Overall win rate (the prior), 0-1. */
  priorRate: number;
  /** Largest single pattern sample count behind it. */
  n: number;
  patterns: string[];
}

/**
 * Learned odds → score points. Pure.
 *
 * For each matching pattern with enough samples, its win rate is shrunk
 * toward the overall rate (`priorStrength` pseudo-samples), turned into a
 * log-odds difference vs the overall rate, and the differences are averaged
 * (weighted by sample count). × pointsPerLogit, capped at ±maxPoints.
 * null = nothing qualified (no adjustment).
 */
export function learnedOddsAdjustment(matched: string[], beliefs: ReadonlyMap<string, PatternBelief>, prior: PatternBelief | undefined, o: OddsOptions): LearnedOdds | null {
  if (!prior || prior.alpha + prior.beta <= 2) return null;
  const priorRate = clampRate(prior.alpha / (prior.alpha + prior.beta));
  let sumW = 0;
  let sumDelta = 0;
  let sumRate = 0;
  let n = 0;
  const used: string[] = [];
  for (const name of matched) {
    const b = beliefs.get(name);
    if (!b || b.observations < o.minSamples) continue;
    // alpha/beta start at 1 each (uniform prior) — strip that, then shrink toward the overall rate.
    const wins = Math.max(0, b.alpha - 1);
    const total = Math.max(0, b.alpha + b.beta - 2);
    const rate = clampRate((wins + o.priorStrength * priorRate) / (total + o.priorStrength));
    const delta = logit(rate) - logit(priorRate);
    const w = b.observations;
    sumW += w;
    sumDelta += w * delta;
    sumRate += w * rate;
    n = Math.max(n, b.observations);
    used.push(name);
  }
  if (!sumW) return null;
  const points = Math.max(-o.maxPoints, Math.min(o.maxPoints, (sumDelta / sumW) * o.pointsPerLogit));
  return { points: round2(points), winRate: sumRate / sumW, priorRate, n, patterns: used };
}

/** Add the learned-odds points to a score (kept within 0-100). Pure. */
export function withOdds(r: ScoreResult, odds: LearnedOdds | null): ScoreResult {
  if (!odds || !odds.points) return r;
  return { ...r, score: Math.round(Math.max(0, Math.min(100, r.score + odds.points)) * 100) / 100 };
}

function clampRate(p: number): number {
  return Math.max(0.001, Math.min(0.999, p));
}
function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export function decide(score: number, threshold: number, ruleFails: string[], hardFail: boolean): { decision: Decision; reasons: string[] } {
  if (hardFail) return { decision: 'REJECT', reasons: ruleFails };
  const reasons = [...ruleFails];
  if (score < threshold) reasons.push(`score ${score.toFixed(1)} < ${threshold}`);
  return reasons.length === 0
    ? { decision: 'BUY', reasons: [`score ${score.toFixed(1)} ≥ ${threshold} and all entry rules passed`] }
    : { decision: 'SKIP', reasons };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
