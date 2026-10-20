/**
 * v26 (owner: "add the real gTrade fees to the tests and the paper account"): the trading venue's own fee, charged on the
 * WHOLE position (margin × leverage), once to open and once to close. gTrade (Gains Network) per-side rates as quoted from
 * docs.gains.trade "Fees & Spread" (via search, Oct 20 2026 — the docs host was unreachable from the sandbox; re-check the
 * live page before going live): forex majors 0.012%, minors / crosses 0.016%, gold 0.05% (silver taken at gold's rate).
 * Coins pay 0 here: their `spreadPips` (types.ts) was already set to a perp taker cost, so charging again would double it.
 * Not modelled: gTrade's borrowing / funding fees (the engine's overnight financing stands in) and price impact on open.
 */
import type { Instrument } from './types';

export const VENUE_FEES = {
  on: true,
  venue: 'gTrade',
  /** % of the position per side */
  majorPct: 0.012,
  minorPct: 0.016,
  metalPct: 0.05,
  cryptoPct: 0,
};

/** the seven USD majors; every other currency pair is a minor / cross on gTrade */
export const FX_MAJORS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD']);

/** The venue's fee per side, % of the position. Pure. */
export function feePctPerSide(inst: Pick<Instrument, 'id' | 'kind'>): number {
  if (!VENUE_FEES.on) return 0;
  if (inst.kind === 'crypto') return VENUE_FEES.cryptoPct;
  if (inst.kind === 'metal') return VENUE_FEES.metalPct;
  return FX_MAJORS.has(inst.id) ? VENUE_FEES.majorPct : VENUE_FEES.minorPct;
}

/** Open + close fee of a trade in R (its starting stop distance): 2 × fee% × entry ÷ |entry − stop|. Pure. */
export function feeR(inst: Pick<Instrument, 'id' | 'kind'>, entry: number, risk: number): number {
  const pct = feePctPerSide(inst);
  if (!(pct > 0) || !(risk > 0) || !(entry > 0)) return 0;
  return (2 * pct * entry) / 100 / risk;
}

/** Open + close fee in USD for a position (or part of one) of `marginUsd` at `leverage`. Pure. */
export function feeUsd(inst: Pick<Instrument, 'id' | 'kind'>, marginUsd: number, leverage: number): number {
  const pct = feePctPerSide(inst);
  if (!(pct > 0) || !(marginUsd > 0) || !(leverage > 0)) return 0;
  return Math.round(((2 * pct * marginUsd * leverage) / 100) * 100) / 100;
}
