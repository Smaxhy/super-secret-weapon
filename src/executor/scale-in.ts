/**
 * Buy in two steps (v10.30, idea from OctoBot; owner approved): most losers never go up at all, so the first buy is only
 * part of the size. The rest is added only when the coin proves itself — the price holds above the entry and buyers are
 * in control — within a short window. Rug signals, a drop or no follow-through cancel the second half, so a dud costs
 * half as much. Pure decision functions; the trader buys the legs, the sell manager asks after every check.
 */

export interface ScaleInConfig {
  enabled: boolean;
  /** Share of the planned size bought at the signal (%). */
  firstPct: number;
  /** Earliest / latest moment (s after the first buy) the second half may be added. */
  minWaitSec: number;
  windowSec: number;
  /** Add only when the price is at least this much above the entry (%), and not more than maxRisePct (not chasing). */
  minRisePct: number;
  maxRisePct: number;
  /** This far under the entry (%) → the second half is cancelled. */
  cancelDropPct: number;
  /** Buyers' share of the SOL traded in the last 30 s needed to add (%). */
  minBuySharePct: number;
}

/** Split the planned size; null = buy it all at once (the split would leave a leg under the minimum size). */
export function scaleInPlan(sizeSol: number, minPositionSol: number, c: ScaleInConfig, exempt: boolean): { firstSol: number; laterSol: number } | null {
  if (!c.enabled || exempt) return null;
  const first = Math.round(sizeSol * (c.firstPct / 100) * 1e4) / 1e4;
  const later = Math.round((sizeSol - first) * 1e4) / 1e4;
  if (first < minPositionSol || later <= 0) return null;
  return { firstSol: first, laterSol: later };
}

export interface ScaleInState {
  nowMs: number;
  openedAtMs: number;
  entryPriceSol: number;
  priceSol: number;
  /** Buyers' share of the last 30 s (null = no recent trades). */
  buySharePct: number | null;
  /** Any rug / dump / mirror-sell signal right now. */
  danger: string | null;
  /** Something was already sold (a take-profit fired) → too late to add. */
  alreadySelling: boolean;
}

export type ScaleInAction = { action: 'add' | 'wait' | 'cancel'; why: string };

export function scaleInVerdict(s: ScaleInState, c: ScaleInConfig): ScaleInAction {
  if (s.danger) return { action: 'cancel', why: `not adding: ${s.danger}` };
  if (s.alreadySelling) return { action: 'cancel', why: 'not adding: already taking profit' };
  const x = s.entryPriceSol > 0 ? s.priceSol / s.entryPriceSol : 0;
  const ageSec = (s.nowMs - s.openedAtMs) / 1000;
  if (x > 0 && x <= 1 - c.cancelDropPct / 100) return { action: 'cancel', why: `not adding: fell ${((1 - x) * 100).toFixed(0)}% under the entry` };
  if (ageSec > c.windowSec) return { action: 'cancel', why: `not adding: no follow-through in ${Math.round(c.windowSec / 60)} min` };
  if (ageSec < c.minWaitSec) return { action: 'wait', why: 'too early' };
  const risePct = (x - 1) * 100;
  if (risePct < c.minRisePct) return { action: 'wait', why: `price ${risePct >= 0 ? '+' : ''}${risePct.toFixed(1)}% (needs +${c.minRisePct}%)` };
  if (risePct > c.maxRisePct) return { action: 'wait', why: `ran +${risePct.toFixed(0)}% — not chasing` };
  if (s.buySharePct === null || s.buySharePct < c.minBuySharePct) return { action: 'wait', why: `buyers ${s.buySharePct ?? 0}% (needs ${c.minBuySharePct}%)` };
  return { action: 'add', why: `held +${risePct.toFixed(1)}% with buyers ${s.buySharePct}% of the last 30 s` };
}
