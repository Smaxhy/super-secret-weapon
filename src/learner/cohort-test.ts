/**
 * Cohort test (v11.22): the two ideas left that are genuinely different from everything already tested, on the tape:
 *   BOOST  — every graduation triggers ~17.6 SOL of scheduled buy-and-burn over ~5 min (the one predictable flow on
 *            pump.fun). Buy at migration + 10 / 30 / 60 s, sell at 1.3× / 1.5× / 2× or when the BOOST ends (5 min),
 *            stop −30%. Every graduate (the bot currently WAITS those 5 minutes out).
 *   SURVIVOR — coins still trading 1 h / 2 h after graduation with ≥20 distinct buyers in the last hour: buy then, hold
 *            up to 6 / 12 / 24 h with a 25% trailing stop (armed at 1.3×), sell at 3× or −40%.
 * Anchor = the first PumpSwap trade on the tape (migration). Entries and exits on PumpSwap trades only, pool price after
 * each trade, 1.25% fee + 0.8% slippage each way + tx fees, `sizeSol` each. No trade after the entry = dead (sold at
 * the entry price, costs lost). Redis `cohort:test:last`; GET /api/cohort-test, POST /api/cohort-test/run {days}.
 */
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import type { TapeRow } from './replay';

export const COHORT_LAST = 'cohort:test:last';

export interface CohortConfig {
  sizeSol: number;
  feePct: number;
  slippagePct: number;
  buyTxSol: number;
  sellTxSol: number;
  boost: { delaysSec: number[]; takeProfitX: number[]; stopPct: number; endMin: number };
  survivor: { ageHours: number[]; minBuyersLastHour: number; holdHours: number[]; trailPct: number; trailArmX: number; takeProfitX: number; stopPct: number };
  /** graduates per run (newest first) — keeps a run to minutes */
  maxGraduates: number;
}

export const DEFAULT_COHORT: CohortConfig = {
  sizeSol: 0.5,
  feePct: 1.25,
  slippagePct: 0.8,
  buyTxSol: 0.0011,
  sellTxSol: 0.006,
  boost: { delaysSec: [10, 30, 60], takeProfitX: [1.3, 1.5, 2], stopPct: 30, endMin: 5 },
  survivor: { ageHours: [1, 2], minBuyersLastHour: 20, holdHours: [6, 12, 24], trailPct: 25, trailArmX: 1.3, takeProfitX: 3, stopPct: 40 },
  maxGraduates: 600,
};

export interface Sim {
  cohort: 'boost' | 'survivor';
  rule: string;
  mint: string;
  symbol: string;
  entryT: number | null;
  pnlPct: number;
  pnlSol: number;
  peakX: number;
  holdSec: number;
  reason: string;
}

export interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }

