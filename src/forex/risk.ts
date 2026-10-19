/**
 * Correlated risk ("heat"). Several open trades that move together (AUD/NZD, EUR/CHF, gold / silver, the risk-on
 * crosses) are really one bet. The combined stop risk of the open book is
 *   heat = sqrt(Σ_j Σ_k (s_j r_j) ρ_jk (s_k r_k))
 * where r_j = risk % of the account of position j, s_j = +1 long / −1 short of its pair and ρ = the correlation of the
 * pairs' hourly returns (ρ = 1 for two positions on the same pair). Two 1% trades on ρ = 1 pairs = 2% of heat, on
 * unrelated pairs ≈ 1.41%, opposite sides of the same pair = 0%.
 *
 * Correlations come from a zero-mean EWMA of hourly log returns (`buildCorrBook`), snapshotted once a day at the 22:00
 * UTC rollover so a backtest can ask "what did the bot know at time T" (`corrAt`). Pure.
 */
import type { Bar } from './types';

/** Fixed before any real result; never tune on dashboard numbers. */
export const HEAT = {
  /** EWMA half-life in hourly returns (≈ 2 trading weeks) */
  halfLifeHours: 240,
  /** joint hourly returns a pair-pair needs before its ρ counts (else 0) */
  minObs: 200,
  /** heat cap = this × the base risk per trade */
  capMult: 3,
  /** a trade cut by the cap below this share of its planned risk is skipped instead of taken tiny */
  minScale: 0.4,
};

const H = 3_600_000;
const DAY = 86_400_000;
/** daily snapshot boundary: 22:00 UTC (FX rollover) */
const ROLL = 22 * H;

export interface CorrBook {
  ids: string[];
  idx: Record<string, number>;
  /** snapshot stamp times (close time of the last bar included), ascending */
  t: Float64Array;
  /** K×K row-major ρ per snapshot */
  mats: Float32Array[];
  /** latest ρ (after every bar); null when there were no bars at all */
  now: Float32Array | null;
}

/** Trading day of a bar CLOSE time: bars closing in (22:00 the day before, 22:00] share a day. */
const dayOf = (closeT: number) => Math.ceil((closeT - ROLL) / DAY);

/**
 * Walk every hourly bar of `ids` in time order and keep EWMA correlations; one snapshot per 22:00 UTC boundary crossed.
 *  - A pair's return at a bar = ln(close ÷ previous close), only when that pair also has the bar exactly 1 h earlier
 *    (weekend / missing bar → no return; a bad close (≤ 0, NaN) breaks the chain the same way).
 *  - Estimator: per pair-pair (j, k), over the hours where BOTH have a return, EWMA sums of r_j·r_k, r_j² and r_k²
 *    (decayed by λ = 2^(−1/halfLife) at each joint observation). ρ_jk = Σr_j r_k ÷ sqrt(Σr_j² · Σr_k²) on the same
 *    samples, so |ρ| ≤ 1 by Cauchy–Schwarz (clamped anyway for float error). Per-pair variances over each pair's own
 *    hours would let ρ leave [−1, 1] when the pairs' hours differ (metals vs FX). The matrix is pairwise, so it can be
 *    slightly non-PSD when hours differ; `heatPct` clamps its radicand at 0.
 *  - ρ is 0 until the pair-pair has `minObs` joint returns; the diagonal is 1.
 *  - Causal: a snapshot stamped T is taken before any bar closing after T is read.
 * O(N·K²) for N distinct bar times and K pairs.
 */
