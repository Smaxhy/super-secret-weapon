/**
 * Trade filters (v13). A filter only VETOES an entry; exits never change. Each strategy is run raw and with every
 * filter; the one it keeps is picked on the FIRST 70% of the history only, so the last 30% stays a fair test.
 *  - strength: buy the stronger currency against the weaker one (gap ≥ STRENGTH_MIN in the trade's direction).
 *  - mtf:      the bigger chart agrees (1h trades: 4h trend with it AND the daily not against; 4h trades: daily with it).
 *  - mood:     no risk-on trade in a clear risk-off market and no safe-haven trade in a clear risk-on one.
 *  - regime:   (v14) trend strategies only in a clean directional market (efficiency ratio ≥ ER_TREND), dip / fade
 *              strategies only in a choppy one; timing and pullback strategies pass.
 *  - volf:     (v16) breakout / trend strategies only when the volatility forecast says moves are about to get bigger
 *              (volF ≥ 1), fades only when they are expected to calm down (volF ≤ 1.05).
 *  - hurst:    (v16) trend strategies only when moves have been continuing (Hurst ≥ 0.52), fades only when they have
 *              been snapping back (≤ 0.48).
 *  - crowd:    (v16) no long when hedge funds are already near their most-long on the pair (CFTC positioning ≥ 1.2 of ±2),
 *              no short when near their most-short — the crowded side is where the squeeze comes from.
 *  - all:      strength + bigger chart + mood.
 * Missing strength / mood data (a feed down) never blocks. The bigger-chart check needs a clear trend, so it also
 * holds back trades in the first weeks of history while the 4h / daily averages warm up.
 */
import type { RStats } from './engine';
import { MOOD_MIN } from './mood';
import { STRETCH } from './stretch';
import type { Style } from './strategies';
import type { Timeframe } from './types';

export type FilterKind = 'none' | 'strength' | 'mtf' | 'mood' | 'regime' | 'volf' | 'hurst' | 'crowd' | 'stretch' | 'all';
export const FILTERS: FilterKind[] = ['none', 'strength', 'mtf', 'mood', 'regime', 'volf', 'hurst', 'crowd', 'stretch', 'all'];
export const FILTER_LABEL: Record<FilterKind, string> = { none: 'no filter', strength: 'strong vs weak currency', mtf: 'bigger chart agrees', mood: 'market mood', regime: 'right market regime', volf: 'volatility forecast fits', hurst: 'trend / chop measure fits', crowd: 'not on the crowded side', stretch: 'not overstretched (price)', all: 'strength + bigger chart + mood' };
/** v16 thresholds */
export const VOLF_UP = 1;
export const VOLF_CALM = 1.05;
export const HURST_TREND = 0.52;
export const HURST_REVERT = 0.48;
export const CROWD_MAX = 1.2;
/** efficiency ratio (20 bars) above which a market counts as trending */
export const ER_TREND = 0.3;
export const STRENGTH_MIN = 0.15;
/** risk exposure above this counts as a clear risk-on (or, negative, safe-haven) trade */
export const RISK_TRADE = 0.4;

/** Per-bar readings for one series (aligned to its bars). */
export interface FilterEnv {
  tf: Timeframe;
  /** strength gap base − quote (NaN = unknown) */
  gap: Float64Array;
  /** 4h trend (1h series only; zeros on 4h series). v15: on 15m series the 1h trend, on 1m series the 15m trend */
  h4: Int8Array;
  /** daily trend. v15: on 15m series the 4h trend, on 1m series the 1h trend */
  d1: Int8Array;
  /** market mood score (NaN = unknown) */
  mood: Float64Array;
  /** risk exposure of buying this pair (+ risk-on, − safe haven) */
  riskLong: number;
  /** v14: efficiency ratio per bar (NaN = unknown) */
  er?: Float64Array;
  /** v16: volatility forecast ratio, Hurst exponent, carry (%), CFTC positioning (±2) per bar (NaN = unknown) */
  volF?: Float64Array;
  hurst?: Float64Array;
  carry?: Float64Array;
  cot?: Float64Array;
  /** v17: price stretch of the pair, base − quote, −2 … +2 (a positioning stand-in from prices only; NaN = unknown) */
  crowdPx?: Float64Array;
}

