/**
 * "Where's the money?" (v11.17, owner: 14 h without a buy; the score-gap check showed every near-miss LOST — so is there
 * ANY kind of coin the bot sees that makes money, or do the exits turn everything into a loss?). Read-only, no AI, no RPC.
 *
 * One pool of coins = everything the bot looked at and we know the result of: real closed PAPER trades, shadow trades
 * (coins it refused / nearly bought, traded virtually with the live exits) and the outcome tracker (every other coin it
 * checked, replayed 45 min later through the live exits — and since v11.17 through other exit variants too). Every row
 * carries the SAME flat entry features the evaluator saw (ai-coach flattenFeatures), the % after costs, and the peak
 * multiple it reached — so we can split the pool any way we like and ask "did this kind of coin pay?".
 *
 *   dimensions   = market cap, age, hour, weekday, score vs bar, buyers, buy pressure, run, off the high, proven wallets,
 *                  KOLs, Telegram, holders, fees, curve %, meme score, …  → per band: n, win %, avg %, median, SOL at
 *                  1 SOL each, how many reached 1.15× (break-even) / 1.5× / 2×, and the "perfect exit" ceiling
 *   verdict      = per strategy: PICKS are the problem (most coins never reach break-even) vs EXITS are the problem
 *                  (coins ran, the exits still lost) — in plain words
 *   best / worst = the groups (any dimension) that paid / bled, shrunk toward 0 for small n so flukes don't win
 *   combos       = pairs of groups (two different dimensions) that paid together
 *   exits        = live exits vs the alt variants vs the perfect exit, per strategy (outcome rows with `alt`)
 *   week         = hour × weekday heat (UTC cells; the dashboard shifts them to the viewer's clock)
 *   gotAway      = the biggest runners it skipped, with why
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { prisma } from '../lib/prisma';
import { flattenFeatures } from './ai-coach';
import type { OutcomeResult } from './outcome-tracker';
import type { ShadowResult } from './shadow-trades';
import { scoreOnly } from '../tools/score-gap';

export type MoneySource = 'real' | 'shadow' | 'outcome';
export type MoneyScope = 'all' | 'skipped' | 'real' | 'filtered';

export interface MoneyRow {
  mint: string;
  symbol: string;
  strategy: string;
  atMs: number;
  /** % after every cost (live exits for skipped coins, the real result for bought ones). */
  pnlPct: number;
  peakX: number;
  source: MoneySource;
  score: number | null;
  bar: number | null;
  /** Why it wasn't bought ('bought' for real trades). */
  why: string;
  /** Every hard rule passed (bought, refused by the trader, or held back only by the score / a Sniper check) — "inside your filters". */
  rulesOk: boolean;
  flat: Record<string, number>;
  /** Other exit variants on the same coin (id → % after costs), outcome rows since v11.17 only. */
  alt?: Record<string, number>;
}

export interface GroupStat {
  label: string;
  n: number;
  winPct: number;
  avgPct: number;
  medianPct: number;
  /** Average with each coin capped at +300% — rankings and verdicts use this one. */
  robustPct: number;
  /** Sum of results at 1 SOL per coin. */
  sol: number;
  /** Share that reached 1.15× (≈ break-even after costs) / 1.5× / 2× at some point. */
  reach115Pct: number;
  reach150Pct: number;
  reach200Pct: number;
  /** Avg % if every coin had been sold at its peak (capped at 10×), after ~7% costs. */
  perfectPct: number;
}

export interface Dimension {
  key: string;
  label: string;
  /** Short note for the UI: what the split means. */
  about: string;
  groups: GroupStat[];
  /** Rows with no value on this dimension. */
  unknown: number;
}

export interface RankedGroup extends GroupStat {
  dim: string;
  dimLabel: string;
  /** Robust avg (each coin capped at +300%) shrunk toward 0 by n/(n+20) — what the ranking sorts by. */
  rank: number;
}

