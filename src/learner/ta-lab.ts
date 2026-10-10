/**
 * Chart-strategy lab — forward-tests every technical strategy (src/evaluator/ta/strategies.ts:
 * Fibonacci, EMA pullbacks, breakouts, divergences, order flow …) LIVE, against a random-entry
 * baseline, on the coins the bot actually watches.
 *
 * Every `ta.everySec` (= one 15 s candle) it takes the most active coins, skips the junk (cheap
 * gates: real trading, market cap, spread-out holders, small dev bag) and runs every strategy
 * on their completed candles. A strategy that fires opens a VIRTUAL position (once per coin +
 * strategy per `cooldownMin`), traded with the bot's live exit rules and real paper costs.
 * `baseline_random` opens on a random ~1-in-`baselineOneIn` look at the same coins: a chart
 * strategy is only worth anything if it beats random entries on the same market.
 *
 * Proven strategies (≥ minTrades results, cautious average > 0, beating the baseline by
 * ≥ minEdgePct per trade) get a say in real trading: the evaluator adds score points when one
 * fires on a coin it is checking, and when one fires here the coin is checked right away.
 * Nothing is proven by default — the lab has to earn it on live data.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, type BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import type { Evaluator } from '../evaluator/evaluator';
import { runStrategies, TA_BY_ID, TA_STRATEGIES, taContext, type TaSignal } from '../evaluator/ta/strategies';
import { moduleLogger } from '../lib/logger';
import { getSolUsd } from '../lib/sol-price';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { deriveMetrics, type LiveState } from '../scanner/live-state';
import { labStats, type LabStats } from './strategy-lab';
import { VirtualBook, type VirtualResult } from './virtual-book';

const log = moduleLogger('ta-lab');
const resKey = (id: string) => `talab:res:${id}`;
export const BASELINE_ID = 'baseline_random';

/**
 * Signals that don't come from the chart but are tested the same way (vs random entries):
 * a coin newly appearing on a trending tab.
 */
export const EXTERNAL_SIGNALS: Array<{ id: string; name: string; family: string; summary: string }> = [
  { id: 'trend_pump', name: 'New on a pump.fun tab (live / KOTH / for-you / runners)', family: 'trending', summary: 'The coin just appeared on one of pump.fun\'s own discovery tabs. Lists rank recent activity, so this is often late — the lab measures whether buying at that moment beats random entries.' },
  { id: 'trend_gecko', name: 'New on GeckoTerminal trending (5m / 1h)', family: 'trending', summary: 'The coin just entered GeckoTerminal\'s trending Solana pools. Tested against random entries like every other signal.' },
];
const EXTERNAL_BY_ID = new Map(EXTERNAL_SIGNALS.map((x) => [x.id, x]));

export interface TaLabResult {
  id: string;
  mint: string;
  phase: 'curve' | 'amm';
  strength: number;
  pnlPct: number;
  peakX: number;
  holdSec: number;
  reason: string;
  at: number;
}

export interface ProvenStrategy {
  id: string;
  n: number;
  avgPnlPct: number;
  /** Average P&L per trade above the random baseline, points. */
  edgePct: number;
}

/** Standard normal upper-tail probability (Abramowitz–Stegun 26.2.17; |error| < 1e-7). */
export function normalSf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? p : 1 - p;
}

/**
 * Pure: the strategies that earned a say in real trading. With dozens of strategies tested at
 * once some will look good by pure luck, so a strategy needs ALL of:
 *  - ≥ minTrades results, and its average beats random entries by ≥ minEdgePct,
 *  - mean − 2 standard errors > 0, profit factor ≥ minProfitFactor, still positive without its
 *    3 best trades (not just a couple of lucky moonshots),
 *  - and it survives Benjamini–Hochberg false-discovery control (q = fdrQ) across every
 *    strategy with enough results (one-sided test of "beats random").
 */
