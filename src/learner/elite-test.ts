/**
 * Elite launch test (v11.20): the deployer study showed repeat-graduator ("elite") creators' launches graduate ~42% vs
 * ~2.6% base on our own data. Graduating is not the same as us making money, so this replays the TRADE: for every launch
 * in the tape window whose creator was elite AT THAT MOMENT (no peeking — status rebuilt from the Token table in time
 * order), buy `sizeSol` 15 / 30 / 60 s after launch at the pool price the tape shows (+ slippage + curve fee + tx fee),
 * then sell at graduation (the curve completes / first PumpSwap trade), at a hard stop, at a take-profit multiple, or
 * after `maxHoldMin` — whichever comes first — with the same costs. Dead coin (no trades after our entry) = minus costs.
 *
 * Reports per entry delay × exit rule: n, win %, avg, median, SOL at `sizeSol` each, profit factor; split by whether the
 * creator was launching again within 24 h (the no-repeat rule) and by elite tier. Zero RPC: Postgres only.
 * Redis `elite:test:last`; GET /api/elite-test, POST /api/elite-test/run; Money tab card.
 */
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import type { Launch } from './deployer-study';
import type { TapeRow } from './replay';

export const ELITE_TEST_LAST = 'elite:test:last';

export interface EliteTestConfig {
  sizeSol: number;
  /** v2: entries — fixed delays after launch, and DIP entries (price ≥ dipPct under the first-minute high, within dipWindowMin) */
  entryDelaysSec: number[];
  dipEntriesPct: number[];
  dipWindowMin: number;
  /** v2: hold horizons (minutes) — each entry × take-profit is tried with each */
  maxHoldMins: number[];
  /** exit rules: graduation always sells; `tpX` sells earlier at this multiple (0 = graduation only) */
  takeProfitX: number[];
  stopPct: number;
  feePct: number;
  slippagePct: number;
  buyTxSol: number;
  sellTxSol: number;
  elite: { minGraduated: number; minBondRatePct: number };
}

export const DEFAULT_ELITE_TEST: EliteTestConfig = {
  sizeSol: 0.5,
  // v3: the elite graduates fill the curve in the first minute — how early must we be? (2 s ≈ our realistic latency)
  entryDelaysSec: [2, 5, 15, 60],
  dipEntriesPct: [30],
  dipWindowMin: 30,
  maxHoldMins: [10, 60],
  takeProfitX: [0, 3],
  stopPct: 60,
  feePct: 1.25,
  slippagePct: 0.8,
  buyTxSol: 0.0011,
  sellTxSol: 0.006,
  elite: { minGraduated: 2, minBondRatePct: 20 },
};

export interface EliteLaunch extends Launch {
  mint: string;
  symbol: string;
  /** creator's record BEFORE this launch */
  priorLaunches: number;
  priorGraduated: number;
  repeat24h: boolean;
}

export interface SimResult {
  mint: string;
  symbol: string;
  /** entry label: "60 s" or "dip 30%" */
  entry: string;
  delaySec: number;
  tpX: number;
  holdMin: number;
  pnlPct: number;
  pnlSol: number;
  peakX: number;
  holdSec: number;
  reason: 'graduation' | 'take profit' | 'hard stop' | 'max hold' | 'dead' | 'no entry' | 'no dip';
  graduated: boolean;
  repeat24h: boolean;
  priorGraduated: number;
}

export interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }

