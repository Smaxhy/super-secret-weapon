/**
 * Evaluator — decides, for every new token, whether the bot would buy it.
 *
 * Each token gets re-evaluated at a series of checkpoints after launch
 * (20s, 45s, 90s, 3m, 5m, 8m, 12m, 15m by default). At each one:
 *
 *   1. Safety result (from the safety checker). Hard fail → REJECT, stop.
 *   2. Market analysis from live state (free, no RPC).
 *   3. Pre-score with neutral wallet features.
 *   4. Only if the entry rules pass AND the pre-score is close to the
 *      threshold: run the wallet analyzer (costs RPC credits) and re-score.
 *   5. BUY → hand to the Trader. Otherwise wait for the next checkpoint.
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
import { evaluateQueue, QUEUE_NAMES, safetyQueue, type EvaluateJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import type { Trader } from '../executor/trader';
import type { LiveState } from '../scanner/live-state';
import { getSolUsd } from '../lib/sol-price';
import { FeeEstimator } from './fee-estimator';
import { keywordCheck, NEUTRAL_SOCIAL_FEATURES, SocialAnalyzer, socialsScore, twitterInfo } from './social-analyzer';
import { analyzeMarket, type PrevCheckpoint } from './market-analyzer';
import { checkEntryRules, decide, scoreFeatures, type FeatureVector } from './scorer';
import { NEUTRAL_WALLET_FEATURES, walletFeatures, type CreatorProfile, type WalletAnalyzer } from './wallet-analyzer';

const log = moduleLogger('evaluator');
const STATE_TTL_SECONDS = 60 * 60;


export class Evaluator {
  private worker: Worker<EvaluateJob> | null = null;
  readonly stats = { evaluated: 0, buys: 0, rejects: 0, walletLookups: 0, feeSamples: 0 };
  private readonly fees: FeeEstimator;
  private readonly social: SocialAnalyzer;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly wallets: WalletAnalyzer,
    private readonly trader: Trader,
  ) {
    this.fees = new FeeEstimator(redis);
    this.social = new SocialAnalyzer(redis);
  }

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

  /** Queue checkpoints after a token migrates to PumpSwap (migration-momentum strategy). */
  async scheduleMigration(mint: string, migratedAtMs: number): Promise<void> {
    const cps = getConfig().scoring.migrationCheckpointsSec;
    const now = Date.now();
    await evaluateQueue.addBulk(
      cps.map((sec, i) => ({
        name: `mig+${sec}s`,
        data: { mint, checkpointSec: sec, final: i === cps.length - 1, strategy: 'MIGRATION_MOMENTUM' as const },
        opts: { jobId: `${mint}-mig-${sec}`, delay: Math.max(0, migratedAtMs + sec * 1000 - now) },
      })),
    );
  }

  /** A tracked wallet just bought this token: check it now and a few times after. */
  async scheduleCopy(mint: string, wallet: string): Promise<void> {
    const cps = getConfig().copy.checkpointsSec;
    const now = Date.now();
    await evaluateQueue.addBulk(
      cps.map((sec, i) => ({
        name: `copy+${sec}s`,
        data: { mint, checkpointSec: sec, final: i === cps.length - 1, strategy: 'SMART_MONEY_COPY' as const, wallet },
        // jobId includes the time so a second buy later can trigger a fresh round.
        opts: { jobId: `${mint}-copy-${sec}-${Math.floor(now / 600_000)}`, delay: sec * 1000 },
      })),
    );
  }

  start(concurrency = 8): void {
    this.worker = new Worker<EvaluateJob>(QUEUE_NAMES.evaluate, (job) => this.process(job), { connection: bullConnection(), concurrency });
    this.worker.on('failed', (job, err) => log.warn({ mint: job?.data.mint, err: err.message }, 'evaluation failed'));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<EvaluateJob>): Promise<void> {
    const { mint, checkpointSec, final } = job.data;
    const STRATEGY = STRATEGIES[job.data.strategy ?? 'CURVE_SNIPE'];
    const doneKey = `eval:${mint}:${STRATEGY.name}:done`;
    if (await this.redis.exists(doneKey)) return;
    const markDone = () => this.redis.set(doneKey, '1', 'EX', STATE_TTL_SECONDS);

    const token = await prisma.token.findUnique({ where: { mint }, select: { symbol: true, name: true, uri: true, creator: true, bondingCurve: true, safetyScore: true, safetyHardFail: true, description: true, twitter: true, telegram: true, website: true, metadataFetchedAt: true } });
    if (!token) return;
    const view = await this.liveState.read(mint);
    if (!view) return void (await markDone());

    // No safety result yet. Request one only once the token has real holders
    // (saves RPC credits — most launches never get there); the result is
    // used from the next checkpoint on.
    if (token.safetyScore === null || token.safetyHardFail === null) {
      if (view.balances.size >= getConfig().scoring.safetyMinHolders) {
        await safetyQueue.add('check', { mint }, { jobId: `safety-${mint}` });
        // Free (no Helius credits): read its X / Telegram / website links in the background.
        void this.social.fetchAndStore(mint, token.uri);
      }
      if (final) await markDone();
      return;
    }

    const cfg = getConfig();
    const { weights, version } = getWeights();
    const prevKey = `eval:${mint}:${STRATEGY.name}:prev`;
    const prevRaw = await this.redis.get(prevKey);
    const prev = prevRaw ? (JSON.parse(prevRaw) as PrevCheckpoint) : null;

    const market = analyzeMarket(view, prev, await getSolUsd(), Date.now(), cfg.entry.assumedExtraFeePerTradeSol);
    await this.redis.set(prevKey, JSON.stringify({ atMs: Date.now(), bondingCurvePct: market.raw.bondingCurvePct, priceSol: market.raw.priceSol } satisfies PrevCheckpoint), 'EX', STATE_TTL_SECONDS);
    this.stats.evaluated++;

    // A tracked wallet buying is a signal of its own → lower bar for copy trades.
    const threshold = cfg.entry.minCombinedScore + (STRATEGY.name === 'SMART_MONEY_COPY' ? cfg.copy.scoreThresholdDelta : 0);
    // Socials + keywords (from the metadata file, if it has been fetched).
    let socialInfo: { hasTwitter: boolean; blockedKeyword: string | null } | undefined;
    let socialFeatures = NEUTRAL_SOCIAL_FEATURES;
    const kw = keywordCheck(`${token.name} ${token.symbol} ${token.description ?? ''}`, cfg.keywords.boost, cfg.keywords.block);
    if (token.metadataFetchedAt) {
      const tw = twitterInfo(token.twitter);
      socialInfo = { hasTwitter: !!(tw.handle || tw.isCommunity), blockedKeyword: kw.blocked };
      socialFeatures = {
        socials: socialsScore(token, await this.social.reuseCounts(token)),
        narrative: kw.blocked ? 0 : kw.boosted ? 1 : 0.5,
      };
    } else if (kw.blocked) {
      socialInfo = { hasTwitter: false, blockedKeyword: kw.blocked };
    }

    const rules = () => checkEntryRules({ safetyScore: token.safetyScore!, safetyHardFail: token.safetyHardFail!, market: market.raw, strategy: STRATEGY, entry: cfg.entry, social: socialInfo });
    let ruleFails = rules();

    // Total fees so far use an ASSUMED priority fee + tip per trade. If fees are
    // the ONLY thing standing in the way, measure the real figure by sampling
    // recent transactions (~25 credits), then re-check.
    if (!token.safetyHardFail && ruleFails.length > 0 && ruleFails.every((f) => f.startsWith('fees '))) {
      const est = await this.fees.estimate(mint, token.bondingCurve, market.raw.buys + market.raw.sells, view.feesSol);
      this.stats.feeSamples++;
      market.raw.totalFeesSol = est.totalFeesSol;
      ruleFails = rules();
    }

    let features: FeatureVector = { safety: token.safetyScore / 100, ...market.features, ...NEUTRAL_WALLET_FEATURES, ...socialFeatures };
    let result = scoreFeatures(features, weights);
    let profile: CreatorProfile | null = null;

    if (!token.safetyHardFail && ruleFails.length === 0 && result.score >= threshold - cfg.scoring.walletAnalysisMargin) {
      profile = await this.wallets.analyze(token.creator, mint);
      this.stats.walletLookups++;
      features = { ...features, ...walletFeatures(profile) };
      result = scoreFeatures(features, weights);
    }

    const { decision, reasons } = decide(result.score, threshold, ruleFails, token.safetyHardFail);
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
          features: json({ checkpointSec, features, contributions: result.contributions, market: market.raw, creator: profile, socials: { twitter: token.twitter, telegram: token.telegram, website: token.website, keyword: kw } }),
          weightsVersion: version,
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
    // Curve snipes stop at migration (the migration strategy takes over from there).
    if (market.raw.complete && STRATEGY.name === 'CURVE_SNIPE') return void (await markDone());

    if (decision === 'BUY') {
      this.stats.buys++;
      log.info({ mint, symbol: token.symbol, score: result.score, checkpointSec, holders: market.raw.holders, curvePct: +market.raw.bondingCurvePct.toFixed(1) }, `🎯 BUY signal ${token.symbol} (${result.score.toFixed(1)})`);
      const res = await this.trader.tryEnter({
        mint,
        symbol: token.symbol,
        strategy: STRATEGY.name,
        evaluationId,
        score: result.score,
        market: market.raw,
        maxSlippageBps: STRATEGY.maxSlippageBps,
        features,
        copiedWallet: job.data.wallet,
      });
      // Entered, or permanently impossible → stop evaluating. Capacity issues → retry next checkpoint.
      if (res.entered || res.reason === 'already traded this token') await markDone();
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
