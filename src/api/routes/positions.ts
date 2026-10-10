/**
 * GET /api/positions           — open positions with live price, market cap and unrealised P&L.
 * GET /api/positions/:id/chart — price history of one position (open or recently closed) for the chart.
 */
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config/runtime-config';
import type { BotConfigShape } from '../../config/default';
import { downsample, readHistory } from '../../executor/position-history';
import { exitCostPctFor, INITIALS_MARKER, stopLossLevel, trailingStopLevel, type TrailLevel } from '../../executor/sell-manager';
import { coachFor } from '../../learner/trade-coach';
import type { StrategyName } from '../../config/types';
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
 * Where the trailing stop sits right now — the exact rule the sell manager sells on
 * (shared trailingStopLevel helper: vol-adaptive trail, runner caps, break-even floor),
 * fed with the volatility the sell manager last measured for this position.
 * Returns null when no trailing stop is active.
 */
function trailingLevel(
  p: { id: string; strategy: StrategyName; entryPriceSol: number; peakPriceSol: number; trailingActive: boolean; tpTiersHit: unknown; sizeSol: number; remainingPct: number; entryContext: unknown },
  cfg: BotConfigShape,
  volatilityPct: number | null,
): TrailLevel | null {
  const tiersHit = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]) : [];
  const buyFeeSol = Number((p.entryContext as { buyFeeSol?: number } | null)?.buyFeeSol ?? 0);
  return trailingStopLevel(
    {
      entryPriceSol: p.entryPriceSol,
      peakPriceSol: p.peakPriceSol,
      trailingActive: p.trailingActive,
      initialsOut: tiersHit.includes(INITIALS_MARKER),
      volatilityPct,
      sizeSol: p.sizeSol,
      costSol: p.sizeSol + buyFeeSol,
      remainingPct: p.remainingPct,
      txFeeSol: cfg.paper.txFeeSol,
      trailFactor: coachFor(p.strategy).trailFactor,
    },
    cfg.exit,
  );
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
  /** Coins that passed the rules but were too stretched — waiting for a dip + bounce to buy. */
  app.get('/api/dip-watch', async () => {
    const now = Date.now();
    return (deps.dips?.list() ?? []).map((w) => {
      const t = deps.crowd?.trades(w.mint);
      const price = t && t.length ? t[t.length - 1]!.px : null;
      return { mint: w.mint, symbol: w.symbol, strategy: w.strategy, zoneLo: w.zone.lo, zoneHi: w.zone.hi, signalPrice: w.signalPrice, price, inZone: w.lowest !== null, secondsLeft: Math.max(0, Math.round((w.expiresAt - now) / 1000)), why: w.why };
    });
  });

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
        const volatilityPct = deps.sellManager.volatilityFor(p.id);
        const trail = trailingLevel(p, cfg, volatilityPct);
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
            stopLossPrice: stopLossLevel(p.entryPriceSol, volatilityPct, cfg.exit, coachFor(p.strategy).stopBiasPct, exitCostPctFor(cfg.paper, false, (p.sizeSol * p.remainingPct) / 100), p.strategy).stopPriceSol,
            takeProfits: cfg.exit.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct, hit: tiersHit.includes(t.multiple) })),
            trailingStopPrice: trail?.stopPriceSol ?? null,
            trailingStopPct: trail?.trailPct ?? null,
            breakEvenFloorPrice: trail?.floorPriceSol ?? null,
            volatilityPct,
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
      ...downsample(history.filter((h) => h.t > openedMs), 1_500).map((h) => ({ t: h.t, priceSol: h.priceSol, marketCapSol: h.priceSol * supply })),
    ];
    const tiersHit = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]) : [];
    const volatilityPct = p.status === 'OPEN' ? deps.sellManager.volatilityFor(p.id) : null;
    const trail = trailingLevel(p, cfg, volatilityPct);

    return {
      positionId: p.id,
      symbol: p.token.symbol,
      openedAt: p.openedAt.toISOString(),
      closedAt: p.closedAt ? p.closedAt.toISOString() : null,
      entryPriceSol: p.entryPriceSol,
      entryMarketCapSol: entryMarketCapSol(p.entryPriceSol, supply, ctx),
      points,
      takeProfits: cfg.exit.takeProfitTiers.map((t) => ({ multiple: t.multiple, sellPct: t.sellPct, hit: tiersHit.includes(t.multiple) })),
      stopLossPriceSol: stopLossLevel(p.entryPriceSol, volatilityPct, cfg.exit, coachFor(p.strategy).stopBiasPct, exitCostPctFor(cfg.paper, false, (p.sizeSol * p.remainingPct) / 100), p.strategy).stopPriceSol,
      // Exactly the stop the sell manager sells on (shared trailingStopLevel helper).
      trailingStopPriceSol: trail?.stopPriceSol ?? null,
      trailingStopPct: trail?.trailPct ?? null,
      breakEvenFloorPriceSol: trail?.floorPriceSol ?? null,
      volatilityPct,
      peakPriceSol: p.peakPriceSol,
    };
  });
}
