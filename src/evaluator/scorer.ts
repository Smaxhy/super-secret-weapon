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
  /** Soon / migrated rules (replace the matching general minimums for those strategies). */
  focus?: BotConfigShape['focus'];
  /** Crowd numbers from the live trade log (null = no log for this coin yet). */
  crowd?: { activeWallets5m: number; fakeVolumePct?: number; trades5m?: number } | null;
}

/**
 * Conviction sizing (×min…×max of the normal size). Pure.
 *  - score margin over the bar: at the bar ×0.6, +10 → ×1.0, +20 → ×1.4
 *  - calibration: the score band's real win rate vs average (×0.7–1.3)
 *  - crowd behaviour: ×0.85 (bad) – ×1.15 (great)
 */
export function convictionFactor(i: { scoreMargin: number; calibrationFactor: number; crowdScore: number | null; min: number; max: number }): { factor: number; note: string } {
  const s = Math.max(0.6, Math.min(1.4, 0.6 + i.scoreMargin / 25));
  const c = i.crowdScore === null ? 1 : 0.85 + 0.3 * i.crowdScore;
  const f = Math.round(Math.max(i.min, Math.min(i.max, s * i.calibrationFactor * c)) * 100) / 100;
  const bits = [`score ${i.scoreMargin >= 0 ? '+' : ''}${i.scoreMargin.toFixed(0)} over the bar`];
  if (i.calibrationFactor !== 1) bits.push(`band record ×${i.calibrationFactor}`);
  if (i.crowdScore !== null) bits.push(`crowd ${i.crowdScore.toFixed(2)}`);
  return { factor: f, note: `size ×${f} conviction (${bits.join(', ')})` };
}

export interface ManipulationInput {
  trades5m: number;
  fakeVolumePct: number;
  bundledBuyPct: number;
  top3VolumePct: number;
  dustTradePct: number;
  priceChange3mPct: number | null;
}

/**
 * Fake volume, bundles, a few wallets making all the volume, buying a vertical
 * candle. Over the limits → rule failures (no buy). Under them → score points
 * off, so manipulated coins can't score high just because their numbers look
 * busy. Pure.
 */
export function manipulationCheck(c: ManipulationInput | null | undefined, lim: BotConfigShape['entry']['manipulation'] | undefined): { fails: string[]; penalty: number; notes: string[] } {
  const out = { fails: [] as string[], penalty: 0, notes: [] as string[] };
  if (!c || !lim || c.trades5m < 10) return out;
  if (c.fakeVolumePct > lim.maxFakeVolumePct) out.fails.push(`fake volume ~${c.fakeVolumePct.toFixed(0)}% (wash trading)`);
  else if (c.fakeVolumePct > 15) {
    out.penalty += Math.min(7, (c.fakeVolumePct - 15) * 0.2);
    out.notes.push(`fake volume ~${c.fakeVolumePct.toFixed(0)}%`);
  }
  if (c.bundledBuyPct > lim.maxBundledBuyPct) out.fails.push(`bundled buys ${c.bundledBuyPct.toFixed(0)}% of buying`);
  else if (c.bundledBuyPct > 10) {
    out.penalty += Math.min(5, (c.bundledBuyPct - 10) * 0.25);
    out.notes.push(`bundled buys ${c.bundledBuyPct.toFixed(0)}%`);
  }
  if (c.trades5m >= 20 && c.top3VolumePct > lim.maxTop3VolumePct) out.fails.push(`${c.top3VolumePct.toFixed(0)}% of volume from 3 wallets`);
  if (c.priceChange3mPct !== null && c.priceChange3mPct > lim.chasePct) {
    out.penalty += 8;
    out.notes.push(`up ${c.priceChange3mPct.toFixed(0)}% in 3 min (chasing)`);
  } else if (c.priceChange3mPct !== null && c.priceChange3mPct > lim.chasePct / 2) {
    out.penalty += 4;
    out.notes.push(`up ${c.priceChange3mPct.toFixed(0)}% in 3 min`);
  }
  if (c.dustTradePct > 60) {
    out.penalty += 3;
    out.notes.push(`${c.dustTradePct.toFixed(0)}% dust trades (tx bots)`);
  }
  out.penalty = Math.round(Math.min(15, out.penalty) * 10) / 10;
  return out;
}

