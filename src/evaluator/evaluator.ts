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
import { explainBuy } from '../learner/explain';
import { hotKeywords } from '../scanner/x-watcher';
import type { OutcomeLabeler } from '../learner/outcome-labeler';
import { currentRegime } from '../learner/regime-detector';
import { keywordCheck, NEUTRAL_SOCIAL_FEATURES, SocialAnalyzer, socialsScore, twitterInfo } from './social-analyzer';
import { analyzeMarket, withInsider, type PrevCheckpoint } from './market-analyzer';
import { checkEntryRules, convictionFactor, decide, manipulationCheck, learnedOddsAdjustment, scoreFeatures, withOdds, type FeatureVector, type LearnedOdds, type ScoreResult } from './scorer';
import { ALL_PATTERN, beliefCache, patternsOf, type StoredFeatures } from '../learner/bayesian-updater';
import { DEFAULT_CONFIG } from '../config/default';
import { NEUTRAL_WALLET_FEATURES, walletFeatures, type CreatorProfile, type WalletAnalyzer } from './wallet-analyzer';
import type { CrowdMetrics, CrowdTracker } from '../scanner/crowd-tracker';
import { dexPoints, type DexScreener } from '../scanner/dexscreener';
import { kolActivity, kolPoints } from '../scanner/kol-signal';
import type { MarketLeaders } from '../scanner/market-leaders';
import { analyzeChart } from './chart-reader';
import type { DipWatcher } from '../executor/dip-watcher';
import { rememberBuyers, smartShare } from '../learner/wallet-reputation';
import { coachFor } from '../learner/trade-coach';
import { calibration, calibrationAdjust, type CalibrationAdjust } from '../learner/score-calibration';
import type { StrategyName } from '../config/types';

const log = moduleLogger('evaluator');

type Scored = ScoreResult & { pre: number; cal: CalibrationAdjust };
const STATE_TTL_SECONDS = 60 * 60;


export class Evaluator {
  private worker: Worker<EvaluateJob> | null = null;
  readonly stats = { evaluated: 0, buys: 0, rejects: 0, walletLookups: 0, feeSamples: 0 };
  private readonly fees: FeeEstimator;
  private readonly social: SocialAnalyzer;
  /** Live per-trade crowd log (set in index.ts). */
  crowd: CrowdTracker | null = null;
  /** DexScreener trending + DEX paid (set in index.ts). */
  dex: DexScreener | null = null;
  /** Top coins right now and the narratives they share (set in index.ts). */
  leaders: MarketLeaders | null = null;
  /** Stretched charts wait here for a dip instead of being bought at the top (set in index.ts). */
  dips: DipWatcher | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly wallets: WalletAnalyzer,
    private readonly trader: Trader,
    private readonly outcomes: OutcomeLabeler | null = null,
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

