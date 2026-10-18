/**
 * Forex backtest engine (v12). Signal at a bar's close → filled at the next bar's open + half the spread.
 * Exits are checked on every bar's high / low (stop first when both are touched — the pessimistic choice),
 * gaps fill at the open, stops slip an extra quarter spread. Results are in R so any account size or leverage
 * can be applied afterwards (`equityCurve`).
 */
import type { Ctx } from './ta';
import type { Strategy } from './strategies';
import type { Instrument, Timeframe, Trade } from './types';

export const WARMUP = 210;

export function runSeries(inst: Instrument, tf: Timeframe, c: Ctx, s: Strategy): Trade[] {
  const bars = c.bars;
  const n = bars.length;
  const spread = inst.spreadPips * inst.pip;
  const out: Trade[] = [];
  let pos: {
    side: 1 | -1;
    entryIdx: number;
    entry: number;
    stop: number;
    stop0: number;
    target: number | null;
    trailAtr: number | null;
    maxBars: number | null;
    exitWhen: string | null;
    best: number;
  } | null = null;
  const close = (i: number, px: number, reason: Trade['reason']) => {
    const p = pos!;
    const fill = px - (p.side * spread) / 2 - (reason === 'stop' || reason === 'trail' ? p.side * spread * 0.25 : 0);
    const risk = Math.abs(p.entry - p.stop0);
    out.push({
      strategy: s.id,
      tf,
      pair: inst.id,
      side: p.side,
      entryT: bars[p.entryIdx]!.t,
      exitT: bars[i]!.t,
      entry: p.entry,
      exit: fill,
      r: (p.side * (fill - p.entry)) / risk,
      stopPct: (risk / p.entry) * 100,
      reason,
      bars: i - p.entryIdx + 1,
      stop: p.stop,
      stop0: p.stop0,
      target: p.target,
    });
    pos = null;
  };
  for (let i = WARMUP; i < n; i++) {
    const b = bars[i]!;
    if (pos && pos.entryIdx <= i) {
      const p = pos;
      const hitStop = p.side === 1 ? b.l <= p.stop : b.h >= p.stop;
      const hitTgt = p.target !== null && (p.side === 1 ? b.h >= p.target : b.l <= p.target);
      const trailed = p.stop !== p.stop0;
      if (hitStop) close(i, p.side === 1 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop), trailed ? 'trail' : 'stop');
      else if (hitTgt) close(i, p.side === 1 ? Math.max(b.o, p.target!) : Math.min(b.o, p.target!), 'target');
      else {
        const held = i - p.entryIdx + 1;
        const ew = p.exitWhen;
        const exitNow =
          (ew === 'aboveSma5' && (p.side === 1 ? b.c > c.sma5[i]! : b.c < c.sma5[i]!)) ||
          (ew === 'midBand' && (p.side === 1 ? b.c >= c.bb.mid[i]! : b.c <= c.bb.mid[i]!)) ||
          (ew === 'ema20' && (p.side === 1 ? b.c >= c.ema20[i]! : b.c <= c.ema20[i]!));
        if (exitNow) close(i, b.c, 'exit');
        else if (p.maxBars !== null && held >= p.maxBars) close(i, b.c, 'time');
        else if (p.trailAtr !== null && Number.isFinite(c.atr14[i]!)) {
          p.best = p.side === 1 ? Math.max(p.best, b.c) : Math.min(p.best, b.c);
          const t = p.best - p.side * p.trailAtr * c.atr14[i]!;
          p.stop = p.side === 1 ? Math.max(p.stop, t) : Math.min(p.stop, t);
        }
      }
    }
    if (!pos && i < n - 1) {
      const sig = s.signal(c, i);
      if (sig) {
        const entry = bars[i + 1]!.o + (sig.side * spread) / 2;
        const ok = sig.side === 1 ? sig.stop < entry && (sig.target === null || sig.target > entry) : sig.stop > entry && (sig.target === null || sig.target < entry);
        // the stop must be worth more than the spread, else the trade is all cost
        if (ok && Math.abs(entry - sig.stop) > 2 * spread) {
          pos = {
            side: sig.side,
            entryIdx: i + 1,
            entry,
            stop: sig.stop,
            stop0: sig.stop,
            target: sig.target,
            trailAtr: sig.trailAtr ?? null,
            maxBars: sig.maxBars ?? null,
            exitWhen: sig.exitWhen ?? null,
            best: entry,
          };
        }
      }
    }
  }
  if (pos) close(n - 1, bars[n - 1]!.c, 'open');
  return out;
}

