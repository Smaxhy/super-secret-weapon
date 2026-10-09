/**
 * Bayesian beliefs — "when we see pattern X, how often does the token go on to 1.8×?"
 *
 * Each pattern keeps a Beta(alpha, beta) distribution: alpha counts wins,
 * beta counts losses (both start at 1 = "no idea yet"). The win probability
 * estimate is alpha / (alpha + beta) and it sharpens with every labelled
 * outcome. Shown on the Learning page; the daily adjuster uses the same labels.
 */
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('bayesian');

/** What an evaluation's stored `features` JSON looks like (the parts we use). */
export interface StoredFeatures {
  market?: Record<string, number | boolean | null>;
  features?: Record<string, number>;
  socials?: { twitter?: string | null; website?: string | null; telegram?: string | null };
}

/** Human-readable pattern names → test. Pure, exported for tests. */
export const PATTERNS: Record<string, (f: StoredFeatures, strategy: string | null) => boolean> = {
  'Bundlers hold >10%': (f) => Number(f.market?.earlyBuyerPct ?? 0) > 10,
  'Top 10 hold >35%': (f) => Number(f.market?.top10HolderPct ?? 0) > 35,
  'Dev holds >5%': (f) => Number(f.market?.devHoldingPct ?? 0) > 5,
  'Dev sold >30% of bag': (f) => Number(f.market?.devSoldFraction ?? 0) > 0.3,
  '50+ holders': (f) => Number(f.market?.holders ?? 0) >= 50,
  'Fast curve (>5%/min)': (f) => Number(f.market?.curveVelocity ?? 0) > 5,
  'Buyers 3× sellers': (f) => Number(f.market?.buySellRatio ?? 0) >= 3,
  'Volume spiking (3×+ average)': (f) => Number(f.market?.volumeSpikeRatio ?? 1) >= 3,
  'Fees paid >2 SOL': (f) => Number(f.market?.totalFeesSol ?? 0) > 2,
  'Low holder retention (<50%)': (f) => Number(f.market?.retention ?? 1) < 0.5,
  'Has X link': (f) => !!f.socials?.twitter,
  'Has website': (f) => !!f.socials?.website,
  'Already migrated': (f) => f.market?.complete === true,
  'Copy trade (tracked wallet bought)': (_f, s) => s === 'SMART_MONEY_COPY',
};

export function patternsOf(f: StoredFeatures, strategy: string | null): string[] {
  return Object.entries(PATTERNS)
    .filter(([, test]) => {
      try {
        return test(f, strategy);
      } catch {
        return false;
      }
    })
    .map(([name]) => name);
}

/** Pseudo-pattern every labelled outcome counts towards → the overall win rate (the prior). */
export const ALL_PATTERN = 'All labelled tokens';

/**
 * Add one labelled outcome to every pattern it matched (plus the overall
 * pattern). `weight` lets our own trades count more (alpha/beta are floats).
 * Never throws.
 */
export async function updateBeliefs(patterns: string[], win: boolean, weight = 1): Promise<void> {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  try {
    await prisma.$transaction(
      [...patterns, ALL_PATTERN].map((pattern) =>
        prisma.beliefState.upsert({
          where: { pattern },
          update: { alpha: { increment: win ? w : 0 }, beta: { increment: win ? 0 : w }, observations: { increment: 1 } },
          create: { pattern, alpha: 1 + (win ? w : 0), beta: 1 + (win ? 0 : w), observations: 1 },
        }),
      ),
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'belief update failed');
  }
}

export interface BeliefStat {
  pattern: string;
  alpha: number;
  beta: number;
  observations: number;
}

/** In-memory copy of all beliefs, refreshed every few minutes for the scorer (no DB hit per evaluation). */
let cache = new Map<string, BeliefStat>();
let cacheTimer: NodeJS.Timeout | null = null;
export const beliefCache = (): ReadonlyMap<string, BeliefStat> => cache;

export async function refreshBeliefCache(): Promise<void> {
  try {
    const rows = await prisma.beliefState.findMany();
    cache = new Map(rows.map((r) => [r.pattern, { pattern: r.pattern, alpha: r.alpha, beta: r.beta, observations: r.observations }]));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'belief cache refresh failed');
  }
}

export function startBeliefCache(everyMs = 5 * 60_000): void {
  void refreshBeliefCache();
  cacheTimer ??= setInterval(() => void refreshBeliefCache(), everyMs);
  cacheTimer.unref?.();
}
export function stopBeliefCache(): void {
  if (cacheTimer) clearInterval(cacheTimer);
  cacheTimer = null;
}

/**
 * Forget all beliefs (they're rebuilt from new labels). Used after a paper
 * reset so nothing learnt from the old, bugged data keeps steering the scorer.
 */
export async function clearBeliefs(): Promise<number> {
  const r = await prisma.beliefState.deleteMany({});
  cache = new Map();
  return r.count;
}
