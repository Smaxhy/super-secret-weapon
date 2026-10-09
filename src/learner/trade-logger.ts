/**
 * Trade logger — every buy and sell, paper or live, goes through here.
 *
 * Each Trade row carries a `context` blob: the evaluation features at entry,
 * the market metrics at the moment of the trade, and P&L for sells. That's
 * what the learning engine (Phase 7-8) trains on.
 */
import type { Prisma, Strategy, TradeSide, TradingMode } from '@prisma/client';
import { recordEvent } from '../lib/bot-events';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { Fill } from '../executor/types';

const log = moduleLogger('trade-logger');

export interface TradeLogInput {
  positionId: string | null;
  mint: string;
  symbol?: string;
  side: TradeSide;
  mode: TradingMode;
  strategy: Strategy;
  fill: Fill;
  reason: string;
  context: Record<string, unknown>;
  /** SELL only: realised profit/loss of this sell in SOL. */
  pnlSol?: number;
  /** SELL only: best price multiple reached while holding. */
  peakMultiple?: number;
  /** SELL only: this sell closed the position; total P&L of the whole trade. */
  closed?: boolean;
  totalPnlSol?: number;
}

export async function logTrade(t: TradeLogInput, tx: Prisma.TransactionClient = prisma): Promise<string> {
  const context = JSON.parse(
    JSON.stringify({ ...t.context, pnlSol: t.pnlSol }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
  const row = await tx.trade.create({
    data: {
      positionId: t.positionId,
      mint: t.mint,
      side: t.side,
      mode: t.mode,
      strategy: t.strategy,
      status: t.fill.status,
      amountSol: t.fill.solAmount,
      tokenAmountRaw: t.fill.tokenAmountRaw,
      priceSol: t.fill.priceSol,
      feeSol: t.fill.feeSol,
      signature: t.fill.signature,
      reason: t.reason,
      context,
      error: t.fill.error,
      confirmedAt: t.fill.ok ? new Date() : null,
    },
  });

  const tag = t.mode === 'PAPER' ? '📝' : '💸';
  const pnl =
    (t.pnlSol !== undefined ? ` pnl ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL` : '') +
    (t.closed && t.totalPnlSol !== undefined ? ` | trade total ${t.totalPnlSol >= 0 ? '+' : ''}${t.totalPnlSol.toFixed(4)} SOL, peak ${t.peakMultiple?.toFixed(2)}x` : '');
  log.info(
    { mint: t.mint, side: t.side, sol: +t.fill.solAmount.toFixed(4), reason: t.reason, pnlSol: t.pnlSol },
    `${tag} ${t.side} ${t.symbol ?? t.mint.slice(0, 6)} ${t.fill.solAmount.toFixed(4)} SOL (${t.reason})${pnl}`,
  );
  bus.publish({ type: 'trade', data: { mint: t.mint, symbol: t.symbol, side: t.side, mode: t.mode, amountSol: t.fill.solAmount, reason: t.reason, pnlSol: t.pnlSol, peakMultiple: t.peakMultiple, closed: t.closed, totalPnlSol: t.totalPnlSol } });
  void recordEvent({
    module: 'trader',
    type: `${t.side.toLowerCase()}_${t.fill.ok ? 'filled' : 'failed'}`,
    mint: t.mint,
    message: `${t.side} ${t.fill.solAmount.toFixed(4)} SOL — ${t.reason}${pnl}`,
    data: { mode: t.mode, strategy: t.strategy, pnlSol: t.pnlSol ?? null, error: t.fill.error ?? null },
  });
  return row.id;
}