export interface RStats {
  n: number;
  winPct: number;
  avgR: number;
  medianR: number;
  pf: number | null;
  totalR: number;
  /** worst peak-to-trough of cumulative R */
  maxDdR: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function rStats(ts: readonly Trade[]): RStats {
  const done = ts.filter((t) => t.reason !== 'open');
  const n = done.length;
  if (!n) return { n: 0, winPct: 0, avgR: 0, medianR: 0, pf: null, totalR: 0, maxDdR: 0 };
  const rs = done.map((t) => t.r).sort((a, b) => a - b);
  let gw = 0;
  let gl = 0;
  for (const r of rs) if (r > 0) gw += r; else gl -= r;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...done].sort((a, b) => a.exitT - b.exitT)) {
    cum += t.r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return { n, winPct: Math.round((rs.filter((r) => r > 0).length / n) * 100), avgR: r2(cum / n), medianR: r2(rs[Math.floor(n / 2)]!), pf: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0, totalR: r2(cum), maxDdR: r2(dd) };
}

export interface RiskResult {
  riskPct: number;
  /** account multiple at the end (1 = flat) */
  finalX: number;
  avgWeekPct: number;
  medianWeekPct: number;
  greenWeeksPct: number;
  /** share of weeks that made +10% or more */
  bigWeeksPct: number;
  bestWeekPct: number;
  worstWeekPct: number;
  maxDdPct: number;
  /** account fell under 10% of its peak → wiped */
  blown: boolean;
  medianLeverage: number;
  weeks: number;
}

const WEEK = 7 * 86_400_000;

/**
 * Compound the trades at `riskPct` of equity per trade (leverage capped at `maxLev`; a trade needing more is
 * sized down to the cap). Concurrent trades share the equity at their entry. Weekly results from Monday 00:00 UTC.
 */
export function equityCurve(ts: readonly Trade[], riskPct: number, maxLev: number): RiskResult {
  const done = ts.filter((t) => t.reason !== 'open');
  const empty: RiskResult = { riskPct, finalX: 1, avgWeekPct: 0, medianWeekPct: 0, greenWeeksPct: 0, bigWeeksPct: 0, bestWeekPct: 0, worstWeekPct: 0, maxDdPct: 0, blown: false, medianLeverage: 0, weeks: 0 };
  if (!done.length) return empty;
  type Ev = { t: number; kind: 0 | 1; tr: Trade; risk?: number };
  const ev: Ev[] = [];
  for (const tr of done) {
    ev.push({ t: tr.entryT, kind: 0, tr });
    ev.push({ t: tr.exitT, kind: 1, tr });
  }
  // exits before entries at the same time (frees the equity first)
  ev.sort((a, b) => a.t - b.t || b.kind - a.kind);
  const riskOf = new Map<Trade, number>();
  const levs: number[] = [];
  let eq = 1;
  let peak = 1;
  let dd = 0;
  let blown = false;
  const mon = (t: number) => {
    // weeks start Monday 00:00 UTC (epoch was a Thursday → +4 days)
    return Math.floor((t + 4 * 86_400_000) / WEEK);
  };
  const firstWeek = mon(ev[0]!.t);
  const weekEnd = new Map<number, number>();
  for (const e of ev) {
    if (blown) break;
    if (e.kind === 0) {
      let lev = riskPct / e.tr.stopPct;
      let risk = riskPct;
      if (lev > maxLev) {
        lev = maxLev;
        risk = maxLev * e.tr.stopPct;
      }
      levs.push(lev);
      riskOf.set(e.tr, (risk / 100) * eq);
    } else {
      const amt = riskOf.get(e.tr) ?? 0;
      eq = Math.max(0, eq + amt * e.tr.r);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak > 0 ? 1 - eq / peak : 1);
      if (eq <= 0.1 * peak) blown = true;
      weekEnd.set(mon(e.t), eq);
    }
  }
  const lastWeek = mon(ev[ev.length - 1]!.t);
  const weekly: number[] = [];
  let prev = 1;
  for (let w = firstWeek; w <= lastWeek; w++) {
    const v = weekEnd.get(w) ?? prev;
    weekly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
    prev = v;
    if (blown && v <= 0.1 * peak) break;
  }
  const sorted = [...weekly].sort((a, b) => a - b);
  levs.sort((a, b) => a - b);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    riskPct,
    finalX: r2(eq),
    avgWeekPct: r1(weekly.reduce((a, b) => a + b, 0) / Math.max(1, weekly.length)),
    medianWeekPct: r1(sorted[Math.floor(sorted.length / 2)] ?? 0),
    greenWeeksPct: Math.round((weekly.filter((x) => x > 0).length / Math.max(1, weekly.length)) * 100),
    bigWeeksPct: Math.round((weekly.filter((x) => x >= 10).length / Math.max(1, weekly.length)) * 100),
    bestWeekPct: r1(sorted[sorted.length - 1] ?? 0),
    worstWeekPct: r1(sorted[0] ?? 0),
    maxDdPct: Math.round(dd * 100),
    blown,
    medianLeverage: r1(levs[Math.floor(levs.length / 2)] ?? 0),
    weeks: weekly.length,
  };
}
