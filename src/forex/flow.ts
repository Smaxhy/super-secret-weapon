/**
 * v27.35 standard deviation, volume profile and order flow (owner: "standard deviation, order flow, volume profile — I
 * want you to train on that too"). All causal (bar i uses bars up to i only), built once per chart on first use and
 * kept on the Ctx (`flowOf`).
 *  - Deviation: a 20-bar z-score of the close, and a 50-bar linear-regression channel (line, slope, R², the residuals'
 *    standard deviation) → `lrZ` = how many standard deviations the close sits from the line.
 *  - Volume profile: the last 96 candles' traded volume spread over 24 price bins → POC (the busiest price), value area
 *    (the 70% of volume around it: VAL…VAH). A market without real volume (spot FX on Yahoo) gets the TIME profile
 *    instead (how many candles traded at each price — the classic market profile / TPO). Rebuilt every 4 candles.
 *  - Order flow from candles: estimated delta per candle = volume × (2·close − high − low) ÷ (high − low) (where in its
 *    range a candle closed tells who won it; the same weighting Chaikin money flow uses), CMF = 20-candle delta ÷
 *    volume, a 5-candle version, and relative volume (this candle ÷ the 20 before). Only where candles carry volume
 *    (coins, stock indices, metals); NaN elsewhere. True tick-by-tick order flow has no free history — this is the
 *    honest candle estimate.
 */
import type { Ctx } from './ta';

export const FLOW = {
  z: 20,
  lr: 50,
  vpBars: 96,
  vpBins: 24,
  vpStride: 4,
  valueShare: 0.7,
  cmf: 20,
  dr: 5,
  relVol: 20,
};

export interface VolumeProfile {
  poc: number;
  vah: number;
  val: number;
  /** true = real volume, false = time at price (no volume in the window) */
  byVolume: boolean;
}

export interface Flow {
  /** some candles carry volume */
  hasVol: boolean;
  z20: Float64Array;
  lrMid: Float64Array;
  lrSd: Float64Array;
  /** regression slope per candle */
  lrSlope: Float64Array;
  lrR2: Float64Array;
  /** (close − line) ÷ residual standard deviation */
  lrZ: Float64Array;
  delta: Float64Array;
  cmf: Float64Array;
  dr5: Float64Array;
  relVol: Float64Array;
  /** the profile known at bar i (built from the 96 candles up to the last 4-candle step ≤ i) */
  vp(i: number): VolumeProfile | null;
  /** v27.36: previous week's high / low */
  week: Array<{ h: number; l: number } | null>;
}

const volOf = (v: number | undefined) => (v !== undefined && v > 0 ? v : NaN);

/** Value area from a binned profile: start at the POC, add the bigger neighbour until 70% is inside. Pure. */
export function valueArea(bins: readonly number[], lo: number, width: number, share = FLOW.valueShare): { poc: number; vah: number; val: number } | null {
  let total = 0;
  let p = 0;
  for (let k = 0; k < bins.length; k++) {
    total += bins[k]!;
    if (bins[k]! > bins[p]!) p = k;
  }
  if (!(total > 0)) return null;
  let a = p;
  let b = p;
  let acc = bins[p]!;
  while (acc < share * total && (a > 0 || b < bins.length - 1)) {
    const up = b < bins.length - 1 ? bins[b + 1]! : -1;
    const dn = a > 0 ? bins[a - 1]! : -1;
    if (up >= dn) acc += bins[++b]!;
    else acc += bins[--a]!;
  }
  return { poc: lo + (p + 0.5) * width, val: lo + a * width, vah: lo + (b + 1) * width };
}

