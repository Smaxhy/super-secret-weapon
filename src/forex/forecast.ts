/**
 * v18 the quant desk: a continuous, vol-targeted forecast system in the style of Rob Carver's pysystemtrade
 * ("Systematic Trading"), built from his published rules and read from his repo's defaults:
 *  - RULES give a CONTINUOUS signed forecast per market per day, already vol-normalised: the EWMAC trend ladder
 *    (fast / slow span pairs 2/8 … 64/256 on price ÷ price-change vol), the breakout ladder (where the price sits in
 *    its 10 … 320-day range, smoothed), carry (policy-rate gap ÷ annual vol, smoothed), acceleration (is the trend
 *    strengthening). Each is SCALED so its average size is 10 (scalar = 10 ÷ the expanding mean of the cross-market
 *    median |raw|, estimated on the FIRST 70% only and frozen for the unseen 30%; his fixed scalars are the fallback)
 *    and capped at ±20.
 *  - COSTS in Sharpe units gate the rules per market: a rule's annual turnover × the cost of one trade (half spread +
 *    slippage ÷ annual price vol) must stay under the "speed limit" (0.13 SR / year): fast rules on wide-spread
 *    markets are dropped before they are combined.
 *  - COMBINATION: a weighted sum of the admitted rules (fixed family weights, nothing fitted), times a forecast
 *    diversification multiplier (1 ÷ √(w′Cw), correlations from the first 70%, negatives floored at 0, cap 2.5),
 *    capped at ±20 again.
 *  - SIZING: vol targeting — the position at an average forecast gives the account its daily cash vol target
 *    (equity × 20% a year ÷ 16); position = that × forecast ÷ 10 × instrument weight × instrument diversification
 *    multiplier; a ±10% buffer around the target so small forecast wobbles don't trade (trade to the band's edge).
 *  - SIMULATION on daily bars: decide at the 22:00 UTC close, fill at the open of the first bar two hours later (so
 *    the rollover spread is avoided; the weekly open pays its ×4 spread), costs on every position change, P&L in USD.
 * Everything is causal; the first 70% fits scalars / correlations / the cost gate, the unseen 30% is the exam. Pure.
 */
import { spreadMultAt } from './spreads';
import { FINANCING, swapGain } from './financing';
import type { Instrument } from './types';

export const CARVER = {
  targetAbs: 10,
  cap: 20,
  /** vol of daily price changes: EWM span, min days, and the share of the long-run average blended in */
  volSpan: 35,
  volMin: 10,
  slowShare: 0.3,
  ewmac: [2, 4, 8, 16, 32, 64],
  breakout: [10, 20, 40, 80, 160, 320],
  accel: [16, 32, 64],
  carrySpan: 90,
  /** Carver's fixed scalars (the fallback when the first 70% is too short to estimate one) */
  fixed: { ewmac: { 2: 10.6, 4: 7.5, 8: 5.3, 16: 3.75, 32: 2.65, 64: 1.87 } as Record<number, number>, breakout: 0.7, carry: 30, accel: { 16: 7.82, 32: 5.56, 64: 3.9 } as Record<number, number> },
  /** days of cross-market medians needed before an estimated scalar replaces the fixed one */
  minScalarDays: 100,
  /** family weights (sum 1; split equally inside a family) — Carver's default is half carry, half trend */
  families: { trend: 0.35, breakout: 0.25, carry: 0.25, accel: 0.15 } as Record<RuleFamily, number>,
  fdmCap: 2.5,
  idmCap: 2.5,
  /** annual vol target of the account (half-Kelly territory for a system with Sharpe ~0.4) */
  volTarget: 0.2,
  buffer: 0.1,
  /** a rule's annual cost in Sharpe units may not exceed this on a market (⅓ of a 0.4 pre-cost Sharpe) */
  speedLimit: 0.13,
  /** slippage per fill in pips on top of the half spread */
  slipPips: 0.1,
  /** gross notional may not exceed this multiple of equity (the practice account's margin is 30×) */
  maxLeverage: 20,
  /** a daily price change beyond this many vols is winsorised in the vol estimate */
  volClip: 5,
};

export type RuleFamily = 'trend' | 'breakout' | 'carry' | 'accel';

export interface RuleDef {
  id: string;
  family: RuleFamily;
  label: string;
  fixedScalar: number;
}

