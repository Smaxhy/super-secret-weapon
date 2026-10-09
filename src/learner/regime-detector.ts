/**
 * Market regime — is Pump.fun hot, normal, cold or rug-heavy right now?
 *
 * Every 15 minutes, look at the last 6 hours:
 *   - launches per hour (vs the 7-day average)
 *   - share of launches that completed the curve (migration rate)
 *   - share of labelled tokens that hit 1.8× (hit rate)
 *   - share of labelled tokens that dumped hard without ever pumping (rug rate)
 * and classify. The trader and evaluator then apply regimeAdjustments from
 * config: bigger size / easier bar when HOT, smaller / stricter when COLD or RUG_HEAVY.
 */
import type { MarketRegime } from '@prisma/client';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { WIN_MULTIPLE } from './outcome-labeler';

const log = moduleLogger('regime');
const EVERY_MS = 15 * 60_000;

export interface RegimeStats {
  launchesPerHour: number;
  launchesPerHour7d: number;
  migrationRatePct: number;
  hitRatePct: number | null;
  rugRatePct: number | null;
  labeled: number;
}

let current: MarketRegime = 'NORMAL';
export const currentRegime = (): MarketRegime => current;

/** Hit rate per UTC hour vs overall (last 7 days) → size multiplier 0.6-1.3 for the current hour. */
let hourFactors: number[] = Array(24).fill(1);
export const currentHourFactor = (): number => hourFactors[new Date().getUTCHours()] ?? 1;
export const allHourFactors = (): number[] => [...hourFactors];

async function updateHourFactors(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ h: number; n: bigint; wins: bigint }>>`
    SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS h, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE "outcomeMax" >= ${WIN_MULTIPLE}) AS wins
    FROM "Evaluation" WHERE "outcomeLabeledAt" IS NOT NULL AND "createdAt" >= NOW() - INTERVAL '7 days'
    GROUP BY 1`;
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const wins = rows.reduce((s, r) => s + Number(r.wins), 0);
  const overall = total ? wins / total : 0;
  const next: number[] = Array(24).fill(1);
  for (const r of rows) {
    if (Number(r.n) < 30 || overall <= 0) continue;
    next[r.h] = Math.max(0.6, Math.min(1.3, Number(r.wins) / Number(r.n) / overall));
  }
  hourFactors = next;
}

/** Pure classification. Exported for tests. */
export function classify(s: RegimeStats): MarketRegime {
  if (s.labeled >= 30 && (s.rugRatePct ?? 0) >= 60) return 'RUG_HEAVY';
  if ((s.labeled >= 30 && (s.hitRatePct ?? 0) >= 15) || s.migrationRatePct >= 1.5) return 'HOT';
  if ((s.labeled >= 30 && (s.hitRatePct ?? 100) < 5) || (s.launchesPerHour7d > 0 && s.launchesPerHour < s.launchesPerHour7d * 0.6)) return 'COLD';
  return 'NORMAL';
}

async function measure(): Promise<RegimeStats> {
  const now = Date.now();
  const h6 = new Date(now - 6 * 3600_000);
  const d7 = new Date(now - 7 * 24 * 3600_000);
  const [launches6h, launches7d, migrated6h, labeled] = await Promise.all([
    prisma.token.count({ where: { createdAt: { gte: h6 } } }),
    prisma.token.count({ where: { createdAt: { gte: d7 } } }),
    prisma.token.count({ where: { createdAt: { gte: h6 }, status: 'COMPLETED' } }),
    prisma.evaluation.findMany({ where: { outcomeLabeledAt: { gte: h6 } }, select: { outcomeMax: true, outcomeMin: true }, take: 10_000 }),
  ]);
  const firstToken = await prisma.token.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  const hours7d = firstToken ? Math.max(1, Math.min(168, (now - firstToken.createdAt.getTime()) / 3600_000)) : 1;
  const hits = labeled.filter((l) => (l.outcomeMax ?? 0) >= WIN_MULTIPLE).length;
  const rugs = labeled.filter((l) => (l.outcomeMin ?? 1) <= 0.5 && (l.outcomeMax ?? 0) < 1.2).length;
  return {
    launchesPerHour: launches6h / 6,
    launchesPerHour7d: launches7d / hours7d,
    migrationRatePct: launches6h ? (migrated6h / launches6h) * 100 : 0,
    hitRatePct: labeled.length ? (hits / labeled.length) * 100 : null,
    rugRatePct: labeled.length ? (rugs / labeled.length) * 100 : null,
    labeled: labeled.length,
  };
}

async function tick(): Promise<void> {
  try {
    const stats = await measure();
    const regime = classify(stats);
    if (regime !== current) log.info({ from: current, to: regime, ...stats }, `market regime → ${regime}`);
    current = regime;
    await prisma.regimeSnapshot.create({ data: { regime, stats: stats as unknown as object } });
    await updateHourFactors();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'regime update failed');
  }
}

export async function startRegimeDetector(): Promise<NodeJS.Timeout> {
  const last = await prisma.regimeSnapshot.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null);
  if (last) current = last.regime;
  void tick();
  return setInterval(() => void tick(), EVERY_MS);
}
