/**
 * Swing trader — buys confirmed dips on BIGGER coins (v7, strategy SWING).
 *
 * Every `swing.everySec` each coin the swing universe follows live (scanner/swing-universe.ts)
 * gets a cheap look: the live dip-and-bounce setup (evaluator/swing.ts swingSetup) and the
 * dip-type chart strategies (`swing.taStrategies`). Only when one of them fires does it run the
 * full decision (swingDecision): safety check result, live market cap / liquidity, activity,
 * fake volume, KOLs, trending flags, top-10 holders (RPC, cached), bounce-back power — then the
 * score calibration (the strategy's real record per score band) and the trade coach's bar.
 * BUY → the trader (all its risk gates, the pre-entry rug screen, swing re-entry cooldowns).
 * Near-misses that pass every rule can become small learning trades (config `explore`).
 * BUYs and interesting skips are stored as evaluations, so the outcome labeler and calibration
 * learn from them like every other strategy.
 */
import type { Prisma } from '@prisma/client';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { STRATEGIES } from '../config/strategies';
import { analyzeMarket } from '../evaluator/market-analyzer';
import { convictionFactor } from '../evaluator/scorer';
import { bounceBack, bounceSummary, swingDecision, swingSetup, swingSizeForMc, toBars, type SwingVerdict } from '../evaluator/swing';
import { runStrategies, taContext } from '../evaluator/ta/strategies';
import { explainSwingBuy } from '../learner/explain';
import type { OutcomeLabeler } from '../learner/outcome-labeler';
import { currentRegime } from '../learner/regime-detector';
import { calibration, calibrationAdjust } from '../learner/score-calibration';
import type { TaLab } from '../learner/ta-lab';
import { coachFor } from '../learner/trade-coach';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { bondingCurveAddress } from '../lib/pump-pda';
import { PUMP_DEFAULT_TOTAL_SUPPLY, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';
import { getSolUsd } from '../lib/sol-price';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { kolActivity } from '../scanner/kol-signal';
import { deriveMetrics, type LiveState } from '../scanner/live-state';
import type { SwingCoin, SwingUniverse } from '../scanner/swing-universe';
import type { TrendingHub } from '../scanner/trending-hub';
import type { Trader } from './trader';
import type { VampGuard } from '../evaluator/vamp-guard';
import { exitRulesFor } from './sell-manager';

const log = moduleLogger('swing-trader');
/** A coin's buy signal is stored at most this often (a refused buy is retried every tick). */
const STORE_EVERY_MS = 60_000;

/**
 * Top-10 holders' share of supply (%), from RPC getTokenLargestAccounts (1 call). The pool's own
 * token vault and the old bonding curve's account don't count. null = lookup failed.
 */
export async function topHoldersPct(mint: string, pool: string | null): Promise<number | null> {
  try {
    const mintKey = new PublicKey(mint);
    const exclude = new Set<string>();
    for (const owner of [pool, bondingCurveAddress(mint)]) {
      if (!owner) continue;
      for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) exclude.add(getAssociatedTokenAddressSync(mintKey, new PublicKey(owner), true, new PublicKey(prog)).toBase58());
    }
    const res = await getConnection().getTokenLargestAccounts(mintKey, 'confirmed');
    const amounts = res.value
      .filter((a) => !exclude.has(a.address.toBase58()))
      .map((a) => Number(a.amount))
      .sort((a, b) => b - a);
    const top = amounts.slice(0, 10).reduce((s, x) => s + x, 0);
    return Math.round((top / Number(PUMP_DEFAULT_TOTAL_SUPPLY)) * 1000) / 10;
  } catch (err) {
    log.debug({ mint, err: (err as Error).message }, 'top holders lookup failed');
    return null;
  }
}

/** The swing exit plan in words, from the live rules (e.g. "50% at 1.1x, 25% at 1.2x … stop 10–12%"). */
export function swingPlan(r: ReturnType<typeof exitRulesFor>): string {
  const tiers = r.takeProfitTiers.map((t) => `${t.sellPct}% at ${t.multiple}x`).join(', ');
  const sl = r.stopLoss as { minPct: number; maxPct: number; minPctByStrategy?: Record<string, number>; maxPctByStrategy?: Record<string, number> };
  const lo = sl.minPctByStrategy?.SWING ?? sl.minPct;
  const hi = Math.min(sl.maxPct, sl.maxPctByStrategy?.SWING ?? sl.maxPct);
  const spike = r.spikeSell?.enabled ? `; a +${r.spikeSell.risePct}% spike within ${Math.round(r.spikeSell.windowSec / 60)} min sells ${r.spikeSell.sellPct}% of the rest` : '';
  return `${tiers}, then a tight trailing stop + break-even floor from ${r.trail.breakEvenAfterMultiple}x${spike}; stop ${lo}–${hi}% after fees`;
}