/** The profile of bars (from, to] — volume when every candle has it, else time at price. Pure. */
export function profileOf(c: Pick<Ctx, 'bars'>, from: number, to: number, nBins = FLOW.vpBins): VolumeProfile | null {
  let lo = Infinity;
  let hi = -Infinity;
  let byVolume = true;
  for (let j = from + 1; j <= to; j++) {
    const b = c.bars[j]!;
    lo = Math.min(lo, b.l);
    hi = Math.max(hi, b.h);
    if (!(volOf(b.v) > 0)) byVolume = false;
  }
  if (!(hi > lo)) return null;
  const width = (hi - lo) / nBins;
  const bins = new Array<number>(nBins).fill(0);
  for (let j = from + 1; j <= to; j++) {
    const b = c.bars[j]!;
    const w = byVolume ? b.v! : 1;
    const k0 = Math.min(nBins - 1, Math.max(0, Math.floor((b.l - lo) / width)));
    const k1 = Math.min(nBins - 1, Math.max(0, Math.floor((b.h - lo) / width)));
    if (k0 === k1 || !(b.h > b.l)) {
      bins[k0]! += w;
      continue;
    }
    // spread the candle's weight over the bins it covers, by overlap
    for (let k = k0; k <= k1; k++) {
      const top = Math.min(b.h, lo + (k + 1) * width);
      const bot = Math.max(b.l, lo + k * width);
      if (top > bot) bins[k]! += (w * (top - bot)) / (b.h - b.l);
    }
  }
  const va = valueArea(bins, lo, width);
  return va ? { ...va, byVolume } : null;
}

/** Build every reading for a chart. Pure. */
export function buildFlow(c: Pick<Ctx, 'bars' | 'close'>): Flow {
  const n = c.bars.length;
  const nan = () => new Float64Array(n).fill(NaN);
  const z20 = nan();
  const lrMid = nan();
  const lrSd = nan();
  const lrSlope = nan();
  const lrR2 = nan();
  const lrZ = nan();
  const delta = nan();
  const cmf = nan();
  const dr5 = nan();
  const relVol = nan();
  const C = c.close;
  // 20-bar z-score
  for (let i = FLOW.z - 1; i < n; i++) {
    let s = 0;
    for (let j = i - FLOW.z + 1; j <= i; j++) s += C[j]!;
    const m = s / FLOW.z;
    let q = 0;
    for (let j = i - FLOW.z + 1; j <= i; j++) q += (C[j]! - m) ** 2;
    const sd = Math.sqrt(q / (FLOW.z - 1));
    if (sd > 0) z20[i] = (C[i]! - m) / sd;
  }
  // 50-bar regression channel (prices taken relative to the newest close for precision)
  const L = FLOW.lr;
  const sx = ((L - 1) * L) / 2;
  const sxx = ((L - 1) * L * (2 * L - 1)) / 6;
  const den = L * sxx - sx * sx;
  for (let i = L - 1; i < n; i++) {
    const ref = C[i]!;
    let sy = 0;
    let sxy = 0;
    for (let k = 0; k < L; k++) {
      const y = C[i - L + 1 + k]! - ref;
      sy += y;
      sxy += k * y;
    }
    const b = (L * sxy - sx * sy) / den;
    const a = (sy - b * sx) / L;
    let ssr = 0;
    let sst = 0;
    const my = sy / L;
    for (let k = 0; k < L; k++) {
      const y = C[i - L + 1 + k]! - ref;
      ssr += (y - (a + b * k)) ** 2;
      sst += (y - my) ** 2;
    }
    const mid = ref + a + b * (L - 1);
    const sd = Math.sqrt(ssr / (L - 2));
    lrMid[i] = mid;
    lrSlope[i] = b;
    lrSd[i] = sd;
    lrR2[i] = sst > 0 ? 1 - ssr / sst : 0;
    if (sd > 0) lrZ[i] = (C[i]! - mid) / sd;
  }
  // order flow from candles
  let hasVol = false;
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = c.bars[i]!;
    const v = volOf(b.v);
    vol[i] = v;
    if (!Number.isFinite(v)) continue;
    hasVol = true;
    delta[i] = b.h > b.l ? (v * (2 * b.c - b.h - b.l)) / (b.h - b.l) : 0;
  }
  if (hasVol) {
    const ratio = (out: Float64Array, len: number) => {
      for (let i = len - 1; i < n; i++) {
        let d = 0;
        let v = 0;
        let okAll = true;
        for (let j = i - len + 1; j <= i && okAll; j++) {
          if (!Number.isFinite(vol[j]!)) okAll = false;
          else {
            d += delta[j]!;
            v += vol[j]!;
          }
        }
        if (okAll && v > 0) out[i] = d / v;
      }
    };
    ratio(cmf, FLOW.cmf);
    ratio(dr5, FLOW.dr);
    for (let i = FLOW.relVol; i < n; i++) {
      if (!Number.isFinite(vol[i]!)) continue;
      let s = 0;
      let okAll = true;
      for (let j = i - FLOW.relVol; j < i && okAll; j++) {
        if (!Number.isFinite(vol[j]!)) okAll = false;
        else s += vol[j]!;
      }
      if (okAll && s > 0) relVol[i] = vol[i]! / (s / FLOW.relVol);
    }
  }
  const cache = new Map<number, VolumeProfile | null>();
  const vp = (i: number): VolumeProfile | null => {
    if (!(i >= 0) || i >= n) return null;
    const s = i - (i % FLOW.vpStride);
    if (s < FLOW.vpBars - 1) return null;
    if (!cache.has(s)) cache.set(s, profileOf(c, s - FLOW.vpBars, s));
    return cache.get(s)!;
  };
  return { hasVol, z20, lrMid, lrSd, lrSlope, lrR2, lrZ, delta, cmf, dr5, relVol, vp, week: prevWeekLevels(c) };
}

