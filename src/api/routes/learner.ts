/**
 * Learning engine data for the dashboard.
 *   GET  /api/learner          weights (now vs default), weight history, beliefs,
 *                              regime now + history, missed opportunities, label stats
 *   POST /api/learner/adjust   run the weight adjustment right now
 */
import type { FastifyInstance } from 'fastify';
import { DEFAULT_WEIGHTS } from '../../config/default';
import { getWeights } from '../../config/runtime-config';
import { runDailyAdjustment } from '../../learner/daily-adjuster';
import { WIN_MULTIPLE } from '../../learner/outcome-labeler';
import { allHourFactors, currentRegime } from '../../learner/regime-detector';
import { prisma } from '../../lib/prisma';

export async function learnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/learner', async () => {
    const day = new Date(Date.now() - 24 * 3600_000);
    const { weights, version } = getWeights();
    const [snapshots, beliefs, regimes, missed, labeled24h, wins24h, byDecision] = await Promise.all([
      prisma.weightSnapshot.findMany({ orderBy: { version: 'desc' }, take: 10 }),
      prisma.beliefState.findMany({ orderBy: { observations: 'desc' }, take: 30 }),
      prisma.regimeSnapshot.findMany({ orderBy: { createdAt: 'desc' }, take: 96 }),
      prisma.missedOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.evaluation.count({ where: { outcomeLabeledAt: { gte: day } } }),
      prisma.evaluation.count({ where: { outcomeLabeledAt: { gte: day }, outcomeMax: { gte: WIN_MULTIPLE } } }),
      prisma.evaluation.groupBy({ by: ['decision'], where: { outcomeLabeledAt: { gte: day } }, _count: true, _avg: { outcomeMax: true } }),
    ]);
    const mints = [...new Set(missed.map((m) => m.mint))];
    const symbols = new Map((await prisma.token.findMany({ where: { mint: { in: mints } }, select: { mint: true, symbol: true } })).map((t) => [t.mint, t.symbol]));
    return {
      winMultiple: WIN_MULTIPLE,
      weightsVersion: version ?? 0,
      weights: Object.entries(weights).map(([feature, w]) => ({ feature, weight: w, default: DEFAULT_WEIGHTS[feature as keyof typeof DEFAULT_WEIGHTS] })),
      history: snapshots.map((s) => ({ version: s.version, active: s.active, reason: s.reason, createdAt: s.createdAt, changes: s.changes })),
      beliefs: beliefs.map((b) => ({ pattern: b.pattern, winRate: (b.alpha / (b.alpha + b.beta)) * 100, observations: b.observations })),
      regime: currentRegime(),
      hourFactors: allHourFactors(),
      regimeHistory: regimes.reverse().map((r) => ({ t: r.createdAt, regime: r.regime, stats: r.stats })),
      missed: missed.map((m) => ({ ...m, symbol: symbols.get(m.mint) ?? m.mint.slice(0, 6) })),
      labeled24h,
      hitRate24h: labeled24h ? (wins24h / labeled24h) * 100 : null,
      byDecision: byDecision.map((d) => ({ decision: d.decision, count: d._count, avgMax: d._avg.outcomeMax })),
    };
  });

  app.post('/api/learner/adjust', async () => runDailyAdjustment('manual'));
}
