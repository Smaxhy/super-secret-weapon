/**
 * v27.47 (owner: "make it on time"): OANDA prices the US indices and metals live, but as CFDs / spot, while the lab,
 * the bot's stops and Kojiro's signals are all in FUTURES prices (Yahoo NQ=F, ES=F, GC=F … — 10 min late). The gap
 * between the two (the basis: interest until expiry, dividends, roll) is measured on the same 1-minute candles of
 * both feeds and added to OANDA's live price → a live futures-equivalent price. It moves slowly (a few points a day,
 * a jump at the quarterly roll), so it's re-measured every 10 min and only trusted for an hour.
 */
import { isFutures } from './types';

export const BASIS = {
  /** at least this many minutes both feeds have a close for */
  minMatches: 10,
  refreshMs: 10 * 60_000,
  /** a gap older than this isn't used: the market falls back to Yahoo's delayed price */
  maxAgeMs: 60 * 60_000,
  /** a gap bigger than this share of the price means a wrong pairing / a broken feed, never a basis */
  maxPct: 3,
};

/** Only futures-priced markets need it (currency pairs are the same spot price on both feeds). */
export const needsBasis = (id: string) => isFutures(id);

/** Median of futures close − OANDA close over the minutes both have, or null (too few / implausible). Pure.
 * Rows are [minute open time ms, close]. */
export function measureBasis(fut: ReadonlyArray<readonly [number, number]>, cfd: ReadonlyArray<readonly [number, number]>): { basis: number; n: number } | null {
  const minute = (t: number) => Math.floor(t / 60_000);
  const byMin = new Map(cfd.filter(([, c]) => c > 0).map(([t, c]) => [minute(t), c]));
  const diffs: number[] = [];
  let px = 0;
  for (const [t, c] of fut) {
    const o = byMin.get(minute(t));
    if (o === undefined || !(c > 0)) continue;
    diffs.push(c - o);
    px = c;
  }
  if (diffs.length < BASIS.minMatches) return null;
  diffs.sort((a, b) => a - b);
  const m = diffs.length >> 1;
  const basis = diffs.length % 2 ? diffs[m]! : (diffs[m - 1]! + diffs[m]!) / 2;
  if (Math.abs(basis) > (px * BASIS.maxPct) / 100) return null;
  return { basis, n: diffs.length };
}

export interface BasisRow {
  basis: number;
  n: number;
  at: number;
}

/** Shift an OANDA quote's prices and 1-minute bars by the gap. Pure. */
export function shiftBars<T extends [number, number, number, number, number?]>(bars: readonly T[], b: number): T[] {
  return bars.map((x) => (x.length > 4 && x[4] !== undefined ? [x[0], x[1] + b, x[2] + b, x[3] + b, x[4] + b] : [x[0], x[1] + b, x[2] + b, x[3] + b]) as T);
}
