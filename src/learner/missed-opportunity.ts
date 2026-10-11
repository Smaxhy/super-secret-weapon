/**
 * Outcome tracker — closes the loop on every decision.
 *
 * An hour after launch (the H1 snapshot) we look up the token's latest stored
 * evaluation and ask what actually happened relative to the market cap at the
 * moment we judged it:
 *
 *   COMPLETED  curve filled                              → good
 *   PUMPED     peak MC ≥ `pumpMultiple` × MC at decision → good
 *   DIED       MC now ≤ `deadFraction` × MC at decision  → bad
 *   FLAT       neither                                   → bad (no edge there)
 *
 * Every resolved evaluation becomes a MissedOpportunity row (the table name is
 * historical — it's the full outcome log: skips that pumped, buys that died,
 * and everything in between). Those rows are what the daily adjuster and the
 * Bayesian beliefs learn from, and the ones that hurt are logged loudly so a
 * human can review them on the dashboard.
 */
import type { Decision } from '@prisma/client';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { marketCapSol } from '../lib/pumpfun';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { CreatorProfile } from '../evaluator/wallet-analyzer';
import type { LiveTokenView } from '../scanner/live-state';
import type { ObservationSnapshot } from '../config/types';
import { patternsFor, type BeliefStore } from './bayesian-updater';

const log = moduleLogger('outcomes');

export type Outcome = 'COMPLETED' | 'PUMPED' | 'DIED' | 'FLAT';

export function resolveOutcome(i: { mcAtEval: number; peakMc: number; mcNow: number; complete: boolean }, pumpMultiple: number, deadFraction: number): { outcome: Outcome; peakMultiple: number; good: boolean } {
  const peakMultiple = i.mcAtEval > 0 ? i.peakMc / i.mcAtEval : 0;
  if (i.complete) return { outcome: 'COMPLETED', peakMultiple, good: true };
  if (peakMultiple >= pumpMultiple) return { outcome: 'PUMPED', peakMultiple, good: true };
  if (i.mcAtEval > 0 && i.mcNow / i.mcAtEval <= deadFraction) return { outcome: 'DIED', peakMultiple, good: false };
  return { outcome: 'FLAT', peakMultiple, good: false };
}

interface StoredFeatures {
  market?: Partial<MarketRaw>;
  creator?: CreatorProfile | null;
  checkpointSec?: number;
}

export class OutcomeTracker {
  readonly stats = { resolved: 0, missed: 0, badBuys: 0 };

  constructor(private readonly beliefs: BeliefStore) {}

  /** Wire to the observation logger — only the H1 snapshot resolves outcomes. */
  onSnapshot = async (view: LiveTokenView, snap: ObservationSnapshot): Promise<void> => {
    if (snap.interval !== 'H1') return;
    try {
      await this.resolve(view, snap);
    } catch (err) {
      log.warn({ mint: view.mint, err: (err as Error).message }, 'outcome resolution failed');
    }
  };

  private async resolve(view: LiveTokenView, snap: ObservationSnapshot): Promise<void> {
    const evaluation = await prisma.evaluation.findFirst({ where: { mint: view.mint }, orderBy: { createdAt: 'desc' } });
    if (!evaluation) return;
    if (await prisma.missedOpportunity.count({ where: { evaluationId: evaluation.id } })) return;

    const stored = (evaluation.features ?? {}) as StoredFeatures;
    const mcAtEval = stored.market?.marketCapSol ?? 0;
    if (!mcAtEval) return;

    const [token, position] = await Promise.all([
      prisma.token.findUnique({ where: { mint: view.mint }, select: { symbol: true, peakMarketCapSol: true } }),
      prisma.position.findFirst({ where: { mint: view.mint }, select: { realizedPnlSol: true, exitReason: true, status: true } }),
    ]);
    const peakMc = Math.max(token?.peakMarketCapSol ?? 0, marketCapSol(view.athPriceSol, view.curve.totalSupply), snap.marketCapSol);
    const { learning } = getConfig();
    const r = resolveOutcome({ mcAtEval, peakMc, mcNow: snap.marketCapSol, complete: view.complete }, learning.pumpMultiple, learning.deadFraction);

    const traded = position !== null;
    const decision: Decision = evaluation.decision;
    const notes = JSON.stringify({
      traded,
      pnlSol: position?.realizedPnlSol ?? null,
      exitReason: position?.exitReason ?? null,
      checkpointSec: stored.checkpointSec ?? null,
      setup: stored.market?.setup ?? null,
      reasons: evaluation.reasons,
    });
    await prisma.missedOpportunity.create({
      data: { mint: view.mint, evaluationId: evaluation.id, decision, scoreAtDecision: evaluation.combinedScore, peakMultiple: round(r.peakMultiple), outcome: r.outcome, notes },
    });
    this.stats.resolved++;

    if (stored.market && typeof stored.market.marketCapSol === 'number') {
      await this.beliefs.recordOutcome(patternsFor(withDefaults(stored.market), stored.creator ?? null), r.good);
    }

    const symbol = token?.symbol ?? view.mint.slice(0, 6);
    if (!traded && r.good && decision !== 'REJECT' && evaluation.combinedScore >= getConfig().scoring.storeAboveScore) {
      this.stats.missed++;
      log.info({ mint: view.mint, symbol, score: evaluation.combinedScore, peakMultiple: round(r.peakMultiple), reasons: evaluation.reasons }, `😬 missed ${symbol}: ${r.outcome} ${round(r.peakMultiple)}x after we passed (${(evaluation.reasons as string[])[0]})`);
    } else if (traded && !r.good && (position?.realizedPnlSol ?? 0) < 0) {
      this.stats.badBuys++;
      log.info({ mint: view.mint, symbol, score: evaluation.combinedScore, pnlSol: position?.realizedPnlSol, exitReason: position?.exitReason }, `📉 bad buy ${symbol}: ${r.outcome}, pnl ${position?.realizedPnlSol?.toFixed(4)} SOL`);
    }
  }
}

/** Old evaluations predate the price-action fields; fill them neutrally so patterns still resolve. */
export function withDefaults(m: Partial<MarketRaw>): MarketRaw {
  return {
    ageSec: 0, holders: 0, uniqueWallets: 0, buys: 0, sells: 0, buySellRatio: 0, volumeSol: 0, liquiditySol: 0, bondingCurvePct: 0, curveVelocity: 0,
    priceSol: 0, marketCapSol: 0, devHoldingPct: 0, devSoldFraction: 0, top10HolderPct: 0, earlyBuyerPct: 0, retention: 0, complete: false, totalFeesSol: 0,
    volumeUsd: null, marketCapUsd: null, setup: 'THIN', trendSlopePctPerMin: 0, trendR2: 0, higherLows: 0, lowerHighs: 0, supportSol: null, resistanceSol: null,
    supportDistPct: null, resistanceDistPct: null, athPriceSol: 0, drawdownFromAthPct: 0, change60Pct: 0, change180Pct: 0, extensionPct: 0, buyVolShare60: 0.5,
    flowAcceleration: 0, uniqueBuyers60: 0, trades60: 0, topBuyerShare60: 0, churnRatio: 0, manipulation: 0, strength: 0,
    ...m,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