export function provenStrategies(
  stats: readonly LabStats[],
  baseline: LabStats | null,
  c: { minTrades: number; minEdgePct: number; minProfitFactor?: number; fdrQ?: number },
): Map<string, ProvenStrategy> {
  const base = baseline && baseline.n >= 20 ? baseline.avgPnlPct : 0;
  const tested = stats.filter((s) => s.id !== BASELINE_ID && s.n >= c.minTrades);
  // p-value of "beats random": one-sided z on the average's standard error.
  const ps = tested.map((s) => ({ s, p: s.sePct > 0 ? normalSf((s.avgPnlPct - base) / s.sePct) : s.avgPnlPct > base ? 0 : 1 })).sort((a, b) => a.p - b.p);
  const q = c.fdrQ ?? 0.1;
  let cut = -1;
  ps.forEach((x, k) => {
    if (x.p <= ((k + 1) / Math.max(1, ps.length)) * q) cut = k;
  });
  const discovered = new Set(ps.slice(0, cut + 1).map((x) => x.s.id));
  const out = new Map<string, ProvenStrategy>();
  for (const s of tested) {
    if (!discovered.has(s.id)) continue;
    if (s.avgPnlPct < base + c.minEdgePct || !(s.lower2Pct > 0) || !(s.trimmedAvgPct > 0)) continue;
    if (s.profitFactor !== null && s.profitFactor < (c.minProfitFactor ?? 1.2)) continue;
    out.set(s.id, { id: s.id, n: s.n, avgPnlPct: s.avgPnlPct, edgePct: Math.round((s.avgPnlPct - base) * 10) / 10 });
  }
  return out;
}