export const RULES: RuleDef[] = [
  ...CARVER.ewmac.map((n) => ({ id: `ewmac${n}`, family: 'trend' as const, label: `EWMAC ${n}/${n * 4}`, fixedScalar: CARVER.fixed.ewmac[n]! })),
  ...CARVER.breakout.map((n) => ({ id: `breakout${n}`, family: 'breakout' as const, label: `breakout ${n} days`, fixedScalar: CARVER.fixed.breakout })),
  { id: 'carry', family: 'carry', label: 'carry (rate gap ÷ vol)', fixedScalar: CARVER.fixed.carry },
  ...CARVER.accel.map((n) => ({ id: `accel${n}`, family: 'accel' as const, label: `acceleration ${n}`, fixedScalar: CARVER.fixed.accel[n]! })),
];

/** one market's daily data, aligned on the desk's calendar (NaN where the market has no bar that day) */
export interface DailyMarket {
  inst: Instrument;
  /** close of each calendar day (22:00 UTC boundary) */
  close: Float64Array;
  /** fill price of the day's decision: the open of the first hourly bar two hours into the NEXT day (NaN = none) */
  fill: Float64Array;
  /** time of that fill bar and the bar before it (for the spread multiple) */
  fillT: Float64Array;
  fillPrevT: Float64Array;
  /** policy-rate gap base − quote in % per calendar day (NaN = unknown) */
  carry?: Float64Array;
}

export interface DeskInput {
  /** calendar: start of each day (ms), ascending */
  cal: number[];
  markets: DailyMarket[];
  /** the lab's 70/30 line (ms) */
  oosFrom: number;
  /** start equity, USD */
  equity: number;
  /** USD per unit of a currency on a day (1 for USD; null = unknown) */
  usdPer: (ccy: string, d: number) => number | null;
  volTarget?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fin = (x: number) => Number.isFinite(x);

/** Exponentially weighted mean with the given span over an array (NaN inputs are skipped, output NaN until the first). */
function ewm(xs: ArrayLike<number>, span: number): Float64Array {
  const a = 2 / (span + 1);
  const out = new Float64Array(xs.length).fill(NaN);
  let m = NaN;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (!fin(x)) {
      out[i] = m;
      continue;
    }
    m = fin(m) ? m + a * (x - m) : x;
    out[i] = m;
  }
  return out;
}

/**
 * Carver's vol: EWM standard deviation (span 35) of daily price CHANGES, blended 70 / 30 with its long-run average,
 * in price units per day. NaN until `volMin` changes are known. Big changes are winsorised at ±`volClip` vols.
 */
export function carverVol(close: ArrayLike<number>, span = CARVER.volSpan, minN = CARVER.volMin, slowShare = CARVER.slowShare): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  const a = 2 / (span + 1);
  let mean = 0;
  let varE = 0;
  let count = 0;
  let prev = NaN;
  let slowSum = 0;
  let slowN = 0;
  for (let i = 0; i < n; i++) {
    const c = close[i]!;
    if (!fin(c)) {
      out[i] = count >= minN ? out[i - 1]! : NaN;
      continue;
    }
    if (fin(prev)) {
      let d = c - prev;
      const sd = Math.sqrt(Math.max(varE, 0));
      if (count >= minN && sd > 0) d = Math.max(-CARVER.volClip * sd, Math.min(CARVER.volClip * sd, d));
      count++;
      if (count === 1) {
        mean = d;
        varE = 0;
      } else {
        const delta = d - mean;
        mean += a * delta;
        varE = (1 - a) * (varE + a * delta * delta);
      }
      if (count >= minN) {
        const base = Math.sqrt(Math.max(varE, 1e-20));
        slowSum += base;
        slowN++;
        out[i] = (1 - slowShare) * base + slowShare * (slowSum / slowN);
      }
    }
    prev = c;
  }
  return out;
}

/** EWMAC: (EMA fast − EMA slow) ÷ price-change vol (slow = 4 × fast). */
export function ewmacRaw(close: ArrayLike<number>, vol: ArrayLike<number>, fast: number): Float64Array {
  const f = ewm(close, fast);
  const s = ewm(close, fast * 4);
  const out = new Float64Array(close.length).fill(NaN);
  for (let i = 0; i < out.length; i++) {
    const v = vol[i]!;
    if (fin(f[i]!) && fin(s[i]!) && fin(v) && v > 0 && fin(close[i]!)) out[i] = (f[i]! - s[i]!) / v;
  }
  return out;
}