/** The entry minimums that apply to this strategy (focus rules override the general ones). */
export function strategyMinimums(e: BotConfigShape['entry'], focus: BotConfigShape['focus'] | undefined, strategy: string) {
  const fr = strategy === 'SOON' ? focus?.soon : strategy === 'MIGRATION_MOMENTUM' ? focus?.migrated : undefined;
  return {
    minTotalFeesSol: fr?.minTotalFeesSol ?? e.minTotalFeesSol,
    minMarketCapUsd: fr?.minMarketCapUsd ?? e.minMarketCapUsd,
    minVolumeUsd: fr && 'minVolumeUsd' in fr ? fr.minVolumeUsd : e.minVolumeUsd,
    minLiquidityUsd: fr && 'minLiquidityUsd' in fr ? fr.minLiquidityUsd : 0,
    minActiveWallets5m: fr?.minActiveWallets5m ?? 0,
    curveRange: strategy === 'SOON' && focus ? { min: focus.soon.minCurvePct, max: focus.soon.maxCurvePct } : null,
  };
}

/** Hard rules. Returns the list of rules that FAILED (empty = all passed). */
export function checkEntryRules(i: EntryCheckInput): string[] {
  const { market: m, entry: e, strategy: s } = i;
  const mins = strategyMinimums(e, i.focus, s.name);
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
  if (e.minAgeSec && m.ageSec < e.minAgeSec) fails.push(`too young (${m.ageSec}s < ${e.minAgeSec}s)`);
  const ageMin = m.ageSec / 60;
  if (ageMin < s.entryWindowMinutes.min || ageMin > s.entryWindowMinutes.max) fails.push(`age ${ageMin.toFixed(1)}m outside entry window`);
  const range = mins.curveRange ?? s.curveProgressRange;
  if (m.bondingCurvePct < range.min || m.bondingCurvePct > range.max) {
    fails.push(`curve ${m.bondingCurvePct.toFixed(1)}% outside ${range.min}-${range.max}%`);
  }
  if (m.complete && (s.name === 'CURVE_SNIPE' || s.name === 'SOON')) fails.push('curve already complete');
  // Migration plays need a live PumpSwap price; copy trades too once the token migrated.
  if ((s.name === 'MIGRATION_MOMENTUM' || m.complete) && s.name !== 'CURVE_SNIPE' && s.name !== 'SOON' && !m.onAmm) fails.push('waiting for PumpSwap pool');
  if (mins.minLiquidityUsd > 0 && m.liquidityUsd !== null && m.liquidityUsd < mins.minLiquidityUsd) fails.push(`liquidity $${Math.round(m.liquidityUsd)} < $${mins.minLiquidityUsd}`);
  // "Eyes on the coin": different wallets trading in the last 5 minutes.
  if (mins.minActiveWallets5m > 0) {
    const n = i.crowd?.activeWallets5m ?? 0;
    if (n < mins.minActiveWallets5m) fails.push(`only ${n} active wallets in 5m (< ${mins.minActiveWallets5m})`);
  }
  if (i.social?.blockedKeyword) fails.push(`blocked keyword "${i.social.blockedKeyword}"`);
  if (e.requireTwitter && !i.social?.hasTwitter) fails.push(i.social ? 'no X link' : 'socials not checked yet');
  if (m.totalFeesSol < mins.minTotalFeesSol) fails.push(`fees ${m.totalFeesSol.toFixed(2)} SOL < ${mins.minTotalFeesSol}`);
  // Fail closed: without a SOL price we can't verify the USD minimums.
  if (m.volumeUsd === null || m.marketCapUsd === null) fails.push('SOL/USD price unknown');
  else {
    // Volume minus what the live log says is fake (wash trading / volume bots).
    const fake = (i.crowd?.trades5m ?? 0) >= 10 ? Math.min(90, i.crowd?.fakeVolumePct ?? 0) : 0;
    const organic = m.volumeUsd * (1 - fake / 100);
    if (organic < mins.minVolumeUsd) fails.push(`${fake >= 10 ? 'organic ' : ''}volume $${Math.round(organic)} < $${mins.minVolumeUsd}`);
    if (m.marketCapUsd < mins.minMarketCapUsd) fails.push(`MC $${Math.round(m.marketCapUsd)} < $${mins.minMarketCapUsd}`);
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