/** Pure: deterministic "random" pick for the baseline — about 1 in `oneIn` looks at a coin. */
export function baselinePick(mint: string, tick: number, oneIn: number): boolean {
  if (oneIn <= 1) return true;
  let h = 2166136261;
  const s = `${mint}:${tick}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % oneIn === 0;
}

/** Pure: cheap quality gate for a lab candidate (null = OK, else why not). */
export function labGate(
  m: { marketCapSol: number; top10HolderPct: number; devHoldingPct: number; earlyBuyerPct: number; liquiditySol: number },
  solUsd: number | null,
  c: { minMarketCapUsd: number; maxTop10Pct: number; maxDevHoldingPct: number; maxBundlePct: number },
): string | null {
  if (solUsd !== null && m.marketCapSol * solUsd < c.minMarketCapUsd) return 'market cap too small';
  if (m.top10HolderPct > c.maxTop10Pct) return 'top 10 too concentrated';
  if (m.devHoldingPct > c.maxDevHoldingPct) return 'dev holds too much';
  if (m.earlyBuyerPct > c.maxBundlePct) return 'bundles hold too much';
  if (m.liquiditySol < 3) return 'no liquidity';
  return null;
}

/** Score points for proven strategies that fired (capped). Pure. */
export function taPoints(fired: readonly TaSignal[], proven: ReadonlyMap<string, ProvenStrategy>, c: { pointsPerSignal: number; maxPoints: number }): { points: number; notes: string[] } {
  let points = 0;
  const notes: string[] = [];
  for (const s of fired) {
    const p = proven.get(s.id);
    if (!p) continue;
    // Full points at a +10%/trade edge over random, less for a smaller edge.
    points += c.pointsPerSignal * Math.min(1, p.edgePct / 10) * (0.5 + 0.5 * s.strength);
    notes.push(`${TA_BY_ID.get(s.id)?.name ?? s.id} (lab: +${p.edgePct}%/trade vs random over ${p.n} tests)`);
  }
  return { points: Math.round(Math.min(c.maxPoints, points) * 10) / 10, notes };
}

export class TaLab {
  private readonly book: VirtualBook;
  private readonly lastFire = new Map<string, number>();
  private readonly lastCheckReq = new Map<string, number>();
  private proven = new Map<string, ProvenStrategy>();
  private timer: NodeJS.Timeout | null = null;
  private stepTimer: NodeJS.Timeout | null = null;
  private provenTimer: NodeJS.Timeout | null = null;
  private busy = false;
  readonly stats = { ticks: 0, coinsLooked: 0, signals: 0, opened: 0, lastTickMs: 0 };
  /** Set in index.ts: proven strategies firing ask the evaluator to check the coin now. */
  evaluator: Evaluator | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly crowd: CrowdTracker,
    private readonly liveState: LiveState,
  ) {
    this.book = new VirtualBook(crowd, (_tag, live) => live, (r) => this.save(r), () => this.cfg().maxOpen);
  }

  private cfg(): BotConfigShape['ta'] {
    return getConfig().ta ?? DEFAULT_CONFIG.ta;
  }

  start(): void {
    const every = Math.max(5, this.cfg().everySec) * 1000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
    this.stepTimer = setInterval(() => this.book.stepAll(), 1_000);
    this.stepTimer.unref?.();
    void this.refreshProven();
    this.provenTimer = setInterval(() => void this.refreshProven(), 5 * 60_000);
    this.provenTimer.unref?.();
  }

  stop(): void {
    for (const t of [this.timer, this.stepTimer, this.provenTimer]) if (t) clearInterval(t);
  }

  onTrade(mint: string): void {
    this.book.onTrade(mint);
  }

  get openCount(): number {
    return this.book.size;
  }

  /** Strategies with a proven edge right now (refreshed every 5 min). */
  provenNow(): ReadonlyMap<string, ProvenStrategy> {
    return this.proven;
  }

  /** One look at the market (every candle). Never throws. */
  async tick(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled || !c.labEnabled || this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const tick = Math.floor(now / (Math.max(5, c.everySec) * 1000));
      const ids = TA_STRATEGIES.map((s) => s.id).filter((id) => !c.disabled.includes(id));
      const solUsd = await getSolUsd().catch(() => null);
      let looked = 0;
      for (const mint of this.crowd.activeMints(120_000, c.maxCoinsPerTick, now)) {
        // Let trades / exits run between coins (a full tick is ~0.2 s of CPU in one go otherwise).
        if (++looked % 10 === 0) await new Promise((r) => setImmediate(r));
        const trades = this.crowd.trades(mint);
        let recent = 0;
        for (let i = trades.length - 1; i >= 0 && now - trades[i]!.t <= 120_000; i--) recent++;
        if (recent < c.minTradesLast2m) continue;
        const raw = this.crowd.candles(mint);
        if (raw.length < 12) continue;
        this.stats.coinsLooked++;
        const last = trades[trades.length - 1]!;
        const price = last.pp && last.pp > 0 ? last.pp : last.px;
        const meta = this.liveState.meta(mint);
        const ctx = taContext(raw, price, now, meta ? Math.max(0, now / 1000 - meta.createdSec) : null, 15_000, { trades, creator: meta?.creator ?? null });
        const sigs = runStrategies(ctx, ids);
        const pool: TaSignal[] = [...sigs];
        if (baselinePick(mint, tick, c.baselineOneIn)) pool.push({ id: BASELINE_ID, strength: 0, why: 'random entry (baseline)' });
        const strategy = await this.open(mint, pool, price, solUsd, now);
        if (!strategy) continue;
        // Proven strategies firing → the real evaluator checks this coin now (all its rules still apply).
        const provenHits = sigs.filter((s) => this.proven.has(s.id));
        if (c.triggerChecks && this.evaluator && provenHits.length && now - (this.lastCheckReq.get(mint) ?? 0) >= 60_000) {
          this.lastCheckReq.set(mint, now);
          void this.evaluator.checkNow(mint, strategy, `ta:${provenHits.map((s) => s.id).join('+')}`, { bucketSec: 30 }).catch(() => undefined);
        }
      }
      if (this.lastFire.size > 50_000) for (const [k, t] of this.lastFire) if (now - t > c.cooldownMin * 60_000) this.lastFire.delete(k);
      if (this.lastCheckReq.size > 10_000) this.lastCheckReq.clear();
      this.stats.ticks++;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'ta lab tick failed');
    } finally {
      this.stats.lastTickMs = Date.now() - t0;
      this.busy = false;
    }
  }

  /** Open virtual trades for `sigs` on `mint` if it passes the gates. Returns its strategy, or null. */
  private async open(mint: string, sigs: readonly TaSignal[], price: number, solUsd: number | null, now: number): Promise<StrategyName | null> {
    const c = this.cfg();
    const fresh = sigs.filter((s) => now - (this.lastFire.get(`${s.id}:${mint}`) ?? 0) >= c.cooldownMin * 60_000);
    if (!fresh.length) return null;
    const view = await this.liveState.read(mint);
    if (!view) return null;
    const m = deriveMetrics(view);
    if (labGate(m, solUsd, c)) return null;
    const onAmm = view.ammBaseReserve !== null && view.ammBaseReserve > 0n;
    const strategy: StrategyName = view.complete ? 'MIGRATION_MOMENTUM' : m.bondingCurvePct >= 70 ? 'SOON' : 'CURVE_SNIPE';
    for (const s of fresh) {
      this.lastFire.set(`${s.id}:${mint}`, now);
      this.stats.signals++;
      if (this.book.add({ key: `${s.id}:${mint}`, mint, symbol: '', strategy, onAmm, priceSol: price > 0 ? price : m.priceSol, tag: { id: s.id, phase: onAmm ? 'amm' : 'curve', strength: s.strength } }, now)) this.stats.opened++;
    }
    return strategy;
  }

  /** A non-chart signal (e.g. the coin just appeared on a trending tab): paper-trade it like the others. Never throws. */
  async externalSignal(id: string, mint: string, why: string, now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled || !c.labEnabled || !EXTERNAL_BY_ID.has(id)) return;
    try {
      const t = this.crowd.trades(mint);
      const last = t[t.length - 1];
      const price = last ? (last.pp && last.pp > 0 ? last.pp : last.px) : 0;
      await this.open(mint, [{ id, strength: 0.5, why }], price, await getSolUsd().catch(() => null), now);
    } catch (err) {
      log.debug({ id, mint, err: (err as Error).message }, 'external lab signal failed');
    }
  }

  private save(v: VirtualResult): void {
    const id = String(v.tag.id);
    const r: TaLabResult = { id, mint: v.mint, phase: v.tag.phase === 'amm' ? 'amm' : 'curve', strength: Number(v.tag.strength ?? 0), pnlPct: v.pnlPct, peakX: v.peakX, holdSec: v.holdSec, reason: v.reason, at: v.at };
    void this.redis
      .multi()
      .lpush(resKey(id), JSON.stringify(r))
      .ltrim(resKey(id), 0, this.cfg().keepResults - 1)
      .exec()
      .catch((err: Error) => log.warn({ err: err.message }, 'ta lab result not saved'));
  }

  async results(id: string): Promise<TaLabResult[]> {
    const raw = await this.redis.lrange(resKey(id), 0, this.cfg().keepResults - 1);
    return raw.map((x) => JSON.parse(x) as TaLabResult);
  }

  private async allStats(): Promise<{ stats: LabStats[]; baseline: LabStats | null; byPhase: Map<string, { curve: LabStats; amm: LabStats }> }> {
    const stats: LabStats[] = [];
    const byPhase = new Map<string, { curve: LabStats; amm: LabStats }>();
    let baseline: LabStats | null = null;
    for (const id of [BASELINE_ID, ...TA_STRATEGIES.map((s) => s.id), ...EXTERNAL_SIGNALS.map((x) => x.id)]) {
      const rows = await this.results(id);
      const name = id === BASELINE_ID ? 'Random entry (baseline)' : (TA_BY_ID.get(id)?.name ?? EXTERNAL_BY_ID.get(id)?.name ?? id);
      const st = labStats(id, name, rows);
      if (id === BASELINE_ID) baseline = st;
      else stats.push(st);
      byPhase.set(id, { curve: labStats(id, name, rows.filter((r) => r.phase === 'curve')), amm: labStats(id, name, rows.filter((r) => r.phase === 'amm')) });
    }
    return { stats, baseline, byPhase };
  }

  async refreshProven(): Promise<void> {
    try {
      const { stats, baseline } = await this.allStats();
      const next = provenStrategies(stats, baseline, this.cfg());
      const added = [...next.keys()].filter((k) => !this.proven.has(k));
      const dropped = [...this.proven.keys()].filter((k) => !next.has(k));
      this.proven = next;
      if (added.length || dropped.length) log.info({ added, dropped, proven: [...next.keys()] }, '📈 chart strategies with a proven edge updated');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not refresh proven chart strategies');
    }
  }

  /** Dashboard: every strategy with its live record vs the random baseline. */
  async report(): Promise<{
    baseline: LabStats | null;
    strategies: Array<LabStats & { family: string; summary: string; proven: boolean; edgePct: number | null; curve: LabStats; amm: LabStats }>;
    open: number;
    stats: TaLab['stats'];
    minTrades: number;
    minEdgePct: number;
  }> {
    const { stats, baseline, byPhase } = await this.allStats();
    const strategies = stats.map((s) => {
      const def = TA_BY_ID.get(s.id) ?? EXTERNAL_BY_ID.get(s.id);
      const ph = byPhase.get(s.id)!;
      return { ...s, family: def?.family ?? '', summary: def?.summary ?? '', proven: this.proven.has(s.id), edgePct: baseline && baseline.n >= 20 && s.n ? Math.round((s.avgPnlPct - baseline.avgPnlPct) * 10) / 10 : null, curve: ph.curve, amm: ph.amm };
    });
    strategies.sort((a, b) => Number(b.proven) - Number(a.proven) || b.lowerPct - a.lowerPct);
    const c = this.cfg();
    return { baseline, strategies, open: this.book.size, stats: this.stats, minTrades: c.minTrades, minEdgePct: c.minEdgePct };
  }
}