function json(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export class SwingTrader {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Latest stored buy signal per coin (a refused buy retried within a minute reuses it). */
  private readonly lastStored = new Map<string, { at: number; id: string }>();
  readonly stats = { ticks: 0, checks: 0, setups: 0, decisions: 0, buySignals: 0, entered: 0, learning: 0, lastTickMs: 0, lastBuyAt: 0 };
  /** Proven chart strategies (live lab) — set in index.ts. */
  ta: TaLab | null = null;
  /** Trending tabs (banned / Mayhem flags) — set in index.ts. */
  trending: TrendingHub | null = null;
  /** Copycat ("vamp") guard — set in index.ts. */
  vamp: VampGuard | null = null;
  /** Holder lookup (RPC); replaceable in tests. */
  holders: (mint: string, pool: string | null) => Promise<number | null> = topHoldersPct;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly crowd: CrowdTracker,
    private readonly universe: SwingUniverse,
    private readonly trader: Trader,
    private readonly outcomes: OutcomeLabeler | null,
  ) {}

  private cfg() {
    return getConfig().swing ?? DEFAULT_CONFIG.swing;
  }

  start(): void {
    const every = Math.max(5, this.cfg().everySec) * 1000;
    this.timer = setInterval(() => void this.tick(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    const cfg = getConfig();
    if (this.busy || !this.cfg().enabled || !cfg.trading.enabledStrategies.SWING) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const held = new Set((await prisma.position.findMany({ where: { status: { in: ['OPEN', 'CLOSING'] } }, select: { mint: true } })).map((p) => p.mint));
      for (const coin of this.universe.liveCoins()) {
        if (held.has(coin.mint)) {
          coin.last = { at: now, score: coin.last?.score ?? 0, decision: 'HOLD', why: 'holding it' };
          continue;
        }
        await this.check(coin, now).catch((err: Error) => log.debug({ mint: coin.mint, err: err.message }, 'swing check failed'));
      }
      this.stats.ticks++;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'swing tick failed');
    } finally {
      this.stats.lastTickMs = Date.now() - t0;
      this.busy = false;
    }
  }

  /** One coin, right now. Returns the decision when the full check ran (a setup was there), else null. */
  async check(coin: SwingCoin, now = Date.now()): Promise<(SwingVerdict & { explore: boolean; entered: boolean }) | null> {
    const c = this.cfg();
    const cfg = getConfig();
    const mint = coin.mint;
    const candles = this.crowd.candles(mint);
    const trades = this.crowd.trades(mint);
    const lt = trades[trades.length - 1];
    const price = lt ? (lt.pp && lt.pp > 0 ? lt.pp : lt.px) : 0;
    if (candles.length < 20 || !(price > 0)) {
      coin.last = { at: now, score: 0, decision: 'WAIT', why: 'waiting for live trades' };
      return null;
    }
    this.stats.checks++;
    const ctx = taContext(candles, price, now, null, 15_000, { trades });
    const setup = swingSetup(ctx.c15, price, c, coin.high3hSol);
    const proven = this.ta?.provenNow() ?? new Map();
    const ta = runStrategies(ctx, c.taStrategies).map((s) => ({ id: s.id, strength: s.strength, why: s.why, proven: proven.has(s.id) }));
    if (!setup.ok && !ta.some((t) => t.strength >= 0.6)) {
      coin.last = { at: now, score: 0, decision: 'WAIT', why: setup.why };
      return null;
    }
    this.stats.setups++;

    // A setup is there — now the full picture.
    const [view, token, sol] = await Promise.all([
      this.liveState.read(mint),
      prisma.token.findUnique({ where: { mint }, select: { symbol: true, name: true, safetyScore: true, safetyHardFail: true } }),
      getSolUsd(),
    ]);
    if (!view || !token) return null;
    const vampWhy = this.vamp ? await this.vamp.check(mint, token.symbol, token.name, now) : null;
    if (vampWhy) {
      coin.last = { at: now, score: 0, decision: 'SKIP', why: vampWhy };
      return null;
    }
    const m = deriveMetrics(view);
    const liveMc = sol && view.ammTrades > 0 && m.priceSol > 0 ? m.marketCapSol * sol : null;
    const liveLiq = sol && view.ammTrades > 0 ? 2 * m.liquiditySol * sol : null;
    const crowd = this.crowd.metrics(mint);
    const kc = cfg.kol ?? DEFAULT_CONFIG.kol;
    const kol = kc.enabled ? await kolActivity(this.redis, mint, kc, now).catch(() => null) : null;
    const tr = this.trending?.info(mint, now) ?? null;
    if (!coin.holders || now - coin.holders.at >= c.holdersCheckMin * 60_000) {
      const pct = await this.holders(mint, coin.pool);
      if (pct !== null) coin.holders = { top10Pct: pct, at: now };
    }
    const trades10m = candles.filter((x) => now - x.t <= 10 * 60_000).reduce((s, x) => s + x.n, 0);
    const liveBounce = bounceBack(toBars(candles, 60_000), { dipPct: Math.max(8, c.dipPct * 0.6), recoverPct: c.recoverPct }, now);
    const coach = coachFor('SWING');
    const regime = currentRegime();
    const migratedAt = coin.migratedAtMs ?? view.migratedAtMs;
    const verdict = swingDecision(
      {
        watchlist: coin.watchlist,
        trendingLists: coin.trendingLists.length,
        marketCapUsd: liveMc ?? coin.marketCapUsd,
        liquidityUsd: liveLiq ?? coin.liquidityUsd,
        volume24hUsd: coin.volume24hUsd,
        ageMin: migratedAt ? (now - migratedAt) / 60_000 : null,
        priceChange1hPct: coin.priceChange1hPct,
        priceChange24hPct: coin.priceChange24hPct,
        trades10m,
        activeWallets5m: crowd.activeWallets5m,
        safety: { checked: token.safetyScore !== null && token.safetyHardFail !== null, hardFail: token.safetyHardFail === true },
        banned: coin.banned || !!tr?.banned,
        mayhem: coin.mayhem || !!tr?.mayhem,
        bounce: coin.bounce,
        liveBounce,
        setup,
        ta,
        crowd: { fakeVolumePct: crowd.fakeVolumePct, top3VolumePct: crowd.top3VolumePct, whaleSellPct: crowd.whaleSellPct },
        top10Pct: coin.holders?.top10Pct ?? null,
        kolDumping: !!kol?.dumping,
        kolBuyers: kol?.buyers.length ?? 0,
        barDelta: coach.thresholdDelta + cfg.regimeAdjustments[regime].scoreThresholdDelta,
      },
      c,
    );
    this.stats.decisions++;
    // Calibration: how this strategy's score band has REALLY done lately.
    const cal = calibrationAdjust(calibration(), 'SWING', verdict.score);
    const score = Math.round(Math.max(0, Math.min(100, verdict.score + cal.points)) * 10) / 10;
    let decision: 'BUY' | 'SKIP' = !verdict.fails.length && score >= verdict.threshold ? 'BUY' : 'SKIP';
    // Learning trade: passes every rule, just short on score → small size (config explore).
    const ex = cfg.explore ?? DEFAULT_CONFIG.explore;
    const explore = decision === 'SKIP' && ex.enabled && ex.strategies.includes('SWING') && !verdict.fails.length && score >= verdict.threshold - ex.scoreMargin;
    if (explore) decision = 'BUY';
    const why = verdict.fails[0] ?? (decision === 'BUY' ? setup.why : `score ${score} < ${verdict.threshold}`);
    coin.last = { at: now, score, decision: explore ? 'LEARN' : decision, why };

    // Store BUYs (incl. learning buys): their real trade results teach the score calibration. Skips
    // aren't stored — their only label would be the 1-hour "1.8x before 0.7x" price test, which
    // bigger coins almost never meet, and that would drown the real results.
    const prevStored = this.lastStored.get(mint);
    let evaluationId: string | null = prevStored && now - prevStored.at < STORE_EVERY_MS ? prevStored.id : null;
    const market = analyzeMarket(view, null, sol, now).raw;
    if (decision === 'BUY' && !evaluationId) {
      if (this.lastStored.size > 5_000) this.lastStored.clear();
      const row = await prisma.evaluation.create({
        data: {
          mint,
          strategy: 'SWING',
          safetyScore: token.safetyScore ?? 0,
          marketScore: null,
          combinedScore: score,
          decision,
          reasons: decision === 'BUY' ? [explore ? `learning trade: score ${score} (bar ${verdict.threshold})` : `swing: ${setup.why}`, ...verdict.notes.slice(0, 4)] : verdict.fails.length ? verdict.fails : [`score ${score} < ${verdict.threshold}`],
          features: json({ preCalibrationScore: verdict.score, calibration: cal, explore, swing: { parts: verdict.parts, resilience: verdict.resilience, setup, bounce: coin.bounce, liveBounce, ta, top10Pct: coin.holders?.top10Pct ?? null, sources: coin.sources, watchlist: coin.watchlist, marketCapUsd: liveMc ?? coin.marketCapUsd, liquidityUsd: liveLiq ?? coin.liquidityUsd }, market, crowd }),
          regime,
        },
      });
      evaluationId = row.id;
      this.lastStored.set(mint, { at: now, id: row.id });
      await this.outcomes?.startWindow(mint, row.id, m.priceSol > 0 ? m.priceSol : price);
      bus.publish({ type: 'evaluation', data: { mint, symbol: token.symbol, score, decision, reasons: [why] } });
    }
    let entered = false;
    if (decision === 'BUY') {
      this.stats.buySignals++;
      const conv = convictionFactor({ scoreMargin: score - verdict.threshold, calibrationFactor: cal.factor, crowdScore: crowd.crowdScore, min: cfg.trading.minConvictionMultiple ?? 0.4, max: cfg.trading.maxConvictionMultiple ?? 1.6 });
      // Owner: small market caps get less, big ones more (sizeByMarketCap).
      const mcMult = swingSizeForMc(liveMc ?? coin.marketCapUsd, c.sizeByMarketCap);
      const sizeMultiplier = explore ? ex.sizeMultiplier * coach.sizeFactor * Math.min(1, mcMult) : verdict.sizeFactor * coach.sizeFactor * conv.factor * c.sizeMultiplier * mcMult;
      log.info({ mint, symbol: token.symbol, score, explore, setup: setup.why }, `🌊 SWING ${explore ? 'learning ' : ''}buy signal ${token.symbol} (${score})`);
      const res = await this.trader.tryEnter({
        mint,
        symbol: token.symbol,
        strategy: 'SWING',
        evaluationId,
        score,
        market,
        maxSlippageBps: STRATEGIES.SWING.maxSlippageBps,
        features: verdict.parts,
        sizeMultiplier,
        swing: true,
        explore,
        explain: (sizeSol) =>
          explainSwingBuy({
            symbol: token.symbol,
            sizeSol,
            score,
            threshold: verdict.threshold,
            parts: verdict.parts,
            marketCapUsd: liveMc ?? coin.marketCapUsd,
            liquidityUsd: liveLiq ?? coin.liquidityUsd,
            resilience: verdict.resilience,
            bounce: bounceSummary(coin.bounce ?? liveBounce),
            setup: setup.ok ? setup.why : `chart setup (${ta.filter((t) => t.strength >= 0.6).map((t) => t.why).join('; ')})`,
            notes: verdict.notes,
            sources: coin.sources,
            explore,
            sizeNote: (explore ? `learning trade ×${ex.sizeMultiplier}` : conv.note + (verdict.sizeFactor !== 1 ? `, ×${verdict.sizeFactor} (holders)` : '')) + `, ×${mcMult} for its market cap`,
            coachNote: coach.note,
            calibrationNote: cal.note,
            plan: swingPlan(exitRulesFor('SWING', cfg.exit)),
          }),
      });
      entered = res.entered;
      if (res.entered) {
        this.stats.entered++;
        if (explore) this.stats.learning++;
        this.stats.lastBuyAt = now;
      }
      coin.last = { at: now, score, decision: res.entered ? (explore ? 'LEARN' : 'BUY') : 'SKIP', why: res.entered ? setup.why : res.reason };
    }
    return { ...verdict, score, decision, explore, entered };
  }
}
