/**
 * v17 rolling picker — the bot relearns its strategy list every week. Each Sunday it keeps the strategy × chart rows
 * whose trades CLOSED in the last 26 weeks made money (shrunk toward zero when there are few, profit factor ≥ 1.1),
 * plus the always-on four; nothing else. The same function decides the live list and is graded on the unseen weeks:
 * week by week, only the trades it would have picked that week, traded together like the bot does — against the list
 * picked once on the first 70% and against 100 pickers that choose the same number of rows at random. It goes live
 * only when it beats 80% of the random pickers and makes money (and, once live, stays while it beats 60%). Pure.
 */
import { simulatePortfolio, stratFactorFromStats, weekOf, weekStart, type PortfolioOpts, type PortfolioResult, type PTrade } from './portfolio';

/** fixed before any real result; never tune on dashboard numbers */
export const ROLL = {
  lookbackWeeks: 26,
  embargoDays: 7,
  minN: 12,
  shrinkK: 20,
  minShrunkR: 0.03,
  minPf: 1.1,
  minGradedWeeks: 26,
  nullDraws: 100,
  nullBeatPct: 80,
  stayBeatPct: 60,
  maxDdTol: 1.25,
  seed: 17,
};
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** One strategy × chart row: its closed trades sorted by exit time, with prefix sums for fast windows. */
export interface RollRow {
  key: string;
  always: boolean;
  exitT: Float64Array;
  cumR: Float64Array;
  /** sum of winning R / of losing |R| */
  cumW: Float64Array;
  cumL: Float64Array;
}

export function rollRow(key: string, done: ReadonlyArray<{ exitT: number; r: number }>, always: boolean): RollRow {
  const xs = [...done].sort((a, b) => a.exitT - b.exitT);
  const n = xs.length;
  const exitT = new Float64Array(n);
  const cumR = new Float64Array(n + 1);
  const cumW = new Float64Array(n + 1);
  const cumL = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const r = xs[k]!.r;
    exitT[k] = xs[k]!.exitT;
    cumR[k + 1] = cumR[k]! + r;
    cumW[k + 1] = cumW[k]! + (r > 0 ? r : 0);
    cumL[k + 1] = cumL[k]! + (r < 0 ? -r : 0);
  }
  return { key, always, exitT, cumR, cumW, cumL };
}

