/**
 * Loss autopsy (owner: "the bot keeps losing money nonstop — scan what keeps going wrong and learn
 * properly"). Every 30 min it reads the closed paper trades (since the last reset, ≤14 days) and works out:
 *
 *   - the scoreboard: win rate, average win vs average loss, the win rate that would be NEEDED to break
 *     even with those sizes, profit factor, per strategy, per exit reason
 *   - WHERE it goes wrong: losers that never went up (bad entries) vs losers that were up and gave it
 *     back (bad exits); fee drag
 *   - WHICH KINDS of trades lose: every trade is put in bands (strategy × market cap / coin age / curve /
 *     score / time of day) and each band gets its record
 *
 * and then ACTS: a band that loses consistently (≥ minTrades trades, average < maxAvgPct, still negative
 * after one standard error, and it lost real SOL) is BLOCKED for new entries. 1 in `probeEvery` such
 * trades still goes through at the minimum size as a learning trade, so a band that starts working
 * again gets unblocked by the next run. Pure analysis (`runAutopsy`) + Redis store (`autopsy:last`).
 */
import type { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { learningSince } from './labels';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('loss-autopsy');

export interface AutopsyConfig {
  enabled: boolean;
  everyMin: number;
  lookbackDays: number;
  minTrades: number;
  /** A band averaging under this % per trade (after one SE) is blocked. */
  maxAvgPct: number;
  /** …and it must have lost at least this much SOL in total. */
  minLossSol: number;
  /** Let 1 in N trades of a blocked band through (minimum size, learning trade) so it can recover. */
  probeEvery: number;
}

/** What we know about a trade when it is opened (also what the trader checks a new buy against). */
export interface EntryShape {
  strategy: string;
  mcUsd: number | null;
  ageMin: number | null;
  /** Bonding curve %, 'migrated' once on PumpSwap, null = unknown. */
  curvePct: number | 'migrated' | null;
  score: number | null;
  hourUtc: number;
  /** KOLs (incl. discovered smart wallets) holding it when we bought; null = unknown. */
  kols?: number | null;
  /** Price shape before the buy (evaluator/price-shape.ts): % run over 3 min, % under the 10-min high. */
  run3m?: number | null;
  offHigh10m?: number | null;
}

export interface ClosedTrade extends EntryShape {
  pnlSol: number;
  pnlPct: number;
  sizeSol: number;
  exitReason: string;
  peakMultiple: number;
  heldMin: number;
  explore: boolean;
}

type Dim = 'mc' | 'age' | 'curve' | 'score' | 'hour' | 'kols' | 'chase' | 'entry';
const DIMS: Dim[] = ['mc', 'age', 'curve', 'score', 'hour', 'kols', 'chase', 'entry'];

const band = (v: number, edges: number[], labels: string[]) => {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]!) return labels[i]!;
  return labels[labels.length - 1]!;
};

/** Pure: the band of a trade on one dimension (null = unknown). */
export function bandOf(dim: Dim, s: EntryShape): string | null {
  switch (dim) {
    case 'mc':
      return s.mcUsd === null ? null : band(s.mcUsd, [5e3, 10e3, 20e3, 50e3, 150e3, 1e6], ['MC <$5k', 'MC $5–10k', 'MC $10–20k', 'MC $20–50k', 'MC $50–150k', 'MC $150k–1M', 'MC >$1M']);
    case 'age':
      return s.ageMin === null ? null : band(s.ageMin, [1, 3, 10, 30, 120], ['age <1 min', 'age 1–3 min', 'age 3–10 min', 'age 10–30 min', 'age 30 min–2 h', 'age >2 h']);
    case 'curve':
      return s.curvePct === null ? null : s.curvePct === 'migrated' ? 'migrated' : band(s.curvePct, [30, 60, 80], ['curve <30%', 'curve 30–60%', 'curve 60–80%', 'curve 80–100%']);
    case 'score':
      return s.score === null ? null : band(s.score, [70, 80, 90], ['score <70', 'score 70–80', 'score 80–90', 'score 90+']);
    case 'hour':
      return band(s.hourUtc, [4, 8, 12, 16, 20], ['00–04 UTC', '04–08 UTC', '08–12 UTC', '12–16 UTC', '16–20 UTC', '20–24 UTC']);
    case 'chase':
      return s.run3m === null || s.run3m === undefined ? null : band(s.run3m, [0, 20, 50, 100], ['falling 3 min before', 'up 0–20% in 3 min', 'up 20–50% in 3 min', 'up 50–100% in 3 min', 'up 100%+ in 3 min']);
    case 'entry':
      return s.offHigh10m === null || s.offHigh10m === undefined ? null : band(s.offHigh10m, [3, 10, 25], ['bought at the 10-min high', '3–10% under the high', '10–25% under the high', '25%+ under the high']);
    case 'kols':
      return s.kols === null || s.kols === undefined ? null : s.kols === 0 ? 'no KOLs' : s.kols === 1 ? '1 KOL' : s.kols === 2 ? '2 KOLs' : '3+ KOLs';
  }
}

