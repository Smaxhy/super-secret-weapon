/**
 * Weight optimizer — grid-search over scorer weights to find configurations
 * where high scores actually predict winners.
 *
 * The trade data showed scoring is anti-predictive (score >= 80 → 17.9% WR,
 * score < 80 → 26.0% WR). This script runs through weight variations and
 * measures which ones produce the best risk-adjusted returns AND the highest
 * score↔outcome correlation.
 *
 * Usage:
 *   npx ts-node src/cli/optimize-weights.ts
 *   npx ts-node src/cli/optimize-weights.ts --days 14 --iterations 200
 *   npx ts-node src/cli/optimize-weights.ts --json > results.json
 *
 * Strategy:
 *   1. Load archived tapes (same as the backtester)
 *   2. For each candidate weight vector:
 *      a. Run every tape through the full sim pipeline
 *      b. Measure: PnL, win rate, profit factor, return on risk
 *      c. Measure: score↔outcome correlation (do higher scores = more wins?)
 *   3. Rank candidates by a composite metric (returnOnRisk × correlation)
 *   4. Print the top-N weight vectors with their stats
 *
 * The optimizer uses a mutation-based approach rather than pure random:
 *   - Start from current weights
 *   - Each iteration perturbs 2-4 weights by ±10-30%
 *   - Keep the best candidate as the base for the next round
 *   - This hill-climbs towards good configurations while exploring
 */
import { DEFAULT_WEIGHTS, type FeatureName, type Weights } from '../config/default';
import { prisma } from '../lib/prisma';
import { getSolUsd } from '../lib/sol-price';
import { decodeTape, type TapeRow } from '../learner/tape-archiver';
import {
  currentPolicy,
  runComparison,
  simulateToken,
  summarisePolicy,
  type Policy,
  type PolicyReport,
  type SimResult,
  type SimTrade,
  type TokenMeta,
} from '../learner/backtester';
import type { WalletFeatures } from '../evaluator/wallet-analyzer';
import type { TapeTrade } from '../scanner/live-state';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAYS = Number(arg('days') ?? 7);
const ITERATIONS = Number(arg('iterations') ?? 150);
const TOP_N = Number(arg('top') ?? 10);
const JSON_OUTPUT = process.argv.includes('--json');
const WEIGHT_FLOOR = 0.01;
const WEIGHT_CEILING = 0.25;

// ---------------------------------------------------------------------------
// Token loading (same as backtest CLI)
// ---------------------------------------------------------------------------
async function loadTokens(days: number, limit: number): Promise<Array<{ tape: TapeTrade[]; meta: TokenMeta }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const tapes = await prisma.tokenTape.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: limit });
  const tokens = await prisma.token.findMany({ where: { mint: { in: tapes.map(t => t.mint) } } });
  const byMint = new Map(tokens.map(t => [t.mint, t]));
  const evals = await prisma.evaluation.findMany({ where: { mint: { in: tapes.map(t => t.mint) } }, orderBy: { createdAt: 'asc' }, select: { mint: true, features: true } });
  const walletByMint = new Map<string, WalletFeatures>();
  for (const e of evals) {
    const stored = e.features as { creator?: unknown; features?: Partial<WalletFeatures> } | null;
    const f = stored?.features;
    if (stored?.creator && f && typeof f.creatorLaunches === 'number' && typeof f.creatorSuccess === 'number' && typeof f.funderReuse === 'number' && typeof f.walletAge === 'number') {
      walletByMint.set(e.mint, { creatorLaunches: f.creatorLaunches, creatorSuccess: f.creatorSuccess, funderReuse: f.funderReuse, walletAge: f.walletAge });
    }
  }
  const solUsd = (await getSolUsd().catch(() => null)) ?? 150;
  const out: Array<{ tape: TapeTrade[]; meta: TokenMeta }> = [];
  for (const t of tapes) {
    const tok = byMint.get(t.mint);
    if (!tok || tok.safetyScore === null || tok.safetyHardFail === null) continue;
    out.push({
      tape: decodeTape(t.tape as TapeRow[], t.wallets as string[]),
      meta: {
        mint: t.mint,
        symbol: tok.symbol,
        createdAtMs: tok.createdAt.getTime(),
        creator: tok.creator,
        safetyScore: tok.safetyScore,
        safetyHardFail: tok.safetyHardFail,
        curve: { initialVirtualSolReserves: tok.initialVirtualSolReserves, initialVirtualTokenReserves: tok.initialVirtualTokenReserves, initialRealTokenReserves: tok.initialRealTokenReserves, totalSupply: tok.totalSupply },
        solUsd,
        complete: t.complete || tok.status === 'COMPLETED',
        walletFeatures: walletByMint.get(t.mint),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weight mutation
// ---------------------------------------------------------------------------
const FEATURES = Object.keys(DEFAULT_WEIGHTS) as FeatureName[];

function normalize(w: Weights): Weights {
  const total = FEATURES.reduce((s, f) => s + w[f], 0) || 1;
  const out = { ...w };
  for (const f of FEATURES) out[f] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, out[f] / total));
  // Re-normalize after clamping
  const t2 = FEATURES.reduce((s, f) => s + out[f], 0) || 1;
  for (const f of FEATURES) out[f] = round4(out[f] / t2);
  return out;
}

function mutate(base: Weights, intensity = 0.2): Weights {
  const out = { ...base };
  // Perturb 2-5 random features
  const nMutations = 2 + Math.floor(Math.random() * 4);
  const shuffled = [...FEATURES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < nMutations && i < shuffled.length; i++) {
    const f = shuffled[i]!;
    const delta = (Math.random() * 2 - 1) * intensity;
    out[f] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, out[f] * (1 + delta)));
  }
  return normalize(out);
}

