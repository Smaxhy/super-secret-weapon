/**
 * One training set for the learners (win model, rule search, allocator): every closed PAPER trade since the
 * last reset (≤ 30 days) + the shadow trades (pretend trades on coins it didn't buy), each with the SAME flat
 * entry features the evaluator sees at buy time (ai-coach flattenFeatures), the result and a weight:
 *   real trade 1 · learning / probe trade 0.8 · shadow it would have taken (refused / near) 0.5 · skipped by a rule 0.3
 * Cached for 5 minutes so the three learners share one DB read.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { prisma } from '../lib/prisma';
import type { OutcomeResult } from './outcome-tracker';
import { flattenFeatures } from './ai-coach';
import { learningSince } from './labels';
import { wouldHaveTaken, type ShadowResult } from './shadow-trades';

export interface LearnRow {
  flat: Record<string, number>;
  strategy: string;
  atMs: number;
  pnlPct: number;
  peakX: number;
  weight: number;
  source: 'real' | 'shadow' | 'outcome';
}

const WEIGHT = { real: 1, learning: 0.8, wouldTake: 0.5, skipped: 0.4 };

/** Pure: how long after entry a trade of this strategy is (almost) surely closed. */
export function embargoMs(strategy: string): number {
  const h = strategy === 'SWING' ? 9 : strategy === 'MIGRATION_MOMENTUM' ? 4.5 : strategy === 'SMART_MONEY_COPY' ? 2 : 1.5;
  return h * 3_600_000;
}

/** Pure: a shadow trade as a learning row. */
export function shadowRow(r: ShadowResult): LearnRow {
  return { flat: r.flat ?? {}, strategy: r.strategy, atMs: r.openedAtMs, pnlPct: r.pnlPct, peakX: r.peakX, weight: wouldHaveTaken(r) ? WEIGHT.wouldTake : WEIGHT.skipped, source: 'shadow' };
}

export class LearnRows {
  private cache: { at: number; rows: LearnRow[] } | null = null;
  private pending: Promise<LearnRow[]> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly shadowSource: ((sinceMs: number) => Promise<ShadowResult[]>) | null,
    /** Every coin it checked and didn't buy, replayed with its exits (outcome-tracker.ts). */
    private readonly outcomeSource: ((sinceMs: number) => Promise<OutcomeResult[]>) | null = null,
  ) {}

  /** All rows (real + shadow). `onlyTaken` drops shadow trades the bot would NOT have taken (for the allocator). */
  async load(opts: { onlyTaken?: boolean } = {}): Promise<LearnRow[]> {
    const rows = await this.all();
    return opts.onlyTaken ? rows.filter((r) => r.source === 'real' || r.weight >= WEIGHT.wouldTake) : rows;
  }

  private async all(): Promise<LearnRow[]> {
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.rows;
    this.pending ??= this.read().finally(() => (this.pending = null));
    return this.pending;
  }

  private async read(): Promise<LearnRow[]> {
    const since = Math.max((await learningSince(this.redis))?.getTime() ?? 0, Date.now() - 30 * 86_400_000);
    const ps = await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: new Date(since) } },
      // Newest first so the cap drops the OLDEST trades, never the newest (the learners' exams use the newest).
      orderBy: { openedAt: 'desc' },
      take: 5_000,
      select: { strategy: true, sizeSol: true, realizedPnlSol: true, entryPriceSol: true, peakPriceSol: true, openedAt: true, entryContext: true, token: { select: { createdAt: true } }, evaluation: { select: { combinedScore: true, features: true } } },
    });
    const real: LearnRow[] = ps
      .filter((p) => p.sizeSol > 0 && p.evaluation)
      .map((p) => {
        const ec = (p.entryContext ?? {}) as { marketCapUsd?: number; kols?: number; explore?: boolean; probe?: boolean };
        return {
          flat: flattenFeatures(p.evaluation?.features, {
            score: p.evaluation?.combinedScore ?? null,
            kols: ec.kols ?? null,
            mcUsd: ec.marketCapUsd ?? null,
            ageMin: p.token ? (p.openedAt.getTime() - p.token.createdAt.getTime()) / 60_000 : null,
            hourUtc: p.openedAt.getUTCHours(),
            dowUtc: p.openedAt.getUTCDay(),
          }),
          strategy: p.strategy,
          atMs: p.openedAt.getTime(),
          pnlPct: (p.realizedPnlSol / p.sizeSol) * 100,
          peakX: p.entryPriceSol > 0 ? p.peakPriceSol / p.entryPriceSol : 1,
          weight: ec.explore || ec.probe ? WEIGHT.learning : WEIGHT.real,
          source: 'real' as const,
        };
      });
    const shadow = this.shadowSource ? (await this.shadowSource(since).catch(() => [])).map(shadowRow) : [];
    const ow = (getConfig().outcomes ?? DEFAULT_CONFIG.outcomes).weight;
    const outcomes = this.outcomeSource ? (await this.outcomeSource(since).catch(() => [])).map((r): LearnRow => ({ flat: { ...r.flat, 'entry.score': r.score }, strategy: r.strategy, atMs: r.atMs, pnlPct: r.pnlPct, peakX: r.peakX, weight: ow, source: 'outcome' })) : [];
    // Closed trades only exist once they closed: recently opened LONG holds are still open, so the newest slice would
    // over-represent quick losers (stops / time stops). Drop rows younger than the strategy's longest normal hold.
    const now = Date.now();
    const rows = [...real, ...shadow, ...outcomes]
      .filter((r) => Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs) && r.atMs <= now - embargoMs(r.strategy))
      .sort((a, b) => a.atMs - b.atMs);
    this.cache = { at: Date.now(), rows };
    return rows;
  }
}
