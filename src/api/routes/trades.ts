/**
 * GET /api/trades — completed positions for the History page (one row per
 * position, with average exit price). Filterable by strategy, date range,
 * outcome (win/loss) and exit reason.
 */
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';
import { clampInt, type ApiDeps } from '../deps';

interface Query {
  strategy?: string;
  from?: string;
  to?: string;
  outcome?: 'win' | 'loss';
  exitReason?: string;
  limit?: string;
}

export async function tradesRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Querystring: Query }>('/api/trades', async (req) => {
    const q = req.query;
    const where: Prisma.PositionWhereInput = { status: 'CLOSED', mode: deps.executor.mode };
    if (q.strategy) where.strategy = q.strategy as Prisma.PositionWhereInput['strategy'];
    if (q.exitReason) where.exitReason = q.exitReason as Prisma.PositionWhereInput['exitReason'];
    if (q.outcome === 'win') where.realizedPnlSol = { gt: 0 };
    if (q.outcome === 'loss') where.realizedPnlSol = { lte: 0 };
    if (q.from || q.to) where.closedAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };

    const rows = await prisma.position.findMany({
      where,
      orderBy: { closedAt: 'desc' },
      take: clampInt(q.limit, 500, 1, 5000),
      include: {
        token: { select: { symbol: true, name: true } },
        evaluation: { select: { combinedScore: true, outcomeMax: true } },
        trades: { where: { status: { in: ['SIMULATED', 'CONFIRMED'] } }, select: { side: true, amountSol: true, tokenAmountRaw: true, context: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    return rows.map((p) => {
      const sells = p.trades.filter((t) => t.side === 'SELL');
      const solOut = sells.reduce((s, t) => s + t.amountSol, 0);
      const tokensOut = sells.reduce((s, t) => s + Number(t.tokenAmountRaw), 0) / 1e6;
      const why = (t: { context: unknown }) => ((t.context as { explanation?: string } | null)?.explanation ?? null);
      return {
        id: p.id,
        mint: p.mint,
        symbol: p.token.symbol,
        name: p.token.name,
        strategy: p.strategy,
        entryPriceSol: p.entryPriceSol,
        exitPriceSol: tokensOut > 0 ? solOut / tokensOut : null,
        sizeSol: p.sizeSol,
        pnlSol: p.realizedPnlSol,
        pnlPct: (p.realizedPnlSol / p.sizeSol) * 100,
        holdSeconds: p.closedAt ? Math.round((p.closedAt.getTime() - p.openedAt.getTime()) / 1000) : null,
        exitReason: p.exitReason,
        scoreAtEntry: p.evaluation?.combinedScore ?? null,
        // Best price while we held it, as a multiple of our entry, and what that would have paid.
        peakMultiple: p.peakPriceSol / p.entryPriceSol,
        maxProfitSol: p.sizeSol * (p.peakPriceSol / p.entryPriceSol - 1),
        // Best price within 1h of the buy signal (includes after we sold) — did we exit too early?
        bestWithin1hMultiple: p.evaluation?.outcomeMax ?? null,
        buyReason: (p.entryContext as { explanation?: string } | null)?.explanation ?? why(p.trades.find((t) => t.side === 'BUY') ?? { context: null }),
        sellReasons: sells.map(why).filter((x): x is string => !!x),
        openedAt: p.openedAt,
        closedAt: p.closedAt,
      };
    });
  });
}
