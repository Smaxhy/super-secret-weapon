/**
 * Multi-timeframe view of a coin (owner: "check 5 s, 30 s, 1 min, 5 min, 1 hour"). Candles are built straight from
 * the crowd trade log (pool price after each trade), so every timeframe is exact — not a resample of 15 s.
 *
 * Per timeframe:
 *   lastPct    move of the current (still open) candle
 *   prevPct    move of the last completed candle
 *   run3Pct    change over the last 3 candles (current one included)
 *   offHighPct % under the high of the last 20 candles (0 = at the top)
 *   green      green candles in a row (completed ones)
 *   rsi        RSI 14 on the closes (null with < 15 candles)
 *   volAccel   SOL traded in the last 3 candles ÷ the 3 before
 *   buyShare   buy SOL ÷ all SOL over the last 3 candles (%)
 *
 * Stored as `features.tf.<s5|s15|s30|m1|m5|h1>.*` on every evaluation (AI coach, rule search, win model, autopsy
 * can all use them) and checked against the owner's limits (`entry.timeframes`, editable on the Controls page).
 * Pure.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';
import type { Candle } from './chart-reader';
import { rsi } from './chart-reader';

export const TIMEFRAMES = [
  { key: 's5', label: '5 s', stepMs: 5_000 },
  { key: 's15', label: '15 s', stepMs: 15_000 },
  { key: 's30', label: '30 s', stepMs: 30_000 },
  { key: 'm1', label: '1 min', stepMs: 60_000 },
  { key: 'm5', label: '5 min', stepMs: 300_000 },
  { key: 'h1', label: '1 hour', stepMs: 3_600_000 },
] as const;
export type TfKey = (typeof TIMEFRAMES)[number]['key'];

export interface TfStats {
  lastPct: number;
  prevPct: number | null;
  run3Pct: number;
  offHighPct: number;
  green: number;
  rsi: number | null;
  volAccel: number;
  buyShare: number;
  candles: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);

/** Candles of `stepMs` from trades (gaps filled with the previous close), oldest first, at most `max`. */
export function candlesFromTrades(trades: readonly CrowdTrade[], stepMs: number, now: number, max = 120): Candle[] {
  const from = Math.floor(now / stepMs) * stepMs - (max - 1) * stepMs;
  const out: Candle[] = [];
  let prevClose = 0;
  for (const t of trades) {
    const px = t.pp && t.pp > 0 ? t.pp : t.px;
    if (!(px > 0) || t.t > now) continue;
    if (t.t < from) {
      prevClose = px;
      continue;
    }
    const b = Math.floor(t.t / stepMs) * stepMs;
    let last = out[out.length - 1];
    if (!last && prevClose > 0 && b > from) out.push((last = { t: from, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0, bv: 0, sv: 0, n: 0 }));
    if (last && last.t < b) {
      for (let k = last.t + stepMs; k < b; k += stepMs) out.push({ t: k, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, bv: 0, sv: 0, n: 0 });
      last = out[out.length - 1];
    }
    if (last && last.t === b) {
      last.h = Math.max(last.h, px);
      last.l = Math.min(last.l, px);
      last.c = px;
      last.v += t.sol;
      if (t.buy) last.bv += t.sol;
      else last.sv += t.sol;
      last.n++;
    } else {
      const o = last?.c ?? (prevClose > 0 ? prevClose : px);
      out.push({ t: b, o, h: Math.max(o, px), l: Math.min(o, px), c: px, v: t.sol, bv: t.buy ? t.sol : 0, sv: t.buy ? 0 : t.sol, n: 1 });
    }
  }
  // Up to now: a quiet stretch at the end still counts as flat candles.
  const cur = Math.floor(now / stepMs) * stepMs;
  const last = out[out.length - 1];
  if (last) for (let k = last.t + stepMs; k <= cur; k += stepMs) out.push({ t: k, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, bv: 0, sv: 0, n: 0 });
  return out.slice(-max);
}

export function tfStats(cs: readonly Candle[]): TfStats | null {
  if (!cs.length) return null;
  const last = cs[cs.length - 1]!;
  const done = cs.slice(0, -1);
  const prev = done[done.length - 1];
  const base = cs[Math.max(0, cs.length - 3)]!;
  const win = cs.slice(-20);
  const high = Math.max(...win.map((c) => c.h));
  let green = 0;
  for (let i = done.length - 1; i >= 0 && done[i]!.c > done[i]!.o; i--) green++;
  const sum = (xs: readonly Candle[], f: (c: Candle) => number) => xs.reduce((s, c) => s + f(c), 0);
  const v3 = sum(cs.slice(-3), (c) => c.v);
  const vPrev = sum(cs.slice(-6, -3), (c) => c.v);
  const bv = sum(cs.slice(-3), (c) => c.bv);
  const sv = sum(cs.slice(-3), (c) => c.sv);
  const r = cs.length >= 15 ? rsi(cs.map((c) => c.c), 14) : null;
  return {
    lastPct: r1(pct(last.c, last.o)),
    prevPct: prev ? r1(pct(prev.c, prev.o)) : null,
    run3Pct: r1(pct(last.c, base.o)),
    offHighPct: r1(high > 0 ? (1 - last.c / high) * 100 : 0),
    green,
    rsi: r === null ? null : r1(r),
    volAccel: r1(vPrev > 0 ? v3 / vPrev : v3 > 0 ? 3 : 1),
    buyShare: r1(bv + sv > 0 ? (bv / (bv + sv)) * 100 : 50),
    candles: cs.length,
  };
}

/** Every timeframe at once (null where there are no trades yet). */
export function timeframes(trades: readonly CrowdTrade[], now: number): Partial<Record<TfKey, TfStats>> {
  const out: Partial<Record<TfKey, TfStats>> = {};
  if (!trades.length) return out;
  for (const tf of TIMEFRAMES) {
    const s = tfStats(candlesFromTrades(trades, tf.stepMs, now, tf.key === 'h1' ? 24 : 120));
    if (s) out[tf.key] = s;
  }
  return out;
}

export interface TfLimits {
  /** Per timeframe: don't buy when the current candle rose more than this (%; 0 = off). */
  maxLastCandlePct: Record<TfKey, number>;
  /** Per timeframe: don't buy when the last 3 candles rose more than this (%; 0 = off). */
  maxRun3Pct: Record<TfKey, number>;
  /** Per timeframe: don't buy when the current candle fell more than this (%; 0 = off). */
  maxLastDropPct: Record<TfKey, number>;
}

/** The owner's timeframe limits → the first one broken (null = all fine). */
export function timeframeFail(tf: Partial<Record<TfKey, TfStats>>, lim: TfLimits): string | null {
  for (const t of TIMEFRAMES) {
    const s = tf[t.key];
    if (!s) continue;
    const up = lim.maxLastCandlePct?.[t.key] ?? 0;
    if (up > 0 && s.lastPct > up) return `${t.label} candle +${s.lastPct}% (max ${up}%) — chasing`;
    const run = lim.maxRun3Pct?.[t.key] ?? 0;
    if (run > 0 && s.run3Pct > run) return `last 3 × ${t.label} candles +${s.run3Pct}% (max ${run}%) — chasing`;
    const dn = lim.maxLastDropPct?.[t.key] ?? 0;
    if (dn > 0 && s.lastPct < -dn) return `${t.label} candle ${s.lastPct}% (max −${dn}%) — dumping`;
  }
  return null;
}