/** A single pretend trade can't be trusted past 10× (bad pool prints). Averages are capped at +300% per trade. */
export const SANE_MAX_X = 10;
export const CAP_PCT = 300;
export const saneSim = (s: Sim) => s.peakX <= SANE_MAX_X && s.pnlPct <= (SANE_MAX_X - 1) * 100;
export interface RuleRow extends Agg { cohort: 'boost' | 'survivor'; rule: string; byReason: Array<{ reason: string; n: number; avgPct: number }> }
export interface CohortReport {
  at: number;
  /** sims dropped as broken price prints (gain > 10× or peak > 10×, like the Money tab's saneRow) */
  dropped: number;
  from: string;
  to: string;
  graduates: number;
  withTape: number;
  survivors: number;
  sizeSol: number;
  rows: RuleRow[];
  best: { cohort: 'boost' | 'survivor'; rule: string } | null;
  verdict: string;
  durationMs: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const priceOf = (r: TapeRow) => (r.pp && r.pp > 0 ? r.pp : r.px);

export function agg(xs: readonly Sim[]): Agg {
  const n = xs.length;
  if (!n) return { n: 0, winPct: 0, avgPct: 0, medianPct: 0, totalSol: 0, profitFactor: null };
  const ps = xs.map((x) => Math.min(CAP_PCT, x.pnlPct)).sort((a, b) => a - b);
  const sols = xs.map((x) => (x.pnlPct > CAP_PCT ? (x.pnlSol * CAP_PCT) / x.pnlPct : x.pnlSol));
  let gw = 0;
  let gl = 0;
  for (const v of sols) if (v > 0) gw += v; else gl += -v;
  return {
    n,
    winPct: Math.round((xs.filter((x) => x.pnlPct > 0).length / n) * 100),
    avgPct: r1(ps.reduce((a, b) => a + b, 0) / n),
    medianPct: r1(ps[Math.floor(n / 2)]!),
    totalSol: r2(sols.reduce((a, v) => a + v, 0)),
    profitFactor: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0,
  };
}

interface Open { entryPx: number; tok: number; t: number; peak: number }

function enter(px: number, t: number, c: CohortConfig): Open {
  const entryPx = px * (1 + c.slippagePct / 100);
  const tok = (c.sizeSol * (1 - c.feePct / 100) - c.buyTxSol) / entryPx;
  return { entryPx, tok, t, peak: px };
}

function close(base: Omit<Sim, 'pnlPct' | 'pnlSol' | 'peakX' | 'holdSec' | 'reason'>, o: Open, px: number, t: number, reason: string, c: CohortConfig): Sim {
  const sellPx = px * (1 - c.slippagePct / 100);
  const got = o.tok * sellPx * (1 - c.feePct / 100) - c.sellTxSol;
  const pnlSol = got - c.sizeSol;
  return { ...base, pnlPct: r1((pnlSol / c.sizeSol) * 100), pnlSol: r3(pnlSol), peakX: r2(o.peak / o.entryPx), holdSec: Math.round((t - o.t) / 1000), reason };
}

/** BOOST trade: buy `delaySec` after migration, sell at `tpX`, at the hard stop, or when the BOOST window ends. */
export function simulateBoost(meta: { mint: string; symbol: string }, amm: readonly TapeRow[], migMs: number, delaySec: number, tpX: number, c: CohortConfig): Sim {
  const base = { cohort: 'boost' as const, rule: `${delaySec} s in, sell ${tpX}× / BOOST end`, mint: meta.mint, symbol: meta.symbol, entryT: null as number | null };
  const i0 = amm.findIndex((r) => r.t >= migMs + delaySec * 1000 && priceOf(r) > 0);
  if (i0 < 0) return { ...base, pnlPct: 0, pnlSol: 0, peakX: 1, holdSec: 0, reason: 'no entry' };
  const e = amm[i0]!;
  const o = enter(priceOf(e), e.t, c);
  base.entryT = e.t;
  const endT = migMs + c.boost.endMin * 60_000;
  for (let i = i0 + 1; i < amm.length; i++) {
    const r = amm[i]!;
    const p = priceOf(r);
    if (!(p > 0)) continue;
    if (p > o.peak) o.peak = p;
    if (p >= o.entryPx * tpX) return close(base, o, p, r.t, 'take profit', c);
    if (p <= o.entryPx * (1 - c.boost.stopPct / 100)) return close(base, o, p, r.t, 'hard stop', c);
    if (r.t >= endT) return close(base, o, p, r.t, 'BOOST end', c);
  }
  const last = amm[amm.length - 1]!;
  if (last.t <= e.t) return close(base, o, priceOf(e), e.t, 'dead (no trade after the buy)', c);
  return close(base, o, priceOf(last), last.t, 'tape end', c);
}

/** Is the coin still alive at `at`: ≥ minBuyers distinct buyers in the hour before. */
export function survivorAt(amm: readonly TapeRow[], at: number, minBuyers: number): boolean {
  const seen = new Set<string>();
  for (const r of amm) {
    if (r.t >= at) break;
    if (r.buy && r.t >= at - 3_600_000) seen.add(r.w);
  }
  return seen.size >= minBuyers;
}

/** Survivor trade: buy `ageH` hours after migration if still alive, trail 25% from 1.3×, sell at 3× / −40% / `holdH` hours. */
export function simulateSurvivor(meta: { mint: string; symbol: string }, amm: readonly TapeRow[], migMs: number, ageH: number, holdH: number, c: CohortConfig): Sim | null {
  const at = migMs + ageH * 3_600_000;
  if (!survivorAt(amm, at, c.survivor.minBuyersLastHour)) return null;
  const i0 = amm.findIndex((r) => r.t >= at && priceOf(r) > 0);
  if (i0 < 0) return null;
  const base = { cohort: 'survivor' as const, rule: `alive at ${ageH} h, hold ≤ ${holdH} h`, mint: meta.mint, symbol: meta.symbol, entryT: amm[i0]!.t as number | null };
  const e = amm[i0]!;
  const o = enter(priceOf(e), e.t, c);
  const s = c.survivor;
  let armed = false;
  for (let i = i0 + 1; i < amm.length; i++) {
    const r = amm[i]!;
    const p = priceOf(r);
    if (!(p > 0)) continue;
    if (p > o.peak) o.peak = p;
    if (p >= o.entryPx * s.trailArmX) armed = true;
    if (p >= o.entryPx * s.takeProfitX) return close(base, o, p, r.t, 'take profit', c);
    if (armed && p <= o.peak * (1 - s.trailPct / 100)) return close(base, o, p, r.t, 'trailing stop', c);
    if (p <= o.entryPx * (1 - s.stopPct / 100)) return close(base, o, p, r.t, 'hard stop', c);
    if (r.t >= e.t + holdH * 3_600_000) return close(base, o, p, r.t, 'max hold', c);
  }
  const last = amm[amm.length - 1]!;
  if (last.t <= e.t) return close(base, o, priceOf(e), e.t, 'dead (no trade after the buy)', c);
  return close(base, o, priceOf(last), last.t, 'tape end', c);
}

export function buildReport(sims: readonly Sim[], c: CohortConfig, meta: { from: number; to: number; graduates: number; withTape: number; survivors: number; startedAt: number }): CohortReport {
  const groups = new Map<string, Sim[]>();
  let dropped = 0;
  for (const s of sims) {
    if (s.reason === 'no entry') continue;
    if (!saneSim(s)) {
      dropped++;
      continue;
    }
    const k = `${s.cohort}:${s.rule}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const rows: RuleRow[] = [...groups.values()].map((xs) => {
    const by = new Map<string, Sim[]>();
    for (const x of xs) (by.get(x.reason) ?? by.set(x.reason, []).get(x.reason)!).push(x);
    return { cohort: xs[0]!.cohort, rule: xs[0]!.rule, ...agg(xs), byReason: [...by.entries()].map(([reason, ys]) => ({ reason, n: ys.length, avgPct: agg(ys).avgPct })).sort((a, b) => b.n - a.n) };
  });
  rows.sort((a, b) => b.totalSol - a.totalSol);
  const bestRow = rows.find((r) => r.n >= 30) ?? null;
  const best = bestRow ? { cohort: bestRow.cohort, rule: bestRow.rule } : null;
  // pays = positive after costs for the TYPICAL trade too (median), not one lucky print carrying the total
  const pays = !!bestRow && bestRow.totalSol > 0 && bestRow.medianPct > 0 && (bestRow.profitFactor === null || bestRow.profitFactor >= 1.5);
  const verdict = !bestRow
    ? 'Too few trades to judge (a rule needs 30+). Record more tape and run again.'
    : pays
      ? `It pays: ${bestRow.cohort === 'boost' ? 'BOOST' : 'Survivor'} "${bestRow.rule}" made ${bestRow.totalSol >= 0 ? '+' : ''}${bestRow.totalSol} SOL over ${bestRow.n} trades (${bestRow.winPct}% won, PF ${bestRow.profitFactor ?? '∞'}). Worth wiring as a real strategy.`
      : `Not an edge: the best rule (${bestRow.cohort === 'boost' ? 'BOOST' : 'Survivor'} "${bestRow.rule}") made ${bestRow.totalSol >= 0 ? '+' : ''}${bestRow.totalSol} SOL over ${bestRow.n} trades, ${bestRow.winPct}% won, PF ${bestRow.profitFactor ?? '∞'} — needs PF ≥ 1.5 AND a positive median (the typical trade must pay, not one lucky print).`;
  return { at: Date.now(), dropped, from: new Date(meta.from).toISOString(), to: new Date(meta.to).toISOString(), graduates: meta.graduates, withTape: meta.withTape, survivors: meta.survivors, sizeSol: c.sizeSol, rows, best, verdict, durationMs: Date.now() - meta.startedAt };
}

let running: Promise<CohortReport> | null = null;
export const cohortTestRunning = () => running !== null;

export function runCohortTest(from: number, to: number, c: CohortConfig = DEFAULT_COHORT): Promise<CohortReport> {
  if (running) return running;
  running = (async () => {
    const startedAt = Date.now();
    const grads = await prisma.token.findMany({ where: { completedAt: { gte: new Date(from), lte: new Date(to) } }, select: { mint: true, symbol: true, completedAt: true }, orderBy: { completedAt: 'desc' }, take: c.maxGraduates });
    const horizonMs = (Math.max(...c.survivor.ageHours) + Math.max(...c.survivor.holdHours)) * 3_600_000;
    const sims: Sim[] = [];
    let withTape = 0;
    let survivors = 0;
    for (const g of grads) {
      const at = g.completedAt!.getTime();
      const rows = await prisma.tradeTape.findMany({ where: { mint: g.mint, amm: true, t: { gte: new Date(at - 60_000), lte: new Date(at + horizonMs) } }, orderBy: [{ t: 'asc' }, { id: 'asc' }], select: { mint: true, t: true, wallet: true, buy: true, sol: true, tokens: true, px: true, pp: true, amm: true, curvePct: true } });
      if (!rows.length) continue;
      withTape++;
      const amm: TapeRow[] = rows.map((r) => ({ mint: r.mint, t: r.t.getTime(), w: r.wallet, buy: r.buy, sol: r.sol, tok: r.tokens ?? 0, px: r.px, ...(r.pp ? { pp: r.pp } : {}), amm: r.amm, curvePct: r.curvePct }));
      const migMs = amm[0]!.t;
      const meta = { mint: g.mint, symbol: g.symbol ?? g.mint.slice(0, 6) };
      for (const d of c.boost.delaysSec) for (const tp of c.boost.takeProfitX) sims.push(simulateBoost(meta, amm, migMs, d, tp, c));
      if (survivorAt(amm, migMs + c.survivor.ageHours[0]! * 3_600_000, c.survivor.minBuyersLastHour)) survivors++;
      for (const a of c.survivor.ageHours) for (const h of c.survivor.holdHours) {
        const s = simulateSurvivor(meta, amm, migMs, a, h, c);
        if (s) sims.push(s);
      }
      await new Promise((r) => setImmediate(r));
    }
    const report = buildReport(sims, c, { from, to, graduates: grads.length, withTape, survivors, startedAt });
    await redis.set(COHORT_LAST, JSON.stringify(report)).catch(() => undefined);
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function lastCohortTest(): Promise<CohortReport | null> {
  const raw = await redis.get(COHORT_LAST).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CohortReport;
  } catch {
    return null;
  }
}
