/**
 * Learning engine data for the dashboard.
 *   GET  /api/learner          weights (now vs default), weight history, beliefs,
 *                              regime now + history, missed opportunities, label stats
 *                              + lastAdjustAt / nextAdjustAt, recent adjustment steps
 *                              (accepted/rejected, AUC before/after), clean label stats
 *                              (wins / losses / excluded) and learned keywords
 *   POST /api/learner/adjust   run the weight adjustment right now
 */
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../../config/default';
import { getConfig, getWeights } from '../../config/runtime-config';
import { adjusterTimes, loadLabelled, recentSteps, runAdjustment } from '../../learner/daily-adjuster';
import { ALL_PATTERN } from '../../learner/bayesian-updater';
import { keywordInsights } from '../../learner/keyword-learner';
import { coachSnapshot } from '../../learner/trade-coach';
import { calibration } from '../../learner/score-calibration';
import { topWallets } from '../../learner/wallet-reputation';
import { redis } from '../../lib/redis';
import { allHourFactors, currentRegime } from '../../learner/regime-detector';
import { prisma } from '../../lib/prisma';

/** Label stats are a 20k-row scan → cache them for a minute. */
const WIN_MULTIPLE = DEFAULT_CONFIG.learning.winMultiple;

let labelCache: { at: number; value: unknown } | null = null;
async function labelStats(): Promise<unknown> {
  if (labelCache && Date.now() - labelCache.at < 60_000) return labelCache.value;
  const s = await loadLabelled(redis, false);
  const value = {
    since: s.since.toISOString(),
    wins: s.wins,
    losses: s.losses,
    excluded: s.excluded,
    excludedBy: s.excludedBy,
    fromTrades: s.fromTrades,
    winRate: s.wins + s.losses ? (s.wins / (s.wins + s.losses)) * 100 : null,
  };
  labelCache = { at: Date.now(), value };
  return value;
}

export async function learnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/learner', async () => {
    const day = new Date(Date.now() - 24 * 3600_000);
    const { weights, version } = getWeights();
    const [snapshots, beliefs, regimes, missed, labeled24h, wins24h, byDecision] = await Promise.all([
      prisma.weightSnapshot.findMany({ orderBy: { version: 'desc' }, take: 10 }),
      prisma.beliefState.findMany({ orderBy: { observations: 'desc' }, take: 30 }),
      prisma.regimeSnapshot.findMany({ orderBy: { createdAt: 'desc' }, take: 96 }),
      prisma.missedOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.evaluation.count({ where: { outcomeLabeledAt: { gte: day }, outcomeMax: { not: null } } }),
      prisma.evaluation.count({ where: { outcomeLabeledAt: { gte: day }, outcomeMax: { gte: WIN_MULTIPLE }, outcomeMin: { gt: DEFAULT_CONFIG.learning.drawdownLossMultiple } } }),
      prisma.evaluation.groupBy({ by: ['decision'], where: { outcomeLabeledAt: { gte: day } }, _count: true, _avg: { outcomeMax: true } }),
    ]);
    const mints = [...new Set(missed.map((m) => m.mint))];
    const symbols = new Map((await prisma.token.findMany({ where: { mint: { in: mints } }, select: { mint: true, symbol: true } })).map((t) => [t.mint, t.symbol]));
    const lc = getConfig().learning ?? DEFAULT_CONFIG.learning;
    const [times, adjustments, labels, keywords, coach, smartWallets] = await Promise.all([
      adjusterTimes(redis),
      recentSteps(redis, 20),
      labelStats().catch(() => null),
      Promise.resolve()
        .then(() => keywordInsights(redis, 20))
        .catch(() => null),
      coachSnapshot(redis).catch(() => null),
      topWallets(redis, 10).catch(() => null),
    ]);
    return {
      winMultiple: lc.winMultiple,
      drawdownLossMultiple: lc.drawdownLossMultiple,
      lastAdjustAt: times.lastAdjustAt,
      nextAdjustAt: times.nextAdjustAt,
      adjustPendingAfterTrade: times.pendingAfterTrade,
      adjustEveryMinutes: lc.adjustEveryMinutes,
      adjustments,
      labelStats: labels,
      keywords,
      // Trade coach: per-strategy adjustments + the latest trade reviews (lessons).
      coach,
      // Wallets the bot learned are early on winners.
      smartWallets,
      // Real win rate per strategy per score band (do high scores actually win?).
      calibration: calibration(),
      weightsVersion: version ?? 0,
      weights: Object.entries(weights).map(([feature, w]) => ({ feature, weight: w, default: DEFAULT_WEIGHTS[feature as keyof typeof DEFAULT_WEIGHTS] })),
      history: snapshots.map((s) => ({ version: s.version, active: s.active, reason: s.reason, createdAt: s.createdAt, changes: s.changes })),
      beliefs: beliefs.map((b) => ({
        pattern: b.pattern,
        winRate: (b.alpha / (b.alpha + b.beta)) * 100,
        observations: b.observations,
        overall: b.pattern === ALL_PATTERN,
        // Used in scoring once it has enough samples.
        usedInScoring: lc.oddsEnabled && b.pattern !== ALL_PATTERN && b.observations >= lc.oddsMinSamples,
      })),
      regime: currentRegime(),
      hourFactors: allHourFactors(),
      regimeHistory: regimes.reverse().map((r) => ({ t: r.createdAt, regime: r.regime, stats: r.stats })),
      missed: missed.map((m) => ({ ...m, symbol: symbols.get(m.mint) ?? m.mint.slice(0, 6) })),
      labeled24h,
      hitRate24h: labeled24h ? (wins24h / labeled24h) * 100 : null,
      byDecision: byDecision.map((d) => ({ decision: d.decision, count: d._count, avgMax: d._avg.outcomeMax })),
    };
  });

  app.post('/api/learner/adjust', async () => runAdjustment('manual'));
}