export interface Record_ {
  n: number;
  wins: number;
  winRatePct: number;
  pnlSol: number;
  avgPct: number;
  medianPct: number;
  /** Standard error of the average %. */
  sePct: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function record(ts: readonly ClosedTrade[]): Record_ {
  const p = ts.map((t) => t.pnlPct);
  const n = p.length;
  const mean = n ? p.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(p.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const s = [...p].sort((a, b) => a - b);
  const med = n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : 0;
  const wins = ts.filter((t) => t.pnlSol > 0).length;
  return { n, wins, winRatePct: n ? Math.round((wins / n) * 100) : 0, pnlSol: r3(ts.reduce((a, t) => a + t.pnlSol, 0)), avgPct: r1(mean), medianPct: r1(med), sePct: r1(n > 1 ? sd / Math.sqrt(n) : 0) };
}

export interface Segment extends Record_ {
  strategy: string;
  dim: Dim;
  band: string;
  key: string;
}

/** What the autopsy changes per strategy (recomputed from scratch every run, so it self-corrects). */
export interface StrategyTune {
  strategy: string;
  /** Points added to the buy bar (+ stricter, − easier). */
  barDelta: number;
  /** Position size ×. */
  sizeFactor: number;
  /** Trailing stop distance × (< 1 = sell sooner after a peak). */
  trailFactor: number;
  why: string;
}

const NEUTRAL_TUNE = (strategy: string): StrategyTune => ({ strategy, barDelta: 0, sizeFactor: 1, trailFactor: 1, why: '' });

/**
 * Pure: per strategy, what the record says to do.
 *   working (avg − SE > +2%)                → bar −3, size ×1.2 (do more of it)
 *   losing, mostly bad entries (never up)  → bar +6, size ×0.7
 *   losing otherwise                        → bar +3, size ×0.85
 *   losers often were up 15%+ (gave back)   → trail ×0.75 (sell sooner after a peak)
 */
export function tuneStrategies(trades: readonly ClosedTrade[], minTrades: number): StrategyTune[] {
  const out: StrategyTune[] = [];
  for (const s of [...new Set(trades.map((t) => t.strategy))]) {
    const ts = trades.filter((t) => t.strategy === s);
    const t = NEUTRAL_TUNE(s);
    if (ts.length < minTrades) {
      out.push(t);
      continue;
    }
    const r = record(ts);
    const losers = ts.filter((x) => x.pnlSol <= 0);
    const neverUp = losers.length ? losers.filter((x) => x.peakMultiple < 1.05).length / losers.length : 0;
    const gaveBack = losers.length ? losers.filter((x) => x.peakMultiple >= 1.15).length / losers.length : 0;
    const why: string[] = [];
    if (r.avgPct - r.sePct > 2) {
      t.barDelta = -3;
      t.sizeFactor = 1.2;
      why.push(`working (${r.n} trades, avg +${r.avgPct}%) → easier bar, bigger size`);
    } else if (r.avgPct < 0) {
      if (neverUp >= 0.55) {
        t.barDelta = 6;
        t.sizeFactor = 0.7;
        why.push(`${Math.round(neverUp * 100)}% of its losers never went up → stricter entries`);
      } else {
        t.barDelta = 3;
        t.sizeFactor = 0.85;
        why.push(`losing (avg ${r.avgPct}%) → a bit stricter`);
      }
    }
    if (r.avgPct < 2 && gaveBack >= 0.35) {
      t.trailFactor = 0.75;
      why.push(`${Math.round(gaveBack * 100)}% of its losers were up 15%+ first → sell sooner after a peak`);
    }
    t.why = why.join('; ');
    out.push(t);
  }
  return out;
}

let tuneCache = new Map<string, StrategyTune>();
/** The autopsy's current adjustments for a strategy (neutral until the first run). */
export function autopsyTuneFor(strategy: string): StrategyTune {
  return tuneCache.get(strategy) ?? NEUTRAL_TUNE(strategy);
}
export function setAutopsyTunes(t: readonly StrategyTune[]): void {
  tuneCache = new Map(t.map((x) => [x.strategy, x]));
}

export interface Autopsy {
  at: string;
  tuning: StrategyTune[];
  trades: number;
  overall: Record_ & { avgWinPct: number; avgLossPct: number; neededWinRatePct: number | null; profitFactor: number | null };
  byStrategy: Array<Record_ & { strategy: string }>;
  byExit: Array<{ reason: string; n: number; pnlSol: number; avgPct: number }>;
  losers: { n: number; neverUpPct: number; gaveBackPct: number; avgPeakMultiple: number };
  learning: Record_;
  findings: string[];
  worst: Segment[];
  best: Segment[];
  blocked: Segment[];
}

export const segmentKey = (strategy: string, dim: string, b: string) => `${strategy}|${dim}|${b}`;

/** Pure: the full autopsy. */
export function runAutopsy(trades: readonly ClosedTrade[], c: AutopsyConfig, now = Date.now()): Autopsy {
  const all = record(trades);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const grossW = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossL = -losses.reduce((a, t) => a + t.pnlSol, 0);
  // Break-even win rate for these win / loss sizes: |L| / (W + |L|).
  const needed = avgWin > 0 && avgLoss < 0 ? Math.round((-avgLoss / (avgWin - avgLoss)) * 100) : null;

  const strategies = [...new Set(trades.map((t) => t.strategy))];
  const byStrategy = strategies.map((s) => ({ strategy: s, ...record(trades.filter((t) => t.strategy === s)) })).sort((a, b) => a.pnlSol - b.pnlSol);
  const reasons = [...new Set(trades.map((t) => t.exitReason))];
  const byExit = reasons
    .map((r) => {
      const x = record(trades.filter((t) => t.exitReason === r));
      return { reason: r, n: x.n, pnlSol: x.pnlSol, avgPct: x.avgPct };
    })
    .sort((a, b) => a.pnlSol - b.pnlSol);

  const neverUp = losses.filter((t) => t.peakMultiple < 1.05).length;
  const gaveBack = losses.filter((t) => t.peakMultiple >= 1.15).length;

  // Bands per strategy × dimension.
  const segs: Segment[] = [];
  for (const s of strategies) {
    const ts = trades.filter((t) => t.strategy === s);
    for (const d of DIMS) {
      const groups = new Map<string, ClosedTrade[]>();
      for (const t of ts) {
        const b = bandOf(d, t);
        if (b) groups.set(b, [...(groups.get(b) ?? []), t]);
      }
      for (const [b, g] of groups) segs.push({ strategy: s, dim: d, band: b, key: segmentKey(s, d, b), ...record(g) });
    }
  }
  const enough = segs.filter((x) => x.n >= c.minTrades);
  const blocked = enough.filter((x) => x.avgPct + x.sePct < c.maxAvgPct && x.pnlSol <= -c.minLossSol).sort((a, b) => a.pnlSol - b.pnlSol);
  const worst = [...enough].sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 8);
  const best = [...enough].filter((x) => x.pnlSol > 0).sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 5);

