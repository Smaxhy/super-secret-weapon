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
 * Then: size the position, execute through the Executor, and record it.
 *
 * Entries run one at a time (a small mutex) so two tokens can't both grab the
 * last free slot.
 */
import type { Strategy } from '@prisma/client';
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { logTrade } from '../learner/trade-logger';
import { currentRegime } from '../learner/regime-detector';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { Executor } from './types';

const log = moduleLogger('trader');

export interface EntryRequest {
  mint: string;
  symbol: string;
  strategy: Strategy;
  evaluationId: string | null;
  score: number;
  market: MarketRaw;
  maxSlippageBps: number;
  features: Record<string, number>;
  /** Copy trades: the wallet we copied (its sells trigger our exit). */
  copiedWallet?: string;
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
    // Market mood scales position size (e.g. ×1.2 when hot, ×0.5 when rug-heavy).
    const sized = Math.min(cfg.trading.maxPositionSol * cfg.regimeAdjustments[currentRegime()].sizeMultiplier, cfg.trading.maxPositionSolCeiling);
    const size = Math.min(sized, budget, balance - reserve);
    if (size < cfg.trading.minPositionSol) {
      return refuse(`size ${size.toFixed(3)} SOL below minimum (balance ${balance.toFixed(3)}, ${req.strategy} budget ${budget.toFixed(3)})`);
    }

    const fill = await this.executor.buy({ mint: req.mint, solAmount: round4(size), maxSlippageBps: req.maxSlippageBps });
    const context = { score: req.score, market: req.market, features: req.features, balanceBefore: balance };
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
            earlyBuyerPct: req.market.earlyBuyerPct,
            copiedWallet: req.copiedWallet ?? null,
            // Counted into each sell's cost basis so P&L includes the buy's gas/tip.
            buyFeeSol: fill.feeSol,
            top10HolderPct: req.market.top10HolderPct,
            holders: req.market.holders,
            marketCapSol: req.market.marketCapSol,
          },
        },
      });
      await logTrade({ positionId: p.id, mint: req.mint, symbol: req.symbol, side: 'BUY', mode, strategy: req.strategy, fill, reason: `entry: score ${req.score.toFixed(1)}`, context }, tx);
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
