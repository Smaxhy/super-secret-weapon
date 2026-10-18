/**
 * Safer sizing, one bet per currency, and the whole-bot backtest (v13).
 *  - Sizing: risk per trade = base risk × strategy factor (proven strategies a bit more, unproven ones less) × wildness
 *    factor (less when a market is far wilder than normal) × drawdown factor (less after the account has dropped).
 *  - Exposure: every open trade puts its risk on two currencies (buying EUR/USD = long EUR + short USD). No currency
 *    may carry more than `ccyCapPct` of the account in one direction, so three dollar trades are not taken as three bets.
 *  - Portfolio: plays the bot's whole system (all chosen strategies together, max open, margin, the rules above) over
 *    the unseen last 30% of the history, week by week, plus a Monte Carlo of the next 3 months from those weeks.
 * Pure.
 */
import { legsOf } from './types';

export const SIZING = {
  baseRiskPct: 1,
  /** risk per trade never below / above these multiples of the base */
  minMult: 0.25,
  maxMult: 1.5,
  /** most risk on one currency in one direction, % of the account (≈ two full trades) */
  ccyCapPct: 2.2,
  maxOpen: 8,
  /** most open trades from one strategy, so one rule can't take every slot */
  maxPerStrategy: 3,
  leverage: 30,
  /** one trade may use at most this share of the free margin */
  marginShare: 0.25,
};

/** Less risk when the market is far wilder than its normal (ATR now ÷ its 100-bar median). */
export const volFactor = (volRatio: number | undefined) => (volRatio === undefined ? 1 : volRatio > 1.8 ? 0.5 : volRatio > 1.4 ? 0.75 : 1);
/** Less risk after the account has dropped from its peak. */
export const ddFactor = (ddPct: number) => (ddPct > 15 ? 0.5 : ddPct > 8 ? 0.75 : 1);
/** Strategy factor from its record (first-70% stats for the honest test, the verdict for the live bot). */
export const stratFactorFromStats = (avgR: number, pf: number | null) => (avgR >= 0.15 && (pf ?? 99) >= 1.3 ? 1.25 : avgR >= 0.05 ? 1 : 0.6);
export const stratFactorFromVerdict = (v: 'edge' | 'maybe' | 'no') => (v === 'edge' ? 1.25 : v === 'maybe' ? 1 : 0.6);
export const clampRisk = (base: number, x: number) => Math.min(base * SIZING.maxMult, Math.max(base * SIZING.minMult, x));

/** Signed risk per currency, % of the account. */
export type Exposure = Record<string, number>;

/** Add a trade's risk to an exposure map (mutates). */
export function addExposure(exp: Exposure, pair: string, side: 1 | -1, riskPct: number): void {
  const [b, q] = legsOf(pair);
  exp[b] = (exp[b] ?? 0) + side * riskPct;
  exp[q] = (exp[q] ?? 0) - side * riskPct;
}

/** The currency a new trade would push past the cap (null = fine). Only blocks moves that ADD to a concentration. */
export function exposureBlock(exp: Exposure, pair: string, side: 1 | -1, riskPct: number, capPct: number): string | null {
  const [b, q] = legsOf(pair);
  for (const [ccy, d] of [[b, side * riskPct], [q, -side * riskPct]] as const) {
    const before = exp[ccy] ?? 0;
    const after = before + d;
    if (Math.abs(after) > capPct + 1e-9 && Math.abs(after) > Math.abs(before) + 1e-9) return ccy;
  }
  return null;
}

export interface PTrade {
  pair: string;
  side: 1 | -1;
  entryT: number;
  exitT: number;
  r: number;
  stopPct: number;
  strategy: string;
  tf: string;
  /** strategy × wildness factor (ignored in flat sizing) */
  sizeF: number;
  /** when several signals arrive at once, the higher one gets the free slot first (its tested R per trade) */
  prio?: number;
}

export interface PortfolioOpts {
  label: string;
  baseRiskPct: number;
  maxOpen: number;
  /** null = no limit per strategy (the old bot) */
  maxPerStrategy: number | null;
  /** best-tested signals first when several arrive at once (the old bot took them in any order) */
  prioritise: boolean;
  /** null = no per-currency cap (the old bot) */
  ccyCapPct: number | null;
  leverage: number;
  marginShare: number;
  /** smaller trades after a drop */
  ddSizing: boolean;
  /** every trade the same size (the old bot) */
  flatSizing: boolean;
  /** report weeks / months over this window (defaults to the trades' span) */
  from?: number;
  to?: number;
  seed?: number;
}

