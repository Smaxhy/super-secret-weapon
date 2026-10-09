/**
 * GET /api/positions           — open positions with live price, market cap and unrealised P&L.
 * GET /api/positions/:id/chart — price history of one position (open or recently closed) for the chart.
 */
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config/runtime-config';
import type { BotConfigShape } from '../../config/default';
import { readHistory } from '../../executor/position-history';
import { INITIALS_MARKER, runnerTrailPct } from '../../executor/sell-manager';
import { prisma } from '../../lib/prisma';
import { PUMP_TOKEN_DECIMALS, quoteSell } from '../../lib/pumpfun';
import { getSolUsd } from '../../lib/sol-price';
import { deriveMetrics, type LiveTokenView } from '../../scanner/live-state';
import type { ApiDeps } from '../deps';

/** pump.fun tokens: 1 billion whole tokens. */
const DEFAULT_SUPPLY_TOKENS = 1_000_000_000;

/** What the trader saved about the market when we bought (older positions may lack some fields). */
interface EntryContext {
  explanation?: string | null;
  marketCapSol?: number;
  marketCapUsd?: number | null;
  priceSol?: number;
  totalSupplyTokens?: number;
}

/**
 * Where the trailing stop sits right now, mirroring decideExit in sell-manager:
 * - after initials are out the runner trail applies (always on; volatility isn't stored, so the
 *   fallback trail % is used as a close stand-in),
 * - otherwise the normal trail (tightening as the peak grows), only once it has been activated.
 * Returns null when no trailing stop is active.
 */
function trailingStopPriceSol(
  p: { entryPriceSol: number; peakPriceSol: number; trailingActive: boolean; tpTiersHit: unknown },
  exit: BotConfigShape['exit'],
): number | null {
  if (!(p.entryPriceSol > 0) || !(p.peakPriceSol > 0)) return null;
  const peakX = p.peakPriceSol / p.entryPriceSol;
  const tiersHit = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]) : [];
  if (tiersHit.includes(INITIALS_MARKER)) {
    return p.peakPriceSol * (1 - runnerTrailPct(null, peakX, exit.runner) / 100);
  }
  if (!p.trailingActive) return null;
  const pct = exit.trailingTightening.reduce<number>((acc, t) => (peakX >= t.fromMultiple ? Math.min(acc, t.pct) : acc), exit.trailingStopPct);
  return p.peakPriceSol * (1 - pct / 100);
}

/** Total supply in whole tokens: live curve data first, then what we saved at entry, then 1e9. */
function supplyTokens(view: LiveTokenView | null, ctx: EntryContext | null): number {
  const live = view ? Number(view.curve.totalSupply) / 10 ** PUMP_TOKEN_DECIMALS : 0;
  if (live > 0 && Number.isFinite(live)) return live;
  const saved = ctx?.totalSupplyTokens;
  return saved && saved > 0 ? saved : DEFAULT_SUPPLY_TOKENS;
}

/** Market cap (SOL) when we bought. Exact = our fill price × supply; else the evaluator's figure. */
function entryMarketCapSol(entryPriceSol: number, supply: number, ctx: EntryContext | null): number {
  if (entryPriceSol > 0) return entryPriceSol * supply;
  return ctx?.marketCapSol ?? 0;
}