/** Breakout: 40 × (price − mid of the N-day range) ÷ the range, smoothed over N/4 days (±20 by construction). */
export function breakoutRaw(close: ArrayLike<number>, n: number): Float64Array {
  const len = close.length;
  const raw = new Float64Array(len).fill(NaN);
  const minP = Math.ceil(n / 2);
  const win: number[] = [];
  for (let i = 0; i < len; i++) {
    const c = close[i]!;
    if (fin(c)) win.push(c);
    if (win.length > n) win.shift();
    if (!fin(c) || win.length < minP) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (const x of win) {
      if (x > hi) hi = x;
      if (x < lo) lo = x;
    }
    const range = hi - lo;
    raw[i] = range > 0 ? (40 * (c - (hi + lo) / 2)) / range : 0;
  }
  return ewm(raw, Math.max(1, Math.floor(n / 4)));
}

/** Carry: (rate gap % ÷ 100) ÷ (annual % vol), smoothed — the "Sharpe of just holding it". */
export function carryRaw(carryPct: ArrayLike<number>, close: ArrayLike<number>, vol: ArrayLike<number>, span = CARVER.carrySpan): Float64Array {
  const raw = new Float64Array(close.length).fill(NaN);
  for (let i = 0; i < raw.length; i++) {
    const c = close[i]!;
    const v = vol[i]!;
    const k = carryPct[i]!;
    if (fin(c) && fin(v) && v > 0 && fin(k) && c > 0) raw[i] = k / 100 / ((v / c) * 16);
  }
  return ewm(raw, span);
}

/** Acceleration: EWMAC(n, 4n) now minus n days ago. */
export function accelRaw(close: ArrayLike<number>, vol: ArrayLike<number>, n: number): Float64Array {
  const e = ewmacRaw(close, vol, n);
  const out = new Float64Array(e.length).fill(NaN);
  for (let i = n; i < e.length; i++) if (fin(e[i]!) && fin(e[i - n]!)) out[i] = e[i]! - e[i - n]!;
  return out;
}

/** Raw forecast of a rule on one market. */
export function rawForecast(rule: RuleDef, m: DailyMarket, vol: Float64Array): Float64Array {
  if (rule.family === 'trend') return ewmacRaw(m.close, vol, Number(rule.id.slice(5)));
  if (rule.family === 'breakout') return breakoutRaw(m.close, Number(rule.id.slice(8)));
  if (rule.family === 'accel') return accelRaw(m.close, vol, Number(rule.id.slice(5)));
  return m.carry ? carryRaw(m.carry, m.close, vol) : new Float64Array(m.close.length).fill(NaN);
}

/**
 * Forecast scalar per day: 10 ÷ the expanding mean (from the first day with 3+ markets) of the cross-market median
 * |raw|, frozen from `fitEnd` on. Returns the scalar series and whether it was estimated (else the fixed one).
 */
export function scalarSeries(rawByMarket: readonly Float64Array[], fitEnd: number, fixed: number, minDays = CARVER.minScalarDays): { k: Float64Array; estimated: boolean; value: number } {
  const n = rawByMarket[0]?.length ?? 0;
  const k = new Float64Array(n).fill(fixed);
  let sum = 0;
  let cnt = 0;
  const med: number[] = [];
  for (let d = 0; d < n; d++) {
    for (const r of rawByMarket) {
      const v = r[d]!;
      if (fin(v) && v !== 0) med.push(Math.abs(v));
    }
    if (med.length >= 3 && d < fitEnd) {
      med.sort((a, b) => a - b);
      sum += med[Math.floor(med.length / 2)]!;
      cnt++;
    }
    med.length = 0;
    if (d < fitEnd && cnt >= minDays && sum > 0) k[d] = CARVER.targetAbs / (sum / cnt);
    else if (d >= fitEnd) k[d] = k[fitEnd - 1] ?? fixed;
  }
  // the warm-up uses the first estimate (Carver backfills)
  const first = cnt >= minDays && sum > 0 ? CARVER.targetAbs / (sum / cnt) : fixed;
  if (cnt >= minDays) for (let d = 0; d < Math.min(n, fitEnd); d++) if (k[d] === fixed) k[d] = first;
  return { k, estimated: cnt >= minDays, value: r3(k[Math.max(0, Math.min(n, fitEnd) - 1)] ?? fixed) };
}

