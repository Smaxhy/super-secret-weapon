/**
 * Bayesian pattern beliefs — the bot's memory of "what tends to happen when…".
 *
 * Every evaluation is described by a handful of coarse patterns, e.g.
 * `snipers:>10`, `setup:PULLBACK`, `dev:sold`, `launches24h:>2`. For each
 * pattern we keep a Beta(α, β) belief about P(good outcome), where "good" means
 * the token went on to at least double from where we evaluated it and "bad"
 * means it fell apart. The outcome tracker resolves outcomes an hour after
 * launch and calls `recordOutcome()`.
 *
 * `patternPrior()` turns the beliefs that apply to a new token into one 0-1
 * feature for the scorer: 0.5 = no opinion, > 0.5 = this combination has
 * historically pumped more often than average, < 0.5 = it usually dies.
 * Patterns with too few observations are ignored, so the prior stays neutral
 * until the data earns the right to move the score.
 */
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { CreatorProfile } from '../evaluator/wallet-analyzer';

const log = moduleLogger('beliefs');
const REFRESH_MS = 5 * 60_000;
export const BASE_PATTERN = 'all';

export interface Belief {
  alpha: number;
  beta: number;
  observations: number;
}

/** Coarse, human-readable buckets. Pure — the same function runs in the backtester. */
export function patternsFor(m: MarketRaw, creator: CreatorProfile | null): string[] {
  const p: string[] = [BASE_PATTERN, `setup:${m.setup}`];
  p.push(m.earlyBuyerPct > 10 ? 'snipers:>10' : m.earlyBuyerPct > 3 ? 'snipers:3-10' : 'snipers:<3');
  p.push(m.top10HolderPct > 35 ? 'top10:>35' : m.top10HolderPct > 20 ? 'top10:20-35' : 'top10:<20');
  p.push(m.devSoldFraction > 0 ? 'dev:sold' : m.devHoldingPct > 5 ? 'dev:holds>5' : 'dev:small');
  p.push(m.curveVelocity > 12 ? 'velocity:>12' : m.curveVelocity >= 2 ? 'velocity:2-12' : 'velocity:<2');
  p.push(m.manipulation > 0.4 ? 'manip:>0.4' : 'manip:low');
  p.push(m.uniqueBuyers60 >= 8 ? 'buyers60:>=8' : m.uniqueBuyers60 >= 4 ? 'buyers60:4-7' : 'buyers60:<4');
  p.push(m.retention >= 0.7 ? 'retention:high' : 'retention:low');
  p.push(m.ageSec < 60 ? 'age:<1m' : m.ageSec < 180 ? 'age:1-3m' : m.ageSec < 480 ? 'age:3-8m' : 'age:>8m');
  p.push(m.bondingCurvePct < 15 ? 'curve:<15' : m.bondingCurvePct < 40 ? 'curve:15-40' : 'curve:>40');
  if (creator) {
    p.push(creator.launches24h === 0 ? 'launches24h:0' : creator.launches24h <= 2 ? 'launches24h:1-2' : 'launches24h:>2');
    p.push(creator.funderCreatorCount > 1 ? 'funder:reused' : 'funder:fresh');
  }
  return p;
}

/** Combine the applicable beliefs into one 0-1 feature. Pure. */
export function combinePrior(patterns: string[], beliefs: Map<string, Belief>, minObservations: number): number {
  const base = beliefs.get(BASE_PATTERN);
  const baseRate = base && base.observations >= minObservations ? base.alpha / (base.alpha + base.beta) : null;
  if (baseRate === null) return 0.5;
  let weighted = 0;
  let weightSum = 0;
  for (const name of patterns) {
    if (name === BASE_PATTERN) continue;
    const b = beliefs.get(name);
    if (!b || b.observations < minObservations) continue;
    const mean = b.alpha / (b.alpha + b.beta);
    // Confidence grows with evidence but saturates — one hot pattern shouldn't dominate.
    const w = Math.min(1, b.observations / (minObservations * 4));
    weighted += w * (mean - baseRate);
    weightSum += w;
  }
  if (weightSum === 0) return 0.5;
  // Average lift over the base rate, scaled so ±25 points of lift saturates the feature.
  const lift = weighted / weightSum;
  return Math.max(0, Math.min(1, 0.5 + lift * 2));
}

export class BeliefStore {
  private beliefs = new Map<string, Belief>();
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const rows = await prisma.beliefState.findMany();
      const next = new Map<string, Belief>();
      for (const r of rows) next.set(r.pattern, { alpha: r.alpha, beta: r.beta, observations: r.observations });
      this.beliefs = next;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'belief refresh failed');
    }
  }

  snapshot(): Map<string, Belief> {
    return this.beliefs;
  }

  prior(patterns: string[]): number {
    return combinePrior(patterns, this.beliefs, getConfig().learning.beliefMinObservations);
  }

  /** Posterior mean P(good) for a pattern, or null if unseen. Handy for the dashboard. */
  probability(pattern: string): number | null {
    const b = this.beliefs.get(pattern);
    return b ? b.alpha / (b.alpha + b.beta) : null;
  }

  async recordOutcome(patterns: string[], good: boolean): Promise<void> {
    const inc = good ? { alpha: { increment: 1 } } : { beta: { increment: 1 } };
    try {
      await prisma.$transaction(
        patterns.map((pattern) =>
          prisma.beliefState.upsert({
            where: { pattern },
            update: { ...inc, observations: { increment: 1 } },
            create: { pattern, alpha: good ? 2 : 1, beta: good ? 1 : 2, observations: 1 },
          }),
        ),
      );
      for (const pattern of patterns) {
        const b = this.beliefs.get(pattern) ?? { alpha: 1, beta: 1, observations: 0 };
        this.beliefs.set(pattern, { alpha: b.alpha + (good ? 1 : 0), beta: b.beta + (good ? 0 : 1), observations: b.observations + 1 });
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'failed to record outcome');
    }
  }
}
