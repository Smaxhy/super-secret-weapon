/**
 * v27.47 (owner: "make it on time"): OANDA prices the US indices and metals live, but as CFDs / spot, while the lab,
 * the bot's stops and Kojiro's signals are all in FUTURES prices (Yahoo NQ=F, ES=F, GC=F … — 10 min late). The gap
 * between the two (the basis: interest until expiry, dividends, roll) is measured on the same 1-minute candles of
 * both feeds and added to OANDA's live price → a live futures-equivalent price. It moves slowly (a few points a day,
 * a jump at the quarterly roll), so it's re-measured every 10 min and only trusted for an hour.
 */
import { isFutures, type Bar } from './types';
import { nyMinOfDay } from './ny-time';

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

/**
 * v27.52 (owner: "what happened to not having delayed candles"): Yahoo's CME candles arrive ~10 min late, so the newest
 * 15-minute / hourly candle of an index or metal was missing when the bot looked. `live` = the same market's candles
 * from a real-time source (Hyperliquid's builder market); the gap is measured on the candles both have (`measureBasis`,
 * ≥ 10) and only the finished live candles NEWER than Yahoo's last one are added, moved onto the futures price. Volume is
 * scaled by the median Yahoo ÷ live ratio of the shared candles (no ratio → none). Candles inside the CME daily halt
 * (17:00–18:00 New York) or for which `closed(t)` says the market is shut are left out. Yahoo's own candle replaces the
 * live one at the next refresh. Pure.
 */
export function extendWithLive(base: readonly Bar[], live: readonly Bar[], barMs: number, now: number, closed: (t: number) => boolean = () => false): { bars: Bar[]; added: number; basis: number | null } {
  if (!base.length || !live.length) return { bars: [...base], added: 0, basis: null };
  const done = live.filter((b) => b.t + barMs <= now && b.c > 0);
  const m = measureBasis(
    base.map((b) => [b.t, b.c] as const),
    done.map((b) => [b.t, b.c] as const),
  );
  if (!m) return { bars: [...base], added: 0, basis: null };
  const byT = new Map(done.map((b) => [b.t, b]));
  const ratios = base.flatMap((b) => {
    const l = byT.get(b.t);
    return l && b.v && l.v ? [b.v / l.v] : [];
  });
  ratios.sort((x, y) => x - y);
  const ratio = ratios.length >= BASIS.minMatches ? ratios[ratios.length >> 1]! : null;
  const last = base[base.length - 1]!.t;
  const B = m.basis;
  const add = done
    .filter((b) => b.t > last && !closed(b.t) && !(nyMinOfDay(b.t) >= 17 * 60 && nyMinOfDay(b.t) < 18 * 60))
    .map((b): Bar => ({ t: b.t, o: b.o + B, h: b.h + B, l: b.l + B, c: b.c + B, ...(ratio !== null && b.v ? { v: b.v * ratio } : {}) }));
  return { bars: [...base, ...add], added: add.length, basis: B };
}