export function buildCorrBook(h1: ReadonlyMap<string, readonly Bar[]>, ids: readonly string[]): CorrBook {
  const K = ids.length;
  const idx: Record<string, number> = {};
  ids.forEach((id, i) => (idx[id] = i));
  const series = ids.map((id) => h1.get(id) ?? []);
  const lambda = Math.pow(2, -1 / HEAT.halfLifeHours);
  const KK = K * K;
  // cov[j*K+k] (j < k): Σ r_j r_k; vv[j*K+k]: Σ r_j² over the hours where k also has a return (vv[j*K+j]: own hours)
  const cov = new Float64Array(KK);
  const vv = new Float64Array(KK);
  const nObs = new Float64Array(KK);
  const ptr = new Int32Array(K);
  const lastSeen = new Float64Array(K).fill(-Infinity);
  const lastT = new Float64Array(K).fill(NaN);
  const lastC = new Float64Array(K).fill(NaN);
  const present = new Int32Array(K);
  const ret = new Float64Array(K);
  const stamps: number[] = [];
  const mats: Float32Array[] = [];

  const rho = (): Float32Array => {
    const m = new Float32Array(KK);
    for (let j = 0; j < K; j++) {
      m[j * K + j] = 1;
      for (let k = j + 1; k < K; k++) {
        const a = j * K + k;
        let r = 0;
        if (nObs[a]! >= HEAT.minObs) {
          const den = Math.sqrt(vv[a]! * vv[k * K + j]!);
          r = den > 0 ? cov[a]! / den : 0;
          r = r > 1 ? 1 : r < -1 ? -1 : r;
        }
        m[a] = r;
        m[k * K + j] = r;
      }
    }
    return m;
  };

  let prevClose = NaN;
  for (;;) {
    // next bar time = the smallest head across the pairs (skipping duplicates / out-of-order rows)
    let t = Infinity;
    for (let j = 0; j < K; j++) {
      const s = series[j]!;
      let p = ptr[j]!;
      while (p < s.length && !(s[p]!.t > lastSeen[j]!)) p++;
      ptr[j] = p;
      if (p < s.length && s[p]!.t < t) t = s[p]!.t;
    }
    if (t === Infinity) break;
    const closeT = t + H;
    if (Number.isFinite(prevClose) && dayOf(closeT) > dayOf(prevClose)) {
      stamps.push(prevClose);
      mats.push(rho());
    }
    let np = 0;
    for (let j = 0; j < K; j++) {
      const s = series[j]!;
      const p = ptr[j]!;
      if (p >= s.length || s[p]!.t !== t) continue;
      const c = s[p]!.c;
      lastSeen[j] = t;
      ptr[j] = p + 1;
      if (!(c > 0) || !Number.isFinite(c)) {
        lastT[j] = NaN;
        continue;
      }
      if (lastT[j] === t - H) {
        present[np] = j;
        ret[np] = Math.log(c / lastC[j]!);
        np++;
      }
      lastT[j] = t;
      lastC[j] = c;
    }
    for (let a = 0; a < np; a++) {
      const j = present[a]!;
      const rj = ret[a]!;
      const d = j * K + j;
      vv[d] = lambda * vv[d]! + rj * rj;
      nObs[d] = nObs[d]! + 1;
      for (let b = a + 1; b < np; b++) {
        const k = present[b]!;
        const rk = ret[b]!;
        const lo = j < k ? j : k;
        const hi = j < k ? k : j;
        const up = lo * K + hi;
        cov[up] = lambda * cov[up]! + rj * rk;
        nObs[up] = nObs[up]! + 1;
        const jk = j * K + k;
        const kj = k * K + j;
        vv[jk] = lambda * vv[jk]! + rj * rj;
        vv[kj] = lambda * vv[kj]! + rk * rk;
      }
    }
    prevClose = closeT;
  }
  let now: Float32Array | null = null;
  if (Number.isFinite(prevClose)) {
    now = rho();
    // the last bar closed exactly on the rollover: that day is complete (a longer history would snapshot it too)
    if ((((prevClose - ROLL) % DAY) + DAY) % DAY === 0) {
      stamps.push(prevClose);
      mats.push(now);
    }
  }
  return { ids: [...ids], idx, t: Float64Array.from(stamps), mats, now };
}

/** ρ as known at time t: the last snapshot stamped ≤ t (null if none yet). */
export function corrAt(book: CorrBook, t: number): Float32Array | null {
  const ts = book.t;
  let lo = 0;
  let hi = ts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best < 0 ? null : (book.mats[best] ?? null);
}

export interface HeatPos {
  pair: string;
  side: 1 | -1;
  riskPct: number;
}

/** ρ between two pairs: 1 for the same pair, 0 when either is unknown or there is no matrix. */
function rhoOf(a: string, b: string, idx: Record<string, number>, m: Float32Array | null): number {
  if (a === b) return 1;
  if (!m) return 0;
  const i = idx[a];
  const j = idx[b];
  if (i === undefined || j === undefined) return 0;
  const K = Math.round(Math.sqrt(m.length));
  if (i >= K || j >= K) return 0;
  const r = m[i * K + j]!;
  return Number.isFinite(r) ? r : 0;
}

const riskOf = (p: HeatPos) => (Number.isFinite(p.riskPct) ? p.riskPct : 0);

/** Σ_j Σ_k s_j r_j ρ_jk s_k r_k (may be a hair below 0 on a non-PSD matrix). */
function quad(pos: ReadonlyArray<HeatPos>, idx: Record<string, number>, m: Float32Array | null): number {
  let sum = 0;
  for (let j = 0; j < pos.length; j++) {
    const pj = pos[j]!;
    const xj = pj.side * riskOf(pj);
    sum += xj * xj;
    for (let k = j + 1; k < pos.length; k++) {
      const pk = pos[k]!;
      sum += 2 * xj * pk.side * riskOf(pk) * rhoOf(pj.pair, pk.pair, idx, m);
    }
  }
  return sum;
}

