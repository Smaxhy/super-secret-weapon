/**
 * v27.4 (owner: "implement Monte Carlo simulations; focus on the ones that can give an edge; test certain strategies on
 * certain markets, results might vary"). Pure, seeded, cheap.
 *
 * `monteCarlo(rs)` reshuffles a strategy's own trade results (R) thousands of ways — the same trades in another order, some
 * drawn twice, some not at all — and reads off how sure the profit is:
 *  - pProfit: share of the reshuffled records that still made money (≈ how likely the edge is not just these few trades)
 *  - p5AvgR / p50AvgR: the 5th / 50th percentile of R a trade (the "bad luck" and the "typical" result)
 *  - ddR95: the 95th percentile of the deepest drop in R over the next `horizon` trades (what a bad stretch costs)
 *  - streak95: the 95th percentile of the longest losing run in those trades
 * A drop of D R at r% risk a trade costs about 1 − (1 − r/100)^D of the account (`ddPctAt`).
 *
 * `marketCells` splits one strategy × chart's trades by market (first 70% / unseen 30%, Monte Carlo on the unseen part) and
 * by New York session, so the Strategies page can show every market on its own and the bot can trade a strategy only on
 * the markets where it proved itself (`cellPass`).
 */
import { rStats } from './engine';
import type { Trade } from './types';
import { nyMinOfDay } from './ny-time';

export interface McResult {
  n: number;
  pProfit: number;
  p5AvgR: number;
  p50AvgR: number;
  ddR95: number;
  streak95: number;
  /** v27.5: Kelly risk per trade (% of the account) from the win rate and win / loss size; ≤ 0 = no edge to size */
  kellyPct: number;
}

export const MC = { sims: 400, horizon: 100 };

/** deterministic 32-bit RNG (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
export const seedOf = (s: string) => {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16_777_619);
  return h >>> 0;
};

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Bootstrap a list of trade results (R). Fewer than 5 trades → null. Pure. */
export function monteCarlo(rs: readonly number[], seed = 1, o: { sims?: number; horizon?: number } = {}): McResult | null {
  const n = rs.length;
  if (n < 5) return null;
  const sims = o.sims ?? MC.sims;
  const horizon = o.horizon ?? MC.horizon;
  const rand = rng(seed);
  const avgs: number[] = [];
  const dds: number[] = [];
  const streaks: number[] = [];
  let wins = 0;
  for (let k = 0; k < sims; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rs[(rand() * n) | 0]!;
    if (sum > 0) wins++;
    avgs.push(sum / n);
    let eq = 0;
    let peak = 0;
    let dd = 0;
    let run = 0;
    let worst = 0;
    for (let i = 0; i < horizon; i++) {
      const r = rs[(rand() * n) | 0]!;
      eq += r;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
      run = r < 0 ? run + 1 : 0;
      if (run > worst) worst = run;
    }
    dds.push(dd);
    streaks.push(worst);
  }
  const w = rs.filter((r) => r > 0);
  const l = rs.filter((r) => r <= 0);
  const avgW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  const avgL = l.length ? -l.reduce((a, b) => a + b, 0) / l.length : 0;
  const pW = w.length / n;
  const kelly = !w.length ? 0 : !(avgL > 0) ? 1 : pW - (1 - pW) / (avgW / avgL);
  return { n, kellyPct: Math.round(Math.max(0, kelly) * 1000) / 10, pProfit: r2(wins / sims), p5AvgR: r2(pct(avgs, 0.05)), p50AvgR: r2(pct(avgs, 0.5)), ddR95: r2(pct(dds, 0.95)), streak95: pct(streaks, 0.95) };
}

/** Share of the account a drop of `ddR` R costs at `riskPct`% risk a trade (compounded). Pure. */
export const ddPctAt = (ddR: number, riskPct: number) => Math.round((1 - Math.pow(1 - riskPct / 100, ddR)) * 1000) / 10;

/** New York session of a time: 0 Asia (18:00–03:00 NY), 1 London (03:00–08:00), 2 NY morning (08:00–12:00, the open),
 * 3 NY afternoon (12:00–18:00). */
export function sessionOf(t: number): 0 | 1 | 2 | 3 {
  const m = nyMinOfDay(t);
  if (m >= 1080 || m < 180) return 0;
  if (m < 480) return 1;
  if (m < 720) return 2;
  return 3;
}
export const SESSIONS = ['Asia', 'London', 'NY open', 'NY afternoon'] as const;

/** Trades per New York session: [n, avg R] each (by entry time). Pure. */
export function bySession(done: readonly Trade[]): Array<[number, number]> {
  const acc: Array<[number, number]> = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (const t of done) {
    const s = sessionOf(t.entryT);
    acc[s]![0]++;
    acc[s]![1] += t.r;
  }
  return acc.map(([n, sum]) => [n, n ? r2(sum / n) : 0]);
}

/** One strategy × chart on one market. */
export interface MarketCell {
  pair: string;
  /** first 70% (finished before the line) */
  inN: number;
  inAvgR: number;
  /** unseen 30% (entered after the line) */
  n: number;
  avgR: number;
  pf: number | null;
  winPct: number;
  /** Monte Carlo of the unseen trades: P(profit), 5th-percentile R a trade (null under 5 trades) */
  mcP: number | null;
  mcP5: number | null;
  /** all trades by New York session: [n, avg R] for Asia / London / NY open / NY afternoon */
  sess: Array<[number, number]>;
}

/** Per-market cells of one row's finished trades (purged split like statsOf). Pure. */
export function marketCells(done: readonly Trade[], oosFrom: number, key: string): MarketCell[] {
  const byPair = new Map<string, Trade[]>();
  for (const t of done) {
    if (t.reason === 'open') continue;
    const a = byPair.get(t.pair) ?? [];
    a.push(t);
    byPair.set(t.pair, a);
  }
  const out: MarketCell[] = [];
  for (const [pair, ts] of byPair) {
    const inS = rStats(ts.filter((t) => t.exitT < oosFrom));
    const outT = ts.filter((t) => t.entryT >= oosFrom);
    const o = rStats(outT);
    const mc = monteCarlo(outT.map((t) => t.r), seedOf(`${key}:${pair}`), { sims: 300, horizon: 50 });
    out.push({ pair, inN: inS.n, inAvgR: inS.avgR, n: o.n, avgR: o.avgR, pf: o.pf, winPct: o.winPct, mcP: mc?.pProfit ?? null, mcP5: mc?.p5AvgR ?? null, sess: bySession(ts) });
  }
  return out.sort((a, b) => b.n * b.avgR - a.n * a.avgR);
}

/**
 * v27.4: the bar a strategy must clear on ONE market to trade there on its own record (its pooled row may fail). Stricter
 * than the row floor: every market × strategy × chart combination is a separate try (~1,800 of them), so some will look
 * good by luck — 30+ unseen trades at 0.1R+ and PF 1.3+, profitable before the 70/30 line too (20+ trades there), and the
 * Monte Carlo says ≥ 95% of reshuffles still made money.
 */
export const MARKET_EDGE = { minN: 30, minAvgR: 0.1, minPf: 1.3, minInN: 20, minMcP: 0.95 };
export function cellPass(c: MarketCell | undefined | null): boolean {
  if (!c) return false;
  const e = MARKET_EDGE;
  return c.n >= e.minN && c.avgR >= e.minAvgR && (c.pf ?? 99) >= e.minPf && c.inN >= e.minInN && c.inAvgR > 0 && (c.mcP ?? 0) >= e.minMcP;
}