  const findings: string[] = [];
  if (trades.length < 10) findings.push(`Only ${trades.length} closed trades so far — too few to judge; keep collecting.`);
  if (needed !== null && all.n >= 10) {
    findings.push(
      all.winRatePct < needed
        ? `Wins average +${r1(avgWin)}% but losses ${r1(avgLoss)}% — that needs ${needed}% winners to break even; it wins ${all.winRatePct}%.`
        : `Win rate ${all.winRatePct}% beats the ${needed}% needed for these win/loss sizes.`,
    );
  }
  if (losses.length >= 5) {
    const nu = Math.round((neverUp / losses.length) * 100);
    const gb = Math.round((gaveBack / losses.length) * 100);
    if (nu >= 50) findings.push(`${nu}% of losing trades never went up even 5% after buying → the ENTRIES are the problem (buying tops / dead coins), not the exits.`);
    if (gb >= 30) findings.push(`${gb}% of losing trades were up 15%+ at some point and still lost → profit is being given back; sell earlier.`);
  }
  const worstExit = byExit[0];
  if (worstExit && worstExit.pnlSol < 0) findings.push(`Most SOL lost through "${worstExit.reason}" exits: ${worstExit.n} trades, ${worstExit.pnlSol} SOL.`);
  const worstStrat = byStrategy[0];
  if (worstStrat && worstStrat.pnlSol < 0 && worstStrat.n >= 5) findings.push(`Worst strategy: ${worstStrat.strategy} — ${worstStrat.n} trades, ${worstStrat.winRatePct}% wins, ${worstStrat.pnlSol} SOL.`);
  const learning = record(trades.filter((t) => t.explore));
  if (learning.n >= 10 && learning.avgPct < all.avgPct - 3) findings.push(`Learning trades (just under the bar) average ${learning.avgPct}% vs ${all.avgPct}% overall — the score bar is doing its job.`);
  for (const b of blocked.slice(0, 5)) findings.push(`BLOCKED: ${b.strategy} with ${b.band} — ${b.n} trades, ${b.winRatePct}% wins, avg ${b.avgPct}%, ${b.pnlSol} SOL.`);

