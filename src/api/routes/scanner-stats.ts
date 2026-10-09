/** GET /api/scanner-stats — launch counts, completion & rug rates, score histogram, scanner health. */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';
import { rpcUsage } from '../../lib/solana';
import { hotKeywords } from '../../scanner/x-watcher';
import type { ApiDeps } from '../deps';

export async function scannerStatsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  /** DexScreener trending (our ranking of its boosted/profiled Solana coins) + whether we track each coin. */
  app.get('/api/dexscreener', async () => {
    const snap = deps.dex?.snapshot() ?? { trending: [], updatedAt: null, error: 'DexScreener not running' };
    return {
      ...snap,
      trending: snap.trending.map((c) => ({ ...c, tracked: deps.liveState.isTracked(c.mint), dexPaid: deps.dex?.paidInfo(c.mint) ?? null })),
    };
  });

  app.get('/api/scanner-stats', async () => {
    const now = Date.now();
    const day = new Date(now - 24 * 3600_000);
    const week = new Date(now - 7 * 24 * 3600_000);
    const [today, thisWeek, completedWeek, flaggedWeek, ruggedWeek, buckets, hourly] = await Promise.all([
      prisma.token.count({ where: { createdAt: { gte: day } } }),
      prisma.token.count({ where: { createdAt: { gte: week } } }),
      prisma.token.count({ where: { createdAt: { gte: week }, status: 'COMPLETED' } }),
      prisma.token.count({ where: { createdAt: { gte: week }, safetyHardFail: true } }),
      prisma.token.count({ where: { createdAt: { gte: week }, status: 'RUGGED' } }),
      prisma.$queryRaw<Array<{ bucket: number; n: bigint }>>`
        SELECT LEAST(FLOOR("combinedScore" / 10), 9)::int AS bucket, COUNT(*) AS n
        FROM "Token" WHERE "combinedScore" IS NOT NULL AND "createdAt" >= ${week}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Array<{ hour: Date; n: bigint }>>`
        SELECT date_trunc('hour', "createdAt") AS hour, COUNT(*) AS n
        FROM "Token" WHERE "createdAt" >= ${day}
        GROUP BY 1 ORDER BY 1`,
    ]);
    const histogram = Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}-${i * 10 + 9}`,
      count: Number(buckets.find((b) => b.bucket === i)?.n ?? 0),
    }));
    return {
      launches24h: today,
      launches7d: thisWeek,
      completionRate7d: thisWeek ? (completedWeek / thisWeek) * 100 : null,
      flaggedRate7d: thisWeek ? (flaggedWeek / thisWeek) * 100 : null,
      rugRate7d: thisWeek ? (ruggedWeek / thisWeek) * 100 : null,
      scoreHistogram: histogram,
      launchesPerHour: hourly.map((h) => ({ hour: h.hour.toISOString(), count: Number(h.n) })),
      regime: null, // Phase 7
      hotKeywords: hotKeywords(),
      // Which entry rules blocked buys in the last 24h (from stored evaluations).
      skipReasons: await (async () => {
        const evals = await prisma.evaluation.findMany({ where: { createdAt: { gte: day }, decision: { not: 'BUY' } }, select: { mint: true, reasons: true }, orderBy: { createdAt: 'desc' }, take: 20_000 });
        const counts = new Map<string, Set<string>>();
        for (const e of evals) {
          for (const r of (e.reasons as string[]) ?? []) {
            // "holders 12 < 20" → "holders"; "MC $8123 < $12000" → "MC"
            const key = r.replace(/["\d$.,%:-]+.*$/, '').replace(/\s+(<|>|outside|above|below).*$/, '').trim() || r;
            if (!counts.has(key)) counts.set(key, new Set());
            counts.get(key)!.add(e.mint);
          }
        }
        return [...counts.entries()].map(([reason, mints]) => ({ reason, tokens: mints.size })).sort((a, b) => b.tokens - a.tokens);
      })(),
      rpc: await (async () => {
        const days = Array.from({ length: 7 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));
        const usage = await Promise.all(days.map((d) => rpcUsage(d)));
        const today = usage[0] ?? {};
        const done = usage.slice(1).filter((u) => (u._total ?? 0) > 0);
        const avgPerDay = done.length ? done.reduce((s, u) => s + (u._total ?? 0), 0) / done.length : (today._total ?? 0);
        return { today: today._total ?? 0, byMethodToday: today, estMonth: Math.round(avgPerDay * 30) };
      })(),
      scanner: deps.listenerStats(),
    };
  });
}
