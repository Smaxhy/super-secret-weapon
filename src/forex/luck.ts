/**
 * Luck meter (v17). The lab tries ~50 strategies × 2 charts × ~90 filter / exit variants and rates every row edge /
 * maybe / no on the unseen last 30%. With that many tries some rows pass by luck. Here a row is compared with
 * `LUCK.twins` "twins": the row's EXACT rules for stops / targets / trails / exits / filter / costs, but fired at
 * random times — every signal moved by the same random number of bars (wrapping around inside the history), its stop
 * and target re-placed at the same ATR distances. A row only keeps edge / maybe when its real unseen avg R beats the
 * twins' 90th percentile (`luckDowngrade`). Pure except for the event-loop yields in `luckFor`.
 *
 * This module never imports lab.ts at run time (lab.ts calls it): `Series` is a type-only import and the lab's
 * `verdictFor` is passed in.
 */
import { rStats, signalsFor, simulate, WARMUP, type RStats } from './engine';
import { applyExit, type ExitKind } from './exits';
import { allowFor, type FilterKind } from './filters';
import { styleOf, type Strategy } from './strategies';
import type { Ctx } from './ta';
import type { Signal, Trade } from './types';
import type { Series } from './lab';

/** Fixed before any real result was seen. Never tune these on dashboard numbers. */
/** v17 review: the shift must clear the longest rule's look-back + hold (tsmom_long on 4h ≈ 80 days + 14-day holds), else
 * a twin still "knows" the trend its signal came from */
export const LUCK = { twins: 20, pctl: 90, minWeeks: 16, seed: 7 };

const WEEK = 7 * 86_400_000;
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Seeded uniform numbers in [0, 1): the LCG of `monteCarlo` (portfolio.ts). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 1) / 2147483648;
  };
  rnd();
  rnd();
  return rnd;
}

/** FNV-1a: a row's key → a number, so every row gets its own (still fixed) random times. */
const fnv = (str: string) => {
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const twinSeed = (seed: number, key: string, k: number) => (seed ^ fnv(key) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0 || 1;

/**
 * The signal was designed at bar i; rebuild it for bar j. Stop and target are kept as ATR multiples of bar i's close
 * (d = (close_i − level) · side ÷ ATR_i) and placed at the same multiples of bar j's ATR around bar j's close. Every
 * other field (side, trails, take-profit trail, break-even, scale-out, bar limit, indicator exit) is unchanged. null
 * when an ATR is unknown / not positive or the rebuilt stop lands on the wrong side. Pure.
 */
export function retime(sig: Signal, c: Ctx, i: number, j: number): Signal | null {
  const ai = c.atr14[i]!;
  const aj = c.atr14[j]!;
  const pi = c.close[i]!;
  const pj = c.close[j]!;
  if (!Number.isFinite(ai) || !Number.isFinite(aj) || !(ai > 0) || !(aj > 0) || !Number.isFinite(pi) || !Number.isFinite(pj)) return null;
  const dStop = ((pi - sig.stop) * sig.side) / ai;
  const stop = pj - sig.side * dStop * aj;
  if (!((pj - stop) * sig.side > 0)) return null;
  const target = sig.target === null ? null : pj + sig.side * (((sig.target - pi) * sig.side) / ai) * aj;
  return { ...sig, stop, target };
}

/** The bars a signal may move between: [WARMUP, n − 2] (bar n − 1 would only make a never-closed live-edge trade). */
export function twinWindow(n: number): { lo: number; hi: number; span: number } {
  const lo = WARMUP;
  const hi = n - 2;
  return { lo, hi, span: Math.max(0, hi - lo + 1) };
}

/**
 * Every signal inside [WARMUP, n − 2] moved `delta` bars later, wrapping around inside that window, each re-placed with
 * `retime`. On a clash (two on one bar) the first wins; a signal on the last bar is dropped. Pure.
 */
export function twinSignals(sigs: ReadonlyArray<Signal | null>, c: Ctx, delta: number): Array<Signal | null> {
  const out: Array<Signal | null> = new Array(sigs.length).fill(null);
  const { lo, hi, span } = twinWindow(Math.min(sigs.length, c.bars.length));
  if (span <= 0) return out;
  const d = ((Math.round(delta) % span) + span) % span;
  for (let i = lo; i <= hi; i++) {
    const sg = sigs[i];
    if (!sg) continue;
    let j = i + d;
    if (j > hi) j -= span;
    if (out[j]) continue;
    out[j] = retime(sg, c, i, j);
  }
  return out;
}

/** Bars in `weeks` weeks of this series, measured from its own times (FX has no weekend bars). */
export function weeksOfBars(c: Ctx, weeks: number): number {
  const { lo, hi, span } = twinWindow(c.bars.length);
  const perDay = 1440 / c.barMin;
  if (span < 2) return Math.round(weeks * 7 * perDay);
  const w = (c.bars[hi]!.t - c.bars[lo]!.t) / WEEK;
  return Math.max(1, Math.round((weeks * (span - 1)) / Math.max(w, 1e-9)));
}

/**
 * A twin's shift in bars: uniform in [minShift, span − minShift], re-drawn while it is a whole number of days (an
 * hour-of-day rule must meet random hours, not the same hour on another day). null when the series is too short.
 */
export function pickDelta(rnd: () => number, span: number, barMin: number, minShift: number): number | null {
  const lo = Math.max(1, Math.round(minShift));
  const hi = span - lo;
  if (hi < lo) return null;
  const perDay = Math.round(1440 / barMin);
  const ok = (d: number) => perDay < 2 || d % perDay !== 0;
  for (let k = 0; k < 64; k++) {
    const d = lo + Math.floor(rnd() * (hi - lo + 1));
    if (ok(d)) return d;
  }
  for (let d = lo; d <= hi; d++) if (ok(d)) return d;
  return null;
}

/** Linear-interpolated percentile (p 0–100). NaN for no values. */
export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, p / 100));
  const a = Math.floor(pos);
  const b = Math.ceil(pos);
  return s[a]! + (s[b]! - s[a]!) * (pos - a);
}

