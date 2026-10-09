/** GET /api/detections — recent tokens for the live feed; GET /api/detections/:mint — full breakdown. */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';
import { deriveMetrics } from '../../scanner/live-state';
import { clampInt, detectionStatus, type ApiDeps } from '../deps';

export async function detectionsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Querystring: { limit?: string; status?: string } }>('/api/detections', async (req) => {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const tokens = await prisma.token.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        mint: true, name: true, symbol: true, creator: true, createdAt: true, status: true,
        safetyScore: true, safetyHardFail: true, combinedScore: true, lastHolderCount: true, lastPriceSol: true, peakMarketCapSol: true, twitter: true, telegram: true, website: true,
        positions: { select: { id: true }, take: 1 },
      },
    });
    const rows = await Promise.all(
      tokens.map(async ({ positions, ...t }) => {
        const view = await deps.liveState.read(t.mint);
        const m = view ? deriveMetrics(view) : null;
        return {
          ...t,
          feedStatus: detectionStatus({ ...t, hasPosition: positions.length > 0 }),
          live: m && view ? { holders: m.holderCount, marketCapSol: m.marketCapSol, curvePct: m.bondingCurvePct, volumeSol: m.volumeSol, buys: view.buys, sells: view.sells, devHoldingPct: m.devHoldingPct } : null,
        };
      }),
    );
    return req.query.status ? rows.filter((r) => r.feedStatus === req.query.status) : rows;
  });

  app.get<{ Params: { mint: string } }>('/api/detections/:mint', async (req, reply) => {
    const { mint } = req.params;
    const token = await prisma.token.findUnique({
      where: { mint },
      include: {
        safetyChecks: { orderBy: { checkedAt: 'desc' }, take: 1 },
        evaluations: { orderBy: { createdAt: 'desc' }, take: 10 },
        snapshots: { orderBy: { takenAt: 'asc' } },
        positions: { include: { trades: { orderBy: { createdAt: 'asc' } } } },
      },
    });
    if (!token) return reply.code(404).send({ error: 'unknown token' });
    const view = await deps.liveState.read(mint);
    return { ...token, live: view ? deriveMetrics(view) : null };
  });
}
