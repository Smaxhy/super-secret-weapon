/**
 * Bigger-chart agreement (v13). The trend on the 4-hour and the daily chart, read at a smaller bar's close from the
 * last bigger bar that had already FINISHED by then (no look-ahead). Trend = close and the 20 EMA both on the same side
 * of the 50 EMA: +1 up, −1 down, 0 no clear trend. Days run 22:00 → 22:00 UTC (≈ the 17:00 New York forex day);
 * weekend slivers shorter than 6 hours are dropped.
 */
import { emaSeries } from '../evaluator/ta/indicators';
import type { Bar } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SpanBar extends Bar {
  /** time the bar finished */
  end: number;
}

/** Hourly → daily bars (22:00 UTC boundary). Pure. */
export function toDaily(h1: readonly Bar[]): SpanBar[] {
  const out: SpanBar[] = [];
  let cur: SpanBar | null = null;
  let count = 0;
  const flush = () => {
    if (cur && count >= 6) out.push(cur);
  };
  for (const b of h1) {
    const key = Math.floor((b.t + 2 * HOUR) / DAY);
    const start = key * DAY - 2 * HOUR;
    if (!cur || cur.t !== start) {
      flush();
      cur = { t: start, end: start + DAY, o: b.o, h: b.h, l: b.l, c: b.c };
      count = 0;
    }
    cur.h = Math.max(cur.h, b.h);
    cur.l = Math.min(cur.l, b.l);
    cur.c = b.c;
    count++;
  }
  flush();
  return out;
}

/** 4h bars (from `to4h`) with their end time. */
export const withEnd = (bars: readonly Bar[], spanMs: number): SpanBar[] => bars.map((b) => ({ ...b, end: b.t + spanMs }));

/** Trend per bar: +1 / −1 / 0. Needs 50 bars before it says anything. Pure. */
export function trendSeries(bars: readonly Bar[]): Int8Array {
  const close = bars.map((b) => b.c);
  const e20 = emaSeries(close, 20);
  const e50 = emaSeries(close, 50);
  const out = new Int8Array(bars.length);
  for (let i = 50; i < bars.length; i++) {
    const c = close[i]!;
    const a = e20[i]!;
    const b = e50[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (c > b && a > b) out[i] = 1;
    else if (c < b && a < b) out[i] = -1;
  }
  return out;
}

/**
 * For each decision time (ascending), the trend of the last bigger bar that had finished by then. Pure.
 */
export function alignTrend(decisionTimes: readonly number[], big: readonly SpanBar[], trend: Int8Array): Int8Array {
  const out = new Int8Array(decisionTimes.length);
  let k = -1;
  for (let i = 0; i < decisionTimes.length; i++) {
    const d = decisionTimes[i]!;
    while (k + 1 < big.length && big[k + 1]!.end <= d) k++;
    out[i] = k >= 0 ? trend[k]! : 0;
  }
  return out;
}

/** Decision time of each bar = its close. */
export const decisionTimes = (bars: readonly Bar[], barMin: number): number[] => bars.map((b) => b.t + barMin * 60_000);