/** Pearson correlation matrix of column series (rows with a NaN in either column are skipped); diagonal 1. */
export function corrMatrix(cols: readonly Float64Array[], upTo?: number): number[][] {
  const n = cols.length;
  const len = Math.min(upTo ?? Infinity, ...cols.map((c) => c.length));
  const C: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let m = 0;
      for (let t = 0; t < len; t++) {
        const x = cols[i]![t]!;
        const y = cols[j]![t]!;
        if (!fin(x) || !fin(y)) continue;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        m++;
      }
      let rho = 0;
      if (m >= 20) {
        const vx = sxx / m - (sx / m) ** 2;
        const vy = syy / m - (sy / m) ** 2;
        rho = vx > 0 && vy > 0 ? (sxy / m - (sx / m) * (sy / m)) / Math.sqrt(vx * vy) : 0;
      }
      C[i]![j] = rho;
      C[j]![i] = rho;
    }
  }
  return C;
}

/** Diversification multiplier 1 ÷ √(w′Cw) with negative correlations floored at 0, capped. */
export function divMultiplier(w: readonly number[], C: readonly number[][], cap: number): number {
  let q = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) q += w[i]! * w[j]! * (i === j ? 1 : Math.max(0, C[i]![j]!));
  if (!(q > 0)) return 1;
  return Math.min(cap, Math.max(1, 1 / Math.sqrt(q)));
}

export interface RuleGrade {
  id: string;
  label: string;
  family: RuleFamily;
  scalar: number;
  estimated: boolean;
  /** markets where the rule passes the speed limit, of those with data */
  allowed: number;
  of: number;
  /** average annual cost in Sharpe units across markets, and the average annual turnover */
  costSr: number;
  turnover: number;
  /** the rule alone, scaled, as a subsystem: Sharpe of its daily P&L (annualised) first 70% / unseen 30% */
  inSr: number | null;
  outSr: number | null;
}

export interface DeskMarketNow {
  id: string;
  label: string;
  /** combined forecast −20 … +20 (0 = flat) */
  forecast: number;
  /** per rule the scaled forecast now (admitted rules only) */
  rules: Record<string, number>;
  /** units the desk wants and the notional in USD; the band it does not trade inside */
  targetUnits: number;
  notionalUsd: number;
  bufferUnits: number;
  /** daily price vol in pips and the vol scalar (units at an average forecast) */
  volPips: number;
  volScalar: number;
  fdm: number;
  weight: number;
}

export interface DeskSummary {
  days: number;
  totalPct: number;
  /** annualised Sharpe of the daily P&L and its skew */
  sr: number;
  skew: number;
  maxDdPct: number;
  /** average absolute gross leverage (notional ÷ equity) */
  avgLeverage: number;
  /** average cost per year in % of equity */
  costPctYr: number;
  /** turnover: average |Δposition| ÷ average position, per year (a full round trip of the average position = 2) */
  turnover: number;
  weeks: number;
  avgWeekPct: number;
  worstWeekPct: number;
  greenWeeksPct: number;
  months: number;
  avgMonthPct: number;
  worstMonthPct: number;
  finalX: number;
}

export interface DeskReport {
  at: number;
  from: number;
  to: number;
  oosFrom: number;
  volTarget: number;
  markets: number;
  rules: RuleGrade[];
  fdm: number;
  idm: number;
  /** the whole system on the first 70% (where its scalars / correlations were fitted) and on the unseen 30% */
  inSample: DeskSummary;
  unseen: DeskSummary;
  /** unseen weekly returns in % (for the Monte Carlo / chart) and the equity multiple per unseen week */
  unseenWeekly: number[];
  equity: number[];
  now: DeskMarketNow[];
  note: string;
}

interface MarketPrep {
  m: DailyMarket;
  vol: Float64Array;
  /** scaled + capped forecast per rule (NaN = none / not admitted) */
  f: Map<string, Float64Array>;
  admitted: Set<string>;
  combined: Float64Array;
  ret: Float64Array;
  /** the day whose fill last changed the position (mark-to-market starts from that fill) */
  lastFill?: number;
}

/** Daily log return series of a market's closes (NaN where unknown). */
function dailyRet(close: Float64Array): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < close.length; i++) {
    const c = close[i]!;
    if (fin(c) && fin(prev) && prev > 0 && c > 0) out[i] = Math.log(c / prev);
    if (fin(c)) prev = c;
  }
  return out;
}