type Split = { all: RStats; inSample: RStats; outSample: RStats };
/** Same split as lab.ts `statsOf`: first 70% = finished before `oosFrom`, unseen = opened after it. */
export function splitStats(trades: readonly Trade[], oosFrom: number): Split {
  const done = trades.filter((t) => t.reason !== 'open');
  return { all: rStats(done), inSample: rStats(done.filter((t) => t.exitT < oosFrom)), outSample: rStats(done.filter((t) => t.entryT >= oosFrom)) };
}

export type Verdict = 'edge' | 'maybe' | 'no';
/** lab.ts `verdictFor` (passed in by the lab). */
export type VerdictFn = (row: Split, randomAvgR: number | null) => { verdict: Verdict };

export interface LuckInput {
  /** the row's chosen filter and exit (as `evaluateTf` picked them) */
  filter: FilterKind;
  exit: ExitKind;
  /** start of the unseen last 30% (ms), the lab's `oosFrom` */
  oosFrom: number;
  /** the real row's unseen avg R (`row.outSample.avgR`) */
  realOutAvgR: number;
  /** the random yardstick's avg R on the same chart (`evaluateTf` uses the random row's `all.avgR`), null = none */
  randomAvgR: number | null;
  /** lab.ts `verdictFor` */
  verdict: VerdictFn;
  /** number of twins (default `LUCK.twins`) */
  twins?: number;
  /** default `LUCK.seed` */
  seed?: number;
  /** shortest shift in weeks (default `LUCK.minWeeks`) */
  minWeeks?: number;
}

export interface LuckResult {
  /** unseen avg R per twin */
  twins: number[];
  /** unseen closed trades per twin */
  twinN: number[];
  /** the twins' `LUCK.pctl` percentile of unseen avg R */
  twinsP90: number;
  /** where the real row's unseen avg R falls among the twins, 0–100 */
  pctl: number;
  /** % of twins the lab would have rated edge / maybe */
  twinPassPct: number;
  /** each twin's shift in bars on the row's first market */
  deltas: number[];
}

