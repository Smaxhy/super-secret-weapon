/**
 * What the bot "sees" on a chart (v12.2): active trendlines through swing points that price has respected,
 * horizontal support / resistance where swing points cluster, yesterday's high / low and today's Asian range.
 * Pure, causal (only confirmed swings), used for the Markets view.
 */
import type { Ctx, Swing } from './ta';

export interface TrendLine {
  kind: 'support' | 'resistance';
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  /** value of the line at the last bar */
  pNow: number;
  touches: number;
  /** closed through it on the last bar */
  broken: boolean;
}
export interface Level {
  kind: 'support' | 'resistance';
  price: number;
  touches: number;
}
export interface Drawings {
  lines: TrendLine[];
  levels: Level[];
  prevDay: { h: number; l: number } | null;
  asia: { h: number; l: number } | null;
}

function bestLines(c: Ctx, pts: Swing[], kind: TrendLine['kind'], lookback: number): TrendLine[] {
  const n = c.bars.length;
  const last = n - 1;
  const a = c.atr14[last]!;
  if (!Number.isFinite(a) || a <= 0) return [];
  const recent = pts.filter((s) => s.at <= last && s.i >= n - lookback).slice(-8);
  const out: TrendLine[] = [];
  for (let x = 0; x < recent.length; x++) {
    for (let y = x + 1; y < recent.length; y++) {
      const s1 = recent[x]!;
      const s2 = recent[y]!;
      if (s2.i - s1.i < 5) continue;
      // supports must rise, resistances fall (a trend line, not a flat level)
      if (kind === 'support' ? s2.p <= s1.p : s2.p >= s1.p) continue;
      const slope = (s2.p - s1.p) / (s2.i - s1.i);
      const at = (i: number) => s1.p + slope * (i - s1.i);
      let ok = true;
      let touches = 0;
      for (let i = s1.i; i < last; i++) {
        const b = c.bars[i]!;
        const v = at(i);
        // a close beyond the line (more than 0.25 ATR) means it didn't hold
        if (kind === 'support' ? b.c < v - 0.25 * a : b.c > v + 0.25 * a) {
          ok = false;
          break;
        }
        if (kind === 'support' ? Math.abs(b.l - v) <= 0.2 * a : Math.abs(b.h - v) <= 0.2 * a) touches++;
      }
      if (!ok || touches < 2) continue;
      const pNow = at(last);
      const lc = c.bars[last]!.c;
      out.push({ kind, t1: c.bars[s1.i]!.t, p1: s1.p, t2: c.bars[s2.i]!.t, p2: s2.p, pNow, touches, broken: kind === 'support' ? lc < pNow : lc > pNow });
    }
  }
  // most touches, then most recent second point
  return out.sort((p, q) => q.touches - p.touches || q.t2 - p.t2).slice(0, 2);
}

function levels(c: Ctx, lookback: number): Level[] {
  const n = c.bars.length;
  const a = c.atr14[n - 1]!;
  if (!Number.isFinite(a) || a <= 0) return [];
  const pts = [...c.sw.highs, ...c.sw.lows].filter((s) => s.at <= n - 1 && s.i >= n - lookback).map((s) => s.p).sort((x, y) => x - y);
  const clusters: Array<{ sum: number; k: number }> = [];
  for (const p of pts) {
    const cl = clusters[clusters.length - 1];
    if (cl && p - cl.sum / cl.k <= 0.35 * a) {
      cl.sum += p;
      cl.k++;
    } else clusters.push({ sum: p, k: 1 });
  }
  const px = c.close[n - 1]!;
  return clusters
    .filter((x) => x.k >= 3)
    .map((x) => ({ price: x.sum / x.k, touches: x.k }))
    .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))
    .slice(0, 5)
    .map((x) => ({ kind: x.price < px ? ('support' as const) : ('resistance' as const), price: x.price, touches: x.touches }));
}

export function drawingsFor(c: Ctx, lookback = 150): Drawings {
  const n = c.bars.length;
  return {
    lines: [...bestLines(c, c.sw.lows, 'support', lookback), ...bestLines(c, c.sw.highs, 'resistance', lookback)],
    levels: levels(c, 300),
    prevDay: c.prevDay[n - 1] ? { h: c.prevDay[n - 1]!.h, l: c.prevDay[n - 1]!.l } : null,
    asia: c.asia[n - 1] ?? null,
  };
}