/** Generate a fully random weight vector. */
function randomWeights(): Weights {
  const out = {} as Weights;
  for (const f of FEATURES) out[f] = WEIGHT_FLOOR + Math.random() * (WEIGHT_CEILING - WEIGHT_FLOOR);
  return normalize(out);
}

// ---------------------------------------------------------------------------
// Score-outcome correlation
// ---------------------------------------------------------------------------
/**
 * Measure how well scores predict outcomes. Returns a number -1 to 1 where:
 *   +1 = higher scores always win, lower scores always lose (perfect)
 *   -1 = higher scores always lose (anti-predictive, what we have now)
 *    0 = no relationship
 *
 * Uses point-biserial correlation between score and win/loss (0/1).
 */
function scoreCorrelation(results: SimResult[]): number {
  const trades = results.filter((r): r is SimTrade => r.entered);
  if (trades.length < 10) return 0;

  const scores = trades.map(t => t.score);
  const outcomes = trades.map(t => t.pnlSol > 0 ? 1 : 0);
  const n = scores.length;
  const meanScore = scores.reduce((a, b) => a + b, 0) / n;
  const meanOutcome = outcomes.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denomScore = 0;
  let denomOutcome = 0;
  for (let i = 0; i < n; i++) {
    const ds = scores[i]! - meanScore;
    const dw = outcomes[i]! - meanOutcome;
    num += ds * dw;
    denomScore += ds * ds;
    denomOutcome += dw * dw;
  }
  const denom = Math.sqrt(denomScore * denomOutcome);
  return denom > 0 ? num / denom : 0;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
interface CandidateResult {
  weights: Weights;
  report: PolicyReport;
  correlation: number;
  /** Composite score: combines return on risk with correlation. */
  composite: number;
}

function evaluateCandidate(
  tokens: Array<{ tape: TapeTrade[]; meta: TokenMeta }>,
  weights: Weights,
  name: string,
  thresholds: number[] = [60, 65, 70],
): CandidateResult {
  // Try each threshold and pick the best
  let best: CandidateResult | null = null;

  for (const threshold of thresholds) {
    const policy = currentPolicy({ name: `${name}@th${threshold}`, weights, threshold });
    const results = tokens.map(t => simulateToken(t.tape, t.meta, policy));
    const report = summarisePolicy(policy.name, results);
    const corr = scoreCorrelation(results);

    // Composite: we want both profitability AND predictive scoring
    // returnOnRisk = PnL / capital risked (the efficiency of capital use)
    // correlation = how well scores predict wins (we NEED this to be positive)
    const ror = report.returnOnRisk ?? -1;
    const pf = report.profitFactor ?? 0;
    const wr = (report.winRate ?? 0) / 100;

    // Heavily penalize negative correlation (anti-predictive = useless scoring)
    const corrBonus = corr > 0 ? corr * 2 : corr * 4;
    // Reward profit factor above 1 (breakeven), heavily reward above 1.5
    const pfBonus = pf > 1 ? (pf - 1) * 0.5 : (pf - 1) * 2;
    // Win rate bonus
    const wrBonus = wr > 0.35 ? (wr - 0.35) * 3 : (wr - 0.35) * 1;

    const composite = ror + corrBonus + pfBonus + wrBonus;

    const candidate: CandidateResult = { weights, report, correlation: corr, composite };
    if (!best || composite > best.composite) best = candidate;
  }

  return best!;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!JSON_OUTPUT) {
    console.log(`\n🔬 Weight Optimizer`);
    console.log(`   Loading tapes from last ${DAYS} days...`);
  }

  const tokens = await loadTokens(DAYS, 3000);
  if (tokens.length === 0) {
    console.error('No archived tapes found. Let the bot run for a while first.');
    return;
  }
  if (!JSON_OUTPUT) console.log(`   ${tokens.length} tapes loaded. Running ${ITERATIONS} iterations...\n`);

  // Start from current weights as baseline
  const baseline = evaluateCandidate(tokens, { ...DEFAULT_WEIGHTS }, 'baseline');
  if (!JSON_OUTPUT) {
    console.log(`Baseline: PnL ${baseline.report.pnlSol.toFixed(4)} SOL | WR ${baseline.report.winRate?.toFixed(1)}% | PF ${baseline.report.profitFactor?.toFixed(2)} | Corr ${baseline.correlation.toFixed(3)} | Composite ${baseline.composite.toFixed(3)}`);
    console.log(`─────────────────────────────────────────────────`);
  }

  const candidates: CandidateResult[] = [baseline];
  let bestSoFar = baseline;
  let stagnation = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    let candidate: CandidateResult;

    if (i < 10 || stagnation > 15) {
      // Exploration: fully random weights or large perturbation
      const w = i % 3 === 0 ? randomWeights() : mutate(bestSoFar.weights, 0.4);
      candidate = evaluateCandidate(tokens, w, `rand-${i}`);
      if (stagnation > 15) stagnation = 0;
    } else {
      // Exploitation: small perturbation from the best so far
      const w = mutate(bestSoFar.weights, 0.15);
      candidate = evaluateCandidate(tokens, w, `mut-${i}`);
    }

    candidates.push(candidate);

    if (candidate.composite > bestSoFar.composite) {
      bestSoFar = candidate;
      stagnation = 0;
      if (!JSON_OUTPUT) {
        console.log(`[${i + 1}/${ITERATIONS}] ★ New best: PnL ${candidate.report.pnlSol.toFixed(4)} | WR ${candidate.report.winRate?.toFixed(1)}% | PF ${candidate.report.profitFactor?.toFixed(2)} | Corr ${candidate.correlation.toFixed(3)} | Comp ${candidate.composite.toFixed(3)}`);
      }
    } else {
      stagnation++;
      if (!JSON_OUTPUT && (i + 1) % 20 === 0) {
        console.log(`[${i + 1}/${ITERATIONS}]   ...searching (stagnation ${stagnation})`);
      }
    }
  }

  // Sort by composite and show top N
  candidates.sort((a, b) => b.composite - a.composite);
  const topN = candidates.slice(0, TOP_N);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      tapes: tokens.length,
      days: DAYS,
      iterations: ITERATIONS,
      baseline: { pnl: baseline.report.pnlSol, winRate: baseline.report.winRate, profitFactor: baseline.report.profitFactor, correlation: baseline.correlation, composite: baseline.composite, weights: baseline.weights },
      top: topN.map(c => ({
        pnl: c.report.pnlSol,
        trades: c.report.trades,
        winRate: c.report.winRate,
        profitFactor: c.report.profitFactor,
        returnOnRisk: c.report.returnOnRisk,
        maxDrawdown: c.report.maxDrawdownSol,
        correlation: c.correlation,
        composite: c.composite,
        weights: c.weights,
        byExitReason: c.report.byExitReason,
      })),
    }, null, 2));
    return;
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`   TOP ${TOP_N} WEIGHT CONFIGURATIONS`);
  console.log(`═══════════════════════════════════════════════\n`);

  for (let i = 0; i < topN.length; i++) {
    const c = topN[i]!;
    const r = c.report;
    console.log(`#${i + 1} — ${r.policy}`);
    console.log(`   PnL: ${r.pnlSol.toFixed(4)} SOL | Trades: ${r.trades} | Win Rate: ${r.winRate?.toFixed(1)}%`);
    console.log(`   Profit Factor: ${r.profitFactor?.toFixed(2)} | Return/Risk: ${r.returnOnRisk?.toFixed(3)} | Max DD: ${r.maxDrawdownSol.toFixed(4)} SOL`);
    console.log(`   Score↔Outcome Correlation: ${c.correlation.toFixed(3)} (${c.correlation > 0.1 ? '✅ predictive' : c.correlation > 0 ? '⚠️  weak' : '❌ anti-predictive'})`);
    console.log(`   Composite: ${c.composite.toFixed(3)}`);

    // Show weight differences from baseline
    const diffs = FEATURES
      .map(f => ({ f, from: DEFAULT_WEIGHTS[f], to: c.weights[f], delta: c.weights[f] - DEFAULT_WEIGHTS[f] }))
      .filter(d => Math.abs(d.delta) > 0.005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    if (diffs.length) {
      console.log(`   Weight changes from baseline:`);
      for (const d of diffs.slice(0, 8)) {
        const arrow = d.delta > 0 ? '↑' : '↓';
        console.log(`     ${d.f.padEnd(18)} ${d.from.toFixed(3)} → ${d.to.toFixed(3)} ${arrow} ${(d.delta > 0 ? '+' : '')}${(d.delta * 100).toFixed(1)}%`);
      }
    }
    console.log('');
  }

  // Summary recommendation
  const winner = topN[0]!;
  console.log(`═══════════════════════════════════════════════`);
  console.log(`RECOMMENDATION: Use config #1`);
  console.log(`   Copy these weights to DEFAULT_WEIGHTS in src/config/default.ts`);
  console.log(`   or apply them via the daily adjuster's weight snapshot.\n`);
  console.log(`Weights JSON:`);
  console.log(JSON.stringify(winner.weights, null, 2));
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
