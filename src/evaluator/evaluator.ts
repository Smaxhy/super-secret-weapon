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
import { parseXLink, xLinkReuse, xLive, xVerdict, type XVerdict } from './x-check';
import { organicFlow, scanVerdict } from '../scanner/migrated-scanner';
import { priceShape, staircase } from './price-shape';
import { timeframeFail, timeframes } from './timeframes';
import { paFeatures, priceActionFor } from './price-action';
import { poolFeeBps } from '../lib/pumpfun';
import { aiRuleVerdict, flattenFeatures } from '../learner/ai-coach';
import { autopsyTuneFor, strategyEdgeStatsFor } from '../learner/loss-autopsy';
import { timingNow } from '../learner/timing';
import { entryStyleBlock, entryStyleFor, pullbackZone } from '../learner/entry-style';
import { dipOnlyApplies, dipOnlyHigh, hotVolume } from '../executor/dip-watcher';
import { flowPressure, ownerFilterFails, pressureFail } from './owner-filters';
import { moodNow } from '../learner/market-mood';
import type { ShadowKind, ShadowTrades } from '../learner/shadow-trades';
import type { OutcomeTracker } from '../learner/outcome-tracker';
import type { Brain } from '../learner/brain';
import { exploreMargin, noteEvaluation, noteSignal, noteSkip } from '../lib/entry-blockers';
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
import { keywordCheck, NEUTRAL_SOCIAL_FEATURES, SocialAnalyzer, socialsScore, hasXLink, xLinkOf } from './social-analyzer';
import { analyzeMarket, withInsider, type PrevCheckpoint } from './market-analyzer';
import { checkEntryRules, convictionFactor, decide, manipulationCheck, learnedOddsAdjustment, scoreFeatures, withOdds, type FeatureVector, type LearnedOdds, type ScoreResult } from './scorer';
import { ALL_PATTERN, beliefCache, patternsOf, strategyPattern, type StoredFeatures } from '../learner/bayesian-updater';
import { DEFAULT_CONFIG } from '../config/default';
import { NEUTRAL_WALLET_FEATURES, walletFeatures, type CreatorProfile, type WalletAnalyzer } from './wallet-analyzer';
import type { CrowdMetrics, CrowdTracker } from '../scanner/crowd-tracker';
import { dexPoints, type DexScreener } from '../scanner/dexscreener';
import { effectiveKols, kolActivity, kolPoints } from '../scanner/kol-signal';
import type { MarketLeaders } from '../scanner/market-leaders';
import { analyzeChart } from './chart-reader';
import { computeEarlyFlow, newPairCheck, type EarlyFlow } from './new-pair';
import type { DipWatcher } from '../executor/dip-watcher';
import type { StrategyLab } from '../learner/strategy-lab';
import { taPoints, type TaLab } from '../learner/ta-lab';
import { runStrategiesTf } from './ta/strategies';
import { trendScore, type TrendingHub } from '../scanner/trending-hub';
import type { VampGuard } from './vamp-guard';
import { rememberBuyers, smartShare } from '../learner/wallet-reputation';
import { coachFor } from '../learner/trade-coach';
import { calibration, calibrationAdjust, type CalibrationAdjust } from '../learner/score-calibration';
import type { StrategyName } from '../config/types';
import { momentumGateFails, type MomentumGateConfig } from './momentum-gate';
import { entryQuality, DEFAULT_ENTRY_QUALITY } from './entry-quality';
import { fetchRugCheck, rugCheckVerdict, type RugCheckVerdict } from '../integrations/rugcheck';
import { adaptiveStopMultiplier, mcAgeStopMultiplier, DEFAULT_ADAPTIVE_STOP } from '../executor/adaptive-stop';
import { edgeGateVerdict, probeTurn, DEFAULT_EDGE_GATE } from './edge-gate';
import { sniperEntryFails } from './sniper';
import { sniperOn } from '../config/sniper';
import { crowdQuality, type CrowdQuality } from './crowd-quality';
import type { WalletBook } from '../learner/wallet-book';
import type { RuggerMemory } from '../executor/rug-watch';
import type { ObsidianSync } from '../integrations/obsidian-sync';
import { confirmHoldSec, confirmStep } from './confirm';
import type { CrowdTrade } from '../scanner/crowd-tracker';

const log = moduleLogger('evaluator');

type Scored = ScoreResult & { pre: number; cal: CalibrationAdjust };
const STATE_TTL_SECONDS = 60 * 60;


export class Evaluator {
  /** Edge gate: refused signals per strategy (every Nth one goes through as a probe). */
  private readonly edgeRefused = new Map<string, number>();
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
  /** Forward-tests exit setups on every BUY signal and near-miss (set in index.ts). */
  lab: StrategyLab | null = null;
  /** Chart strategies with a proven edge (live-tested vs random entries) add points (set in index.ts). */
  ta: TaLab | null = null;
  /** Trending tabs (pump.fun / GeckoTerminal / DexScreener narratives) (set in index.ts). */
  trending: TrendingHub | null = null;
  /** Copycat ("vamp") coins of coins we traded or bigger coins → no buy (set in index.ts). */
  vamp: VampGuard | null = null;
  /** Pretend trades on coins it didn't buy — faster learning (set in index.ts). */
  shadow: ShadowTrades | null = null;
  /** Every coin checked and not bought → replayed later as a training row (learner/outcome-tracker.ts). */
  coinOutcomes: OutcomeTracker | null = null;
  /** Win model + rule search + allocator (set in index.ts). */
  brain: Brain | null = null;
  /** v11.6: every wallet's record (set in index.ts) — who is buying this coin. */
  walletBook: WalletBook | null = null;
  /** v11.8: dumper memory (set in index.ts) — deployer-funded launch snipers are remembered as ruggers. */
  ruggers: RuggerMemory | null = null;
  /** v11.9 Obsidian shared brain (set in index.ts): coins it wanted / nearly wanted get a linked note. */
  obsidian: ObsidianSync | null = null;