/**
 * The luck meter for one row (one strategy on one chart, every market). For each twin: every market's raw signals →
 * the row's exit variant (`applyExit`, exactly as `evaluateTf`) → moved by the twin's shift (`twinSignals`; one random
 * draw per twin, so markets of the same length share the shift) → `simulate` with the row's filter → pooled trades →
 * unseen avg R (same split and rounding as the lab). Yields to the event loop after every twin (the lab runs in the bot
 * process). A market too short to shift by at least `LUCK.minWeeks` both ways is left out of the twins; null when no
 * market is long enough. Call it only for rows rated edge / maybe (`luckDowngrade` never touches a 'no').
 */
export async function luckFor(s: Strategy, series: readonly Series[], o: LuckInput): Promise<LuckResult | null> {
  const K = Math.max(1, Math.round(o.twins ?? LUCK.twins));
  const seed = o.seed ?? LUCK.seed;
  const style = styleOf(s);
  type Prep = { se: Series; sigs: Array<Signal | null>; allow: ReturnType<typeof allowFor>; span: number; minShift: number };
  const prep: Prep[] = [];
  for (const se of series) {
    const raw = signalsFor(se.ctx, s);
    const sigs = raw.map((sg, i) => applyExit(sg, o.exit, se.ctx, i));
    const { span } = twinWindow(se.ctx.bars.length);
    prep.push({ se, sigs, allow: allowFor(o.filter, se.env, style), span, minShift: weeksOfBars(se.ctx, o.minWeeks ?? LUCK.minWeeks) });
    if (se.ctx.bars.length > 8_000) await yieldNow();
  }
  const key = `${s.id}:${series[0]?.tf ?? ''}`;
  const twins: number[] = [];
  const twinN: number[] = [];
  const deltas: number[] = [];
  let pass = 0;
  for (let k = 0; k < K; k++) {
    const trades: Trade[] = [];
    let first: number | null = null;
    for (const p of prep) {
      // the same seed for every market of this twin → equal-length markets get the same shift
      const d = pickDelta(seeded(twinSeed(seed, key, k)), p.span, p.se.ctx.barMin, p.minShift);
      if (d === null) continue;
      first ??= d;
      for (const t of simulate(p.se.inst, p.se.tf, p.se.ctx, s.id, twinSignals(p.sigs, p.se.ctx, d), p.allow)) trades.push(t);
      // like the lab: a turn for the event loop after every long simulation
      if (p.se.ctx.bars.length > 8_000) await yieldNow();
    }
    if (first === null) return null;
    const st = splitStats(trades, o.oosFrom);
    twins.push(st.outSample.avgR);
    twinN.push(st.outSample.n);
    deltas.push(first);
    if (o.verdict(st, o.randomAvgR).verdict !== 'no') pass++;
    await yieldNow();
  }
  const real = o.realOutAvgR;
  const below = twins.filter((x) => x < real).length;
  const ties = twins.filter((x) => x === real).length;
  return {
    twins,
    twinN,
    twinsP90: Math.round(percentile(twins, LUCK.pctl) * 1000) / 1000,
    pctl: Math.round(((below + ties / 2) / K) * 100),
    twinPassPct: Math.round((pass / K) * 100),
    deltas,
  };
}

/**
 * edge / maybe whose real unseen avg R is not above the twins' 90th percentile → 'no', with the reason in words. No luck
 * data (or 'no' already) → unchanged. Pure.
 */
export function luckDowngrade(verdict: Verdict, realOutAvgR: number, luck: { twinsP90: number; twins: number[] } | null): { verdict: Verdict; why: string | null } {
  if (verdict === 'no' || !luck || !luck.twins.length || !Number.isFinite(luck.twinsP90) || !Number.isFinite(realOutAvgR)) return { verdict, why: null };
  if (realOutAvgR > luck.twinsP90) return { verdict, why: null };
  const asGood = luck.twins.filter((x) => x >= realOutAvgR).length;
  return { verdict: 'no', why: `random timing with the same exits did as well in ${asGood} of ${luck.twins.length} tries (their top ${100 - LUCK.pctl}%: ${luck.twinsP90}R a trade vs ${realOutAvgR}R)` };
}