  const tuning = tuneStrategies(trades, c.minTrades);
  for (const t of tuning) if (t.why) findings.push(`ADJUSTED ${t.strategy}: ${t.why}`);

  return {
    at: new Date(now).toISOString(),
    tuning,
    trades: trades.length,
    overall: { ...all, avgWinPct: r1(avgWin), avgLossPct: r1(avgLoss), neededWinRatePct: needed, profitFactor: grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : null },
    byStrategy,
    byExit,
    losers: { n: losses.length, neverUpPct: losses.length ? Math.round((neverUp / losses.length) * 100) : 0, gaveBackPct: losses.length ? Math.round((gaveBack / losses.length) * 100) : 0, avgPeakMultiple: losses.length ? Math.round((losses.reduce((a, t) => a + t.peakMultiple, 0) / losses.length) * 100) / 100 : 0 },
    learning,
    findings,
    worst,
    best,
    blocked,
  };
}

/** Pure: is a new buy in a blocked band? Returns the band (for the refusal) or null. */
export function blockedBand(shape: EntryShape, blocked: readonly Pick<Segment, 'key' | 'band' | 'n' | 'avgPct' | 'pnlSol'>[]): (typeof blocked)[number] | null {
  if (!blocked.length) return null;
  const byKey = new Map(blocked.map((b) => [b.key, b]));
  for (const d of DIMS) {
    const b = bandOf(d, shape);
    const hit = b ? byKey.get(segmentKey(shape.strategy, d, b)) : undefined;
    if (hit) return hit;
  }
  return null;
}

const LAST = 'autopsy:last';