const annSr = (daily: readonly number[]): number => {
  const xs = daily.filter(fin);
  if (xs.length < 10) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return v > 0 ? (m / Math.sqrt(v)) * 16 : 0;
};

/** Cost of one unit changing hands, in price units: half spread × the hour's multiple + slippage. */
function costPerUnit(inst: Instrument, t: number, prevT: number): number {
  const mult = fin(t) ? spreadMultAt(inst.id, t, fin(prevT) ? prevT : null) : 1;
  return (inst.spreadPips * inst.pip * mult) / 2 + CARVER.slipPips * inst.pip;
}

/** Sharpe-units cost gate of a rule on a market, from its scaled forecast over the first 70%. */
function speedCheck(f: Float64Array, m: DailyMarket, vol: Float64Array, fitEnd: number): { turnover: number; costSr: number } {
  let dsum = 0;
  let days = 0;
  let csum = 0;
  let cdays = 0;
  for (let d = 1; d < Math.min(fitEnd, f.length); d++) {
    const a = f[d]!;
    const b = f[d - 1]!;
    if (fin(a) && fin(b)) {
      dsum += Math.abs(a - b) / CARVER.targetAbs;
      days++;
    }
    const v = vol[d]!;
    if (fin(v) && v > 0) {
      csum += costPerUnit(m.inst, m.fillT[d]!, m.fillPrevT[d]!) / (v * 16);
      cdays++;
    }
  }
  const turnover = days ? (256 * dsum) / days : 0;
  const srCost = cdays ? csum / cdays : 0;
  return { turnover, costSr: turnover * srCost };
}