export interface PortfolioResult {
  label: string;
  baseRiskPct: number;
  trades: number;
  skipped: { full: number; ccy: number; margin: number; strategy: number };
  finalX: number;
  totalPct: number;
  weeks: number;
  avgWeekPct: number;
  medianWeekPct: number;
  greenWeeksPct: number;
  /** share of weeks ≥ +5% / ≥ +10% */
  weeks5Pct: number;
  bigWeeksPct: number;
  bestWeekPct: number;
  worstWeekPct: number;
  months: number;
  avgMonthPct: number;
  medianMonthPct: number;
  greenMonthsPct: number;
  /** share of months ≥ +20% */
  bigMonthsPct: number;
  worstMonthPct: number;
  maxDdPct: number;
  blown: boolean;
  /** Monte Carlo of the next 13 weeks from 4-week blocks of the real weeks */
  mc: { paths: number; quarterP10: number; quarterMedian: number; quarterP90: number; pLoss: number; pDd20: number; pDd40: number } | null;
  /** account multiple at the end of each week (for a chart) */
  equity: number[];
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const r1 = (x: number) => Math.round(x * 10) / 10;
const weekOf = (t: number) => Math.floor((t + 4 * DAY) / WEEK); // weeks start Monday 00:00 UTC
const monthOf = (t: number) => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

function summary(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
    median: s.length ? s[Math.floor(s.length / 2)]! : 0,
    green: xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : 0,
    best: s.length ? s[s.length - 1]! : 0,
    worst: s.length ? s[0]! : 0,
  };
}

/** Monte Carlo: 13-week paths from random 4-week blocks of the real weekly returns. Seeded, pure. */
export function monteCarlo(weekly: readonly number[], paths = 2_000, seed = 42): PortfolioResult['mc'] {
  if (weekly.length < 8) return null;
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 1) / 2147483648;
  };
  const block = Math.min(4, weekly.length);
  const ends: number[] = [];
  const dds: number[] = [];
  for (let p = 0; p < paths; p++) {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    let w = 0;
    while (w < 13) {
      const start = Math.floor(rnd() * (weekly.length - block + 1));
      for (let k = 0; k < block && w < 13; k++, w++) {
        eq *= 1 + weekly[start + k]! / 100;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, 1 - eq / peak);
      }
    }
    ends.push((eq - 1) * 100);
    dds.push(dd * 100);
  }
  ends.sort((a, b) => a - b);
  const q = (f: number) => r1(ends[Math.min(ends.length - 1, Math.floor(f * ends.length))]!);
  return {
    paths,
    quarterP10: q(0.1),
    quarterMedian: q(0.5),
    quarterP90: q(0.9),
    pLoss: Math.round((ends.filter((x) => x < 0).length / paths) * 100),
    pDd20: Math.round((dds.filter((x) => x >= 20).length / paths) * 100),
    pDd40: Math.round((dds.filter((x) => x >= 40).length / paths) * 100),
  };
}