/** Combined stop risk of the open positions, % of the account. Never NaN. */
export function heatPct(pos: ReadonlyArray<HeatPos>, book: Pick<CorrBook, 'idx'>, m: Float32Array | null): number {
  const q = quad(pos, book.idx, m);
  return q > 0 ? Math.sqrt(q) : 0;
}

/**
 * Largest risk % x ≥ 0 a new position may take so the heat stays ≤ capPct. With A = heat², B = Σ_j s_c s_j r_j ρ_cj:
 * heat² after = A + 2Bx + x² → x = −B + sqrt(B² + cap² − A). A hedge (opposite side of a correlated pair) makes B < 0 → more room.
 */
export function maxRiskUnder(
  pos: ReadonlyArray<HeatPos>,
  cand: { pair: string; side: 1 | -1 },
  capPct: number,
  book: Pick<CorrBook, 'idx'>,
  m: Float32Array | null,
): number {
  if (!(capPct > 0)) return 0;
  const q = quad(pos, book.idx, m);
  const A = q > 0 ? q : 0;
  let B = 0;
  for (const p of pos) B += cand.side * p.side * riskOf(p) * rhoOf(cand.pair, p.pair, book.idx, m);
  const rad = B * B + capPct * capPct - A;
  if (!(rad >= 0)) return 0;
  const x = -B + Math.sqrt(rad);
  return x > 0 ? x : 0;
}

/** The open position the candidate moves WITH most (signed ρ, its side × theirs), for "moves with your open AUDUSD trade (ρ 0.86)". */
export function topCorrelated(
  pos: ReadonlyArray<HeatPos>,
  cand: { pair: string; side: 1 | -1 },
  book: Pick<CorrBook, 'idx'>,
  m: Float32Array | null,
): { pair: string; rho: number } | null {
  let best: { pair: string; rho: number } | null = null;
  for (const p of pos) {
    const r = cand.side * p.side * rhoOf(cand.pair, p.pair, book.idx, m);
    if (r > 0.5 && (!best || r > best.rho)) best = { pair: p.pair, rho: r };
  }
  return best ? { pair: best.pair, rho: Math.round(best.rho * 100) / 100 } : null;
}

/** The latest matrix rounded to 2 dp, for the dashboard. */
export function roundedMatrix(book: CorrBook): { ids: string[]; rho: number[][] } | null {
  const m = book.now;
  if (!m) return null;
  const K = book.ids.length;
  const rho: number[][] = [];
  for (let j = 0; j < K; j++) {
    const row: number[] = [];
    for (let k = 0; k < K; k++) row.push(Math.round(m[j * K + k]! * 100) / 100 || 0);
    rho.push(row);
  }
  return { ids: [...book.ids], rho };
}

export interface HeatGrade {
  active: boolean;
  why: string;
}

/**
 * v17: does the cap earn its place? Only if the plain bot's biggest drop on the unseen weeks was 5%+ and the cap cut it
 * by 15%+ without costing more than 5% of the return per unit of drop (total % ÷ max drop). Pure.
 */
export function gradeHeat(heated: { totalPct: number; maxDdPct: number } | null, plain: { totalPct: number; maxDdPct: number } | null): HeatGrade {
  if (!heated || !plain) return { active: false, why: 'not graded yet' };
  const calmar = (x: { totalPct: number; maxDdPct: number }) => x.totalPct / Math.max(1, x.maxDdPct);
  const cb = calmar(plain);
  const ch = calmar(heated);
  const words = `with the cap ${heated.totalPct > 0 ? '+' : ''}${heated.totalPct}% / biggest drop ${heated.maxDdPct}%, without ${plain.totalPct > 0 ? '+' : ''}${plain.totalPct}% / ${plain.maxDdPct}% on the unseen weeks`;
  if (plain.maxDdPct < 5) return { active: false, why: `off: the bot's drops are already small (${plain.maxDdPct}%) — ${words}` };
  if (heated.maxDdPct > 0.85 * plain.maxDdPct) return { active: false, why: `off: it didn't cut the biggest drop by 15%+ — ${words}` };
  if (ch < cb - 0.05 * Math.abs(cb)) return { active: false, why: `off: it cost too much return for the smaller drop — ${words}` };
  return { active: true, why: `on: ${words}` };
}
