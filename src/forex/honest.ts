/**
 * v18 "how much of this is luck?" — the lab's selection process graded with the standard quant tests (stats.ts):
 *  - per row: the DEFLATED Sharpe of its unseen trades — P(its true edge is real) given that it is one of N rows
 *    graded on the same unseen data (the best of N no-edge rows would also look good); an Edge row whose deflated
 *    Sharpe is under 50% is downgraded to Maybe (luck explains it at least as well);
 *  - overall: the probability of backtest overfitting (CSCV) over every row's weekly results, and the Reality Check /
 *    SPA p-values of the best row against the random yardstick — "would the best row still beat random once every row
 *    tried is counted?".
 * Pure.
 */
import { bucketSums, deflatedSharpe, minTrackRecord, moments, pbo, realityCheck, varianceOf, type PboResult, type SpaResult } from './stats';
import type { Trade } from './types';

export const HONEST = {
  /** an Edge row needs at least this deflated Sharpe to stay Edge */
  minDsr: 0.5,
  /** unseen trades a row needs to be counted as a trial */
  minOut: 30,
  weekMs: 7 * 86_400_000,
  pboBlocks: 16,
  spaDraws: 400,
  /** rows with fewer closed trades in the whole history are left out of the PBO / SPA matrix (all-zero rows add nothing) */
  minAll: 20,
};

export interface RowStat {
  /** v28.13: Sharpe of its unseen WEEKS (weekly R sum: mean ÷ sd) */
  sr: number;
  /** the Sharpe the best of the N trials would show by luck */
  srStar: number;
  /** P(true Sharpe > 0) without the correction, and the deflated one */
  psr0: number;
  dsr: number;
  /** unseen WEEKS needed before the Sharpe beats srStar at 95% (null = never at this Sharpe) */
  minTrl: number | null;
  n: number;
}

export interface HonestReport {
  /** rows counted as trials (unseen trades ≥ minOut), the spread of their Sharpes, and the luck benchmark */
  trials: number;
  varSr: number;
  expectedMaxSr: number;
  /** Edge rows downgraded to Maybe by the deflated Sharpe */
  downgraded: number;
  /** probability of backtest overfitting over every row's weekly R (null = not enough history / rows) */
  pbo: PboResult | null;
  /** the best row vs the random yardstick's weekly R (or vs zero) once every row is counted */
  spa: (SpaResult & { bestKey: string }) | null;
  benchmark: 'random' | 'zero';
  weeks: number;
  rowsInMatrix: number;
  note: string;
}

export interface StatInput {
  key: string;
  isRandom: boolean;
  /** every closed trade of the row's final variant */
  done: readonly Trade[];
}

