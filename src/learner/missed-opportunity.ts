/**
 * Counterfactuals: skipped tokens that ran, and bought tokens that dumped.
 * These are the most useful examples for tuning — "what did we get wrong?"
 */
import type { Decision } from '@prisma/client';
import { prisma } from '../lib/prisma';

/** Record if this outcome is notable. Thresholds: a skip that hit 2×, a buy that fell 40%. */
export async function recordIfMissed(e: { mint: string; evaluationId: string; decision: Decision; score: number; max: number; min: number }): Promise<void> {
  let outcome: string | null = null;
  if (e.decision !== 'BUY' && e.max >= 2) outcome = `Skipped, then went ${e.max.toFixed(1)}×`;
  else if (e.decision === 'BUY' && e.min <= 0.6) outcome = `Bought, then fell ${Math.round((1 - e.min) * 100)}%`;
  if (!outcome) return;
  await prisma.missedOpportunity.create({
    data: { mint: e.mint, evaluationId: e.evaluationId, decision: e.decision, scoreAtDecision: e.score, peakMultiple: e.max, outcome },
  });
}