export interface ComboStat extends GroupStat {
  a: { dim: string; dimLabel: string; label: string };
  b: { dim: string; dimLabel: string; label: string };
  rank: number;
}

export interface StrategyVerdict {
  strategy: string;
  n: number;
  real: number;
  avgPct: number;
  winPct: number;
  reach115Pct: number;
  reach150Pct: number;
  perfectPct: number;
  verdict: 'picks' | 'exits' | 'both' | 'working' | 'unclear';
  text: string;
}

export interface ExitCompare {
  strategy: string;
  n: number;
  live: number;
  alt: Record<string, number>;
  perfect: number;
}

export interface MoneyMap {
  at: number;
  hours: number;
  filter: { strategy: string | null; source: MoneyScope };
  rows: number;
  /** Rows with an impossible result (beyond their own peak / past 10×) — broken prices, left out. */
  dropped: number;
  bySource: Record<MoneySource, number>;
  overall: GroupStat | null;
  verdicts: StrategyVerdict[];
  best: RankedGroup[];
  worst: RankedGroup[];
  combos: ComboStat[];
  dimensions: Dimension[];
  exits: ExitCompare[];
  exitNames: Record<string, string>;
  /** 7 × 24 cells, UTC: n and avg per weekday (0 = Sunday) × hour. */
  week: Array<{ dow: number; hour: number; n: number; avgPct: number }>;
  gotAway: Array<{ symbol: string; mint: string; strategy: string; atMs: number; peakX: number; pnlPct: number; why: string; source: MoneySource }>;
  note: string;
}

/** Costs a round trip eats (≈ paper fees + slippage at the usual size). */
const COST_PCT = 7;
/** A single coin counts at most this much in the rankings / verdicts (a 4× is real; a +80,000% fake print is not). */
const RANK_CAP_PCT = 300;
/** Results beyond this are broken prices (a 10× is the most any exit here could bank). */
const MAX_PNL_PCT = 900;
/** A group needs this many coins to be ranked. */
const MIN_N = 15;
const SHRINK = 20;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Pure: is this row's result physically possible? A result can't beat the coin's own peak (minus nothing — costs only
 * lower it), can't lose more than everything, and anything past 10× is a fake print (sandwich / wrong pool). Such rows
 * would swing every average by hundreds of points, so they are dropped before anything is counted.
 */
export function saneRow(r: Pick<MoneyRow, 'pnlPct' | 'peakX'>): boolean {
  if (!Number.isFinite(r.pnlPct) || !Number.isFinite(r.peakX)) return false;
  if (r.pnlPct < -100 || r.pnlPct > MAX_PNL_PCT) return false;
  if (r.peakX > 1000) return false;
  // +2 pts of slack: the peak is a settled level, a fill can print a hair above it
  return r.pnlPct <= (Math.max(1, r.peakX) - 1) * 100 + 2;
}

/** Pure: average with each coin capped at RANK_CAP_PCT — what rankings and verdicts use. */
const robustAvg = (rs: readonly MoneyRow[]) => (rs.length ? rs.reduce((a, r) => a + Math.min(RANK_CAP_PCT, r.pnlPct), 0) / rs.length : 0);

/** Pure: label of `v` in ordered `edges` (label i = below edges[i]; last label = above the last edge). */
export function band(v: number, edges: readonly number[], labels: readonly string[]): string {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]!) return labels[i]!;
  return labels[edges.length]!;
}

interface DimDef {
  key: string;
  label: string;
  about: string;
  of: (r: MoneyRow) => string | null;
  /** Display order of the labels (bands not listed sort after, alphabetically). */
  order?: readonly string[];
}

const num = (r: MoneyRow, k: string): number | null => {
  const v = r.flat[k];
  return v === undefined || !Number.isFinite(v) ? null : v;
};
const bandOf = (r: MoneyRow, k: string, edges: readonly number[], labels: readonly string[]): string | null => {
  const v = num(r, k);
  return v === null ? null : band(v, edges, labels);
};