export interface HonestOut {
  report: HonestReport;
  /** per row key */
  rows: Map<string, RowStat>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The whole thing. `from` / `to` / `oosFrom` are the lab's history span and 70/30 line (ms). */
export function honestStats(inputs: readonly StatInput[], o: { from: number; to: number; oosFrom: number; extraSr?: readonly number[] }): HonestOut {
  const rows = new Map<string, RowStat>();
  // ── per-row deflated Sharpe on the unseen WEEKS ──
  // v28.13: every row is measured on the same unseen weeks (its trades summed by the week they closed), so all trials
  // share one sample length T and the luck benchmark is the best of N no-edge rows' weekly Sharpe: under no edge each
  // row's weekly Sharpe estimate is ≈ N(0, 1 ∕ (T − 1)). Before, it was the Sharpe PER TRADE with the luck benchmark
  // from the spread of every row's per-trade Sharpe — rows with 30 trades (very noisy Sharpes) set the bar and a row
  // with 1,357 unseen trades at +0.11R (t ≈ 9) read as "0% real". Same trades counted, same weeks for every row;
  // trades in the same week (coins move together) count once as that week's total.
  const uFrom = o.oosFrom;
  const uWeeks = Math.max(1, Math.ceil((o.to - uFrom) / HONEST.weekMs));
  const unseen = new Map<string, { rs: number[]; weeks: number[] }>();
  for (const x of inputs) {
    if (x.isRandom) continue;
    const done = x.done.filter((t) => t.entryT >= o.oosFrom);
    const w = bucketSums(done.map((t) => ({ t: Math.min(Math.max(t.exitT, uFrom), o.to - 1), v: t.r })), uFrom, o.to, HONEST.weekMs);
    unseen.set(x.key, { rs: done.map((t) => t.r), weeks: Array.from(w) });
  }
  const weekSr = (ws: readonly number[]) => {
    const m = moments(ws);
    return m.sd > 0 ? m.mean / m.sd : 0;
  };
  const trialSr: number[] = [];
  for (const u of unseen.values()) if (u.rs.length >= HONEST.minOut) trialSr.push(weekSr(u.weeks));
  // v27.37: retired strategies skipped this run were still tried — they keep counting as trials
  const trials = trialSr.length + (o.extraSr ?? []).length;
  // the spread of the trials' weekly Sharpes (reported) and the null spread the benchmark uses
  const varSr = varianceOf(trialSr);
  const nullVar = uWeeks > 1 ? 1 / (uWeeks - 1) : 0;
  let expectedMaxSr = 0;
  for (const [key, u] of unseen) {
    if (u.rs.length < HONEST.minOut) continue;
    const d = deflatedSharpe(u.weeks, { n: trials, varSr: nullVar });
    expectedMaxSr = d.srStar;
    const m = moments(u.weeks);
    const mt = minTrackRecord(d.sr, m.skew, m.kurt, d.srStar);
    rows.set(key, { sr: r3(d.sr), srStar: r3(d.srStar), psr0: r3(d.psr0), dsr: r3(d.dsr), minTrl: Number.isFinite(mt) ? Math.round(mt) : null, n: u.rs.length });
  }
  // ── overall: weekly R per row → PBO (CSCV) and the Reality Check / SPA vs the random yardstick ──
  const weeks = Math.max(1, Math.ceil((o.to - o.from) / HONEST.weekMs));
  const weekly = (done: readonly Trade[]) => bucketSums(done.map((t) => ({ t: t.exitT, v: t.r })), o.from, o.to, HONEST.weekMs);
  const matrixKeys: string[] = [];
  const matrix: Float64Array[] = [];
  const bench = new Float64Array(weeks);
  let benchN = 0;
  for (const x of inputs) {
    if (x.isRandom) {
      const w = weekly(x.done);
      for (let i = 0; i < weeks; i++) bench[i] = bench[i]! + (w[i] ?? 0);
      benchN++;
      continue;
    }
    if (x.done.length < HONEST.minAll) continue;
    matrixKeys.push(x.key);
    matrix.push(weekly(x.done));
  }
  if (benchN > 1) for (let i = 0; i < weeks; i++) bench[i] = bench[i]! / benchN;
  const benchmark: HonestReport['benchmark'] = benchN > 0 ? 'random' : 'zero';
  const p = matrix.length >= 2 ? pbo(matrix, HONEST.pboBlocks) : null;
  const excess = matrix.map((w) => {
    const d = new Float64Array(weeks);
    for (let i = 0; i < weeks; i++) d[i] = w[i]! - bench[i]!;
    return d;
  });
  const sp = excess.length >= 1 ? realityCheck(excess, { draws: HONEST.spaDraws, seed: 11 }) : null;
  const spa = sp ? { ...sp, bestKey: matrixKeys[sp.best] ?? '' } : null;
  const parts: string[] = [];
  parts.push(`${trials} rows had ${HONEST.minOut}+ unseen trades; over the ${uWeeks} unseen weeks the best of that many no-edge rows would show a weekly Sharpe of about ${r3(expectedMaxSr)}, so an Edge row must beat that (deflated Sharpe ≥ ${Math.round(HONEST.minDsr * 100)}%).`);
  if (p) parts.push(`PBO ${Math.round(p.pbo * 100)}%: in ${Math.round(p.pbo * 100)}% of ${p.combos} half-and-half splits the in-sample winner ranked below the median out of sample (≤ 30% is healthy; ~50% means the picks are noise).`);
  if (spa) parts.push(`Best row vs ${benchmark === 'random' ? 'random entries' : 'zero'}: Reality Check p ${spa.pRc}, SPA p ${spa.pSpa} (under 0.05 = the best row's lead survives counting every row tried).`);
  return {
    report: { trials, varSr: r3(varSr), expectedMaxSr: r3(expectedMaxSr), downgraded: 0, pbo: p, spa, benchmark, weeks, rowsInMatrix: matrix.length, note: parts.join(' ') },
    rows,
  };
}

/** Apply the deflated Sharpe to a row's verdict: Edge stays Edge only with dsr ≥ HONEST.minDsr. Pure. */
export function dsrDowngrade(verdict: 'edge' | 'maybe' | 'no', st: RowStat | undefined, trials: number): { verdict: 'edge' | 'maybe' | 'no'; why: string | null } {
  if (verdict !== 'edge' || !st || st.dsr >= HONEST.minDsr) return { verdict, why: null };
  return { verdict: 'maybe', why: `positive on unseen data, but one of ${trials} rows graded on it: deflated Sharpe ${Math.round(st.dsr * 100)}% (its weekly Sharpe ${st.sr} is what the best no-edge row would show by luck: ${st.srStar})` };
}