/** Loads closed trades, runs the autopsy, stores it. */
export class LossAutopsy {
  private timer: NodeJS.Timeout | null = null;
  private last: Autopsy | null = null;
  private probes = 0;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: () => AutopsyConfig,
  ) {}

  start(): void {
    void this.restore().then(() => this.run());
    this.timer = setInterval(() => void this.run(), Math.max(5, this.cfg().everyMin) * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): Autopsy | null {
    return this.last;
  }

  /** Trader gate: refuse a buy in a blocked band — except 1 in `probeEvery` (returned as a probe). */
  check(shape: EntryShape): { block: string | null; probe: boolean } {
    const c = this.cfg();
    if (!c.enabled || !this.last) return { block: null, probe: false };
    const hit = blockedBand(shape, this.last.blocked);
    if (!hit) return { block: null, probe: false };
    this.probes++;
    if (c.probeEvery > 0 && this.probes % c.probeEvery === 0) return { block: null, probe: true };
    return { block: `this kind of trade keeps losing: ${shape.strategy} with ${hit.band} (${hit.n} trades, avg ${hit.avgPct}%, ${hit.pnlSol} SOL)`, probe: false };
  }

  private async restore(): Promise<void> {
    try {
      const raw = await this.redis.get(LAST);
      if (raw) {
        this.last = JSON.parse(raw) as Autopsy;
        setAutopsyTunes(this.last.tuning ?? []);
      }
    } catch {
      /* fresh start */
    }
  }

  async run(now = Date.now()): Promise<Autopsy | null> {
    const c = this.cfg();
    if (!c.enabled) return null;
    try {
      // The last paper reset (stored as an ISO date) — older trades belong to an old account.
      const resetAt = (await learningSince(this.redis))?.getTime() ?? 0;
      const since = new Date(Math.max(resetAt, now - c.lookbackDays * 86_400_000));
      const rows = await prisma.position.findMany({
        where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: since } },
        select: {
          strategy: true, sizeSol: true, realizedPnlSol: true, exitReason: true, entryPriceSol: true, peakPriceSol: true, openedAt: true, closedAt: true, entryContext: true,
          token: { select: { createdAt: true } },
          evaluation: { select: { combinedScore: true, features: true } },
        },
      });
      const trades: ClosedTrade[] = rows.map((p) => {
        const ec = (p.entryContext ?? {}) as { marketCapUsd?: number | null; explore?: boolean; kols?: number | null };
        const ef = (p.evaluation?.features ?? {}) as { market?: { bondingCurvePct?: number; complete?: boolean }; shape?: { run3m?: number; offHigh10m?: number } | null };
        const mk = ef.market;
        return {
          strategy: p.strategy,
          mcUsd: typeof ec.marketCapUsd === 'number' ? ec.marketCapUsd : null,
          ageMin: p.token ? (p.openedAt.getTime() - p.token.createdAt.getTime()) / 60_000 : null,
          curvePct: mk ? (mk.complete ? 'migrated' : (mk.bondingCurvePct ?? null)) : p.strategy === 'SWING' ? 'migrated' : null,
          score: p.evaluation?.combinedScore ?? null,
          hourUtc: p.openedAt.getUTCHours(),
          kols: typeof ec.kols === 'number' ? ec.kols : null,
          run3m: typeof ef.shape?.run3m === 'number' ? ef.shape.run3m : null,
          offHigh10m: typeof ef.shape?.offHigh10m === 'number' ? ef.shape.offHigh10m : null,
          pnlSol: p.realizedPnlSol,
          pnlPct: p.sizeSol > 0 ? (p.realizedPnlSol / p.sizeSol) * 100 : 0,
          sizeSol: p.sizeSol,
          exitReason: p.exitReason ?? 'UNKNOWN',
          peakMultiple: p.entryPriceSol > 0 ? p.peakPriceSol / p.entryPriceSol : 1,
          heldMin: p.closedAt ? (p.closedAt.getTime() - p.openedAt.getTime()) / 60_000 : 0,
          explore: ec.explore === true,
        };
      });
      const a = runAutopsy(trades, c, now);
      this.last = a;
      setAutopsyTunes(a.tuning);
      await this.redis.set(LAST, JSON.stringify(a), 'EX', 7 * 86_400);
      if (a.blocked.length) log.info({ blocked: a.blocked.map((b) => `${b.strategy} ${b.band}`) }, `🔬 autopsy: ${a.trades} trades, ${a.blocked.length} losing bands blocked`);
      return a;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'loss autopsy failed');
      return null;
    }
  }
}