const HOURS = ['00–04', '04–08', '08–12', '12–16', '16–20', '20–24'].map((x) => `${x} UTC`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCORE = ['over the bar', '0–10 under', '10–20 under', '20+ under'];

export const DIMENSIONS: readonly DimDef[] = [
  { key: 'strategy', label: 'Strategy', about: 'Which strategy looked at the coin.', of: (r) => r.strategy },
  { key: 'mc', label: 'Market cap', about: 'Market cap in USD when the bot checked it.', of: (r) => bandOf(r, 'entry.mcUsd', [10e3, 25e3, 50e3, 150e3, 500e3], ['< $10k', '$10–25k', '$25–50k', '$50–150k', '$150–500k', '> $500k']), order: ['< $10k', '$10–25k', '$25–50k', '$50–150k', '$150–500k', '> $500k'] },
  { key: 'age', label: 'Coin age', about: 'Minutes since launch when the bot checked it.', of: (r) => bandOf(r, 'entry.ageMin', [5, 30, 120, 720], ['< 5 min', '5–30 min', '30 min – 2 h', '2–12 h', '> 12 h']), order: ['< 5 min', '5–30 min', '30 min – 2 h', '2–12 h', '> 12 h'] },
  { key: 'hour', label: 'Time of day', about: 'UTC hour of the check (the week heatmap below is in your own time).', of: (r) => bandOf(r, 'entry.hourUtc', [4, 8, 12, 16, 20], HOURS), order: HOURS },
  { key: 'dow', label: 'Weekday', about: 'Day of the week (UTC).', of: (r) => { const d = num(r, 'entry.dowUtc'); return d === null ? null : DAYS[Math.round(d)] ?? null; }, order: [...DAYS.slice(1), DAYS[0]!] },
  { key: 'score', label: 'Score vs bar', about: 'How far the score was from the buy bar. Bought coins count as over the bar.', of: (r) => (r.source === 'real' ? SCORE[0]! : r.score === null || r.bar === null ? null : band(r.bar - r.score, [0.000001, 10, 20], SCORE)), order: SCORE },
  { key: 'buyers', label: 'Active wallets', about: 'Wallets trading the coin in the last 5 minutes.', of: (r) => bandOf(r, 'crowd.activeWallets5m', [10, 20, 40, 80], ['< 10', '10–20', '20–40', '40–80', '80+']), order: ['< 10', '10–20', '20–40', '40–80', '80+'] },
  { key: 'pressure', label: 'Buy pressure', about: "Buyers' share of the SOL traded in the last 30 s.", of: (r) => bandOf(r, 'pressure.buySharePct', [45, 55, 65, 80], ['sellers (< 45%)', 'even (45–55%)', 'buyers (55–65%)', 'strong (65–80%)', 'one-way (80%+)']), order: ['sellers (< 45%)', 'even (45–55%)', 'buyers (55–65%)', 'strong (65–80%)', 'one-way (80%+)'] },
  { key: 'run', label: 'Run (3 min)', about: 'Price change over the 3 minutes before the check.', of: (r) => bandOf(r, 'shape.run3m', [-10, 0, 15, 40], ['dropping (< −10%)', 'dipping (−10–0%)', 'calm (0–15%)', 'running (15–40%)', 'spiking (40%+)']), order: ['dropping (< −10%)', 'dipping (−10–0%)', 'calm (0–15%)', 'running (15–40%)', 'spiking (40%+)'] },
  { key: 'offHigh', label: 'Off the high', about: 'How far under the 10-minute high the price was.', of: (r) => bandOf(r, 'shape.offHigh10m', [3, 10, 25], ['at the top (< 3%)', '3–10% under', '10–25% under', '25%+ under']), order: ['at the top (< 3%)', '3–10% under', '10–25% under', '25%+ under'] },
  { key: 'proven', label: 'Proven wallets', about: 'Share of the last 5 minutes of buying from wallets with a winning record.', of: (r) => bandOf(r, 'wallets.provenSolPct', [0.5, 20, 40], ['none', '< 20%', '20–40%', '40%+']), order: ['none', '< 20%', '20–40%', '40%+'] },
  { key: 'kols', label: 'KOLs inside', about: 'Tracked KOL wallets holding the coin.', of: (r) => bandOf(r, 'entry.kols', [1, 2], ['0', '1', '2+']), order: ['0', '1', '2+'] },
  { key: 'telegram', label: 'Telegram link', about: 'Research: a Telegram link made graduation ~9× likelier.', of: (r) => { const v = num(r, 'launch.telegram'); return v === null ? null : v >= 1 ? 'has Telegram' : 'no Telegram'; }, order: ['has Telegram', 'no Telegram'] },
  { key: 'holders', label: 'Holders', about: 'Holders when checked.', of: (r) => bandOf(r, 'market.holders', [50, 150, 500, 1500], ['< 50', '50–150', '150–500', '500–1,500', '1,500+']), order: ['< 50', '50–150', '150–500', '500–1,500', '1,500+'] },
  { key: 'fees', label: 'Fees paid', about: 'Total pump.fun fees traders paid (SOL) — a proxy for real volume.', of: (r) => bandOf(r, 'market.totalFeesSol', [3, 9, 30, 100], ['< 3 SOL', '3–9 SOL', '9–30 SOL', '30–100 SOL', '100+ SOL']), order: ['< 3 SOL', '3–9 SOL', '9–30 SOL', '30–100 SOL', '100+ SOL'] },
  { key: 'stage', label: 'Curve stage', about: 'Bonding-curve progress, or migrated to PumpSwap.', of: (r) => { if ((num(r, 'market.onAmm') ?? 0) >= 1 || (num(r, 'market.complete') ?? 0) >= 1) return 'migrated'; return bandOf(r, 'market.bondingCurvePct', [30, 60, 85], ['curve < 30%', 'curve 30–60%', 'curve 60–85%', 'curve 85%+']); }, order: ['curve < 30%', 'curve 30–60%', 'curve 60–85%', 'curve 85%+', 'migrated'] },
  { key: 'meme', label: 'AI meme score', about: 'The meme reader’s 0–10 read of the name / story (only coins it read).', of: (r) => bandOf(r, 'meme.score', [4, 6, 8], ['weak (< 4)', 'ok (4–6)', 'good (6–8)', 'strong (8+)']), order: ['weak (< 4)', 'ok (4–6)', 'good (6–8)', 'strong (8+)'] },
  { key: 'deployer', label: 'Deployer record', about: 'Has this coin’s creator graduated coins before? Elite = 2+ graduations and a 20%+ bond rate.', of: (r) => { const g = num(r, 'deployer.graduated'); const l = num(r, 'deployer.launches'); if (g === null && l === null) return null; const gg = g ?? 0, ll = Math.max(1, l ?? 0); if (gg >= 2 && gg / ll >= 0.2) return 'elite (repeat graduator)'; return gg >= 1 ? 'graduated before' : ll >= 3 ? 'serial, none graduated' : 'new / few launches'; }, order: ['elite (repeat graduator)', 'graduated before', 'new / few launches', 'serial, none graduated'] },
  { key: 'devHold', label: 'Dev holding', about: 'How much of the supply the creator still held when checked. Research (3-day sample): graduates whose dev had sold out did WORSE.', of: (r) => bandOf(r, 'market.devHoldingPct', [1, 5, 10], ['dev sold out (< 1%)', 'dev holds 1–5%', 'dev holds 5–10%', 'dev holds 10%+']), order: ['dev sold out (< 1%)', 'dev holds 1–5%', 'dev holds 5–10%', 'dev holds 10%+'] },
  { key: 'devSold', label: 'Dev selling', about: 'Share of the creator’s bag already sold when checked.', of: (r) => { const v = num(r, 'market.devSoldFraction'); return v === null ? null : band(v * 100, [1, 50, 99], ['dev sold nothing', 'dev sold < 50%', 'dev sold 50–99%', 'dev sold everything']); }, order: ['dev sold nothing', 'dev sold < 50%', 'dev sold 50–99%', 'dev sold everything'] },
];

/** Pure: stats of one group of rows. */
export function statsOf(label: string, rs: readonly MoneyRow[]): GroupStat {
  const xs = rs.map((r) => r.pnlPct).sort((a, b) => a - b);
  const n = xs.length;
  const avg = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const reach = (m: number) => (n ? Math.round((rs.filter((r) => r.peakX >= m).length / n) * 100) : 0);
  return {
    label,
    n,
    winPct: n ? Math.round((xs.filter((x) => x > 0).length / n) * 100) : 0,
    avgPct: r1(avg),
    medianPct: r1(n ? xs[Math.floor(n / 2)]! : 0),
    robustPct: r1(robustAvg(rs)),
    sol: r2(xs.reduce((a, b) => a + b / 100, 0)),
    reach115Pct: reach(1.15),
    reach150Pct: reach(1.5),
    reach200Pct: reach(2),
    perfectPct: r1(n ? rs.reduce((a, r) => a + (Math.min(10, Math.max(1, r.peakX)) - 1) * 100 - COST_PCT, 0) / n : 0),
  };
}

const shrink = (avg: number, n: number) => r1((avg * n) / (n + SHRINK));

/** Pure: one dimension split. */
export function splitBy(def: DimDef, rows: readonly MoneyRow[]): Dimension {
  const buckets = new Map<string, MoneyRow[]>();
  let unknown = 0;
  for (const r of rows) {
    const l = def.of(r);
    if (l === null) unknown++;
    else buckets.set(l, [...(buckets.get(l) ?? []), r]);
  }
  const order = def.order ?? [];
  const groups = [...buckets]
    .map(([label, rs]) => statsOf(label, rs))
    .sort((a, b) => {
      const ia = order.indexOf(a.label);
      const ib = order.indexOf(b.label);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      return b.n - a.n;
    });
  return { key: def.key, label: def.label, about: def.about, groups, unknown };
}

/** Pure: per strategy — are the picks or the exits the problem? */
export function verdictFor(strategy: string, rs: readonly MoneyRow[]): StrategyVerdict {
  const s = statsOf(strategy, rs);
  const real = rs.filter((r) => r.source === 'real').length;
  let verdict: StrategyVerdict['verdict'] = 'unclear';
  let text = `Only ${s.n} coins — not enough to judge (need ${MIN_N * 2}).`;
  if (s.n >= MIN_N * 2) {
    if (s.robustPct > 0 && s.reach115Pct >= 25) {
      verdict = 'working';
      text = `Working: these coins made ${s.robustPct >= 0 ? '+' : ''}${s.robustPct}% on average with the current exits (${s.winPct}% won, median ${s.medianPct}%).`;
    } else if (s.reach150Pct >= 30) {
      verdict = s.reach115Pct < 50 ? 'both' : 'exits';
      text = `Exits are the problem: ${s.reach150Pct}% of these coins reached 1.5× after the check, yet the exits ended ${s.robustPct}% on average. Selling at the peak would have made ${s.perfectPct >= 0 ? '+' : ''}${s.perfectPct}%.${verdict === 'both' ? ` Picks too: ${100 - s.reach115Pct}% never reached break-even.` : ''}`;
    } else if (s.reach115Pct < 40) {
      verdict = 'picks';
      text = `Picks are the problem: ${100 - s.reach115Pct}% of these coins never even reached 1.15× (break-even after costs). No exit rule fixes a coin that never goes up — the filters are letting the wrong coins through.`;
    } else {
      verdict = 'both';
      text = `A bit of both: ${s.reach115Pct}% reached break-even and ${s.reach150Pct}% reached 1.5×, but the exits still ended ${s.robustPct}% on average (perfect exits: ${s.perfectPct >= 0 ? '+' : ''}${s.perfectPct}%).`;
    }
  }
  return { strategy, n: s.n, real, avgPct: s.robustPct, winPct: s.winPct, reach115Pct: s.reach115Pct, reach150Pct: s.reach150Pct, perfectPct: s.perfectPct, verdict, text };
}

/** Pure: the whole map from the rows. */
export function buildMoneyMap(rows: readonly MoneyRow[], opts: { hours: number; strategy?: string | null; source?: MoneyScope; exitNames?: Record<string, string>; now?: number } = { hours: 48 }): MoneyMap {
  const now = opts.now ?? Date.now();
  const source = opts.source ?? 'all';
  const inScope = (r: MoneyRow) => (source === 'all' ? true : source === 'real' ? r.source === 'real' : source === 'skipped' ? r.source !== 'real' : r.rulesOk);
  const scoped = rows.filter((r) => (!opts.strategy || r.strategy === opts.strategy) && inScope(r));
  const all = scoped.filter(saneRow);
  const dropped = scoped.length - all.length;
  const bySource: Record<MoneySource, number> = { real: 0, shadow: 0, outcome: 0 };
  for (const r of all) bySource[r.source]++;
  const dims = DIMENSIONS.filter((d) => d.key !== 'strategy' || !opts.strategy).map((d) => splitBy(d, all));
  // Ranked groups: any dimension but strategy (the verdicts cover that), ≥ MIN_N coins, shrunk toward 0.
  const ranked: RankedGroup[] = dims
    .filter((d) => d.key !== 'strategy')
    .flatMap((d) => d.groups.filter((g) => g.n >= MIN_N).map((g) => ({ ...g, dim: d.key, dimLabel: d.label, rank: shrink(g.robustPct, g.n) })));
  const best = [...ranked].sort((a, b) => b.rank - a.rank).slice(0, 8);
  const worst = [...ranked].sort((a, b) => a.rank - b.rank).slice(0, 8);
  // Combos: pairs of the 12 best single groups from different dimensions.
  const defs = new Map(DIMENSIONS.map((d) => [d.key, d]));
  const top = [...ranked].sort((a, b) => b.rank - a.rank).slice(0, 12);
  const combos: ComboStat[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!;
      const b = top[j]!;
      if (a.dim === b.dim) continue;
      const da = defs.get(a.dim)!;
      const db = defs.get(b.dim)!;
      const rs = all.filter((r) => da.of(r) === a.label && db.of(r) === b.label);
      if (rs.length < MIN_N) continue;
      const s = statsOf(`${a.label} + ${b.label}`, rs);
      combos.push({ ...s, a: { dim: a.dim, dimLabel: a.dimLabel, label: a.label }, b: { dim: b.dim, dimLabel: b.dimLabel, label: b.label }, rank: shrink(s.robustPct, s.n) });
    }
  }
  combos.sort((x, y) => y.rank - x.rank);
  // Verdicts per strategy.
  const strategies = [...new Set(all.map((r) => r.strategy))];
  const verdicts = strategies.map((s) => verdictFor(s, all.filter((r) => r.strategy === s))).sort((a, b) => b.n - a.n);
  // Exits: outcome rows carrying alt results.
  const withAlt = all.filter((r) => r.alt && Object.keys(r.alt).length);
  const altIds = [...new Set(withAlt.flatMap((r) => Object.keys(r.alt!)))];
  const exits: ExitCompare[] = [...new Set(withAlt.map((r) => r.strategy))]
    .map((s) => {
      const rs = withAlt.filter((r) => r.strategy === s);
      const avg = (f: (r: MoneyRow) => number) => r1(rs.reduce((a, r) => a + f(r), 0) / rs.length);
      const cap = (x: number) => Math.min(RANK_CAP_PCT, x);
      return { strategy: s, n: rs.length, live: avg((r) => cap(r.pnlPct)), alt: Object.fromEntries(altIds.map((id) => [id, avg((r) => cap(r.alt![id] ?? r.pnlPct))])), perfect: avg((r) => (Math.min(10, Math.max(1, r.peakX)) - 1) * 100 - COST_PCT) };
    })
    .sort((a, b) => b.n - a.n);
  // Week heat (UTC cells).
  const cells = new Map<string, { n: number; sum: number }>();
  for (const r of all) {
    const d = num(r, 'entry.dowUtc');
    const h = num(r, 'entry.hourUtc');
    if (d === null || h === null) continue;
    const k = `${Math.round(d)}:${Math.round(h)}`;
    const c = cells.get(k) ?? { n: 0, sum: 0 };
    c.n++;
    c.sum += Math.min(RANK_CAP_PCT, r.pnlPct);
    cells.set(k, c);
  }
  const week = [...cells].map(([k, c]) => { const [d, h] = k.split(':').map(Number); return { dow: d!, hour: h!, n: c.n, avgPct: r1(c.sum / c.n) }; });
  // The ones that got away: biggest skipped runners.
  const gotAway = all
    .filter((r) => r.source !== 'real' && r.peakX >= 1.5)
    .sort((a, b) => b.peakX - a.peakX)
    .slice(0, 12)
    .map((r) => ({ symbol: r.symbol, mint: r.mint, strategy: r.strategy, atMs: r.atMs, peakX: r2(r.peakX), pnlPct: r.pnlPct, why: r.why.slice(0, 90), source: r.source }));
  return {
    at: now,
    hours: opts.hours,
    filter: { strategy: opts.strategy ?? null, source },
    rows: all.length,
    dropped,
    bySource,
    overall: all.length ? statsOf('all', all) : null,
    verdicts,
    best,
    worst,
    combos: combos.slice(0, 6),
    dimensions: dims,
    exits,
    exitNames: opts.exitNames ?? {},
    week,
    gotAway,
    note: (all.length < MIN_N * 2 ? 'fewer than 30 coins — wait for more data' : `${all.length.toLocaleString()} coins: ${bySource.real} bought, ${bySource.shadow + bySource.outcome} skipped and followed with the bot's own exits`) + (dropped ? ` · ${dropped} with a broken price left out` : ''),
  };
}