/** The chart's readings, built on first use. */
export function flowOf(c: Ctx): Flow {
  return (c.flow ??= buildFlow(c));
}

/**
 * v27.36 absorption (owner's friend: "when the sellers or buyers get absorbed at my level, I enter"). Sellers absorbed at
 * bar i (side +1): one of the last 3 candles pushed to a new 10-candle low, yet it closed in the top half of its range —
 * with real volume it must be heavy (≥ 1.5× normal: the effort was there, the result wasn't); without volume (spot FX) the
 * lower wick must be at least half the candle and the close in its top third (the rejection). No lower low since, and the
 * newest close at or above that candle's close. Mirrored for buyers absorbed (−1). Returns the absorbing candle's
 * extreme (for the stop) or null. Pure, causal.
 */
export const ABSORB = { look: 3, newLow: 10, relVol: 1.5, closeShare: 0.5, wickShare: 0.5, wickClose: 2 / 3 };
export function absorptionAt(c: Ctx, i: number, side: 1 | -1): { j: number; extreme: number } | null {
  const f = flowOf(c);
  const B = c.bars;
  const lo = (j: number) => (side > 0 ? B[j]!.l : -B[j]!.h);
  const hi = (j: number) => (side > 0 ? B[j]!.h : -B[j]!.l);
  const cl = (j: number) => side * B[j]!.c;
  const op = (j: number) => side * B[j]!.o;
  for (let j = i; j >= Math.max(ABSORB.newLow, i - ABSORB.look + 1); j--) {
    let prevLow = Infinity;
    for (let k = j - ABSORB.newLow; k < j; k++) prevLow = Math.min(prevLow, lo(k));
    if (!(lo(j) < prevLow)) continue;
    const range = hi(j) - lo(j);
    if (!(range > 0)) continue;
    const rv = f.relVol[j]!;
    const heldUp = cl(j) - lo(j);
    const absorbed = Number.isFinite(rv)
      ? rv >= ABSORB.relVol && heldUp >= ABSORB.closeShare * range
      : Math.min(op(j), cl(j)) - lo(j) >= ABSORB.wickShare * range && heldUp >= ABSORB.wickClose * range;
    if (!absorbed) continue;
    for (let k = j + 1; k <= i; k++) if (lo(k) < lo(j)) return null;
    if (cl(i) < cl(j)) return null;
    return { j, extreme: side * lo(j) };
  }
  return null;
}

/** Previous week's high / low per bar (weeks roll Sunday 21:00 UTC, the FX open). Pure, causal. */
export function prevWeekLevels(c: Pick<Ctx, 'bars'>): Array<{ h: number; l: number } | null> {
  const out: Array<{ h: number; l: number } | null> = [];
  let wk = -1;
  let cur = { h: -Infinity, l: Infinity };
  let prev: { h: number; l: number } | null = null;
  for (const b of c.bars) {
    const w = Math.floor((b.t / 86_400_000 + 3 + 3 / 24) / 7);
    if (w !== wk) {
      if (wk >= 0 && Number.isFinite(cur.h)) prev = { ...cur };
      wk = w;
      cur = { h: -Infinity, l: Infinity };
    }
    cur.h = Math.max(cur.h, b.h);
    cur.l = Math.min(cur.l, b.l);
    out.push(prev);
  }
  return out;
}