function summarize(eq: readonly number[], days: readonly number[], costs: readonly number[], lev: readonly number[], turn: readonly number[], from: number, to: number): { s: DeskSummary; weekly: number[]; curve: number[] } {
  const DAY = 86_400_000;
  const WEEK = 7 * DAY;
  const n = eq.length;
  const dailyRets: number[] = [];
  let peak = -Infinity;
  let dd = 0;
  for (let i = 0; i < n; i++) {
    const e = eq[i]!;
    if (i > 0 && eq[i - 1]! > 0) dailyRets.push(e / eq[i - 1]! - 1);
    peak = Math.max(peak, e);
    if (peak > 0) dd = Math.max(dd, 1 - e / peak);
  }
  const weekOf = (t: number) => Math.floor((t + 4 * DAY) / WEEK);
  const monthOf = (t: number) => {
    const d = new Date(t);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const weekEnd = new Map<number, number>();
  const monthEnd = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    weekEnd.set(weekOf(days[i]!), eq[i]!);
    monthEnd.set(monthOf(days[i]!), eq[i]!);
  }
  const start = n ? eq[0]! : 1;
  const weekly: number[] = [];
  const curve: number[] = [];
  let prev = start;
  for (let w = weekOf(from); w <= weekOf(to); w++) {
    const v = weekEnd.get(w) ?? prev;
    weekly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
    curve.push(start > 0 ? r3(v / start) : 1);
    prev = v;
  }
  const monthly: number[] = [];
  prev = start;
  for (let m = monthOf(from); m <= monthOf(to); m++) {
    const v = monthEnd.get(m) ?? prev;
    monthly.push(prev > 0 ? (v / prev - 1) * 100 : 0);
    prev = v;
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
  const xs = dailyRets.filter(fin);
  const mean = avg(xs);
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  const skew = sd > 0 && xs.length > 2 ? xs.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / xs.length : 0;
  const s: DeskSummary = {
    days: n,
    totalPct: n ? r2((eq[n - 1]! / start - 1) * 100) : 0,
    sr: r2(annSr(dailyRets)),
    skew: r2(skew),
    maxDdPct: r2(dd * 100),
    avgLeverage: r2(avg([...lev])),
    costPctYr: r2(avg(costs.map((c, i) => (eq[i]! > 0 ? c / eq[i]! : 0))) * 256 * 100),
    turnover: r2(avg([...turn]) * 256),
    weeks: weekly.length,
    avgWeekPct: r2(avg(weekly)),
    worstWeekPct: r2(min(weekly)),
    greenWeeksPct: weekly.length ? Math.round((weekly.filter((x) => x > 0).length / weekly.length) * 100) : 0,
    months: monthly.length,
    avgMonthPct: r2(avg(monthly)),
    worstMonthPct: r2(min(monthly)),
    finalX: n ? r3(eq[n - 1]! / start) : 1,
  };
  return { s, weekly: weekly.map(r2), curve };
}

/**
 * Run the desk: fit on the first 70% (scalars, correlations, the cost gate), trade the whole history with those,
 * report both halves. Pure.
 */
export function runDesk(inp: DeskInput): DeskReport {
  const cal = inp.cal;
  const n = cal.length;
  const tau = inp.volTarget ?? CARVER.volTarget;
  let fitEnd = cal.findIndex((t) => t >= inp.oosFrom);
  if (fitEnd < 0) fitEnd = n;
  // ── per market: vol, raw forecasts ──
  const preps: MarketPrep[] = inp.markets.map((m) => ({ m, vol: carverVol(m.close), f: new Map(), admitted: new Set(), combined: new Float64Array(n).fill(NaN), ret: dailyRet(m.close) }));
  const rawBy = new Map<string, Float64Array[]>();
  for (const rule of RULES) rawBy.set(rule.id, preps.map((p) => rawForecast(rule, p.m, p.vol)));
  // ── scalars (first 70%, frozen), scaled + capped forecasts, speed limit per market ──
  const grades: RuleGrade[] = [];
  const scaledPooled = new Map<string, Float64Array>();
  for (const rule of RULES) {
    const raws = rawBy.get(rule.id)!;
    const sc = scalarSeries(raws, fitEnd, rule.fixedScalar);
    let allowed = 0;
    let of = 0;
    let costSum = 0;
    let turnSum = 0;
    const pooled: number[] = [];
    preps.forEach((p, k) => {
      const raw = raws[k]!;
      const f = new Float64Array(n).fill(NaN);
      let any = false;
      for (let d = 0; d < n; d++) {
        const v = raw[d]!;
        if (!fin(v)) continue;
        f[d] = Math.max(-CARVER.cap, Math.min(CARVER.cap, v * sc.k[d]!));
        any = true;
      }
      if (!any) return;
      of++;
      const sp = speedCheck(f, p.m, p.vol, fitEnd);
      costSum += sp.costSr;
      turnSum += sp.turnover;
      if (sp.costSr <= CARVER.speedLimit) {
        allowed++;
        p.f.set(rule.id, f);
        p.admitted.add(rule.id);
        for (let d = 0; d < fitEnd; d++) pooled.push(f[d]!);
      }
    });
    scaledPooled.set(rule.id, Float64Array.from(pooled));
    grades.push({ id: rule.id, label: rule.label, family: rule.family, scalar: sc.value, estimated: sc.estimated, allowed, of, costSr: r3(of ? costSum / of : 0), turnover: r2(of ? turnSum / of : 0), inSr: null, outSr: null });
  }
  // ── combination: family weights split inside the family; FDM from the pooled first-70% forecasts ──
  const familyCount: Record<RuleFamily, number> = { trend: 0, breakout: 0, carry: 0, accel: 0 };
  for (const r of RULES) familyCount[r.family]++;
  const nominalW = RULES.map((r) => CARVER.families[r.family] / familyCount[r.family]);
  // the pooled series are of unequal length per rule; the correlation needs aligned columns → use the longest common length
  const pooledCols = RULES.map((r) => scaledPooled.get(r.id)!);
  const C = corrMatrix(pooledCols);
  const fdm = r2(divMultiplier(nominalW, C, CARVER.fdmCap));
  for (const p of preps) {
    for (let d = 0; d < n; d++) {
      let sum = 0;
      let wsum = 0;
      RULES.forEach((r, i) => {
        const v = p.f.get(r.id)?.[d];
        if (v === undefined || !fin(v)) return;
        sum += nominalW[i]! * v;
        wsum += nominalW[i]!;
      });
      if (wsum > 0) p.combined[d] = Math.max(-CARVER.cap, Math.min(CARVER.cap, (fdm * sum) / wsum));
    }
  }
  // ── instrument weights: equal, IDM from the markets' daily returns on the first 70% ──
  const wInst = preps.map(() => 1 / Math.max(1, preps.length));
  const idm = r2(divMultiplier(wInst, corrMatrix(preps.map((p) => p.ret), fitEnd), CARVER.idmCap));
  // ── simulate ──
  const sim = (forecastOf: (p: MarketPrep, d: number) => number, wantRules = false) => {
    let equity = inp.equity;
    for (const p of preps) p.lastFill = undefined;
    const units = new Float64Array(preps.length);
    const eqIn: number[] = [];
    const dIn: number[] = [];
    const eqOut: number[] = [];
    const dOut: number[] = [];
    const costIn: number[] = [];
    const costOut: number[] = [];
    const levIn: number[] = [];
    const levOut: number[] = [];
    const turnIn: number[] = [];
    const turnOut: number[] = [];
    let now: DeskMarketNow[] = [];
    for (let d = 0; d < n; d++) {
      // 1. mark the day's close (positions held since yesterday's fill), in USD
      let pnl = 0;
      let gross = 0;
      for (let k = 0; k < preps.length; k++) {
        const p = preps[k]!;
        const u = units[k]!;
        if (u === 0) continue;
        const c = p.m.close[d]!;
        const cPrev = d > 0 ? p.m.close[d - 1]! : NaN;
        const fillPx = d > 0 ? p.m.fill[d - 1]! : NaN;
        // the leg from yesterday's close (or the fill, if the position changed) to today's close
        const base = fin(fillPx) && p.lastFill === d - 1 ? fillPx : cPrev;
        const q = inp.usdPer(p.m.inst.kind === 'metal' ? 'USD' : p.m.inst.id.slice(3, 6), d) ?? 0;
        if (fin(c) && fin(base)) pnl += u * (c - base) * q;
        // v18: overnight financing for the nights since the last close — the carry its way minus the broker markup
        // (financing.ts), like every other test; unknown rate = none
        const carry = p.m.carry?.[d - 1];
        const nights = d > 0 ? Math.round((cal[d]! - cal[d - 1]!) / 86_400_000) : 0;
        if (FINANCING.on && nights > 0 && carry !== undefined && fin(carry) && fin(cPrev)) pnl += Math.abs(u) * swapGain(u > 0 ? 1 : -1, carry, cPrev, nights) * q;
        if (fin(c)) gross += Math.abs(u) * c * q;
      }
      equity = Math.max(0, equity + pnl);
      const dayT = cal[d]!;
      const inFit = d < fitEnd;
      (inFit ? eqIn : eqOut).push(equity);
      (inFit ? dIn : dOut).push(dayT);
      (inFit ? levIn : levOut).push(equity > 0 ? gross / equity : 0);
      if (equity <= 0) break;
      // 2. decide at the close: target units per market, buffered; fill at the next fill price
      const cashVolTarget = (equity * tau) / 16;
      let dayCost = 0;
      let dayTurn = 0;
      let newGross = 0;
      const targets = new Float64Array(preps.length);
      const avgPos = new Float64Array(preps.length);
      for (let k = 0; k < preps.length; k++) {
        const p = preps[k]!;
        const c = p.m.close[d]!;
        const v = p.vol[d]!;
        const fc = forecastOf(p, d);
        const q = inp.usdPer(p.m.inst.kind === 'metal' ? 'USD' : p.m.inst.id.slice(3, 6), d);
        if (!fin(c) || !fin(v) || v <= 0 || !q) {
          targets[k] = units[k]!; // no data: hold
          continue;
        }
        const unitVolUsd = v * q;
        const volScalar = cashVolTarget / unitVolUsd;
        const ap = volScalar * wInst[k]! * idm;
        avgPos[k] = ap;
        const target = fin(fc) ? ap * (fc / CARVER.targetAbs) : 0;
        const buf = CARVER.buffer * ap;
        const held = units[k]!;
        let next = held;
        if (held > target + buf) next = target + buf;
        else if (held < target - buf) next = target - buf;
        targets[k] = next;
        newGross += Math.abs(next) * c * q;
      }
      // gross leverage cap: scale every target down
      const scale = newGross > CARVER.maxLeverage * equity ? (CARVER.maxLeverage * equity) / newGross : 1;
      for (let k = 0; k < preps.length; k++) {
        const p = preps[k]!;
        const next = scale < 1 ? targets[k]! * scale : targets[k]!;
        const held = units[k]!;
        if (next === held) continue;
        const fillPx = p.m.fill[d]!;
        if (!fin(fillPx)) continue; // no bar to fill on: hold until there is one
        const q = inp.usdPer(p.m.inst.kind === 'metal' ? 'USD' : p.m.inst.id.slice(3, 6), d) ?? 0;
        const c = p.m.close[d]!;
        // the leg from the close to the fill for the units held, then the cost of the change
        const legPnl = fin(c) ? held * (fillPx - c) * q : 0;
        const cost = Math.abs(next - held) * costPerUnit(p.m.inst, p.m.fillT[d]!, p.m.fillPrevT[d]!) * q;
        equity = Math.max(0, equity + legPnl - cost);
        dayCost += cost;
        if (avgPos[k]! > 0) dayTurn += Math.abs(next - held) / avgPos[k]!;
        units[k] = next;
        p.lastFill = d;
      }
      (inFit ? costIn : costOut).push(dayCost);
      (inFit ? turnIn : turnOut).push(dayTurn / Math.max(1, preps.length));
      if (d === n - 1 && wantRules) {
        now = preps.map((p, k) => {
          const c = p.m.close[d]!;
          const q = inp.usdPer(p.m.inst.kind === 'metal' ? 'USD' : p.m.inst.id.slice(3, 6), d) ?? 0;
          const v = p.vol[d]!;
          const fc = p.combined[d]!;
          const rules: Record<string, number> = {};
          for (const id of p.admitted) {
            const x = p.f.get(id)![d]!;
            if (fin(x)) rules[id] = r2(x);
          }
          return {
            id: p.m.inst.id,
            label: p.m.inst.label,
            forecast: fin(fc) ? r2(fc) : 0,
            rules,
            targetUnits: Math.round(units[k]!),
            notionalUsd: fin(c) ? Math.round(units[k]! * c * q) : 0,
            bufferUnits: Math.round(CARVER.buffer * avgPos[k]!),
            volPips: fin(v) ? r2(v / p.m.inst.pip) : 0,
            volScalar: Math.round(avgPos[k]! / Math.max(1e-9, wInst[k]! * idm)),
            fdm,
            weight: r3(wInst[k]!),
          };
        });
      }
    }
    return { eqIn, dIn, eqOut, dOut, costIn, costOut, levIn, levOut, turnIn, turnOut, now };
  };
  const main = sim((p, d) => p.combined[d]!, true);
  // each rule alone (its own scaled forecast as the whole system) for the table
  for (const g of grades) {
    const s = sim((p, d) => p.f.get(g.id)?.[d] ?? NaN);
    const inR = s.eqIn.map((e, i) => (i > 0 && s.eqIn[i - 1]! > 0 ? e / s.eqIn[i - 1]! - 1 : NaN)).filter(fin);
    const outR = s.eqOut.map((e, i) => (i > 0 && s.eqOut[i - 1]! > 0 ? e / s.eqOut[i - 1]! - 1 : NaN)).filter(fin);
    g.inSr = inR.length >= 20 ? r2(annSr(inR)) : null;
    g.outSr = outR.length >= 20 ? r2(annSr(outR)) : null;
  }
  const from = cal[0] ?? 0;
  const to = cal[n - 1] ?? 0;
  const inS = summarize(main.eqIn, main.dIn, main.costIn, main.levIn, main.turnIn, from, fitEnd < n ? cal[fitEnd]! : to);
  const outS = summarize(main.eqOut, main.dOut, main.costOut, main.levOut, main.turnOut, fitEnd < n ? cal[fitEnd]! : to, to);
  const admitted = grades.reduce((a, g) => a + g.allowed, 0);
  return {
    at: Date.now(),
    from,
    to,
    oosFrom: inp.oosFrom,
    volTarget: tau,
    markets: preps.length,
    rules: grades,
    fdm,
    idm,
    inSample: inS.s,
    unseen: outS.s,
    unseenWeekly: outS.weekly,
    equity: outS.curve,
    now: main.now,
    note: `${RULES.length} rules × ${preps.length} markets on daily closes: ${admitted} rule-market pairs pass the cost speed limit (${CARVER.speedLimit} Sharpe a year). Scalars, correlations (FDM ${fdm}, IDM ${idm}) and the gate come from the first 70% only; the unseen 30% is the exam. Vol target ${Math.round(tau * 100)}% a year, ±${Math.round(CARVER.buffer * 100)}% position buffer, fills two hours after the 22:00 UTC close with that hour's spread, overnight financing included (the carry its way minus the ${FINANCING.markupPct}% markup, Wednesday three nights) like every other test.`,
  };
}