export async function positionsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get('/api/positions', async () => {
    const cfg = getConfig();
    const open = await prisma.position.findMany({
      where: { status: 'OPEN', mode: deps.executor.mode },
      orderBy: { openedAt: 'desc' },
      include: { token: { select: { symbol: true, name: true } }, evaluation: { select: { combinedScore: true } } },
    });
    const solUsd = await getSolUsd().catch(() => null);
    return Promise.all(
      open.map(async (p) => {
        const view = await deps.liveState.read(p.mint);
        const m = view ? deriveMetrics(view) : null;
        // Live price: bonding curve, or the PumpSwap pool once migrated (deriveMetrics handles both).
        const price = m && m.priceSol > 0 ? m.priceSol : null;
        const remainingTokens = (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n;
        // What we'd actually get selling the rest now (after fees), minus its cost.
        const onAmm = !!view && view.ammBaseReserve !== null && view.ammQuoteReserve !== null && view.ammBaseReserve > 0n;
        const exitValue = view
          ? Number(
              (onAmm
                ? quoteSell(remainingTokens, view.ammQuoteReserve!, view.ammBaseReserve!, cfg.paper.ammFeeBps)
                : quoteSell(remainingTokens, view.virtualSolReserves, view.virtualTokenReserves, cfg.paper.curveFeeBps)
              ).solOutLamports,
            ) / 1e9
          : null;
        const costLeft = (p.sizeSol * p.remainingPct) / 100;
        const tiersHit = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]) : [];
        const ctx = p.entryContext as EntryContext | null;
        const supply = supplyTokens(view, ctx);
        const currentMcSol = price !== null ? price * supply : null;
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
          buyReason: ctx?.explanation ?? null,
          // Market cap when we bought vs now (SOL and USD).
          entryMarketCapSol: entryMarketCapSol(p.entryPriceSol, supply, ctx),
          entryMarketCapUsd: typeof ctx?.marketCapUsd === 'number' ? ctx.marketCapUsd : null,
          currentMarketCapSol: currentMcSol,
          currentMarketCapUsd: currentMcSol !== null && solUsd ? currentMcSol * solUsd : null,
          solUsd,
          totalSupplyTokens: supply,
          targets: {
            stopLossPrice: p.entryPriceSol * (1 - cfg.exit.hardStopLossPct / 100),
            takeProfits: cfg.exit.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct, hit: tiersHit.includes(t.multiple) })),
            trailingStopPrice: trailingStopPriceSol(p, cfg.exit),
          },
          health: m ? { holders: m.holderCount, devHoldingPct: m.devHoldingPct, top10HolderPct: m.top10HolderPct, curvePct: m.bondingCurvePct } : null,
        };
      }),
    );
  });

  // Price chart for one position: stored history (every ~5s) with the entry as the first point.
  app.get<{ Params: { id: string } }>('/api/positions/:id/chart', async (req, reply) => {
    const cfg = getConfig();
    const p = await prisma.position.findUnique({
      where: { id: req.params.id },
      include: { token: { select: { symbol: true } } },
    });
    if (!p) return reply.code(404).send({ error: 'position not found' });

    const ctx = p.entryContext as EntryContext | null;
    const view = p.status === 'CLOSED' ? null : await deps.liveState.read(p.mint).catch(() => null);
    const supply = supplyTokens(view, ctx);
    const openedMs = p.openedAt.getTime();

    const history = await readHistory(p.id);
    const points = [
      { t: openedMs, priceSol: p.entryPriceSol, marketCapSol: p.entryPriceSol * supply },
      ...history
        .filter((h) => h.t > openedMs)
        .map((h) => ({ t: h.t, priceSol: h.priceSol, marketCapSol: h.priceSol * supply })),
    ];
    const tiersHit = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]) : [];

    return {
      positionId: p.id,
      symbol: p.token.symbol,
      openedAt: p.openedAt.toISOString(),
      closedAt: p.closedAt ? p.closedAt.toISOString() : null,
      entryPriceSol: p.entryPriceSol,
      entryMarketCapSol: entryMarketCapSol(p.entryPriceSol, supply, ctx),
      points,
      takeProfits: cfg.exit.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct, hit: tiersHit.includes(t.multiple) })),
      stopLossPriceSol: p.entryPriceSol * (1 - cfg.exit.hardStopLossPct / 100),
      // Same rule the sell manager uses (runner trail after initials, tightening trail before).
      trailingStopPriceSol: trailingStopPriceSol(p, cfg.exit),
      peakPriceSol: p.peakPriceSol,
    };
  });
}