const passStrength = (e: FilterEnv, i: number, side: 1 | -1) => {
  const g = e.gap[i]!;
  return !Number.isFinite(g) || side * g >= STRENGTH_MIN;
};
const passMtf = (e: FilterEnv, i: number, side: 1 | -1) => (e.tf === '4h' ? e.d1[i] === side : e.h4[i] === side && e.d1[i] !== -side);
/** v15: the charts `h4` / `d1` hold for each timeframe (the next bigger chart must agree, the one above not be against) */
export const BIGGER_CHARTS: Record<Timeframe, [string, string]> = { '1m': ['15-minute', '1-hour'], '15m': ['1-hour', '4-hour'], '1h': ['4-hour', 'daily'], '4h': ['daily', 'daily'] };
const passMood = (e: FilterEnv, i: number, side: 1 | -1) => {
  const m = e.mood[i]!;
  if (!Number.isFinite(m)) return true;
  const exp = side * e.riskLong;
  if (m <= -MOOD_MIN && exp > RISK_TRADE) return false;
  if (m >= MOOD_MIN && exp < -RISK_TRADE) return false;
  return true;
};

const passRegime = (e: FilterEnv, i: number, style: Style) => {
  const er = e.er?.[i];
  if (er === undefined || !Number.isFinite(er) || style === 'neutral' || style === 'pullback') return true;
  return style === 'trend' ? er >= ER_TREND : er < ER_TREND;
};

const fin = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);
export const passVolF = (e: FilterEnv, i: number, style: Style) => {
  const v = e.volF?.[i];
  if (!fin(v) || style === 'pullback') return true;
  return style === 'revert' ? v <= VOLF_CALM : v >= VOLF_UP;
};
export const passHurst = (e: FilterEnv, i: number, style: Style) => {
  const h = e.hurst?.[i];
  if (!fin(h) || style === 'neutral' || style === 'pullback') return true;
  return style === 'trend' ? h >= HURST_TREND : h <= HURST_REVERT;
};
export const passCrowd = (e: FilterEnv, i: number, side: 1 | -1) => {
  const c = e.cot?.[i];
  return !fin(c) || side * c < CROWD_MAX;
};

/** v17: no buying a pair whose base has run up far harder than its quote (and the mirror) — price-only crowding */
export const passStretch = (e: FilterEnv, i: number, side: 1 | -1) => {
  const c = e.crowdPx?.[i];
  return !fin(c) || side * c < STRETCH.crowdMax;
};

/** Why a filter would block this entry (null = allowed). Pure. */
export function blockReason(kind: FilterKind, e: FilterEnv, i: number, side: 1 | -1, style: Style = 'neutral'): string | null {
  if (kind === 'none') return null;
  if (kind === 'regime') return passRegime(e, i, style) ? null : style === 'trend' ? 'the market is choppy, not trending' : 'the market is trending, not choppy';
  if (kind === 'volf') return passVolF(e, i, style) ? null : style === 'revert' ? 'moves are expected to get bigger' : 'moves are expected to calm down';
  if (kind === 'hurst') return passHurst(e, i, style) ? null : style === 'trend' ? 'moves have been snapping back, not continuing' : 'moves have been continuing, not snapping back';
  if (kind === 'crowd') return passCrowd(e, i, side) ? null : `hedge funds are already crowded ${side === 1 ? 'long' : 'short'} on it`;
  if (kind === 'stretch') return passStretch(e, i, side) ? null : `it has already run ${side === 1 ? 'up' : 'down'} unusually hard (price stretch)`;
  if ((kind === 'strength' || kind === 'all') && !passStrength(e, i, side)) return 'the currency it buys is not the stronger one';
  if ((kind === 'mtf' || kind === 'all') && !passMtf(e, i, side)) return 'the bigger chart does not agree';
  if ((kind === 'mood' || kind === 'all') && !passMood(e, i, side)) return 'the market mood is against it';
  return null;
}

/** v17: which data each filter reads (a filter passes when its data is missing — fine in a backtest, not live). */
const FILTER_INPUTS: Partial<Record<FilterKind, Array<[keyof FilterEnv, string]>>> = {
  strength: [['gap', 'currency strength']],
  mood: [['mood', 'market mood (S&P / VIX feed)']],
  all: [['gap', 'currency strength'], ['mood', 'market mood (S&P / VIX feed)']],
  regime: [['er', 'trend / chop reading']],
  volf: [['volF', 'volatility forecast']],
  hurst: [['hurst', 'continue / snap-back reading']],
  crowd: [['cot', 'CFTC positioning']],
  stretch: [['crowdPx', 'price stretch']],
};

/** Share of the first `upTo` bars where each filter input is known (pure). */
export function filterCoverage(e: FilterEnv, upTo: number): Partial<Record<keyof FilterEnv, number>> {
  const out: Partial<Record<keyof FilterEnv, number>> = {};
  for (const k of ['gap', 'mood', 'er', 'volF', 'hurst', 'cot', 'crowdPx'] as const) {
    const a = e[k] as Float64Array | undefined;
    if (!a) continue;
    const n = Math.min(upTo, a.length);
    let ok = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(a[i]!)) ok++;
    out[k] = n ? ok / n : 0;
  }
  return out;
}

