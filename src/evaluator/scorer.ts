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
}

/** Hard rules. Returns the list of rules that FAILED (empty = all passed). */
export function checkEntryRules(i: EntryCheckInput): string[] {
  const { market: m, entry: e, strategy: s } = i;
  const fails: string[] = [];
  if (i.safetyHardFail) fails.push('safety hard fail');
  if (i.safetyScore < e.minSafetyScore) fails.push(`safety ${i.safetyScore} < ${e.minSafetyScore}`);
  if (m.holders < s.minHolders) fails.push(`holders ${m.holders} < ${s.minHolders}`);
  if (m.devHoldingPct > e.maxDevHoldingPct) fails.push(`dev holds ${m.devHoldingPct.toFixed(1)}% > ${e.maxDevHoldingPct}%`);
  if (m.liquiditySol < e.minLiquiditySol) fails.push(`liquidity ${m.liquiditySol.toFixed(2)} SOL < ${e.minLiquiditySol}`);
  const ageMin = m.ageSec / 60;
  if (ageMin < s.entryWindowMinutes.min || ageMin > s.entryWindowMinutes.max) fails.push(`age ${ageMin.toFixed(1)}m outside entry window`);
  if (m.bondingCurvePct < s.curveProgressRange.min || m.bondingCurvePct > s.curveProgressRange.max) {
    fails.push(`curve ${m.bondingCurvePct.toFixed(1)}% outside ${s.curveProgressRange.min}-${s.curveProgressRange.max}%`);
  }
  if (m.complete) fails.push('curve already complete');
  return fails;
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