/** first index with exitT ≥ t */
function lowerBound(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Window {
  n: number;
  sumR: number;
  avgR: number;
  pf: number | null;
  /** sum R ÷ (n + shrinkK): a few lucky trades can't look like an edge */
  shrunkR: number;
}

/** The row's trades that closed in [t0, t1). */
export function trailing(row: RollRow, t0: number, t1: number): Window {
  const a = lowerBound(row.exitT, t0);
  const b = lowerBound(row.exitT, t1);
  const n = b - a;
  const sumR = row.cumR[b]! - row.cumR[a]!;
  const w = row.cumW[b]! - row.cumW[a]!;
  const l = row.cumL[b]! - row.cumL[a]!;
  return { n, sumR, avgR: n ? sumR / n : 0, pf: l > 0 ? w / l : w > 0 ? null : 0, shrunkR: sumR / (n + ROLL.shrinkK) };
}

export interface Pick {
  key: string;
  n: number;
  avgR: number;
  shrunkR: number;
  pf: number | null;
  /** size factor from its 26-week record */
  sizeF: number;
  always: boolean;
}

/** The rule: who gets traded in week w (only trades that closed before that week starts count). */
export function picksFor(rows: readonly RollRow[], week: number): Pick[] {
  const t1 = weekStart(week);
  const t0 = t1 - ROLL.lookbackWeeks * WEEK;
  const out: Pick[] = [];
  for (const row of rows) {
    const w = trailing(row, t0, t1);
    const good = w.n >= ROLL.minN && w.shrunkR >= ROLL.minShrunkR && (w.pf ?? 99) >= ROLL.minPf;
    if (!row.always && !good) continue;
    out.push({ key: row.key, n: w.n, avgR: Math.round(w.avgR * 100) / 100, shrunkR: Math.round(w.shrunkR * 1000) / 1000, pf: w.pf === null ? null : Math.round(w.pf * 100) / 100, sizeF: stratFactorFromStats(w.shrunkR, w.pf), always: row.always });
  }
  return out;
}

/** A closed lab trade of a row, ready for the whole-bot test (`vf` = its wildness factor). */
export type RollTrade = PTrade & { vf: number };

const byWeek = (trades: readonly RollTrade[]) => {
  const m = new Map<number, RollTrade[]>();
  for (const t of trades) {
    const w = weekOf(t.entryT);
    (m.get(w) ?? m.set(w, []).get(w)!).push(t);
  }
  return m;
};

/** The trades the picker would have taken, week by week (each with its pick's size and priority). */
export function rollingPool(rows: readonly RollRow[], oos: ReadonlyMap<string, readonly RollTrade[]>, w0: number, w1: number): { pool: PTrade[]; weeks: Array<{ week: number; picked: number; trades: number }> } {
  const weeksOf = new Map<string, Map<number, RollTrade[]>>();
  for (const [k, ts] of oos) weeksOf.set(k, byWeek(ts));
  const pool: PTrade[] = [];
  const weeks: Array<{ week: number; picked: number; trades: number }> = [];
  for (let w = w0; w <= w1; w++) {
    const picks = picksFor(rows, w);
    let n = 0;
    for (const p of picks) {
      for (const t of weeksOf.get(p.key)?.get(w) ?? []) {
        pool.push({ ...t, sizeF: p.sizeF * t.vf, prio: p.shrunkR });
        n++;
      }
    }
    weeks.push({ week: w, picked: picks.length, trades: n });
  }
  return { pool, weeks };
}

/** small seeded generator (same as the Monte Carlo's) */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface NullStats {
  draws: number;
  p50: number;
  p80: number;
  p95: number;
  /** % of random pickers the real picker beat (filled in by `gradeRolling`) */
  beatPct?: number;
  /** each draw's total % (sorted) */
  totals: number[];
}

/**
 * The yardstick: pickers that choose the same number of rows each week at random (the always-on rows always in), from
 * the rows that traded in that week's window. Same trades, same caps, same sizing by wildness only.
 */
export async function randomPickerNull(rows: readonly RollRow[], oos: ReadonlyMap<string, readonly RollTrade[]>, w0: number, w1: number, sim: Omit<PortfolioOpts, 'label' | 'from' | 'to'>, draws = ROLL.nullDraws, seed = ROLL.seed, yieldNow: () => Promise<unknown> = () => Promise.resolve()): Promise<NullStats> {
  const rnd = lcg(seed);
  const weeksOf = new Map<string, Map<number, RollTrade[]>>();
  for (const [k, ts] of oos) weeksOf.set(k, byWeek(ts));
  // per week: how many it picked, and which rows were eligible to be drawn
  const plan: Array<{ week: number; k: number; always: string[]; pool: string[] }> = [];
  for (let w = w0; w <= w1; w++) {
    const picks = picksFor(rows, w);
    const t1 = weekStart(w);
    const t0 = t1 - ROLL.lookbackWeeks * WEEK;
    const always = rows.filter((r) => r.always).map((r) => r.key);
    const pool = rows.filter((r) => !r.always && trailing(r, t0, t1).n > 0).map((r) => r.key);
    plan.push({ week: w, k: Math.max(0, picks.length - always.length), always, pool });
  }
  const totals: number[] = [];
  for (let d = 0; d < draws; d++) {
    const trades: PTrade[] = [];
    for (const p of plan) {
      const pool = [...p.pool];
      const chosen = [...p.always];
      for (let j = 0; j < p.k && pool.length; j++) chosen.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);
      for (const key of chosen) for (const t of weeksOf.get(key)?.get(p.week) ?? []) trades.push({ ...t, sizeF: t.vf, prio: 0 });
    }
    totals.push(simulatePortfolio(trades, { ...sim, label: 'random picker', from: weekStart(w0), to: weekStart(w1 + 1) - 1, mc: false }).totalPct);
    await yieldNow();
  }
  totals.sort((a, b) => a - b);
  const q = (p: number) => totals[Math.min(totals.length - 1, Math.floor((p / 100) * totals.length))] ?? 0;
  return { draws, p50: q(50), p80: q(80), p95: q(95), totals };
}

export interface RollReport {
  active: boolean;
  why: string;
  weeksGraded: number;
  from: number;
  to: number;
  result: PortfolioResult | null;
  /** profit factor of the picked trades' R */
  pfR: number | null;
  /** the list picked once on the first 70%, over the same weeks */
  staticSame: PortfolioResult | null;
  null: Omit<NullStats, 'totals'> | null;
  thisWeek: { week: number; picks: Pick[]; added: string[]; rested: string[] };
  byWeek: Array<{ week: string; picked: number; trades: number }>;
}

const isoWeek = (w: number) => {
  const d = new Date(weekStart(w) + DAY); // the Monday
  return d.toISOString().slice(0, 10);
};

