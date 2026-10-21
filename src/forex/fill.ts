/**
 * v17 gap fill (currency pairs only): when Yahoo's hourly candles are missing or behind, the same hours from Dukascopy
 * (bank-grade candles, free) fill them — but only where the two sources agreed in the hours just before the gap
 * (median close difference ≤ 3 pips / 0.04% of the price over ≥ 6 shared hours in the 3 days before). Metals are left
 * alone (Yahoo has futures, Dukascopy spot: different prices). Fills are made fresh every run and never written into
 * Yahoo's store. With almost no Yahoo history at all, the Dukascopy series is used on its own. Pure.
 */
import { instrument, type Bar } from './types';
import type { DkBar } from './dukascopy';

/** fixed before any real result */
export const FILL = { windowDays: 14, minOverlap: 6, overlapDays: 3, maxMedDiffPips: 3, maxMedDiffFrac: 0.0004, bootstrapBars: 400 };

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface FillResult {
  bars: Bar[];
  /** times filled from Dukascopy */
  filled: number[];
  source: 'yahoo' | 'mixed' | 'dukascopy';
  /** why a gap stayed open (first reason), if any */
  reason: string | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

export function fillFromDk(id: string, primary: readonly Bar[], dk: readonly DkBar[], now: number, barMs = HOUR): FillResult {
  const inst = instrument(id);
  const fx = inst ? inst.kind === 'fx' : !id.startsWith('XA');
  const plain = (b: DkBar | Bar): Bar => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  if (!fx || !dk.length) return { bars: [...primary], filled: [], source: 'yahoo', reason: fx ? null : 'metals are not filled (futures vs spot)' };
  const done = dk.filter((b) => b.t + barMs <= now);
  if (primary.length < FILL.bootstrapBars && done.length >= FILL.bootstrapBars) return { bars: done.map(plain), filled: done.map((b) => b.t), source: 'dukascopy', reason: null };
  const have = new Map(primary.map((b) => [b.t, b]));
  const firstP = primary[0]?.t ?? Infinity;
  const cand = done.filter((b) => b.t >= now - FILL.windowDays * DAY && b.t > firstP && !have.has(b.t));
  if (!cand.length) return { bars: [...primary], filled: [], source: 'yahoo', reason: null };
  // contiguous segments of missing hours (a step of more than one bar starts a new segment)
  const segs: DkBar[][] = [];
  for (const b of cand) {
    const s = segs[segs.length - 1];
    if (s && b.t - s[s.length - 1]!.t <= barMs * 3) s.push(b);
    else segs.push([b]);
  }
  const dkBy = new Map(done.map((b) => [b.t, b]));
  const pip = inst?.pip ?? (id.includes('JPY') ? 0.01 : 0.0001);
  const filled: DkBar[] = [];
  let reason: string | null = null;
  for (const s of segs) {
    const start = s[0]!.t;
    const diffs: number[] = [];
    for (const p of primary) {
      if (p.t >= start || p.t < start - FILL.overlapDays * DAY) continue;
      const d = dkBy.get(p.t);
      if (d) diffs.push(Math.abs(p.c - d.c));
    }
    if (diffs.length < FILL.minOverlap) {
      reason = reason ?? `only ${diffs.length} shared hours before the gap (needs ${FILL.minOverlap})`;
      continue;
    }
    const med = median(diffs);
    const px = s[0]!.c;
    if (med > Math.max(FILL.maxMedDiffPips * pip, FILL.maxMedDiffFrac * px)) {
      reason = reason ?? `the two sources disagree by ${(med / pip).toFixed(1)} pips before the gap`;
      continue;
    }
    filled.push(...s);
  }
  if (!filled.length) return { bars: [...primary], filled: [], source: 'yahoo', reason };
  const bars = [...primary, ...filled.map(plain)].sort((a, b) => a.t - b.t);
  return { bars, filled: filled.map((b) => b.t), source: 'mixed', reason };
}