/** Rows from the three sources since `sinceMs` (Redis lists + closed PAPER trades). */
export async function loadMoneyRows(redis: Redis, sinceMs: number): Promise<MoneyRow[]> {
  const parse = <T,>(s: string): T | null => { try { return JSON.parse(s) as T; } catch { return null; } };
  const [outRaw, shRaw, ps] = await Promise.all([
    redis.lrange('outcome:res', 0, -1),
    redis.lrange('shadow:res', 0, -1),
    prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: new Date(sinceMs) } },
      orderBy: { openedAt: 'desc' },
      take: 3_000,
      select: { mint: true, strategy: true, sizeSol: true, realizedPnlSol: true, entryPriceSol: true, peakPriceSol: true, openedAt: true, entryContext: true, token: { select: { symbol: true, createdAt: true } }, evaluation: { select: { combinedScore: true, features: true } } },
    }),
  ]);
  const rows: MoneyRow[] = [];
  for (const raw of outRaw) {
    const o = parse<OutcomeResult>(raw);
    if (!o || typeof o.pnlPct !== 'number' || o.atMs < sinceMs) continue;
    rows.push({ mint: o.mint, symbol: o.symbol, strategy: o.strategy, atMs: o.atMs, pnlPct: o.pnlPct, peakX: o.peakX ?? 1, source: 'outcome', score: o.score ?? null, bar: o.bar ?? null, why: o.why ?? 'skipped', rulesOk: scoreOnly(String(o.why ?? '')) !== null, flat: { ...(o.flat ?? {}), 'entry.score': o.score }, ...(o.alt ? { alt: o.alt } : {}) });
  }
  for (const raw of shRaw) {
    const s = parse<ShadowResult & { flat?: Record<string, number> }>(raw);
    if (!s || typeof s.pnlPct !== 'number' || s.openedAtMs < sinceMs) continue;
    const flat = { ...(s.flat ?? {}) };
    // Older shadow rows carry the key numbers on the row itself.
    const put = (k: string, v: number | null | undefined) => { if (typeof v === 'number' && Number.isFinite(v) && flat[k] === undefined) flat[k] = v; };
    put('entry.mcUsd', s.mcUsd);
    put('entry.ageMin', s.ageMin);
    put('entry.kols', s.kols);
    put('shape.run3m', s.run3m);
    put('shape.offHigh10m', s.offHigh10m);
    put('entry.hourUtc', new Date(s.openedAtMs).getUTCHours());
    put('entry.dowUtc', new Date(s.openedAtMs).getUTCDay());
    put('entry.score', s.score);
    rows.push({ mint: s.mint, symbol: s.symbol, strategy: s.strategy, atMs: s.openedAtMs, pnlPct: s.pnlPct, peakX: s.peakX ?? 1, source: 'shadow', score: s.score ?? null, bar: s.bar ?? null, why: s.why ?? 'skipped', rulesOk: s.kind !== 'skipped' || scoreOnly(String(s.why ?? '')) !== null, flat });
  }
  for (const p of ps) {
    if (!(p.sizeSol > 0)) continue;
    const ec = (p.entryContext ?? {}) as { marketCapUsd?: number; kols?: number };
    rows.push({
      mint: p.mint,
      symbol: p.token?.symbol ?? '',
      strategy: p.strategy,
      atMs: p.openedAt.getTime(),
      pnlPct: r1((p.realizedPnlSol / p.sizeSol) * 100),
      peakX: p.entryPriceSol > 0 ? p.peakPriceSol / p.entryPriceSol : 1,
      source: 'real',
      score: p.evaluation?.combinedScore ?? null,
      bar: null,
      why: 'bought',
      rulesOk: true,
      flat: flattenFeatures(p.evaluation?.features, { score: p.evaluation?.combinedScore ?? null, kols: ec.kols ?? null, mcUsd: ec.marketCapUsd ?? null, ageMin: p.token ? (p.openedAt.getTime() - p.token.createdAt.getTime()) / 60_000 : null, hourUtc: p.openedAt.getUTCHours(), dowUtc: p.openedAt.getUTCDay() }),
    });
  }
  return rows.filter((r) => Number.isFinite(r.pnlPct) && Number.isFinite(r.atMs));
}

/** Names of the exit variants (lab config) for the UI. */
export function exitNames(): Record<string, string> {
  const lab = (getConfig().lab?.variants ?? DEFAULT_CONFIG.lab.variants) as Array<{ id: string; name: string }>;
  return Object.fromEntries(lab.map((v) => [v.id, v.name]));
}

const cache = new Map<string, { at: number; map: MoneyMap }>();

/** The map for the API (cached 2 min per filter). */
export async function moneyMap(redis: Redis, opts: { hours: number; strategy?: string | null; source?: MoneyScope }, now = Date.now()): Promise<MoneyMap> {
  const key = `${opts.hours}:${opts.strategy ?? ''}:${opts.source ?? 'all'}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < 120_000) return hit.map;
  const rows = await loadMoneyRows(redis, now - opts.hours * 3_600_000);
  const map = buildMoneyMap(rows, { ...opts, exitNames: exitNames(), now });
  cache.set(key, { at: now, map });
  if (cache.size > 40) for (const [k, v] of cache) if (now - v.at > 120_000) cache.delete(k);
  return map;
}