/** On / off with the reasons in plain words (hysteresis: once on, it stays while it still beats 60%). Pure. */
export function rollingVerdict(x: { weeksGraded: number; result: PortfolioResult | null; pfR: number | null; staticSame: PortfolioResult | null; beatPct: number | null }, wasActive: boolean): { active: boolean; why: string } {
  const r = x.result;
  if (!r || x.weeksGraded < ROLL.minGradedWeeks) return { active: false, why: `needs ${ROLL.minGradedWeeks}+ unseen weeks to judge (has ${x.weeksGraded}) — the bot keeps the usual list` };
  const base = x.staticSame;
  const ddCap = ROLL.maxDdTol * Math.max(base?.maxDdPct ?? 0, 4);
  const beat = x.beatPct;
  const parts = [`${r.totalPct > 0 ? '+' : ''}${r.totalPct}% over ${x.weeksGraded} unseen weeks`, beat !== null ? `beat ${beat}% of random pickers` : null, base ? `picked once: ${base.totalPct > 0 ? '+' : ''}${base.totalPct}%` : null, `biggest drop ${r.maxDdPct}%`].filter(Boolean).join(', ');
  if (wasActive && r.totalPct > 0 && (beat === null || beat >= ROLL.stayBeatPct)) return { active: true, why: `ON (stays on while it makes money and beats ${ROLL.stayBeatPct}% of random pickers): ${parts}` };
  const fails: string[] = [];
  if (!(r.totalPct > 0)) fails.push('it lost money');
  if ((x.pfR ?? 0) < ROLL.minPf) fails.push(`profit factor ${x.pfR ?? 0} < ${ROLL.minPf}`);
  if (beat !== null ? beat < ROLL.nullBeatPct : base !== null && r.totalPct < base.totalPct) fails.push(beat !== null ? `beat only ${beat}% of random pickers (needs ${ROLL.nullBeatPct}%)` : 'did worse than the list picked once');
  if (r.maxDdPct > ddCap) fails.push(`biggest drop ${r.maxDdPct}% > ${Math.round(ddCap)}%`);
  return fails.length ? { active: false, why: `OFF — ${fails.join('; ')}. ${parts}` } : { active: true, why: `ON: ${parts}` };
}

/**
 * Grade the rolling picker on the unseen weeks (after a 1-week gap behind the 70/30 line) and say what it picks this
 * week. `nul` = the random pickers (cached weekly by the caller), `prevKeys` = last week's picks (for added / rested).
 */
export function gradeRolling(
  rows: readonly RollRow[],
  oos: ReadonlyMap<string, readonly RollTrade[]>,
  o: { oosFrom: number; to: number; now: number; sim: Omit<PortfolioOpts, 'label' | 'from' | 'to'>; staticPool: readonly PTrade[]; nul: NullStats | null; wasActive: boolean; prevKeys: readonly string[] | null },
): RollReport {
  const w0 = weekOf(o.oosFrom + ROLL.embargoDays * DAY) + 1;
  const w1 = weekOf(o.to) - 1;
  const thisW = weekOf(o.now);
  const picks = picksFor(rows, thisW);
  const keys = picks.map((p) => p.key);
  const prev = new Set(o.prevKeys ?? []);
  const thisWeek = { week: thisW, picks, added: o.prevKeys ? keys.filter((k) => !prev.has(k)) : [], rested: o.prevKeys ? [...prev].filter((k) => !keys.includes(k)) : [] };
  const weeksGraded = Math.max(0, w1 - w0 + 1);
  if (weeksGraded < 1) return { active: false, why: 'not enough unseen weeks yet', weeksGraded: 0, from: weekStart(w0), to: o.to, result: null, pfR: null, staticSame: null, null: null, thisWeek, byWeek: [] };
  const { pool, weeks } = rollingPool(rows, oos, w0, w1);
  const from = weekStart(w0);
  const to = weekStart(w1 + 1) - 1;
  const result = simulatePortfolio(pool, { ...o.sim, label: 'learns every week', from, to });
  const staticSame = simulatePortfolio(
    o.staticPool.filter((t) => t.entryT >= from && t.entryT <= to),
    { ...o.sim, label: 'picked once', from, to },
  );
  const w = pool.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const l = -pool.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  const pfR = l > 0 ? Math.round((w / l) * 100) / 100 : w > 0 ? 99 : null;
  const beatPct = o.nul && o.nul.totals.length ? Math.round((o.nul.totals.filter((x) => x < result.totalPct).length / o.nul.totals.length) * 100) : null;
  const v = rollingVerdict({ weeksGraded, result, pfR, staticSame, beatPct }, o.wasActive);
  return {
    active: v.active,
    why: v.why,
    weeksGraded,
    from,
    to,
    result,
    pfR,
    staticSame,
    null: o.nul ? { draws: o.nul.draws, p50: o.nul.p50, p80: o.nul.p80, p95: o.nul.p95, ...(beatPct !== null ? { beatPct } : {}) } : null,
    thisWeek,
    byWeek: weeks.slice(-60).map((x) => ({ week: isoWeek(x.week), picked: x.picked, trades: x.trades })),
  };
}

/** The graded weeks for a 70/30 line at `oosFrom` and history up to `to` (the random pickers' cache key). */
export const rollWeeks = (oosFrom: number, to: number) => ({ w0: weekOf(oosFrom + ROLL.embargoDays * DAY) + 1, w1: weekOf(to) - 1 });