/**
 * v17 live guard: the strategy was tested WITH this filter, but the data the filter reads is missing at the signal bar
 * (a feed is down) although it was there for ≥ 80% of the tested history → trading now would be an untested variant,
 * so the trade waits. Data that was rarely there in the history (e.g. positioning on metals) never blocks. Pure.
 */
export function missingInput(kind: FilterKind, e: FilterEnv | null, i: number, coverage: Partial<Record<keyof FilterEnv, number>>, minCover = 0.8): string | null {
  if (!e) return null;
  for (const [k, label] of FILTER_INPUTS[kind] ?? []) {
    const a = e[k] as Float64Array | undefined;
    if (!a || (coverage[k] ?? 0) < minCover) continue;
    if (!Number.isFinite(a[i]!)) return `its ${label} check has no data right now (feed missing): waiting rather than trading it untested`;
  }
  return null;
}

/** Entry veto for the engine (undefined = allow everything). */
export function allowFor(kind: FilterKind, e: FilterEnv | null, style: Style = 'neutral'): ((i: number, side: 1 | -1) => boolean) | undefined {
  if (kind === 'none' || !e) return undefined;
  if (kind === 'regime' && (style === 'neutral' || style === 'pullback')) return undefined;
  if (kind === 'hurst' && (style === 'neutral' || style === 'pullback')) return undefined;
  if (kind === 'volf' && style === 'pullback') return undefined;
  return (i, side) => blockReason(kind, e, i, side, style) === null;
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
 * Pick a variant on the FIRST 70% only. A variant must keep ≥ `minN` in-sample trades (and ≥ 25% of the base
 * variant's count) and beat the base's score by a clear margin, else the base stays. `prev` (last hour's pick) is kept
 * unless the new best beats it by the same margin, so a near-tie can't flip the bot's trades back and forth. Pure.
 */
export function chooseVariant<K extends string>(v: ReadonlyArray<{ key: K; inSample: RStats }>, baseKey: K, minN = 40, prev?: K): K {
  const raw = v.find((x) => x.key === baseKey);
  if (!raw) return baseKey;
  const valid = (x: { key: K; inSample: RStats }) => x.key === baseKey || x.inSample.n >= Math.max(minN, raw.inSample.n * 0.25);
  let best = raw;
  for (const x of v) {
    if (x.key === baseKey || !valid(x)) continue;
    if (score(x.inSample) > score(best.inSample)) best = x;
  }
  const margin = Math.max(0.5, Math.abs(score(raw.inSample)) * 0.1);
  const pick = best !== raw && score(best.inSample) >= score(raw.inSample) + margin ? best : raw;
  const kept = prev ? v.find((x) => x.key === prev) : undefined;
  if (kept && kept !== pick && valid(kept) && (kept === raw || score(kept.inSample) >= score(raw.inSample) + margin) && score(pick.inSample) < score(kept.inSample) + margin) return kept.key;
  return pick.key;
}

/**
 * Owner preference (v15, v15.1): `preferred` in the owner's order. The first one that scores at least as well as the
 * best variant on the FIRST 70% (within 5% of its score, or 0.1) and keeps enough trades is used instead. Last hour's
 * owner pick (`prev`) stays while it is within a wider band (10%, or 0.2), so a near-tie can't flip the bot's trades
 * back and forth. Selection still sees the first 70% only, so the unseen 30% stays a fair test. Pure.
 */
export function preferVariant<K extends string>(v: ReadonlyArray<{ key: K; inSample: RStats }>, chosen: K, preferred: readonly K[], baseKey: K, minN = 40, prev?: K): K {
  const raw = v.find((x) => x.key === baseKey);
  if (!raw) return chosen;
  const enough = (x: { inSample: RStats }) => x.inSample.n >= Math.max(minN, raw.inSample.n * 0.25);
  // the yardstick: the best-scoring variant with enough trades (or the pick)
  let best = v.find((x) => x.key === chosen);
  for (const x of v) if (enough(x) && (!best || score(x.inSample) > score(best.inSample))) best = x;
  if (!best) return chosen;
  const sc = score(best.inSample);
  const kept = prev && preferred.includes(prev) ? v.find((y) => y.key === prev) : undefined;
  if (kept && enough(kept) && score(kept.inSample) >= sc - Math.max(0.2, Math.abs(sc) * 0.1)) return kept.key;
  for (const k of preferred) {
    const x = v.find((y) => y.key === k);
    if (x && enough(x) && score(x.inSample) >= sc - Math.max(0.1, Math.abs(sc) * 0.05)) return k;
  }
  return chosen;
}

/** Filter pick (see `chooseVariant`). */
export function chooseFilter(v: readonly VariantStats[], minN = 40, prev?: FilterKind): FilterKind {
  return chooseVariant(v.map((x) => ({ key: x.filter, inSample: x.inSample })), 'none', minN, prev);
}
