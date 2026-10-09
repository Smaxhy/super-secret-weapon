/** GET /api/positions — open positions with live price and unrealised P&L. */
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config/runtime-config';
import { prisma } from '../../lib/prisma';
import { curvePriceSol, quoteSell } from '../../lib/pumpfun';
import { deriveMetrics } from '../../scanner/live-state';
import type { ApiDeps } from '../deps';

export async function positionsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get('/api/positions', async () => {
    const cfg = getConfig();
    const open = await prisma.position.findMany({
      where: { status: 'OPEN', mode: deps.executor.mode },
      orderBy: { openedAt: 'desc' },
      include: { token: { select: { symbol: true, name: true } }, evaluation: { select: { combinedScore: true } } },
    });
    return Promise.all(
      open.map(async (p) => {
        const view = await deps.liveState.read(p.mint);
        const price = view ? curvePriceSol(view.virtualSolReserves, view.virtualTokenReserves) : null;
        const remainingTokens = (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n;
        // What we'd actually get selling the rest now (after curve fee), minus its cost.
        const exitValue = view ? Number(quoteSell(remainingTokens, view.virtualSolReserves, view.virtualTokenReserves, cfg.paper.curveFeeBps).solOutLamports) / 1e9 : null;
        const costLeft = (p.sizeSol * p.remainingPct) / 100;
        const m = view ? deriveMetrics(view) : null;
        const tiersHit = (p.tpTiersHit as number[]) ?? [];
        return {
          id: p.id,
          mint: p.mint,
          symbol: p.token.symbol,
          name: p.token.name,
          strategy: p.strategy,
          mode: p.mode,
          openedAt: p.openedAt,
          sizeSol: p.sizeSol,
          remainingPct: p.remainingPct,
          entryPriceSol: p.entryPriceSol,
          currentPriceSol: price,
          peakPriceSol: p.peakPriceSol,
          multiple: price ? price / p.entryPriceSol : null,
          unrealizedPnlSol: exitValue !== null ? exitValue - costLeft : null,
          realizedPnlSol: p.realizedPnlSol,
          scoreAtEntry: p.evaluation?.combinedScore ?? null,
          trailingActive: p.trailingActive,
          buyReason: (p.entryContext as { explanation?: string } | null)?.explanation ?? null,
          targets: {
            stopLossPrice: p.entryPriceSol * (1 - cfg.exit.hardStopLossPct / 100),
            takeProfits: cfg.exit.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct, hit: tiersHit.includes(t.multiple) })),
            trailingStopPrice: p.trailingActive ? p.peakPriceSol * (1 - cfg.exit.trailingStopPct / 100) : null,
          },
          health: m ? { holders: m.holderCount, devHoldingPct: m.devHoldingPct, top10HolderPct: m.top10HolderPct, curvePct: m.bondingCurvePct } : null,
        };
      }),
    );
  });
}