  /** The coin just entered the "Soon" zone (curve ≥ focus.soon.minCurvePct): check it over the next minutes. */
  async scheduleSoon(mint: string): Promise<void> {
    const cps = getConfig().focus.soon.checkpointsSec;
    await evaluateQueue.addBulk(
      cps.map((sec, i) => ({
        name: `soon+${sec}s`,
        data: { mint, checkpointSec: sec, final: i === cps.length - 1, strategy: 'SOON' as const },
        opts: { jobId: `${mint}-soon-${sec}`, delay: sec * 1000 },
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
    // Swing re-entries re-check a token we already finished with.
    const swing = job.data.swing === true;
    if (!swing && (await this.redis.exists(doneKey))) return;
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
    await this.redis.set(prevKey, JSON.stringify({ atMs: Date.now(), bondingCurvePct: market.raw.bondingCurvePct, priceSol: market.raw.priceSol, volumeSol: market.raw.volumeSol } satisfies PrevCheckpoint), 'EX', STATE_TTL_SECONDS);
    this.stats.evaluated++;

    // A tracked wallet buying is a signal of its own → lower bar for copy trades.
    // Market mood shifts the bar (stricter when cold / rug-heavy, easier when hot).
    const regime = currentRegime();
    // Soon / migrated coins have strict rules of their own → easier score bar.
    // The trade coach moves the bar per strategy from what recent trades taught it.
    const focusRules = STRATEGY.name === 'SOON' ? cfg.focus.soon : STRATEGY.name === 'MIGRATION_MOMENTUM' ? cfg.focus.migrated : null;
    const coach = coachFor(STRATEGY.name);
    const threshold =
      cfg.entry.minCombinedScore +
      (STRATEGY.name === 'SMART_MONEY_COPY' ? cfg.copy.scoreThresholdDelta : 0) +
      (focusRules?.scoreThresholdDelta ?? 0) +
      coach.thresholdDelta +
      cfg.regimeAdjustments[regime].scoreThresholdDelta;
    // How people behave on this coin right now (dip buying, paper hands, bots, smart wallets, eyes).
    const buyers = this.crowd?.recentBuyers(mint) ?? [];
    const smart = buyers.length ? await smartShare(this.redis, buyers) : { pct: null };
    const crowd: CrowdMetrics | null = this.crowd && this.crowd.trades(mint).length > 0 ? this.crowd.metrics(mint, smart.pct) : null;
    // Fake volume / bundles / chasing: over the limits = no buy; under them = points off.
    const manip = manipulationCheck(crowd, cfg.entry.manipulation);
    // Read the chart: breaking down = no buy; a dip + bounce in an uptrend = bonus; stretched = wait for a dip.
    const chartCfg = cfg.chart ?? DEFAULT_CONFIG.chart;
    const chart = chartCfg.enabled && this.crowd ? analyzeChart(this.crowd.candles(mint), Date.now(), chartCfg) : null;
    const chartPoints = chart?.verdict === 'buy_now' ? chartCfg.buyDipPoints : 0;
    // DexScreener: DEX paid / CTO / trending → bonus points (optionally required).
    const dexCfg = cfg.dex ?? DEFAULT_CONFIG.dex;
    // (only for coins that matter — DexScreener allows 60 checks a minute)
    const wantPaid = STRATEGY.name !== 'CURVE_SNIPE' || !!job.data.confirm;
    const dexPaid = dexCfg.enabled && wantPaid ? (this.dex?.paidInfo(mint) ?? null) : null;
    const dexTrend = dexCfg.enabled ? (this.dex?.trendingInfo(mint) ?? null) : null;
    const dexBonus = dexPoints(dexPaid, dexTrend, dexCfg);
    const dexFails: string[] = [];
    // KOLs (Cupsey, Cented…) in this coin: points per KOL; KOLs dumping = no buy.
    const kolCfg = cfg.kol ?? DEFAULT_CONFIG.kol;
    const kolAct = kolCfg.enabled ? await kolActivity(this.redis, mint, kolCfg).catch(() => null) : null;
    const kolBonus = kolPoints(kolAct, kolCfg);
    if (kolAct?.dumping) dexFails.push(`KOLs dumping (${kolAct.recentSellers.length} sold)`);
    if (dexCfg.requirePaidFor?.includes(STRATEGY.name) && !(dexPaid?.paid || dexPaid?.cto)) dexFails.push(dexPaid ? 'not DEX paid' : 'DEX paid not checked yet');
    // Socials + keywords (from the metadata file, if it has been fetched).
    let socialInfo: { hasTwitter: boolean; blockedKeyword: string | null } | undefined;
    let socialFeatures = NEUTRAL_SOCIAL_FEATURES;
    // Hot right now: keywords trending on X + narratives shared by today's top coins.
    const hot = [...hotKeywords(), ...(this.leaders?.keywords() ?? [])];
    // Your boost list + keywords currently hot on X (e.g. from Elon's latest post).
    const kw = keywordCheck(`${token.name} ${token.symbol} ${token.description ?? ''}`, [...cfg.keywords.boost, ...hot], cfg.keywords.block);
    // Narrative quality: keywords (static + hot + learned win odds), copycats, trends, description/socials quality.
    let narrativeReason: string | null = null;
    let narrativeScore = kw.blocked ? 0 : kw.boosted ? 1 : 0.5;
    try {
      const nar = await this.social.narrative({ ...token, mint }, cfg.keywords, hot);
      narrativeScore = nar.score;
      narrativeReason = nar.reason;
    } catch (err) {
      log.warn({ mint, err: (err as Error).message }, 'narrative check failed — using keyword match only');
    }
    if (token.metadataFetchedAt) {
      const tw = twitterInfo(token.twitter);
      socialInfo = { hasTwitter: !!(tw.handle || tw.isCommunity), blockedKeyword: kw.blocked };
      socialFeatures = { socials: socialsScore(token, await this.social.reuseCounts(token)), narrative: narrativeScore };
    } else {
      socialFeatures = { ...NEUTRAL_SOCIAL_FEATURES, narrative: narrativeScore };
      if (kw.blocked) socialInfo = { hasTwitter: false, blockedKeyword: kw.blocked };
    }

    const rules = () => [...checkEntryRules({ safetyScore: token.safetyScore!, safetyHardFail: token.safetyHardFail!, market: market.raw, strategy: STRATEGY, entry: cfg.entry, social: socialInfo, focus: cfg.focus, crowd }), ...manip.fails, ...dexFails, ...(chart?.verdict === 'avoid' ? [`chart breaking down (${chart.summary})`] : [])];
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

    // Learned odds: how often coins with the same patterns went on to win (bounded ±points).
    const lc = cfg.learning ?? DEFAULT_CONFIG.learning;
    const odds: LearnedOdds | null = lc.oddsEnabled
      ? learnedOddsAdjustment(
          patternsOf({ market: market.raw as unknown as StoredFeatures['market'], socials: { twitter: token.twitter, website: token.website, telegram: token.telegram } }, STRATEGY.name),
          beliefCache(),
          beliefCache().get(ALL_PATTERN),
          { minSamples: lc.oddsMinSamples, priorStrength: lc.oddsPriorStrength, maxPoints: lc.oddsMaxPoints, pointsPerLogit: lc.oddsPointsPerLogit },
        )
      : null;
    // Final score = weighted features + learned pattern odds − manipulation penalty, then
    // calibrated by how this strategy's score band has REALLY done lately (high scores that
    // keep losing get marked down). `pre` (before calibration) is what calibration measures.
    const score = (f: FeatureVector): Scored => {
      const r = withOdds(scoreFeatures(f, weights), odds);
      const pre = Math.round((r.score - manip.penalty + dexBonus.points + kolBonus.points + chartPoints) * 100) / 100;
      const cal = calibrationAdjust(calibration(), STRATEGY.name, pre);
      return { ...r, score: Math.round(Math.max(0, Math.min(100, pre + cal.points)) * 100) / 100, pre, cal };
    };

    let features: FeatureVector = {
      safety: token.safetyScore / 100,
      ...market.features,
      ...NEUTRAL_WALLET_FEATURES,
      ...socialFeatures,
      crowd: crowd?.crowdScore ?? 0.5,
      attention: crowd?.attentionScore ?? 0.5,
    };
    let result = score(features);
    let profile: CreatorProfile | null = null;

    // Soft = concentration limits a strong token may still be bought through at reduced size.
    const isSoft = (f: string) => /^(bundlers hold|top 10 hold|one wallet holds)/.test(f);
    if (!token.safetyHardFail && ruleFails.every(isSoft) && result.score >= threshold - cfg.scoring.walletAnalysisMargin) {
      profile = await this.wallets.analyze(token.creator, mint);
      this.stats.walletLookups++;
      // Hidden dev wallets / insider clusters count toward the anti-rug limits.
      if (profile.insiderFails?.length) ruleFails = [...ruleFails, ...profile.insiderFails];
      if (profile.rugBlock?.length) ruleFails = [...ruleFails, ...profile.rugBlock.map((r) => `insider rug: ${r}`)];
      if (profile.insider) {
        const mi = withInsider(market.raw, profile.insider);
        market.raw = mi.raw;
        market.features = mi.features;
        features = { ...features, ...mi.features };
      }
      features = { ...features, ...walletFeatures(profile) };
      result = score(features);
    }

    let { decision, reasons } = decide(result.score, threshold, ruleFails, token.safetyHardFail);

    // "Still worth a shot": only soft concentration limits broken, within looser caps,
    // and a clearly strong score → buy at reduced size (the learner tracks how these do).
    let risky: string | null = null;
    const re = cfg.entry.riskyEntry;
    if (
      decision === 'SKIP' && re.enabled && ruleFails.length > 0 && ruleFails.every(isSoft) &&
      (market.raw.effectiveBundlePct ?? market.raw.earlyBuyerPct) <= re.maxBundlePct && market.raw.top10HolderPct <= re.maxTop10Pct && (market.raw.effectiveMaxHolderPct ?? market.raw.maxHolderPct) <= re.maxSingleHolderPct &&
      result.score >= threshold + re.extraScore
    ) {
      risky = ruleFails.join(', ');
      decision = 'BUY';
      reasons = [`higher-risk entry at ${re.sizeMultiplier}× size: ${risky}`, `score ${result.score.toFixed(1)} ≥ ${threshold + re.extraScore}`];
    }
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
          features: json({ checkpointSec, features, contributions: result.contributions, learnedOdds: odds, preCalibrationScore: result.pre, calibration: result.cal, manipulation: manip, dex: { paid: dexPaid?.paid ?? null, cto: dexPaid?.cto ?? null, trendingRank: dexTrend?.rank ?? null }, chart: chart ? { verdict: chart.verdict, summary: chart.summary, vsVwapPct: chart.vsVwapPct, rsi: chart.rsi, trend: chart.trend, pullbackPct: chart.pullbackPct } : null, kol: kolAct ? { kols: kolAct.buyers.length, names: kolAct.buyers.map((b) => b.name), dumping: kolAct.dumping } : null, market: market.raw, creator: profile, crowd, swing, socials: { twitter: token.twitter, telegram: token.telegram, website: token.website, keyword: kw } }),
          weightsVersion: version,
          regime,
        },
      });
      evaluationId = row.id;
      // Learning who's early on winners: remember who was buying when we scored it.
      if (buyers.length) void rememberBuyers(this.redis, row.id, buyers).catch(() => undefined);
      // Learning: watch what the price does over the next hour.
      await this.outcomes?.startWindow(mint, row.id, market.raw.priceSol);
      bus.publish({ type: 'evaluation', data: { mint, symbol: token.symbol, score: result.score, decision, reasons } });
      await prisma.token.update({ where: { mint }, data: { combinedScore: result.score } });
    }

    if (decision === 'REJECT') {
      this.stats.rejects++;
      await markDone();
      return;
    }
    // Curve snipes stop at migration (the migration strategy takes over from there).
    if (market.raw.complete && (STRATEGY.name === 'CURVE_SNIPE' || STRATEGY.name === 'SOON')) return void (await markDone());

    // Don't buy the top: a stretched chart waits for a dip into the buy zone (the dip watcher
    // re-checks the coin when it dips and bounces — that re-check skips this and the confirmation).
    const dipEntry = job.data.dip === true;
    if (decision === 'BUY' && !dipEntry && chart?.verdict === 'wait_dip' && chart.zone && chartCfg.dip.enabled && this.dips) {
      this.dips.add({ mint, symbol: token.symbol, strategy: STRATEGY.name, zone: chart.zone, signalPrice: market.raw.priceSol, why: chart.summary, swing, wallet: job.data.wallet });
      decision = 'SKIP';
      reasons = [`waiting for a dip: ${chart.summary}`];
    }
    // Confirmation delay: re-check a BUY signal a few seconds later before any money moves.
    if (decision === 'BUY' && !dipEntry) {
      const confirmSec = cfg.entry.confirmDelaySec ?? 0;
      const pending = job.data.confirm;
      if (confirmSec > 0 && !pending) {
        // One confirmation at a time per coin + strategy.
        const fresh = await this.redis.set(`confirm:${mint}:${STRATEGY.name}`, '1', 'EX', confirmSec + 10, 'NX');
        if (!fresh) return;
        await evaluateQueue.add(
          'confirm',
          { ...job.data, checkpointSec: checkpointSec + confirmSec, confirm: { priceSol: market.raw.priceSol, at: Date.now(), score: result.score } },
          { jobId: `${mint}-${STRATEGY.name}-confirm-${Math.floor(Date.now() / 60_000)}`, delay: confirmSec * 1000 },
        );
        log.info({ mint, symbol: token.symbol, score: result.score }, `⏱  BUY signal ${token.symbol} (${result.score.toFixed(1)}) — confirming in ${confirmSec}s`);
        return; // the confirmation job carries on (incl. the end-of-schedule watchlist)
      }
      if (pending && pending.priceSol > 0) {
        const c = cfg.entry.confirm;
        const drift = (market.raw.priceSol / pending.priceSol - 1) * 100;
        const ratio = crowd?.buyRatio2m ?? null;
        const why =
          drift < -c.maxDropPct ? `price fell ${Math.abs(drift).toFixed(0)}% while confirming`
          : drift > c.maxPumpPct ? `ran ${drift.toFixed(0)}% while confirming (not chasing)`
          : ratio !== null && ratio < c.minBuyRatio ? `sellers took over (buy/sell ${ratio.toFixed(2)})`
          : null;
        if (why) {
          log.info({ mint, symbol: token.symbol, why }, `✋ ${token.symbol} signal didn't confirm: ${why}`);
          decision = 'SKIP';
          reasons = [`didn't confirm: ${why}`];
        }
      }
    }

    if (decision === 'BUY') {
      this.stats.buys++;
      log.info({ mint, symbol: token.symbol, score: result.score, checkpointSec, holders: market.raw.holders, curvePct: +market.raw.bondingCurvePct.toFixed(1) }, `🎯 BUY ${token.symbol} confirmed (${result.score.toFixed(1)})`);
      // Conviction sizing: more on the strongest setups, less on borderline ones.
      const conv = convictionFactor({
        scoreMargin: result.score - threshold,
        calibrationFactor: result.cal.factor,
        crowdScore: crowd?.crowdScore ?? null,
        min: cfg.trading.minConvictionMultiple ?? 0.4,
        max: cfg.trading.maxConvictionMultiple ?? 1.6,
      });
      const copyMult = STRATEGY.name === 'SMART_MONEY_COPY' ? (cfg.copy.sizeMultiplier ?? 0.5) : 1;
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
        sizeMultiplier: (risky ? re.sizeMultiplier : 1) * (focusRules?.sizeMultiplier ?? 1) * coach.sizeFactor * conv.factor * copyMult,
        swing,
        explain: (sizeSol) =>
          explainBuy({ symbol: token.symbol, strategy: STRATEGY.name, score: result.score, threshold, contributions: result.contributions, features, market: market.raw, sizeSol, regime, risky, copiedWallet: job.data.wallet, odds, narrativeReason, chartNote: chart ? `${chart.summary}${dipEntry ? ` — bought the dip: ${job.data.dipWhy ?? ''}` : ''}` : null, crowdSummary: crowd?.summary ?? null, swingNote: swing ? job.data.swingWhy ?? 'swing re-entry' : null, coachNote: coach.note, sizeNote: conv.note + (copyMult !== 1 ? `, copy ×${copyMult}` : ''), scoreNotes: [...kolBonus.notes, ...dexBonus.notes.map((n) => `${n} (+)`), ...manip.notes, ...(result.cal.note ? [result.cal.note] : [])], insiderNote: profile?.insider?.reasons?.length ? profile.insider.reasons.slice(0, 2).join('; ') : null }),
      });
      // Entered, or permanently impossible → stop evaluating. Capacity issues → retry next checkpoint.
      if (!swing && (res.entered || res.reason === 'already traded this token')) await markDone();
    } else if (result.score >= cfg.scoring.storeAboveScore) {
      log.debug({ mint, symbol: token.symbol, score: result.score, reasons }, `👀 ${token.symbol} ${result.score.toFixed(1)} — ${reasons[0]}`);
    }
    if (final) {
      // Watchlist: a near-miss gets a few extra looks instead of being dropped.
      const wl = cfg.scoring.watchlist;
      const nearMiss = decision === 'SKIP' && (result.score >= threshold - wl.scoreMargin || ruleFails.every(isSoft));
      const watchKey = `eval:${mint}:${STRATEGY.name}:watch`;
      const n = nearMiss ? await this.redis.incr(watchKey) : wl.maxExtraChecks + 1;
      if (n <= wl.maxExtraChecks) {
        await this.redis.expire(watchKey, STATE_TTL_SECONDS);
        await evaluateQueue.add(
          `watch+${n}`,
          { mint, checkpointSec: checkpointSec + wl.everySec, final: true, strategy: STRATEGY.name, wallet: job.data.wallet },
          { jobId: `${mint}-${STRATEGY.name}-watch-${n}`, delay: wl.everySec * 1000 },
        );
        log.debug({ mint, symbol: token.symbol, score: result.score }, `👁 watching ${token.symbol} (${n}/${wl.maxExtraChecks})`);
      } else await markDone();
    }
  }

  /** Something just happened on this token (volume spike) — check it right now. */
  async checkNow(mint: string, strategy: StrategyName, why: string, opts: { swing?: boolean; dip?: boolean; wallet?: string } = {}): Promise<void> {
    const bucket = Math.floor(Date.now() / 60_000);
    const kind = opts.dip ? 'dip' : opts.swing ? 'swing' : 'now';
    await evaluateQueue.add(
      `now:${why}`,
      {
        mint,
        checkpointSec: 0,
        final: false,
        strategy,
        ...(opts.swing ? { swing: true, swingWhy: why } : {}),
        ...(opts.dip ? { dip: true, dipWhy: why } : {}),
        ...(opts.wallet ? { wallet: opts.wallet } : {}),
      },
      { jobId: `${mint}-${strategy}-${kind}-${bucket}` },
    );
  }
}

function avg(o: Record<string, number>): number {
  const v = Object.values(o);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function json(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
