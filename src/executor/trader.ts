/**
 * Trader — turns a BUY decision into an open position, if risk rules allow.
 *
 * Every entry passes these gates, in order (each refusal is logged with why):
 *   1. Kill switch / paused
 *   2. Strategy enabled
 *   3. Daily circuit breaker (realised P&L today ≤ −20% of capital → no new entries)
 *   4. Max concurrent positions
 *   5. Never enter the same token twice
 *   6. Strategy capital allocation (e.g. curve snipes may use 15% of capital)
 *   7. Wallet balance check
 * Then: size the position by conviction (score above threshold × chart
 * strength) and regime, execute through the Executor, and record it together
 * with the chart levels (support, ATH, swing structure) the sell manager
 * needs to manage the trade like a trader would.
 *
 * Entries run one at a time (a small mutex) so two tokens can't both grab the
 * last free slot.
 */
import type { Strategy } from '@prisma/client';
import type { BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { logTrade } from '../learner/trade-logger';
import { regimeAdjustment } from '../learner/regime-detector';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { Executor } from './types';

const log = moduleLogger('trader');

export interface EntryRequest {
  mint: string;
  symbol: string;
  strategy: Strategy;
  evaluationId: string | null;
  score: number;
  /** The threshold the score had to beat (already regime-adjusted). */
  threshold: number;
  market: MarketRaw;
  maxSlippageBps: number;
  features: Record<string, number>;
}

/** What the sell manager knows about the market at the moment we bought. */
export interface EntryContext {
  devHoldingPct: number;
  top10HolderPct: number;
  holders: number;
  marketCapSol: number;
  liquiditySol: number;
  supportSol: number | null;
  athPriceSol: number;
  setup: string;
  strength: number;
  score: number;
  sizeMultiplier: number;
  regime: string;
}

/**
 * Conviction sizing (pure). A bare pass gets the minimum; a score at
 * `convictionFullScore`+ with a strong chart gets the maximum. The regime
 * multiplier then scales the result (and may push it below the minimum, in
 * which case the trader refuses — small trades just feed fees).
 */
export function convictionSize(i: { score: number; threshold: number; strength: number; regimeMultiplier: number }, t: BotConfigShape['trading']): { sizeSol: number; conviction: number } {
  if (!t.convictionSizing) return { sizeSol: t.maxPositionSol * i.regimeMultiplier, conviction: 1 };
  const span = Math.max(1, t.convictionFullScore - i.threshold);
  const scorePart = Math.max(0, Math.min(1, (i.score - i.threshold) / span));
  const conviction = Math.max(0, Math.min(1, 0.7 * scorePart + 0.3 * i.strength));
  const base = t.minPositionSol + (t.maxPositionSol - t.minPositionSol) * conviction;
  return { sizeSol: base * i.regimeMultiplier, conviction };
}

export interface EntryResult {
  entered: boolean;
  reason: string;
  positionId?: string;
}

export class Trader {
  private lock: Promise<unknown> = Promise.resolve();
  private breakerTrippedDay: string | null = null;

  constructor(private readonly executor: Executor) {}

  tryEnter(req: EntryRequest): Promise<EntryResult> {
    const run = this.lock.then(() => this.enter(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async enter(req: EntryRequest): Promise<EntryResult> {
    const cfg = getConfig();
    const mode = this.executor.mode;
    const refuse = (reason: string): EntryResult => {
      log.info({ mint: req.mint, symbol: req.symbol, reason }, `⏭  not entering ${req.symbol}: ${reason}`);
      return { entered: false, reason };
    };

    if (cfg.state.killSwitch) return refuse('kill switch active');
    if (cfg.state.paused) return refuse('bot paused');
    if (!cfg.trading.enabledStrategies[req.strategy]) return refuse(`strategy ${req.strategy} disabled`);

    const open = await prisma.position.findMany({ where: { mode, status: { in: ['OPEN', 'CLOSING'] } } });
    const balance = await this.executor.getBalanceSol();
    const openCost = open.reduce((s, p) => s + (p.sizeSol * p.remainingPct) / 100, 0);
    const capital = balance + openCost;

    const dailyPnl = await realisedPnlToday(mode);
    if (dailyPnl <= -(cfg.exit.dailyLossCircuitBreakerPct / 100) * capital) {
      const day = new Date().toISOString().slice(0, 10);
      if (this.breakerTrippedDay !== day) {
        this.breakerTrippedDay = day;
        void recordEvent({ level: 'WARN', module: 'trader', type: 'circuit_breaker', message: `Daily P&L ${dailyPnl.toFixed(3)} SOL hit the −${cfg.exit.dailyLossCircuitBreakerPct}% breaker — no new entries until 00:00 UTC` });
      }
      return refuse('daily loss circuit breaker');
    }

    if (open.length >= cfg.trading.maxConcurrentPositions) return refuse(`max ${cfg.trading.maxConcurrentPositions} positions open`);
    if (await prisma.position.count({ where: { mint: req.mint } })) return refuse('already traded this token');

    const strategyOpen = open.filter((p) => p.strategy === req.strategy).reduce((s, p) => s + (p.sizeSol * p.remainingPct) / 100, 0);
    const budget = capital * cfg.trading.allocation[req.strategy] - strategyOpen;
    const reserve = cfg.paper.txFeeSol * 4 + 0.01; // keep enough to pay for the exits
    const regime = regimeAdjustment();
    const wanted = convictionSize({ score: req.score, threshold: req.threshold, strength: req.market.strength, regimeMultiplier: regime.sizeMultiplier }, cfg.trading);
    const size = Math.min(wanted.sizeSol, cfg.trading.maxPositionSolCeiling, budget, balance - reserve);
    if (size < cfg.trading.minPositionSol) {
      return refuse(`size ${size.toFixed(3)} SOL below minimum (balance ${balance.toFixed(3)}, ${req.strategy} budget ${budget.toFixed(3)}, regime ${regime.regime} ×${regime.sizeMultiplier})`);
    }

    const fill = await this.executor.buy({ mint: req.mint, solAmount: round4(size), maxSlippageBps: req.maxSlippageBps });
    const context = { score: req.score, threshold: req.threshold, conviction: wanted.conviction, regime: regime.regime, market: req.market, features: req.features, balanceBefore: balance };
    if (!fill.ok) {
      await logTrade({ positionId: null, mint: req.mint, symbol: req.symbol, side: 'BUY', mode, strategy: req.strategy, fill, reason: 'entry failed', context });
      return refuse(`execution failed: ${fill.error}`);
    }

    const position = await prisma.$transaction(async (tx) => {
      const p = await tx.position.create({
        data: {
          mint: req.mint,
          strategy: req.strategy,
          mode,
          evaluationId: req.evaluationId,
          entryPriceSol: fill.priceSol,
          sizeSol: fill.solAmount,
          tokenAmountRaw: fill.tokenAmountRaw,
          peakPriceSol: fill.priceSol,
          refPriceSol: fill.priceSol,
          lastMoveAt: new Date(),
          entryContext: {
            devHoldingPct: req.market.devHoldingPct,
            top10HolderPct: req.market.top10HolderPct,
            holders: req.market.holders,
            marketCapSol: req.market.marketCapSol,
            liquiditySol: req.market.liquiditySol,
            supportSol: req.market.supportSol,
            athPriceSol: req.market.athPriceSol,
            setup: req.market.setup,
            strength: req.market.strength,
            score: req.score,
            sizeMultiplier: regime.sizeMultiplier,
            regime: regime.regime,
          } satisfies EntryContext,
        },
      });
      await logTrade({ positionId: p.id, mint: req.mint, symbol: req.symbol, side: 'BUY', mode, strategy: req.strategy, fill, reason: `entry: score ${req.score.toFixed(1)} ${req.market.setup} (conviction ${(wanted.conviction * 100).toFixed(0)}%)`, context }, tx);
      return p;
    });
    return { entered: true, reason: 'entered', positionId: position.id };
  }
}

/** Sum of realised P&L from sells since 00:00 UTC. */
export async function realisedPnlToday(mode: 'PAPER' | 'LIVE'): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const sells = await prisma.trade.findMany({
    where: { mode, side: 'SELL', createdAt: { gte: midnight }, status: { in: ['SIMULATED', 'CONFIRMED'] } },
    select: { context: true },
  });
  return sells.reduce((s, t) => s + Number((t.context as { pnlSol?: number } | null)?.pnlSol ?? 0), 0);
}

function round4(x: number): number {
  return Math.floor(x * 10_000) / 10_000;
}