export interface EliteTestReport {
  at: number;
  from: string;
  to: string;
  launches: number;
  withTape: number;
  sizeSol: number;
  /** one row per delay × take-profit rule */
  grid: Array<Agg & { entry: string; holdMin: number; tpX: number; graduatedPct: number; byReason: Array<{ reason: string; n: number; avgPct: number }> }>;
  /** best rule, split by the no-repeat rule and by elite tier */
  best: { entry: string; holdMin: number; tpX: number } | null;
  /** when elite launches that graduated actually graduated (minutes after launch), from the Token table */
  timeToGraduate: { n: number; medianMin: number; p25Min: number; p75Min: number; within1hPct: number; within6hPct: number } | null;
  splits: Array<Agg & { label: string }>;
  verdict: string;
  durationMs: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function agg(xs: readonly SimResult[]): Agg {
  const p = xs.map((t) => t.pnlPct).sort((a, b) => a - b);
  const n = p.length;
  const gw = xs.reduce((a, t) => a + Math.max(0, t.pnlSol), 0);
  const gl = xs.reduce((a, t) => a + Math.max(0, -t.pnlSol), 0);
  return {
    n,
    winPct: n ? Math.round((p.filter((x) => x > 0).length / n) * 100) : 0,
    avgPct: r1(n ? p.reduce((a, b) => a + b, 0) / n : 0),
    medianPct: r1(n ? p[Math.floor(n / 2)]! : 0),
    totalSol: r3(xs.reduce((a, t) => a + t.pnlSol, 0)),
    profitFactor: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0,
  };
}

/** Pure: which launches in [from, to] were by a creator who was elite at that moment (state built from ALL launches). */
export function eliteLaunches(all: readonly (Launch & { mint: string; symbol: string })[], from: number, to: number, elite: { minGraduated: number; minBondRatePct: number }): EliteLaunch[] {
  const rows = [...all].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const state = new Map<string, { l: number; g: number; lastT: number }>();
  const out: EliteLaunch[] = [];
  for (const r of rows) {
    const s = state.get(r.creator) ?? { l: 0, g: 0, lastT: 0 };
    const rate = s.l > 0 ? (s.g / s.l) * 100 : 0;
    if (r.createdAtMs >= from && r.createdAtMs <= to && s.g >= elite.minGraduated && rate >= elite.minBondRatePct) {
      out.push({ ...r, priorLaunches: s.l, priorGraduated: s.g, repeat24h: s.l > 0 && r.createdAtMs - s.lastT <= 86_400_000 });
    }
    s.l++;
    if (r.graduated) s.g++;
    s.lastT = r.createdAtMs;
    state.set(r.creator, s);
  }
  return out;
}

export type Entry = { kind: 'delay'; delaySec: number } | { kind: 'dip'; dipPct: number };
export const entryLabel = (e: Entry): string => (e.kind === 'delay' ? `${e.delaySec} s after launch` : `dip ${e.dipPct}% off the first-minute high`);

/** Pure: one launch, one entry rule, one take-profit rule, one hold horizon, on its tape. */
export function simulate(l: EliteLaunch, tape: readonly TapeRow[], entry: Entry, tpX: number, holdMin: number, c: EliteTestConfig): SimResult {
  const base = { mint: l.mint, symbol: l.symbol, entry: entryLabel(entry), delaySec: entry.kind === 'delay' ? entry.delaySec : 0, tpX, holdMin, graduated: l.graduated, repeat24h: l.repeat24h, priorGraduated: l.priorGraduated };
  const costPct = 2 * c.feePct + 2 * c.slippagePct + ((c.buyTxSol + c.sellTxSol) / c.sizeSol) * 100;
  const px = (r: TapeRow) => (r.pp && r.pp > 0 ? r.pp : r.px);
  let first: TapeRow | undefined;
  if (entry.kind === 'delay') {
    const tEntry = l.createdAtMs + entry.delaySec * 1000;
    first = tape.find((r) => r.t >= tEntry && px(r) > 0 && !r.amm);
  } else {
    // the first-minute high, then the first trade ≥ dipPct under it within the dip window (curve only)
    let high = 0;
    for (const r of tape) if (r.t - l.createdAtMs <= 60_000 && px(r) > high) high = px(r);
    if (high > 0) first = tape.find((r) => r.t - l.createdAtMs > 60_000 && r.t - l.createdAtMs <= c.dipWindowMin * 60_000 && !r.amm && px(r) > 0 && px(r) <= high * (1 - entry.dipPct / 100));
    if (!first) return { ...base, pnlPct: 0, pnlSol: 0, peakX: 1, holdSec: 0, reason: 'no dip' };
  }
  if (!first) return { ...base, pnlPct: r1(-costPct), pnlSol: r3((-costPct / 100) * c.sizeSol), peakX: 1, holdSec: 0, reason: tape.length ? 'dead' : 'no entry' };
  const entryPx = px(first) * (1 + c.slippagePct / 100);
  const tok = (c.sizeSol * (1 - c.feePct / 100) - c.buyTxSol) / entryPx;
  const sellAt = (p: number) => Math.max(0, tok * p * (1 - c.slippagePct / 100) * (1 - c.feePct / 100) - c.sellTxSol);
  let peak = px(first);
  let lastPx = px(first);
  let lastT = first.t;
  const deadline = first.t + holdMin * 60_000;
  for (const r of tape) {
    if (r.t <= first.t) continue;
    const p = px(r);
    if (!(p > 0)) continue;
    if (r.t > deadline) break;
    if (p > peak) peak = p;
    const x = p / entryPx;
    const graduated = r.amm || (r.curvePct !== undefined && r.curvePct !== null && r.curvePct >= 99.5);
    const reason: SimResult['reason'] | null = graduated ? 'graduation' : tpX > 0 && x >= tpX ? 'take profit' : x <= 1 - c.stopPct / 100 ? 'hard stop' : null;
    if (reason) {
      const out = sellAt(p);
      return { ...base, pnlPct: r1(((out - c.sizeSol) / c.sizeSol) * 100), pnlSol: r3(out - c.sizeSol), peakX: r2(peak / entryPx), holdSec: Math.round((r.t - first.t) / 1000), reason };
    }
    lastPx = p;
    lastT = r.t;
  }
  const out = sellAt(lastPx);
  return { ...base, pnlPct: r1(((out - c.sizeSol) / c.sizeSol) * 100), pnlSol: r3(out - c.sizeSol), peakX: r2(peak / entryPx), holdSec: Math.round((lastT - first.t) / 1000), reason: 'max hold' };
}

/** Pure: the report from all sim results. */
export function entriesOf(c: EliteTestConfig): Entry[] {
  return [...c.entryDelaysSec.map((d): Entry => ({ kind: 'delay', delaySec: d })), ...c.dipEntriesPct.map((p): Entry => ({ kind: 'dip', dipPct: p }))];
}

export function buildReport(launches: readonly EliteLaunch[], results: readonly SimResult[], c: EliteTestConfig, meta: { from: number; to: number; withTape: number; now?: number; startedAt?: number; timeToGraduate?: EliteTestReport['timeToGraduate'] }): EliteTestReport {
  const taken = results.filter((r) => r.reason !== 'no dip');
  const grid = entriesOf(c).flatMap((e) =>
    c.maxHoldMins.flatMap((h) =>
      c.takeProfitX.map((tp) => {
        const label = entryLabel(e);
        const xs = taken.filter((r) => r.entry === label && r.holdMin === h && r.tpX === tp);
        const reasons = new Map<string, SimResult[]>();
        for (const x of xs) reasons.set(x.reason, [...(reasons.get(x.reason) ?? []), x]);
        return {
          entry: label,
          holdMin: h,
          tpX: tp,
          ...agg(xs),
          graduatedPct: xs.length ? Math.round((xs.filter((x) => x.graduated).length / xs.length) * 100) : 0,
          byReason: [...reasons].map(([reason, rs]) => ({ reason, n: rs.length, avgPct: r1(rs.reduce((a, r) => a + r.pnlPct, 0) / rs.length) })).sort((a, b) => b.n - a.n),
        };
      }),
    ),
  );
  const ranked = [...grid].filter((g) => g.n >= 10).sort((a, b) => b.totalSol - a.totalSol);
  const best = ranked[0] ? { entry: ranked[0].entry, holdMin: ranked[0].holdMin, tpX: ranked[0].tpX } : null;
  const bestRs = best ? taken.filter((r) => r.entry === best.entry && r.holdMin === best.holdMin && r.tpX === best.tpX) : [];
  const splits = best
    ? [
        { label: 'creator launched again within 24 h', ...agg(bestRs.filter((r) => r.repeat24h)) },
        { label: 'no other launch in 24 h', ...agg(bestRs.filter((r) => !r.repeat24h)) },
        { label: '2 prior graduations', ...agg(bestRs.filter((r) => r.priorGraduated === 2)) },
        { label: '3–5 prior graduations', ...agg(bestRs.filter((r) => r.priorGraduated >= 3 && r.priorGraduated <= 5)) },
        { label: '6+ prior graduations', ...agg(bestRs.filter((r) => r.priorGraduated >= 6)) },
      ]
    : [];
  const b = ranked[0];
  const verdict = !launches.length
    ? 'No elite-creator launches in this window.'
    : !b
      ? `Only ${launches.length} elite launches with tape — too few to judge.`
      : b.totalSol > 0 && (b.profitFactor === null || b.profitFactor >= 1.5) && b.n >= 30
        ? `It pays on our tape: ${b.entry}, hold up to ${b.holdMin >= 60 ? `${b.holdMin / 60} h` : `${b.holdMin} min`}, ${b.tpX ? `sell at ${b.tpX}× or graduation` : 'sell into graduation'} → ${b.n} trades, ${b.winPct}% won, ${b.totalSol >= 0 ? '+' : ''}${b.totalSol} SOL at ${c.sizeSol} SOL each (avg ${b.avgPct >= 0 ? '+' : ''}${b.avgPct}%, PF ${b.profitFactor ?? '∞'}).`
        : `Not an edge on our tape: the best rule (${b.entry}, hold ${b.holdMin >= 60 ? `${b.holdMin / 60} h` : `${b.holdMin} min`}, ${b.tpX ? `${b.tpX}×` : 'graduation'}) made ${b.totalSol >= 0 ? '+' : ''}${b.totalSol} SOL over ${b.n} trades (${b.winPct}% won, PF ${b.profitFactor ?? '∞'}). Needs PF ≥ 1.5 on 30+ trades to count.`;
  return { at: meta.now ?? Date.now(), from: new Date(meta.from).toISOString(), to: new Date(meta.to).toISOString(), launches: launches.length, withTape: meta.withTape, sizeSol: c.sizeSol, grid, best, timeToGraduate: meta.timeToGraduate ?? null, splits, verdict, durationMs: Date.now() - (meta.startedAt ?? Date.now()) };
}

let running: Promise<EliteTestReport> | null = null;
export const eliteTestRunning = () => running !== null;

/** Run over the tape window [from, to] (creator history from 30 days before `from`). */
export function runEliteTest(from: number, to: number, cfg: EliteTestConfig = DEFAULT_ELITE_TEST): Promise<EliteTestReport> {
  if (running) return running;
  running = (async () => {
    const startedAt = Date.now();
    const all: Array<Launch & { mint: string; symbol: string; completedAtMs: number | null }> = [];
    let cursor = new Date(from - 30 * 86_400_000);
    const until = new Date(Math.min(to, Date.now() - 2 * 3_600_000));
    for (let page = 0; page < 3_000; page++) {
      const rows = await prisma.token.findMany({ where: { createdAt: { gt: cursor, lte: until } }, select: { mint: true, symbol: true, creator: true, createdAt: true, completedAt: true }, orderBy: { createdAt: 'asc' }, take: 5_000 });
      if (!rows.length) break;
      for (const r of rows) all.push({ mint: r.mint, symbol: r.symbol, creator: r.creator, createdAtMs: r.createdAt.getTime(), graduated: r.completedAt !== null, completedAtMs: r.completedAt?.getTime() ?? null });
      cursor = rows[rows.length - 1]!.createdAt;
      await new Promise((r) => setImmediate(r));
      if (rows.length < 5_000) break;
    }
    const launches = eliteLaunches(all, from, to, cfg.elite);
    // When do elite launches that graduate actually graduate?
    const byMint = new Map(all.map((a) => [a.mint, a]));
    const ttg = launches.map((l) => byMint.get(l.mint)?.completedAtMs).filter((t): t is number => typeof t === 'number').map((t, i) => (t - launches.filter((l) => byMint.get(l.mint)?.completedAtMs !== null)[i]!.createdAtMs) / 60_000).filter((m) => m >= 0).sort((a, b) => a - b);
    const q = (p: number) => (ttg.length ? Math.round(ttg[Math.min(ttg.length - 1, Math.floor(ttg.length * p))]!) : 0);
    const timeToGraduate = ttg.length ? { n: ttg.length, medianMin: q(0.5), p25Min: q(0.25), p75Min: q(0.75), within1hPct: Math.round((ttg.filter((m) => m <= 60).length / ttg.length) * 100), within6hPct: Math.round((ttg.filter((m) => m <= 360).length / ttg.length) * 100) } : null;
    const results: SimResult[] = [];
    let withTape = 0;
    const longest = Math.max(...cfg.maxHoldMins) + cfg.dipWindowMin + 2;
    const entries = entriesOf(cfg);
    for (const l of launches) {
      const rows = await prisma.tradeTape.findMany({ where: { mint: l.mint, t: { gte: new Date(l.createdAtMs), lte: new Date(l.createdAtMs + longest * 60_000) } }, orderBy: [{ t: 'asc' }, { id: 'asc' }], select: { mint: true, t: true, wallet: true, buy: true, sol: true, tokens: true, px: true, pp: true, amm: true, curvePct: true } });
      const tape: TapeRow[] = rows.map((r) => ({ mint: r.mint, t: r.t.getTime(), w: r.wallet, buy: r.buy, sol: r.sol, tok: r.tokens ?? 0, px: r.px, ...(r.pp ? { pp: r.pp } : {}), amm: r.amm, curvePct: r.curvePct }));
      if (tape.length) withTape++;
      else continue; // launched before the tape started recording it: no price path, not counted
      for (const e of entries) for (const h of cfg.maxHoldMins) for (const tp of cfg.takeProfitX) results.push(simulate(l, tape, e, tp, h, cfg));
      await new Promise((r) => setImmediate(r));
    }
    const report = buildReport(launches.filter((l) => results.some((r) => r.mint === l.mint)), results, cfg, { from, to, withTape, startedAt, timeToGraduate });
    await redis.set(ELITE_TEST_LAST, JSON.stringify(report)).catch(() => undefined);
    return report;
  })().finally(() => (running = null));
  return running;
}

export async function lastEliteTest(): Promise<EliteTestReport | null> {
  const raw = await redis.get(ELITE_TEST_LAST).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EliteTestReport;
  } catch {
    return null;
  }
}
