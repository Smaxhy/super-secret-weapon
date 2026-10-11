/**
 * Evaluator — decides, for every new token, whether the bot would buy it.
 *
 * Each token gets re-evaluated at a series of checkpoints after launch
 * (20s, 45s, 90s, 3m, 5m, 8m, 12m, 15m by default). At each one:
 *
 *   1. Safety result (from the safety checker). Hard fail → REJECT, stop.
 *   2. Market analysis from live state (free, no RPC): holders, flow, and the
 *      chart read from the trade tape (trend, structure, buyer quality).
 *   3. Pre-score with neutral wallet features + the learned pattern prior.
 *   4. Only if the entry rules pass AND the pre-score is close to the
 *      threshold: run the wallet analyzer (costs RPC credits) and re-score.
 *   5. Timing: a token that is a buy on every count except *right now*
 *      (vertical candle, thin tape) gets re-checked in 15/30/45s instead of
 *      waiting for the next fixed checkpoint — that's how we buy the pullback
 *      rather than the top.
 *   6. BUY → hand to the Trader. Otherwise wait for the next checkpoint.
 *
 * The threshold moves with the market regime (stricter when things are cold or
 * rug-heavy, a little looser when the tape is hot).
 *
 * To keep the database lean, an Evaluation row is stored only for BUYs,
 * REJECTs, "interesting" scores (≥ 60) and each token's final checkpoint.
 */
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import { getConfig, getWeights } from '../config/runtime-config';
import { STRATEGIES } from '../config/strategies';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { evaluateQueue, QUEUE_NAMES, type EvaluateJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import type { Trader } from '../executor/trader';
import type { BeliefStore } from '../learner/bayesian-updater';
import { patternsFor } from '../learner/bayesian-updater';
import { regimeAdjustment } from '../learner/regime-detector';
import type { LiveState } from '../scanner/live-state';
import { getSolUsd } from '../lib/sol-price';
import { analyzeMarket, type PrevCheckpoint } from './market-analyzer';
import { roundTripCostPct } from './price-action';
import { checkEntryRules, checkTimingRules, decide, isTimingReason, scoreFeatures, type FeatureVector } from './scorer';
import { NEUTRAL_WALLET_FEATURES, walletFeatures, type CreatorProfile, type WalletAnalyzer } from './wallet-analyzer';

const log = moduleLogger('evaluator');
const STATE_TTL_SECONDS = 60 * 60;

/** Phase 2 runs the curve-snipe strategy; the other two arrive in Phase 6. */
const STRATEGY = STRATEGIES.CURVE_SNIPE;

export class Evaluator {
  private worker: Worker<EvaluateJob> | null = null;
  readonly stats = { evaluated: 0, buys: 0, rejects: 0, walletLookups: 0, rechecks: 0, timingWaits: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly wallets: WalletAnalyzer,
    private readonly trader: Trader,
    private readonly beliefs: BeliefStore | null = null,
  ) {}

  /** Queue every checkpoint for a newly launched token. */
  async scheduleFor(mint: string, createdAtMs: number): Promise<void> {
    const cps = getConfig().scoring.checkpointsSec;
    const now = Date.now();
    await evaluateQueue.addBulk(
      cps.map((sec, i) => ({
        name: `t+${sec}s`,
        data: { mint, checkpointSec: sec, final: i === cps.length - 1 },
        opts: { jobId: `${mint}-eval-${sec}`, delay: Math.max(0, createdAtMs + sec * 1000 - now) },
      })),
    );
  }

  /** Look again soon — the setup was right, the moment wasn't. */
  private async scheduleRecheck(mint: string, fromCheckpointSec: number, idx: number): Promise<boolean> {
    const delays = getConfig().scoring.recheckDelaysSec;
    const delay = delays[idx];
    if (delay === undefined) return false;
    await evaluateQueue.add(
      `recheck+${delay}s`,
      { mint, checkpointSec: fromCheckpointSec + delay, final: false, recheck: idx },
      { jobId: `${mint}-recheck-${fromCheckpointSec}-${idx}`, delay: delay * 1000 },
    );
    this.stats.rechecks++;
    return true;
  }

  start(concurrency = 8): void {
    this.worker = new Worker<EvaluateJob>(QUEUE_NAMES.evaluate, (job) => this.process(job), { connection: bullConnection(), concurrency });
    this.worker.on('failed', (job, err) => log.warn({ mint: job?.data.mint, err: err.message }, 'evaluation failed'));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<EvaluateJob>): Promise<void> {
    const { mint, checkpointSec, final, recheck } = job.data;
    const doneKey = `eval:${mint}:done`;
    if (await this.redis.exists(doneKey)) return;
    const markDone = () => this.redis.set(doneKey, '1', 'EX', STATE_TTL_SECONDS);

    const token = await prisma.token.findUnique({ where: { mint }, select: { symbol: true, creator: true, safetyScore: true, safetyHardFail: true } });
    if (!token) return;
    // Safety check not finished yet — try again at the next checkpoint.
    if (token.safetyScore === null || token.safetyHardFail === null) return;

    const view = await this.liveState.read(mint);
    if (!view) return void (await markDone());

    const cfg = getConfig();
    const { weights, version } = getWeights();
    const prevKey = `eval:${mint}:prev`;
    const prevRaw = await this.redis.get(prevKey);
    const prev = prevRaw ? (JSON.parse(prevRaw) as PrevCheckpoint) : null;

    const market = analyzeMarket(view, prev, await getSolUsd());
    // Re-checks are seconds apart; keep the checkpoint-to-checkpoint velocity baseline.
    if (recheck === undefined) {
      await this.redis.set(prevKey, JSON.stringify({ atMs: Date.now(), bondingCurvePct: market.raw.bondingCurvePct } satisfies PrevCheckpoint), 'EX', STATE_TTL_SECONDS);
    }
    this.stats.evaluated++;

    const regime = regimeAdjustment();
    const threshold = cfg.entry.minCombinedScore + regime.scoreThresholdDelta;
    const ruleFails = checkEntryRules({ safetyScore: token.safetyScore, safetyHardFail: token.safetyHardFail, market: market.raw, strategy: STRATEGY, entry: cfg.entry });
    const timingFails = checkTimingRules(market.raw, cfg.entry, roundTripCostPct(cfg.paper.curveFeeBps, cfg.paper.slippagePct));

    let profile: CreatorProfile | null = null;
    let patterns = patternsFor(market.raw, null);
    let features: FeatureVector = { safety: token.safetyScore / 100, ...market.features, ...NEUTRAL_WALLET_FEATURES, patternPrior: this.beliefs?.prior(patterns) ?? 0.5 };
    let result = scoreFeatures(features, weights);

    if (!token.safetyHardFail && ruleFails.length === 0 && result.score >= threshold - cfg.scoring.walletAnalysisMargin) {
      profile = await this.wallets.analyze(token.creator, mint);
      this.stats.walletLookups++;
      patterns = patternsFor(market.raw, profile);
      features = { ...features, ...walletFeatures(profile), patternPrior: this.beliefs?.prior(patterns) ?? 0.5 };
      result = scoreFeatures(features, weights);
    }

    const { decision, reasons } = decide(result.score, threshold, [...ruleFails, ...timingFails], token.safetyHardFail);
    // Everything passed except the moment → a timing wait, not a real skip.
    const timingOnly = decision === 'SKIP' && reasons.length > 0 && reasons.every(isTimingReason);
    const store = decision !== 'SKIP' || final || result.score >= cfg.scoring.storeAboveScore;

    let evaluationId: string | null = null;
    if (store) {
      const row = await prisma.evaluation.create({
        data: {
          mint,
          strategy: STRATEGY.name,
          safetyScore: token.safetyScore,
          walletScore: profile ? avg(walletFeatures(profile)) * 100 : null,
          marketScore: avg(market.features) * 100,
          combinedScore: result.score,
          decision,
          reasons,
          features: json({ checkpointSec, recheck: recheck ?? null, features, contributions: result.contributions, market: market.raw, creator: profile, patterns, threshold, regime: regime.regime }),
          weightsVersion: version,
          regime: regime.regime,
        },
      });
      evaluationId = row.id;
      bus.publish({ type: 'evaluation', data: { mint, symbol: token.symbol, score: result.score, decision, reasons } });
      await prisma.token.update({ where: { mint }, data: { combinedScore: result.score } });
    }

    if (decision === 'REJECT') {
      this.stats.rejects++;
      await markDone();
      return;
    }
    if (market.raw.complete) return void (await markDone());

    if (decision === 'BUY') {
      this.stats.buys++;
      const pa = market.raw;
      log.info(
        { mint, symbol: token.symbol, score: result.score, checkpointSec, holders: pa.holders, curvePct: +pa.bondingCurvePct.toFixed(1), setup: pa.setup, trend: +pa.trendSlopePctPerMin.toFixed(2), ddAth: +pa.drawdownFromAthPct.toFixed(1), buyers60: pa.uniqueBuyers60, regime: regime.regime },
        `🎯 BUY signal ${token.symbol} (${result.score.toFixed(1)}, ${pa.setup}${recheck !== undefined ? ', on re-check' : ''})`,
      );
      const res = await this.trader.tryEnter({
        mint,
        symbol: token.symbol,
        strategy: STRATEGY.name,
        evaluationId,
        score: result.score,
        threshold,
        market: market.raw,
        maxSlippageBps: STRATEGY.maxSlippageBps,
        features,
      });
      // Entered, or permanently impossible → stop evaluating. Capacity issues → retry next checkpoint.
      if (res.entered || res.reason === 'already traded this token') await markDone();
    } else if (timingOnly && !final) {
      this.stats.timingWaits++;
      const next = (recheck ?? -1) + 1;
      const scheduled = await this.scheduleRecheck(mint, checkpointSec, next);
      log.debug({ mint, symbol: token.symbol, score: result.score, reasons, recheckIn: scheduled ? cfg.scoring.recheckDelaysSec[next] : null }, `⏳ ${token.symbol} ${result.score.toFixed(1)} — ${reasons[0]}`);
    } else if (result.score >= cfg.scoring.storeAboveScore) {
      log.debug({ mint, symbol: token.symbol, score: result.score, reasons }, `👀 ${token.symbol} ${result.score.toFixed(1)} — ${reasons[0]}`);
    }
    if (final) await markDone();
  }
}

function avg(o: Record<string, number>): number {
  const v = Object.values(o);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function json(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
