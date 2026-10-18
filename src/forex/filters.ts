/**
 * Trade filters (v13). A filter only VETOES an entry; exits never change. Each strategy is run raw and with every
 * filter; the one it keeps is picked on the FIRST 70% of the history only, so the last 30% stays a fair test.
 *  - strength: buy the stronger currency against the weaker one (gap ≥ STRENGTH_MIN in the trade's direction).
 *  - mtf:      the bigger chart agrees (1h trades: 4h trend with it AND the daily not against; 4h trades: daily with it).
 *  - mood:     no risk-on trade in a clear risk-off market and no safe-haven trade in a clear risk-on one.
 *  - all:      all three.
 * Missing strength / mood data (a feed down) never blocks. The bigger-chart check needs a clear trend, so it also
 * holds back trades in the first weeks of history while the 4h / daily averages warm up.
 */
import type { RStats } from './engine';
import { MOOD_MIN } from './mood';
import type { Timeframe } from './types';

export type FilterKind = 'none' | 'strength' | 'mtf' | 'mood' | 'all';
export const FILTERS: FilterKind[] = ['none', 'strength', 'mtf', 'mood', 'all'];
export const FILTER_LABEL: Record<FilterKind, string> = { none: 'no filter', strength: 'strong vs weak currency', mtf: 'bigger chart agrees', mood: 'market mood', all: 'all three checks' };
export const STRENGTH_MIN = 0.15;
/** risk exposure above this counts as a clear risk-on (or, negative, safe-haven) trade */
export const RISK_TRADE = 0.4;

/** Per-bar readings for one series (aligned to its bars). */
export interface FilterEnv {
  tf: Timeframe;
  /** strength gap base − quote (NaN = unknown) */
  gap: Float64Array;
  /** 4h trend (1h series only; zeros on 4h series) */
  h4: Int8Array;
  /** daily trend */
  d1: Int8Array;
  /** market mood score (NaN = unknown) */
  mood: Float64Array;
  /** risk exposure of buying this pair (+ risk-on, − safe haven) */
  riskLong: number;
}

const passStrength = (e: FilterEnv, i: number, side: 1 | -1) => {
  const g = e.gap[i]!;
  return !Number.isFinite(g) || side * g >= STRENGTH_MIN;
};
const passMtf = (e: FilterEnv, i: number, side: 1 | -1) => (e.tf === '4h' ? e.d1[i] === side : e.h4[i] === side && e.d1[i] !== -side);
const passMood = (e: FilterEnv, i: number, side: 1 | -1) => {
  const m = e.mood[i]!;
  if (!Number.isFinite(m)) return true;
  const exp = side * e.riskLong;
  if (m <= -MOOD_MIN && exp > RISK_TRADE) return false;
  if (m >= MOOD_MIN && exp < -RISK_TRADE) return false;
  return true;
};

/** Why a filter would block this entry (null = allowed). Pure. */
export function blockReason(kind: FilterKind, e: FilterEnv, i: number, side: 1 | -1): string | null {
  if (kind === 'none') return null;
  if ((kind === 'strength' || kind === 'all') && !passStrength(e, i, side)) return 'the currency it buys is not the stronger one';
  if ((kind === 'mtf' || kind === 'all') && !passMtf(e, i, side)) return 'the bigger chart does not agree';
  if ((kind === 'mood' || kind === 'all') && !passMood(e, i, side)) return 'the market mood is against it';
  return null;
}

/** Entry veto for the engine (undefined = allow everything). */
export function allowFor(kind: FilterKind, e: FilterEnv | null): ((i: number, side: 1 | -1) => boolean) | undefined {
  if (kind === 'none' || !e) return undefined;
  return (i, side) => blockReason(kind, e, i, side) === null;
}

export interface VariantStats {
  filter: FilterKind;
  all: RStats;
  inSample: RStats;
  outSample: RStats;
}

/** avg R × √n: rewards a better R per trade without throwing away most of the trades. */
const score = (s: RStats) => s.avgR * Math.sqrt(Math.max(0, s.n));

/**
 * Pick the filter on the FIRST 70% only. A filter must keep ≥ `minN` in-sample trades (and ≥ 25% of the raw count) and
 * beat the raw score by a clear margin, else the strategy stays unfiltered. `prev` (last hour's pick) is kept unless
 * the new best beats it by the same margin, so a near-tie can't flip the bot's trades back and forth. Pure.
 */
export function chooseFilter(v: readonly VariantStats[], minN = 40, prev?: FilterKind): FilterKind {
  const raw = v.find((x) => x.filter === 'none');
  if (!raw) return 'none';
  const valid = (x: VariantStats) => x.filter === 'none' || x.inSample.n >= Math.max(minN, raw.inSample.n * 0.25);
  let best: VariantStats = raw;
  for (const x of v) {
    if (x.filter === 'none' || !valid(x)) continue;
    if (score(x.inSample) > score(best.inSample)) best = x;
  }
  const margin = Math.max(0.5, Math.abs(score(raw.inSample)) * 0.1);
  const pick = best !== raw && score(best.inSample) >= score(raw.inSample) + margin ? best : raw;
  const kept = prev ? v.find((x) => x.filter === prev) : undefined;
  if (kept && kept !== pick && valid(kept) && (kept === raw || score(kept.inSample) >= score(raw.inSample) + margin) && score(pick.inSample) < score(kept.inSample) + margin) return kept.filter;
  return pick.filter;
}