/** Play the whole system over the trades. Pure. */
export function simulatePortfolio(trades: readonly PTrade[], o: PortfolioOpts): PortfolioResult {
  type Ev = { t: number; kind: 0 | 1; tr: PTrade };
  const ev: Ev[] = [];
  for (const tr of trades) {
    ev.push({ t: tr.entryT, kind: 0, tr });
    ev.push({ t: tr.exitT, kind: 1, tr });
  }
  // exits first at the same time (frees margin and exposure); then, if prioritising, the best-tested entries first
  ev.sort((a, b) => a.t - b.t || b.kind - a.kind || (o.prioritise && a.kind === 0 ? (b.tr.prio ?? 0) - (a.tr.prio ?? 0) : 0));
  const open = new Map<PTrade, { riskAbs: number; marginAbs: number }>();
  const perStrategy = new Map<string, number>();
  const skipped = { full: 0, ccy: 0, margin: 0, strategy: 0 };
  let eq = 1;
  let peak = 1;
  let dd = 0;
  let blown = false;
  let taken = 0;
  const weekEnd = new Map<number, number>();
  const monthEnd = new Map<number, number>();
  for (const e of ev) {
    if (blown) break;
    if (e.kind === 0) {
      const tr = e.tr;
      if (open.size >= o.maxOpen) {
        skipped.full++;
        continue;
      }
      const sk = `${tr.strategy}:${tr.tf}`;
      if (o.maxPerStrategy !== null && (perStrategy.get(sk) ?? 0) >= o.maxPerStrategy) {
        skipped.strategy++;
        continue;
      }
      const ddPct = (1 - eq / peak) * 100;
      let riskPct = o.flatSizing ? o.baseRiskPct : clampRisk(o.baseRiskPct, o.baseRiskPct * tr.sizeF * (o.ddSizing ? ddFactor(ddPct) : 1));
      if (o.ccyCapPct !== null) {
        const exp: Exposure = {};
        for (const [t, p] of open) addExposure(exp, t.pair, t.side, (p.riskAbs / eq) * 100);
        if (exposureBlock(exp, tr.pair, tr.side, riskPct, o.ccyCapPct)) {
          skipped.ccy++;
          continue;
        }
      }
      // margin: notional = risk ÷ stop distance; a trade may use at most `marginShare` of the free margin
      let riskAbs = (riskPct / 100) * eq;
      let marginAbs = riskAbs / (tr.stopPct / 100) / o.leverage;
      let used = 0;
      for (const p of open.values()) used += p.marginAbs;
      const free = eq - used;
      if (marginAbs > o.marginShare * free) {
        const k = free > 0 ? (o.marginShare * free) / marginAbs : 0;
        riskAbs *= k;
        marginAbs *= k;
        riskPct *= k;
        if (riskPct < o.baseRiskPct * 0.1) {
          skipped.margin++;
          continue;
        }
      }
      open.set(tr, { riskAbs, marginAbs });
      perStrategy.set(sk, (perStrategy.get(sk) ?? 0) + 1);
      taken++;
    } else {
      const p = open.get(e.tr);
      if (!p) continue;
      open.delete(e.tr);
      const sk = `${e.tr.strategy}:${e.tr.tf}`;
      perStrategy.set(sk, Math.max(0, (perStrategy.get(sk) ?? 1) - 1));
      eq = Math.max(0, eq + p.riskAbs * e.tr.r);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak > 0 ? 1 - eq / peak : 1);
      if (eq <= 0.1 * peak) blown = true;
      weekEnd.set(weekOf(e.t), eq);
      monthEnd.set(monthOf(e.t), eq);
    }
  }
  const from = o.from ?? (ev[0]?.t ?? 0);
  const to = o.to ?? (ev[ev.length - 1]?.t ?? 0);
  const weekly: number[] = [];
  const equity: number[] = [];
  let prev = 1;
  if (ev.length || o.from !== undefined) {
    for (let w = weekOf(from); w <= weekOf(to); w++) {
      const v = weekEnd.get(w) ?? prev;
      weekly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
      equity.push(Math.round(v * 1000) / 1000);
      prev = v;
    }
  }
  const monthly: number[] = [];
  prev = 1;
  if (ev.length || o.from !== undefined) {
    for (let m = monthOf(from); m <= monthOf(to); m++) {
      const v = monthEnd.get(m) ?? prev;
      monthly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
      prev = v;
    }
  }
  const ws = summary(weekly);
  const ms = summary(monthly);
  const step = Math.max(1, Math.ceil(equity.length / 60));
  return {
    label: o.label,
    baseRiskPct: o.baseRiskPct,
    trades: taken,
    skipped,
    finalX: Math.round(eq * 100) / 100,
    totalPct: r1((eq - 1) * 100),
    weeks: weekly.length,
    avgWeekPct: r1(ws.avg),
    medianWeekPct: r1(ws.median),
    greenWeeksPct: Math.round(ws.green),
    weeks5Pct: weekly.length ? Math.round((weekly.filter((x) => x >= 5).length / weekly.length) * 100) : 0,
    bigWeeksPct: weekly.length ? Math.round((weekly.filter((x) => x >= 10).length / weekly.length) * 100) : 0,
    bestWeekPct: r1(ws.best),
    worstWeekPct: r1(ws.worst),
    months: monthly.length,
    avgMonthPct: r1(ms.avg),
    medianMonthPct: r1(ms.median),
    greenMonthsPct: Math.round(ms.green),
    bigMonthsPct: monthly.length ? Math.round((monthly.filter((x) => x >= 20).length / monthly.length) * 100) : 0,
    worstMonthPct: r1(ms.worst),
    maxDdPct: Math.round(dd * 100),
    blown,
    mc: monteCarlo(weekly, 2_000, o.seed ?? 42),
    equity: equity.filter((_, k) => k % step === 0 || k === equity.length - 1),
  };
}