  /** Funders of the biggest recent buyers, from the funding-graph cache only (`wfund:<wallet>`, no RPC). */
  private async cachedFunders(trades: readonly CrowdTrade[], now: number, launchMs: number | null = null): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const bySol = new Map<string, number>();
    for (const t of trades) if (t.buy && now - t.t <= 300_000) bySol.set(t.w, (bySol.get(t.w) ?? 0) + t.sol);
    const top = [...bySol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);
    // v11.8: launch-window buyers too (deployer-funded snipers), whatever their size.
    if (launchMs !== null && launchMs > 0) for (const t of trades) if (t.buy && t.t - launchMs <= 4_000 && !top.includes(t.w) && top.length < 80) top.push(t.w);
    if (!top.length) return out;
    try {
      const vals = await this.redis.mget(top.map((w) => `wfund:${w}`));
      top.forEach((w, i) => {
        const v = vals[i];
        if (!v) return;
        try {
          out.set(w, (JSON.parse(v) as { funder?: string | null }).funder ?? null);
        } catch {
          /* skip */
        }
      });
      // One hop further (cache only): the funders' own funders, so "funded by a wallet the dev funded" is visible.
      const hop = [...new Set([...out.values()].filter((f): f is string => !!f && !out.has(f)))].slice(0, 40);
      if (hop.length) {
        const vals2 = await this.redis.mget(hop.map((w) => `wfund:${w}`));
        hop.forEach((w, i) => {
          const v = vals2[i];
          if (!v) return;
          try {
            out.set(w, (JSON.parse(v) as { funder?: string | null }).funder ?? null);
          } catch {
            /* skip */
          }
        });
      }
    } catch {
      /* cache only — never blocks */
    }
    return out;
  }

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

  /** Several KOLs / smart wallets bought this coin: check it as a KOL follow now and a few times after. */
  async scheduleKolFollow(mint: string, kols: number): Promise<void> {
    const kf = getConfig().kol?.follow ?? DEFAULT_CONFIG.kol.follow;
    if (!kf.enabled || kols < kf.minKols) return;
    const bucket = Math.floor(Date.now() / 600_000);
    await evaluateQueue.addBulk(
      kf.checkpointsSec.map((sec, i) => ({
        name: `kol+${sec}s`,
        data: { mint, checkpointSec: sec, final: i === kf.checkpointsSec.length - 1, strategy: 'SMART_MONEY_COPY' as const, kolFollow: true },
        opts: { jobId: `${mint}-kol-${sec}-${bucket}`, delay: sec * 1000 },
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
    // Swing trades on bigger coins have their own decision maker (executor/swing-trader.ts).
    if (job.data.strategy === 'SWING') return;
    const STRATEGY = STRATEGIES[job.data.strategy ?? 'CURVE_SNIPE'];
    const doneKey = `eval:${mint}:${STRATEGY.name}:done`;
    // Swing re-entries re-check a token we already finished with.
    const swing = job.data.swing === true;
    if (!swing && !job.data.rescan && (await this.redis.exists(doneKey))) return;
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
    // New pairs only live a few minutes: past the window (or dead on arrival) → stop checking.
    const npCfg = cfg.focus.newPair ?? DEFAULT_CONFIG.focus.newPair;
    if (STRATEGY.name === 'CURVE_SNIPE' && !market.raw.complete && (market.raw.ageSec > npCfg.maxAgeSec + 60 || (market.raw.ageSec >= 180 && (market.raw.curveSol ?? 0) < 1))) {
      return void (await markDone());
    }
    await this.redis.set(prevKey, JSON.stringify({ atMs: Date.now(), bondingCurvePct: market.raw.bondingCurvePct, priceSol: market.raw.priceSol, volumeSol: market.raw.volumeSol } satisfies PrevCheckpoint), 'EX', STATE_TTL_SECONDS);
    this.stats.evaluated++;

    // A tracked wallet buying is a signal of its own → lower bar for copy trades.
    // Market mood shifts the bar (stricter when cold / rug-heavy, easier when hot).
    const regime = currentRegime();
    // Soon / migrated coins have strict rules of their own → easier score bar.
    // The trade coach moves the bar per strategy from what recent trades taught it.
    const focusRules = STRATEGY.name === 'SOON' ? cfg.focus.soon : STRATEGY.name === 'MIGRATION_MOMENTUM' ? cfg.focus.migrated : null;
    const coach = coachFor(STRATEGY.name);
    const kolFollow = STRATEGY.name === 'SMART_MONEY_COPY' && job.data.kolFollow === true;
    const kf = cfg.kol?.follow ?? DEFAULT_CONFIG.kol.follow;
    // What the loss autopsy learned about this strategy (stricter when it keeps losing, easier when it works).
    const tune = autopsyTuneFor(STRATEGY.name);
    let threshold =
      cfg.entry.minCombinedScore +
      (STRATEGY.name === 'SMART_MONEY_COPY' && !kolFollow ? cfg.copy.scoreThresholdDelta : 0) +
      tune.barDelta +
      (STRATEGY.name === 'CURVE_SNIPE' ? npCfg.scoreThresholdDelta : 0) +
      (STRATEGY.name === 'RUNNER' ? (cfg.runner ?? DEFAULT_CONFIG.runner).scoreThresholdDelta : 0) +
      (focusRules?.scoreThresholdDelta ?? 0) +
      coach.thresholdDelta +
      cfg.regimeAdjustments[regime].scoreThresholdDelta +
      // best / worst hours and days to trade (market motion + our own results at this time)
      timingNow().barDelta;
    // How people behave on this coin right now (dip buying, paper hands, bots, smart wallets, eyes).
    const buyers = this.crowd?.recentBuyers(mint) ?? [];
    const smart = buyers.length ? await smartShare(this.redis, buyers) : { pct: null };
    const crowd: CrowdMetrics | null = this.crowd && this.crowd.trades(mint).length > 0 ? this.crowd.metrics(mint, smart.pct) : null;
    // Fake volume / bundles / chasing: over the limits = no buy; under them = points off.
    const manip = manipulationCheck(crowd, cfg.entry.manipulation);
    // New pairs: snipers' supply absorbed? real new buyers arriving right now? breaking out, not chasing?
    let earlyFlow: EarlyFlow | null = null;
    let newPair: { fails: string[]; notes: string[]; points: number } | null = null;
    if (STRATEGY.name === 'CURVE_SNIPE' && this.crowd) {
      earlyFlow = computeEarlyFlow(this.crowd.trades(mint), Date.now(), { balances: view.balances, creator: token.creator, supplyRaw: view.curve.totalSupply, sniperWindowSec: npCfg.sniperWindowSec });
      newPair = newPairCheck(
        earlyFlow,
        { devHoldingPct: market.raw.devHoldingPct, devSoldFraction: market.raw.devSoldFraction, top10HolderPct: market.raw.top10HolderPct, supplyStandard: market.raw.supplyStandard !== false, botVolumePct: crowd && crowd.trades5m >= 10 ? crowd.fakeVolumePct : 0 },
        npCfg,
      );
    }
    // Read the chart: breaking down = no buy; a dip + bounce in an uptrend = bonus; stretched = wait for a dip.
    const chartCfg = cfg.chart ?? DEFAULT_CONFIG.chart;
    const chart = chartCfg.enabled && this.crowd ? analyzeChart(this.crowd.candles(mint), Date.now(), chartCfg) : null;
    // Where in the move are we buying (run-up, spikes, distance from the high) — for the AI coach + autopsy.
    const shapeBase = this.crowd ? priceShape(this.crowd.candles(mint), Date.now()) : null;
    const stair = this.crowd ? staircase(this.crowd.candles(mint), this.crowd.trades(mint), Date.now()) : null;
    const shape = shapeBase ? { ...shapeBase, staircase: stair?.hit ? 1 : 0, stairCandles: stair?.candles ?? 0, stairStepCv: stair?.stepCv ?? null } : null;
    // 5 s / 15 s / 30 s / 1 min / 5 min / 1 h candles straight from the trades (owner's per-timeframe limits below).
    const tf = this.crowd ? timeframes(this.crowd.trades(mint), Date.now()) : {};
    // Price action (trend line, defended levels, setup, buyer quality) from the trade tape.
    const paCfg = cfg.entry.priceAction ?? DEFAULT_CONFIG.entry.priceAction;
    const paRead = this.crowd ? priceActionFor(mint, this.crowd.trades(mint), Date.now()) : null;
    const pa = paRead ? paFeatures(paRead) : null;

    // Momentum gate (v11): hard filter on priceShape — blocks chasing, buying the top, seller pressure.
    const mgCfg: MomentumGateConfig = cfg.momentumGate ?? DEFAULT_CONFIG.momentumGate;
    const mgWhy = momentumGateFails(shape, mgCfg);

    const chartPoints = chart?.verdict === 'buy_now' ? chartCfg.buyDipPoints : 0;
    // Chart strategies (Fibonacci, EMA pullback, breakouts …) that PROVED themselves in the live lab.
    const taCfg = cfg.ta ?? DEFAULT_CONFIG.ta;
    let taBonus: { points: number; notes: string[] } = { points: 0, notes: [] };
    if (taCfg.enabled && this.ta && this.crowd && this.ta.provenNow().size) {
      const tr = this.crowd.trades(mint);
      const lt = tr[tr.length - 1];
      if (lt) {
        const fired = runStrategiesTf(this.crowd.candles(mint), tr, lt.pp && lt.pp > 0 ? lt.pp : lt.px, Date.now(), market.raw.ageSec, [...this.ta.provenNow().keys()], { creator: token.creator });
        taBonus = taPoints(fired, this.ta.provenNow(), taCfg);
        if (sniperOn()) taBonus = { points: 0, notes: taBonus.notes }; // v11.7: watch-only in sniper mode
      }
    }
    // DexScreener: DEX paid / CTO / trending → bonus points (optionally required).
    const dexCfg = cfg.dex ?? DEFAULT_CONFIG.dex;
    // (only for coins that matter — DexScreener allows 60 checks a minute)
    const wantPaid = STRATEGY.name !== 'CURVE_SNIPE' || !!job.data.confirm;
    const dexPaid = dexCfg.enabled && wantPaid ? (this.dex?.paidInfo(mint) ?? null) : null;
    const dexTrend = dexCfg.enabled ? (this.dex?.trendingInfo(mint) ?? null) : null;
    const dexBonus = dexPoints(dexPaid, dexTrend, dexCfg, market.raw.ageSec);
    // Trending tabs: organic lists it's on, live viewers, KOTH, fresh-and-paid red flags, banned/Mayhem.
    const trCfg = cfg.trending ?? DEFAULT_CONFIG.trending;
    const trend = trCfg.enabled && this.trending
      ? trendScore(
          {
            info: this.trending.info(mint),
            ageSec: market.raw.ageSec,
            curveVelocity: market.raw.curveVelocity,
            dexPaid: !!dexPaid?.paid,
            boosts: dexTrend?.boosts ?? 0,
            bundlePct: market.raw.effectiveBundlePct ?? market.raw.earlyBuyerPct,
            insiderFlags: !!market.raw.insiderReasons?.length,
            devSoldFraction: market.raw.devSoldFraction,
          },
          trCfg,
        )
      : null;
    const dexFails: string[] = [];
    // KOLs (Cupsey, Cented…) in this coin: points per KOL; KOLs dumping = no buy.
    const kolCfg = cfg.kol ?? DEFAULT_CONFIG.kol;
    const kolAct = kolCfg.enabled ? await kolActivity(this.redis, mint, kolCfg).catch(() => null) : null;
    const kolBonus = kolPoints(kolAct, kolCfg);
    if (kolAct?.dumping) dexFails.push(`KOLs dumping (${kolAct.recentSellers.length} sold)`);
    // RUNNER: the organic flow that triggered it must still be there now (no coins that already faded).
    if (STRATEGY.name === 'RUNNER' && this.crowd) {
      if (market.raw.complete || market.raw.onAmm) dexFails.push('migrated — runners are curve coins');
      const rc = (cfg.runner ?? DEFAULT_CONFIG.runner).scan;
      const why = scanVerdict(organicFlow(this.crowd.trades(mint), Date.now()), market.raw.marketCapUsd ?? null, rc);
      if (why) dexFails.push(`runner flow faded: ${why}`);
    }
    // Staircase chart (owner: "avoid odd-looking staircase charts") → no buy, whatever the score.
    if (stair?.hit) dexFails.push(stair.why);
    const tfWhy = timeframeFail(tf, cfg.entry.timeframes ?? DEFAULT_CONFIG.entry.timeframes);
    if (tfWhy) dexFails.push(tfWhy);
    // Momentum gate (v11): block bad momentum.
    if (mgWhy) dexFails.push(`momentum gate: ${mgWhy}`);
    // Entry quality (v11): trade-level checks — dumping, seller floods, spike retraces, volume drying.
    const eqCfg = cfg.entryQuality ?? DEFAULT_ENTRY_QUALITY;
    const eqTrades = this.crowd ? this.crowd.trades(mint).slice(-200) : [];
    const eq = entryQuality(eqTrades, Date.now(), eqCfg);
    if (eq.verdict === 'block') dexFails.push(`entry quality: ${eq.reason}`);
    // RugCheck.xyz external safety score (v11): fail-open (network errors don't block).
    const rcCfg = cfg.rugCheck ?? DEFAULT_CONFIG.rugCheck;
    const rcResult = rcCfg.enabled ? await fetchRugCheck(mint).catch(() => null) : null;
    const rc: RugCheckVerdict = rugCheckVerdict(rcResult, rcCfg);
    if (!rc.pass) rc.reasons.forEach(r => dexFails.push(r));
    // Price-action rules: "not this coin" (the chart / the buyers say no) and "no room for the fees".
    if (paCfg.enabled && paRead && paRead.setup !== 'THIN') {
      if (paCfg.blockSetups.includes(paRead.setup)) dexFails.push(`chart: ${paRead.setup === 'BREAKDOWN' ? 'breakdown (lost support, sellers in control)' : `distribution (buyers only ${Math.round(paRead.buyVolShare60 * 100)}% of the last minute)`}`);
      if (paRead.manipulation > paCfg.maxManipulation) dexFails.push(`chart: manipulation ${paRead.manipulation.toFixed(2)} (top buyer ${Math.round(paRead.topBuyerShare60 * 100)}%, churn ${Math.round(paRead.churnRatio * 100)}%)`);
      if (paRead.trades60 < paCfg.minTrades60) dexFails.push(`only ${paRead.trades60} trades in the last minute (need ${paCfg.minTrades60})`);
      else if (paRead.uniqueBuyers60 < paCfg.minUniqueBuyers60) dexFails.push(`only ${paRead.uniqueBuyers60} buyers in the last minute (need ${paCfg.minUniqueBuyers60})`);
      const maxOff = paCfg.maxOffHighPctByStrategy?.[STRATEGY.name] ?? 0;
      if (maxOff > 0 && paRead.drawdownFromAthPct > maxOff) dexFails.push(`chart: ${paRead.drawdownFromAthPct.toFixed(0)}% under its recent high (max ${maxOff}%) — a failed run, not a dip`);
      const rtCost = (2 * poolFeeBps(cfg.paper, market.raw.onAmm || market.raw.complete, market.raw.marketCapSol)) / 100 + 2 * cfg.paper.slippagePct;
      const room = paRead.resistanceDistPct ?? paCfg.openSkyRoomPct;
      if (paCfg.minEdgeMultiple > 0 && room < paCfg.minEdgeMultiple * rtCost) dexFails.push(`only ${room.toFixed(0)}% to resistance (< ${paCfg.minEdgeMultiple}× the ${rtCost.toFixed(1)}% round-trip cost)`);
    }
    // KOL follow (owner: "trade more alongside coins a lot of KOLs buy"): the KOLs must still be in;
    // the more of them, the easier the bar and the bigger the size.
    // A trusted wallet (owner's top picks) counts as two.
    const kolsIn = kolAct ? effectiveKols(kolAct.buyers, kolCfg.trustedMinWeight ?? Infinity) : 0;
    let kolSize = 1;
    if (kolFollow) {
      if (kolsIn < kf.minKols) dexFails.push(`only ${kolsIn} KOL${kolsIn === 1 ? '' : 's'} still holding (need ${kf.minKols})`);
      threshold += kolsIn >= 3 ? kf.barDelta3 : kf.barDelta2;
      kolSize = kolsIn >= 3 ? kf.sizeMultiplier3 : kf.sizeMultiplier2;
    }
    // Vamps: a copy of a coin we already traded, or of a bigger coin with the same ticker / name.
    const vampWhy = this.vamp ? await this.vamp.check(mint, token.symbol, token.name) : null;
    if (vampWhy) dexFails.push(vampWhy);
    if (dexCfg.requirePaidFor?.includes(STRATEGY.name) && !(dexPaid?.paid || dexPaid?.cto)) dexFails.push(dexPaid ? 'not DEX paid' : 'DEX paid not checked yet');
    // Socials + keywords (from the metadata file, if it has been fetched).
    let socialInfo: { hasTwitter: boolean; blockedKeyword: string | null } | undefined;
    let socialFeatures = NEUTRAL_SOCIAL_FEATURES;
    // Hot right now: keywords trending on X + narratives shared by today's top coins.
    const hot = [...hotKeywords(), ...(this.leaders?.keywords() ?? []), ...(this.trending?.narratives() ?? [])];
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
      // X account, post or community — in the X field, or pasted into the website / Telegram field or description.
      socialInfo = { hasTwitter: hasXLink(token), blockedKeyword: kw.blocked };
      socialFeatures = { socials: socialsScore(token, await this.social.reuseCounts(token)), narrative: narrativeScore };
    } else {
      socialFeatures = { ...NEUTRAL_SOCIAL_FEATURES, narrative: narrativeScore };
      if (kw.blocked) socialInfo = { hasTwitter: false, blockedKeyword: kw.blocked };
    }

    const rules = () => [...checkEntryRules({ safetyScore: token.safetyScore!, safetyHardFail: token.safetyHardFail!, market: market.raw, strategy: STRATEGY, entry: cfg.entry, social: socialInfo, focus: cfg.focus, crowd }), ...manip.fails, ...dexFails, ...(newPair?.fails ?? []), ...(trend?.fails ?? []), ...(chart?.verdict === 'avoid' ? [`chart breaking down (${chart.summary})`] : [])];
    let ruleFails = rules();
    // Coins we started following late (trending lists / adopted pools): our ledger only covers trades since then,
    // so its fee / volume / holder totals are too low — those minimums can't be judged; everything else still is.
    const lateJoin = view.adopted || !view.creator;
    const partialLedger = (f: string) => /^(fees |volume \$|holders )/.test(f);
    if (lateJoin) ruleFails = ruleFails.filter((f) => !partialLedger(f));

    // Total fees so far use an ASSUMED priority fee + tip per trade. If fees are
    // the ONLY thing standing in the way, measure the real figure by sampling
    // recent transactions (~25 credits), then re-check.
    if (!token.safetyHardFail && ruleFails.length > 0 && ruleFails.every((f) => f.startsWith('fees '))) {
      const est = await this.fees.estimate(mint, token.bondingCurve, market.raw.buys + market.raw.sells, view.feesSol);
      this.stats.feeSamples++;
      market.raw.totalFeesSol = est.totalFeesSol;
      ruleFails = rules().filter((f) => !lateJoin || !partialLedger(f));
    }

    // The owner's own terminal filters (migrated / soon / new pair): EVERY buy must match its stage's set.
    const ofBase = cfg.ownerFilters ?? DEFAULT_CONFIG.ownerFilters;
    // v10.40: the market-cap fee rule (entry.feesByMarketCap, checked in the entry rules) replaces the per-stage fee minimums.
    const ofCfg = cfg.entry.feesByMarketCap?.enabled && market.raw.marketCapUsd !== null ? { ...ofBase, migrated: { ...ofBase.migrated, minTotalFeesSol: 0 }, soon: { ...ofBase.soon, minTotalFeesSol: 0 } } : ofBase;
    const owner = ownerFilterFails(
      {
        complete: market.raw.complete, onAmm: market.raw.onAmm, ageSec: market.raw.ageSec, marketCapUsd: market.raw.marketCapUsd, volumeUsd: market.raw.volumeUsd,
        liquidityUsd: market.raw.liquidityUsd ?? null, holders: market.raw.holders, totalFeesSol: market.raw.totalFeesSol, supplyStandard: market.raw.supplyStandard,
        name: token.name, symbol: token.symbol, lateJoin, narrative: token.metadataFetchedAt ? narrativeScore : null,
      },
      ofCfg,
    );
    ruleFails = [...ruleFails, ...owner.fails];
    // Buyers vs sellers right now (owner: "know whether buyers or sellers are getting high"): sellers in control → not now.
    // Copies too (owner: "don't blindly copy KOLs") — unless copies are set to buy the moment he buys.
    const prCfg = cfg.entry.pressure ?? DEFAULT_CONFIG.entry.pressure;
    const pressure = this.crowd ? flowPressure(this.crowd.trades(mint), Date.now(), prCfg) : null;
    const prWhy = STRATEGY.name === 'SMART_MONEY_COPY' && job.data.wallet && !kolFollow && cfg.copy.skipDipWait === true ? null : pressureFail(pressure, prCfg);
    if (prWhy) ruleFails = [...ruleFails, prWhy];
    // v11.6 wallet engine: WHO is buying — proven wallets lead → points; a dump crew inside / dumpers buying → no buy.
    // Funders come from the funding-graph cache only (never a new RPC call).
    const wbCfg = cfg.wallets ?? DEFAULT_CONFIG.wallets;
    const cqCfg = wbCfg.entry ?? DEFAULT_CONFIG.wallets.entry;
    let cq: CrowdQuality | null = null;
    let cqBuyers: string[] = [];
    if (wbCfg.enabled && cqCfg.enabled && this.walletBook && this.crowd) {
      const cqTrades = this.crowd.trades(mint);
      cqBuyers = [...new Set(cqTrades.filter((t) => t.buy).map((t) => t.w))].slice(0, 80);
      const launchMs = view.createdAtMs > 0 ? view.createdAtMs : null;
      const funders = await this.cachedFunders(cqTrades, Date.now(), launchMs);
      cq = crowdQuality({ trades: cqTrades, now: Date.now(), launchMs, creator: token.creator, supply: Number(view.curve.totalSupply || 1_000_000_000_000_000n) }, (w) => this.walletBook!.get(w), (w) => funders.get(w) ?? null, wbCfg, cqCfg);
      if (cq?.fails.length) ruleFails = [...ruleFails, ...cq.fails];
      // Deployer-funded launch snipers are dumpers everywhere from now on (wallet book + rugger memory).
      if (cq?.deployerSniperWallets.length) {
        this.walletBook.markDumpers(cq.deployerSniperWallets);
        const days = (cfg.antiRug as { rugGuard?: { ruggerMemoryDays?: number } }).rugGuard?.ruggerMemoryDays ?? 14;
        void this.ruggers?.record(cq.deployerSniperWallets, days).catch(() => undefined);
      }
    }

    // Learned odds: how often coins with the same patterns went on to win (bounded ±points).
    const lc = cfg.learning ?? DEFAULT_CONFIG.learning;
    // This strategy's own odds once it has enough outcomes (≥3× the per-pattern minimum), else all strategies together.
    const pats = patternsOf({ market: market.raw as unknown as StoredFeatures['market'], socials: { twitter: token.twitter, website: token.website, telegram: token.telegram } }, STRATEGY.name);
    const stratPrior = beliefCache().get(strategyPattern(STRATEGY.name, ALL_PATTERN));
    const ownOdds = !!stratPrior && stratPrior.observations >= lc.oddsMinSamples * 3;
    const odds: LearnedOdds | null = lc.oddsEnabled
      ? learnedOddsAdjustment(
          ownOdds ? pats.map((x) => strategyPattern(STRATEGY.name, x)) : pats,
          beliefCache(),
          ownOdds ? stratPrior : beliefCache().get(ALL_PATTERN),
          { minSamples: lc.oddsMinSamples, priorStrength: lc.oddsPriorStrength, maxPoints: lc.oddsMaxPoints, pointsPerLogit: lc.oddsPointsPerLogit },
        )
      : null;
    // Final score = weighted features + learned pattern odds − manipulation penalty, then
    // calibrated by how this strategy's score band has REALLY done lately (high scores that
    // keep losing get marked down). `pre` (before calibration) is what calibration measures.
    const score = (f: FeatureVector): Scored => {
      const r = withOdds(scoreFeatures(f, weights), odds);
      const pre = Math.round((r.score - manip.penalty + dexBonus.points + kolBonus.points + chartPoints + (newPair?.points ?? 0) + taBonus.points + (trend?.points ?? 0) + eq.points + (cq?.points ?? 0)) * 100) / 100;
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

    // X: what the coin's X link is (profile / post / community), copy-paste reuse, and — close to a buy,
    // with a token — live followers / engagement / members / who is posting the contract address.
    const xc = cfg.x?.check ?? DEFAULT_CONFIG.x.check;
    let xv: XVerdict | null = null;
    if (xc.enabled && token.metadataFetchedAt) {
      const xUrl = xLinkOf(token);
      const reused = await xLinkReuse(this.redis, xUrl).catch(() => 0);
      const live = xc.live && ruleFails.length === 0 && !token.safetyHardFail && result.score >= threshold - xc.liveWithinPoints ? await xLive(this.redis, mint, xUrl, xc.maxReadsPerDay).catch(() => null) : null;
      xv = xVerdict(parseXLink(xUrl), reused, live);
      threshold -= xv.points;
    }

    // AI coach rules (tested on new trades before they go live): avoid → no buy, prefer → easier bar.
    // Same feature shape as the stored evaluation, so live and backtest read identical numbers.
    const aiFlat = flattenFeatures(
      {
        market: market.raw,
        crowd,
        manipulation: manip,
        newPair: earlyFlow ? { flow: earlyFlow, fails: newPair?.fails ?? [] } : null,
        trending: trend && (trend.points || trend.fails.length) ? trend : null,
        kol: kolAct ? { kols: kolAct.buyers.length, trusted: kolAct.buyers.filter((b) => b.weight >= (kolCfg.trustedMinWeight ?? Infinity)).length, dumping: kolAct.dumping } : null,
        chart: chart ? { vsVwapPct: chart.vsVwapPct, rsi: chart.rsi, pullbackPct: chart.pullbackPct } : null,
        swing,
        shape,
        tf,
        pa,
        x: xv?.features ?? null,
        pressure: pressure ? { buySharePct: pressure.buySharePct, prevBuySharePct: pressure.prevBuySharePct, buySol: pressure.buySol, sellSol: pressure.sellSol } : null,
        mood: moodNow(),
      },
      { score: result.score, kols: kolsIn, mcUsd: market.raw.marketCapUsd ?? null, ageMin: market.raw.ageSec / 60, hourUtc: new Date().getUTCHours(), dowUtc: new Date().getUTCDay() },
    );
    const aiVerdict = aiRuleVerdict(STRATEGY.name, aiFlat, cfg.aiCoach ?? DEFAULT_CONFIG.aiCoach);
    if (aiVerdict.fail) ruleFails = [...ruleFails, aiVerdict.fail];
    threshold += aiVerdict.barDelta;
    // Win-probability model (brain.ts): once it beats the score on newer trades, likely winners get an easier bar,
    // likely losers a harder one (±10). 0 points while it hasn't proven itself.
    const wm = this.brain?.model.predict(aiFlat, STRATEGY.name) ?? null;
    if (wm?.points && !sniperOn()) threshold -= wm.points; // v11.7: watch-only in sniper mode (feature still stored)
    // …and sizes the trade: ×0.7–1.3 by how much better / worse than usual it expects this one to do.
    const modelSize = wm?.points && !sniperOn() ? Math.max(0.7, Math.min(1.3, 1 + (wm.p - wm.baseRate) * 2)) : 1;
    const modelNote = wm?.points ? `win model: ${Math.round(wm.p * 100)}% chance to win vs ${Math.round(wm.baseRate * 100)}% usual → bar ${wm.points > 0 ? '−' : '+'}${Math.abs(wm.points)}${modelSize !== 1 ? `, size ×${modelSize.toFixed(2)}` : ''}` : null;

    // Many KOLs still in (owner: "okay if top holders are a bit high when a lot of KOLs are buying"): concentration limits
    // up to the higher-risk caps don't block. Every other rule (rug, bundle, pressure, dip entry…) still applies.
    const relax = kolCfg.concentrationRelax ?? DEFAULT_CONFIG.kol.concentrationRelax;
    const reCaps = cfg.entry.riskyEntry;
    let kolRelaxNote: string | null = null;
    if (
      relax.enabled && kolsIn >= relax.minKols && ruleFails.length > 0 && ruleFails.every(isSoft) &&
      (market.raw.effectiveBundlePct ?? market.raw.earlyBuyerPct) <= reCaps.maxBundlePct && market.raw.top10HolderPct <= reCaps.maxTop10Pct && (market.raw.effectiveMaxHolderPct ?? market.raw.maxHolderPct) <= reCaps.maxSingleHolderPct
    ) {
      kolRelaxNote = `${ruleFails.join(', ')} — allowed: ${kolAct?.buyers.length ?? 0} KOLs still holding`;
      ruleFails = [];
    }
    let { decision, reasons } = decide(result.score, threshold, ruleFails, token.safetyHardFail);

    // "Still worth a shot": only soft concentration limits broken, within looser caps,
    // and a clearly strong score → buy at reduced size (the learner tracks how these do).
    let risky: string | null = null;
    const re = cfg.entry.riskyEntry;
    if (
      decision === 'SKIP' && re.enabled && STRATEGY.name !== 'CURVE_SNIPE' && ruleFails.length > 0 && ruleFails.every(isSoft) &&
      (market.raw.effectiveBundlePct ?? market.raw.earlyBuyerPct) <= re.maxBundlePct && market.raw.top10HolderPct <= re.maxTop10Pct && (market.raw.effectiveMaxHolderPct ?? market.raw.maxHolderPct) <= re.maxSingleHolderPct &&
      result.score >= threshold + re.extraScore
    ) {
      risky = ruleFails.join(', ');
      decision = 'BUY';
      reasons = [`higher-risk entry at ${re.sizeMultiplier}× size: ${risky}`, `score ${result.score.toFixed(1)} ≥ ${threshold + re.extraScore}`];
    }
    // Learning trade (owner: trade more often so it learns): passes EVERY rule, just short on score
    // → bought at a small size. Score calibration then learns whether that score band really pays.
    const ex = cfg.explore ?? DEFAULT_CONFIG.explore;
    let explore = false;
    if (decision === 'SKIP' && ex.enabled && ex.strategies.includes(STRATEGY.name) && ruleFails.length === 0 && !token.safetyHardFail && result.score >= threshold - exploreMargin(ex)) {
      explore = true;
      decision = 'BUY';
      reasons = [`learning trade: score ${result.score.toFixed(1)} vs bar ${threshold.toFixed(0)} (within ${exploreMargin(ex)}) — bought at ${ex.sizeMultiplier}× size`];
    }
    // Edge gate (v11.3): a strategy whose record since it went live says it loses after costs doesn't buy — except
    // every Nth refused signal, bought at the minimum size, so its record keeps updating and it can earn its way back.
    // After the learning-trade step on purpose: learning trades are the data the gate judges by.
    const egCfg = { ...DEFAULT_EDGE_GATE, ...(cfg.entry.edgeGate ?? {}) };
    let edgeProbe = false;
    let egInfo: { pass: boolean; expectedEdgePct: number; probe: boolean; reason: string } | null = null;
    if (decision === 'BUY' && !explore && egCfg.enabled) {
      const eg = edgeGateVerdict(strategyEdgeStatsFor(STRATEGY.name), result.score - threshold, egCfg);
      egInfo = { pass: eg.pass, expectedEdgePct: Math.round(eg.expectedEdgePct * 10) / 10, probe: false, reason: eg.reason };
      if (!eg.pass) {
        const n = (this.edgeRefused.get(STRATEGY.name) ?? 0) + 1;
        this.edgeRefused.set(STRATEGY.name, n);
        if (probeTurn(n, egCfg.probeEvery)) {
          edgeProbe = true;
          egInfo.probe = true;
          reasons = [...reasons, `edge-gate probe (1 in ${egCfg.probeEvery}): ${eg.reason} — minimum size so ${STRATEGY.name}'s record keeps updating`];
        } else {
          decision = 'SKIP';
          reasons = [`edge gate: ${eg.reason}`];
        }
      }
    }
    // Sniper mode (v11.7): a buy only when everything lines up — real 5-min volume, score well over the bar, momentum /
    // entry quality / edge gate / pressure / crowd green; no learning, probe or half-size entries.
    const snCfg = cfg.sniper ?? DEFAULT_CONFIG.sniper;
    let sniperInfo: { fails: string[] } | null = null;
    if (snCfg.enabled && decision === 'BUY') {
      const flow5 = this.crowd ? organicFlow(this.crowd.trades(mint), Date.now()) : null;
      const fails = sniperEntryFails(
        { flow: flow5, score: result.score, threshold, momentumGateWhy: mgWhy, entryQualityVerdict: eq.verdict, edgeGatePass: egInfo ? egInfo.pass : null, pressureSellersInControl: prWhy !== null, crowd: cq, explore, probe: edgeProbe, risky: risky !== null, dipEntry: job.data.dip === true },
        snCfg,
      );
      sniperInfo = { fails };
      if (fails.length) {
        decision = 'SKIP';
        reasons = fails.map((f) => `sniper: ${f}`);
        explore = false;
        risky = null;
        edgeProbe = false;
      }
    }
    // Funnel (Bot health → strategies): did it pass every rule, was it a buy signal before any wait?
    const rulesOk = ruleFails.length === 0 && !token.safetyHardFail;
    const signalled = decision === 'BUY';
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
          features: json({ checkpointSec, features, contributions: result.contributions, learnedOdds: odds, preCalibrationScore: result.pre, calibration: result.cal, manipulation: manip, dex: { paid: dexPaid?.paid ?? null, cto: dexPaid?.cto ?? null, trendingRank: dexTrend?.rank ?? null }, chart: chart ? { verdict: chart.verdict, summary: chart.summary, vsVwapPct: chart.vsVwapPct, rsi: chart.rsi, trend: chart.trend, pullbackPct: chart.pullbackPct } : null, newPair: earlyFlow ? { flow: earlyFlow, fails: newPair?.fails ?? [] } : null, ta: taBonus.points ? taBonus : null, trending: trend && (trend.points || trend.fails.length) ? trend : null, kol: kolAct ? { kols: kolAct.buyers.length, trusted: kolAct.buyers.filter((b) => b.weight >= (kolCfg.trustedMinWeight ?? Infinity)).length, names: kolAct.buyers.map((b) => b.name), dumping: kolAct.dumping } : null, copied: job.data.wallet ? 1 : 0, owner: { profile: owner.profile, fails: owner.fails }, pressure, wallets: cq, mood: moodNow(), market: market.raw, shape, tf, pa, x: xv ? { ...xv.features, points: xv.points } : null, winModel: wm && wm.p > 0 ? { p: Math.round(wm.p * 1000) / 1000, baseRate: Math.round(wm.baseRate * 1000) / 1000, points: wm.points } : null, momentumGate: mgWhy ? { blocked: true, reason: mgWhy } : null, edgeGate: egInfo, sniper: sniperInfo, entryQuality: eq.verdict !== 'ok' ? { verdict: eq.verdict, reason: eq.reason, points: eq.points } : null, rugCheck: rc.result ? { score: rc.score, riskLevel: rc.riskLevel, pass: rc.pass, reasons: rc.reasons } : null, creator: profile, crowd, swing, socials: { twitter: token.twitter, telegram: token.telegram, website: token.website, keyword: kw } }),
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

    this.obsidian?.onEvaluation({
      mint, symbol: token.symbol ?? null, name: token.name ?? null, strategy: STRATEGY.name, decision, score: result.score, threshold, reasons,
      mcUsd: market.raw.marketCapUsd ?? null, migrated: !!(market.raw.complete || market.raw.onAmm), firstSeenMs: view.createdAtMs > 0 ? view.createdAtMs : 0,
      buyerWallets: cqBuyers, deployerSniperWallets: cq?.deployerSniperWallets ?? [], crowdNote: cq?.note ?? null,
      dumpCrew: (cq?.dumpersInside ?? 0) > 0 || (cq?.deployerSnipers ?? 0) > 0, provenCrowd: (cq?.provenSolPct ?? 0) >= 20,
    });
    if (decision === 'REJECT') noteSkip(STRATEGY.name, ruleFails[0] ?? reasons[0] ?? 'rejected');
    if (decision === 'REJECT') {
      noteEvaluation(STRATEGY.name, { rulesOk, signal: false, outcome: 'none' });
      this.stats.rejects++;
      await markDone();
      return;
    }
    // Curve snipes stop at migration (the migration strategy takes over from there).
    if (market.raw.complete && (STRATEGY.name === 'CURVE_SNIPE' || STRATEGY.name === 'SOON')) return void (await markDone());

    // Don't buy the top: a stretched chart waits for a dip into the buy zone (the dip watcher
    // re-checks the coin when it dips and bounces — that re-check skips this and the confirmation).
    const dipEntry = job.data.dip === true;
    // A copy trade buys when the copied wallet buys (owner: "you're allowed to copy trade him") — no dip waits.
    const copyNow = STRATEGY.name === 'SMART_MONEY_COPY' && !!job.data.wallet && !kolFollow;
    const noWaitCopy = copyNow && cfg.copy.skipDipWait !== false;
    // Fresh low-cap pairs (owner's rule: under ~$15k MC) are bought straight away — waiting for a
    // dip there mostly means missing the move.
    const noDipWait = market.raw.marketCapUsd !== null && market.raw.marketCapUsd < (chartCfg.dip.noWaitBelowMcUsd ?? 15_000);
    // Entry style the loss autopsy learned for this strategy (e.g. "its losers never went up → only buy after a
    // pullback", "chasing +50% in 3 min keeps losing"): don't buy now, wait for the dip — that changes HOW it enters.
    const style = entryStyleFor(STRATEGY.name);
    const styleWhy = decision === 'BUY' && !dipEntry && !explore && !noWaitCopy ? entryStyleBlock(style, shape) : null;
    if (styleWhy) {
      const high = chart?.recentHigh && chart.recentHigh > 0 ? chart.recentHigh : market.raw.priceSol / Math.max(0.01, 1 - (shape?.offHigh10m ?? 0) / 100);
      const zone = chart?.zone ?? pullbackZone(high, style?.minOffHighPct ?? 0);
      if (chartCfg.dip.enabled && this.dips && !(STRATEGY.name === 'CURVE_SNIPE' && noDipWait)) {
        this.dips.add({ mint, symbol: token.symbol, strategy: STRATEGY.name, zone, signalPrice: market.raw.priceSol, high, why: `learned entry rule: ${styleWhy}`, swing, wallet: job.data.wallet });
        reasons = [`waiting for a dip (learned entry rule): ${styleWhy}`];
      } else reasons = [`learned entry rule: ${styleWhy}`];
      decision = 'SKIP';
    }
    if (decision === 'BUY' && !dipEntry && !noDipWait && !noWaitCopy && chart?.verdict === 'wait_dip' && chart.zone && chartCfg.dip.enabled && this.dips) {
      this.dips.add({ mint, symbol: token.symbol, strategy: STRATEGY.name, zone: chart.zone, signalPrice: market.raw.priceSol, high: chart.recentHigh, why: chart.summary, swing, wallet: job.data.wallet });
      decision = 'SKIP';
      reasons = [`waiting for a dip: ${chart.summary}`];
    }
    // Price action says "right coin, wrong moment" (vertical last minute / far above its trend line) → wait for a dip.
    // (v10.16: with only the dip-wait switch on, the broad EXTENDED label alone no longer delays buys — it held back most
    // signals; a real chase = +40% in 60 s or 30% over the trend line.)
    const stretched = (paCfg.enabled || paCfg.dipWait?.enabled) && paRead && paRead.setup !== 'THIN' && ((paCfg.enabled && paRead.setup === 'EXTENDED') || paRead.change60Pct > paCfg.maxChange60Pct || paRead.extensionPct > paCfg.maxExtensionPct);
    if (decision === 'BUY' && !dipEntry && !noDipWait && !explore && !noWaitCopy && stretched && chartCfg.dip.enabled && this.dips && paRead) {
      const high = paRead.athPriceSol > 0 ? paRead.athPriceSol : market.raw.priceSol;
      const why = `+${paRead.change60Pct.toFixed(0)}% in 60 s, ${paRead.extensionPct.toFixed(0)}% above its trend line`;
      this.dips.add({ mint, symbol: token.symbol, strategy: STRATEGY.name, zone: chart?.zone ?? pullbackZone(high, 10), signalPrice: market.raw.priceSol, high, why, swing, wallet: job.data.wallet });
      decision = 'SKIP';
      reasons = [`waiting for a dip (stretched): ${why}`];
    }
    // Owner's rule (v10.24): at/above $15k MC only buy a dip — wait for a pullback off the recent high + a bounce with
    // buyers (dip watcher); under $15k the signal is bought straight away. No dip in time = no buy.
    const dipOnly = chartCfg.dip.dipOnly ?? DEFAULT_CONFIG.chart.dip.dipOnly;
    const dipOnlyHere = decision === 'BUY' && !noWaitCopy && this.dips && chartCfg.dip.enabled && dipOnlyApplies({ enabled: dipOnly.enabled, mcUsd: market.raw.marketCapUsd, minMcUsd: chartCfg.dip.noWaitBelowMcUsd ?? 15_000, dipEntry, swing });
    // …unless there's a crazy amount of real volume right now (owner) → buy straight away.
    const hotWhy = dipOnlyHere && this.crowd ? hotVolume(organicFlow(this.crowd.trades(mint), Date.now()), dipOnly.hotVolume) : null;
    if (hotWhy) reasons = [...reasons, `bought without waiting for a dip — ${hotWhy}`];
    if (dipOnlyHere && !hotWhy && this.dips) {
      const high = dipOnlyHigh(market.raw.priceSol, chart?.recentHigh, shape?.offHigh10m);
      const zone = pullbackZone(high, dipOnly.minPullbackPct);
      const why = `dip-only above $${((chartCfg.dip.noWaitBelowMcUsd ?? 15_000) / 1000).toFixed(0)}k MC — waiting for ${dipOnly.minPullbackPct}%+ off the high and a bounce`;
      this.dips.add({ mint, symbol: token.symbol, strategy: STRATEGY.name, zone, signalPrice: market.raw.priceSol, high, why, swing, wallet: job.data.wallet });
      decision = 'SKIP';
      reasons = [`waiting for a dip (${why})`];
    }
    // Confirmation delay: re-check a BUY signal a few seconds later before any money moves.
    if (decision === 'BUY' && !dipEntry && !(copyNow && cfg.copy.skipConfirm !== false)) {
      // New pairs are bought on the spot: their absorption + live-demand checks ARE the confirmation.
      const confirmSec = STRATEGY.name === 'CURVE_SNIPE' ? (npCfg.confirmDelaySec ?? 0) : (cfg.entry.confirmDelaySec ?? 0);
      const pending = job.data.confirm;
      const cc = cfg.entry.confirm;
      const needed = Math.max(1, cc.consecutivePasses ?? 1);
      const interval = Math.max(1, cc.intervalSec ?? 7);
      if (confirmSec > 0 && !pending) {
        // One confirmation at a time per coin + strategy (held for every pass).
        const fresh = await this.redis.set(`confirm:${mint}:${STRATEGY.name}`, '1', 'EX', confirmHoldSec(confirmSec, needed, interval) + 10, 'NX');
        if (!fresh) return;
        await evaluateQueue.add(
          'confirm',
          { ...job.data, checkpointSec: checkpointSec + confirmSec, confirm: { priceSol: market.raw.priceSol, at: Date.now(), score: result.score } },
          { jobId: `${mint}-${STRATEGY.name}-confirm-${Math.floor(Date.now() / 60_000)}`, delay: confirmSec * 1000 },
        );
        log.info({ mint, symbol: token.symbol, score: result.score }, `⏱  BUY signal ${token.symbol} (${result.score.toFixed(1)}) — confirming in ${confirmSec}s`);
        noteEvaluation(STRATEGY.name, { rulesOk, signal: signalled, outcome: 'confirming' });
        return; // the confirmation job carries on (incl. the end-of-schedule watchlist)
      }
      if (pending && pending.priceSol > 0) {
        const c = cfg.entry.confirm;
        const drift = (market.raw.priceSol / pending.priceSol - 1) * 100;
        const ratio = crowd?.buyRatio2m ?? null;
        // v11: require new unique buyers appeared during the confirmation window
        const confirmTrades = this.crowd ? this.crowd.trades(mint).filter((t) => t.t >= pending.at) : [];
        const confirmBuyers = new Set(confirmTrades.filter((t) => t.buy).map((t) => t.w)).size;
        const minConfirmBuyers = c.minNewBuyers ?? 2;
        const why =
          drift < -c.maxDropPct ? `price fell ${Math.abs(drift).toFixed(0)}% while confirming`
          : drift > c.maxPumpPct ? `ran ${drift.toFixed(0)}% while confirming (not chasing)`
          : ratio !== null && ratio < c.minBuyRatio ? `sellers took over (buy/sell ${ratio.toFixed(2)})`
          : confirmBuyers < minConfirmBuyers ? `only ${confirmBuyers} new buyer(s) during confirmation (need ${minConfirmBuyers})`
          : null;
        if (why) {
          log.info({ mint, symbol: token.symbol, why }, `✋ ${token.symbol} signal didn't confirm: ${why}`);
          decision = 'SKIP';
          reasons = [`didn't confirm: ${why}`];
        } else if (confirmStep(true, pending.passes ?? 0, needed) === 'again') {
          // v11.8: one good reading isn't proof (a rugged pool's numbers lag) — read it again `interval` s later.
          const passes = (pending.passes ?? 0) + 1;
          await evaluateQueue.add(
            'confirm',
            { ...job.data, checkpointSec: checkpointSec + interval, confirm: { ...pending, passes } },
            { jobId: `${mint}-${STRATEGY.name}-confirm${passes}-${Math.floor(Date.now() / 60_000)}`, delay: interval * 1000 },
          );
          log.info({ mint, symbol: token.symbol, passes, needed }, `⏱  ${token.symbol} confirmation ${passes}/${needed} passed — checking again in ${interval}s`);
          noteEvaluation(STRATEGY.name, { rulesOk, signal: signalled, outcome: 'confirming' });
          return;
        }
      }
    }

    // Strategy lab: every BUY signal (whether or not the trader has room) and every near-miss
    // (rules pass, score just short) is traded virtually by each exit setup under test.
    if (this.lab) {
      const labCfg = cfg.lab ?? DEFAULT_CONFIG.lab;
      const near = (decision === 'SKIP' || explore) && ruleFails.length === 0 && !dipEntry && result.score >= threshold - labCfg.nearMissMargin && !reasons.some((r) => r.startsWith('waiting for a dip') || r.startsWith("didn't confirm"));
      if ((decision === 'BUY' && !explore) || near) this.lab.onSignal({ mint, symbol: token.symbol, strategy: STRATEGY.name, kind: decision === 'BUY' && !explore ? 'buy' : 'near', priceSol: market.raw.priceSol, onAmm: market.raw.onAmm });
    }

    // Shadow trade: a pretend trade on a coin it doesn't buy, so the learners see what skipping cost.
    const shadowOf = (kind: ShadowKind, why: string) =>
      this.shadow?.onSignal({
        mint,
        symbol: token.symbol,
        strategy: STRATEGY.name,
        kind,
        why,
        score: result.score,
        bar: threshold,
        priceSol: market.raw.priceSol,
        onAmm: market.raw.onAmm,
        mcUsd: market.raw.marketCapUsd ?? null,
        ageMin: market.raw.ageSec / 60,
        curvePct: market.raw.complete || market.raw.onAmm ? 'migrated' : market.raw.bondingCurvePct,
        kols: kolsIn,
        run3m: shape?.run3m ?? null,
        offHigh10m: shape?.offHigh10m ?? null,
        flat: aiFlat,
      });
    let shadowed = false;
    if (decision === 'SKIP' && !reasons.some((r) => r.startsWith('waiting for a dip'))) {
      if (ruleFails.length === 0) shadowed = !!shadowOf('near', reasons[0] ?? 'score under the bar');
      else shadowed = !!shadowOf('skipped', ruleFails[0]!);
    }
    // Every other coin it looked at and didn't buy: what would buying it now have made? (labelled 45 min later)
    if (decision === 'SKIP' && !shadowed && market.raw.priceSol > 0) {
      this.coinOutcomes?.record({ mint, symbol: token.symbol, strategy: STRATEGY.name, atMs: Date.now(), onAmm: market.raw.onAmm, marketCapSol: market.raw.marketCapSol ?? null, score: result.score, bar: threshold, why: ruleFails[0] ?? reasons[0] ?? 'skipped', flat: aiFlat });
    }

    const r0 = reasons[0] ?? '';
    noteEvaluation(STRATEGY.name, {
      rulesOk,
      signal: signalled,
      outcome: decision === 'BUY' ? 'toTrader' : !signalled ? 'none' : r0.startsWith('waiting for a dip') ? 'dipWait' : r0.startsWith("didn't confirm") ? 'notConfirmed' : 'heldBack',
    });
    if (decision === 'BUY') noteSignal();
    else noteSkip(STRATEGY.name, ruleFails[0] ?? (result.score < threshold ? 'score under the bar' : reasons[0] ?? 'skipped'));
    if (decision === 'BUY') {
      this.stats.buys++;
      log.info({ mint, symbol: token.symbol, score: result.score, checkpointSec, holders: market.raw.holders, curvePct: +market.raw.bondingCurvePct.toFixed(1), explore }, `🎯 ${explore ? 'learning ' : ''}BUY ${token.symbol} confirmed (${result.score.toFixed(1)})`);
      // Conviction sizing: more on the strongest setups, less on borderline ones.
      const conv = convictionFactor({
        scoreMargin: result.score - threshold,
        calibrationFactor: result.cal.factor,
        crowdScore: crowd?.crowdScore ?? null,
        min: cfg.trading.minConvictionMultiple ?? 0.4,
        max: cfg.trading.maxConvictionMultiple ?? 1.6,
      });
      const copyMult = kolFollow ? kolSize : STRATEGY.name === 'SMART_MONEY_COPY' ? (cfg.copy.sizeMultiplier ?? 0.5) : 1;
      const asCfg = cfg.adaptiveStop ?? DEFAULT_ADAPTIVE_STOP;
      const asf = adaptiveStopMultiplier({ entryQualityVerdict: eq.verdict, rugCheckScore: rc.score ?? null, score: result.score, threshold }, asCfg)
        * mcAgeStopMultiplier(market.raw.marketCapUsd ?? null, market.raw.ageSec != null ? market.raw.ageSec / 60 : null, asCfg);
      const res = await this.trader.tryEnter({ probe: edgeProbe,
        mint,
        symbol: token.symbol,
        strategy: STRATEGY.name,
        evaluationId,
        score: result.score,
        market: market.raw,
        maxSlippageBps: STRATEGY.maxSlippageBps,
        features,
        copiedWallet: job.data.wallet,
        kols: kolsIn,
        kolFollow,
        sizeMultiplier: tune.sizeFactor * (explore
          ? ex.sizeMultiplier * coach.sizeFactor * (trend?.sizeFactor ?? 1)
          : (risky ? re.sizeMultiplier : 1) * (focusRules?.sizeMultiplier ?? (STRATEGY.name === 'CURVE_SNIPE' ? npCfg.sizeMultiplier : STRATEGY.name === 'RUNNER' ? (cfg.runner ?? DEFAULT_CONFIG.runner).sizeMultiplier : 1)) * coach.sizeFactor * conv.factor * copyMult * (trend?.sizeFactor ?? 1) * modelSize),
        swing,
        explore,
        adaptiveStopFactor: asf,
        explain: (sizeSol) =>
          explainBuy({ symbol: token.symbol, strategy: STRATEGY.name, score: result.score, threshold, contributions: result.contributions, features, market: market.raw, sizeSol, regime, risky, copiedWallet: job.data.wallet, odds, narrativeReason, chartNote: chart ? `${chart.summary}${dipEntry ? ` — bought the dip: ${job.data.dipWhy ?? ''}` : ''}` : null, crowdSummary: crowd?.summary ?? null, swingNote: swing ? job.data.swingWhy ?? 'swing re-entry' : null, coachNote: coach.note, sizeNote: explore ? `learning trade ×${ex.sizeMultiplier} (score just under the bar)` : conv.note + (copyMult !== 1 ? `, copy ×${copyMult}` : ''), scoreNotes: [...(explore ? [`LEARNING TRADE: score ${result.score.toFixed(1)} is just under the bar ${threshold.toFixed(0)} — bought small so the bot learns whether these near-misses pay`] : []), ...(newPair?.notes ?? []), ...taBonus.notes.map((n) => `chart setup: ${n}`), ...(trend?.notes ?? []), ...aiVerdict.notes, ...(modelNote ? [modelNote] : []), ...(xv?.notes ?? []).map((n) => `X: ${n}`), ...kolBonus.notes, ...(kolRelaxNote ? [`top holders high but KOLs in: ${kolRelaxNote}`] : []), ...(pressure ? [`buyers ${pressure.buySharePct}% of the last ${prCfg.windowSec}s${pressure.prevBuySharePct !== null ? ` (was ${pressure.prevBuySharePct}%)` : ''}`] : []), ...(cq ? [cq.note] : []), ...dexBonus.notes.map((n) => `${n} (+)`), ...manip.notes, ...(result.cal.note ? [result.cal.note] : []), ...(rc.result && rc.pass ? [`RugCheck: score ${rc.score}, ${rc.riskLevel}`] : []), ...(eq.verdict === 'boost' ? [`entry quality: ${eq.reason}`] : [])], insiderNote: profile?.insider?.reasons?.length ? profile.insider.reasons.slice(0, 2).join('; ') : null }),
      });
      if (!res.entered && !/^(already traded|still holding)/.test(res.reason)) shadowOf('refused', res.reason);
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
  async checkNow(mint: string, strategy: StrategyName, why: string, opts: { swing?: boolean; dip?: boolean; wallet?: string; bucketSec?: number; rescan?: boolean } = {}): Promise<void> {
    // One "check now" per coin + strategy + kind per bucket (default a minute; fresh pairs re-check faster).
    const bucket = Math.floor(Date.now() / ((opts.bucketSec ?? 60) * 1000));
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
        ...(opts.rescan ? { rescan: true } : {}),
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
