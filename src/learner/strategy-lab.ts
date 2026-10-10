/**
 * Strategy lab — forward-tests several exit setups on the bot's REAL signals, live.
 *
 * Guessing settings is how the bot ended up with +3% wins and −20% losses. The lab measures
 * instead: every BUY signal (also the ones the trader had no room for) and every near-miss
 * opens a VIRTUAL position for each variant. Every variant runs the bot's own exit logic
 * (decideExit) with a few settings changed, on the same live trades, with the same costs as
 * paper fills (pool fee + slippage + tx fees, both ways). Nothing is bought or sold.
 *
 * Results (last `keepResults` per variant) live in Redis. /api/lab shows which setup really
 * makes money. With `lab.autoApply`, once a variant has at least `minTrades` results, a
 * lower bound (mean − 1 standard error) above zero and beats the setup in use by
 * `minEdgePct`, its settings are written into the live exit config (at most once per
 * `applyEveryHours`). The owner's stop-loss band is never touched by a variant.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, type BotConfigShape } from '../config/default';
import { deepMerge, getConfig, updateConfigSection } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { VirtualBook, type VirtualResult } from './virtual-book';

const log = moduleLogger('strategy-lab');
type ExitRules = BotConfigShape['exit'];
const resKey = (variant: string) => `lab:res:${variant}`;
const APPLIED_KEY = 'lab:applied';
const SIGNAL_COOLDOWN_MS = 30 * 60_000;

export interface LabVariant {
  id: string;
  name: string;
  /** Tests something only the owner may switch on (e.g. a stop outside the 10–20% band): reported, never auto-applied. */
  ownerOnly?: boolean;
  /** Partial exit settings layered over the live exit config (deep-merged; arrays replace). */
  exit: Record<string, unknown>;
}

export interface LabResult {
  variant: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  kind: 'buy' | 'near';
  pnlPct: number;
  peakX: number;
  holdSec: number;
  reason: string;
  at: number;
}

export interface LabStats {
  id: string;
  name: string;
  n: number;
  wins: number;
  winRate: number;
  avgPnlPct: number;
  medianPnlPct: number;
  sumPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null;
  /** mean − 1 standard error: a cautious estimate of the true average. */
  lowerPct: number;
  /** Standard error of the average, points. */
  sePct: number;
  /** mean − 2 standard errors (≈ 97.5% one-sided): a strict lower bound. */
  lower2Pct: number;
  /** Average without the 3 best results — is it more than a couple of lucky moonshots? */
  trimmedAvgPct: number;
}

/** Pure: summary of one variant's results. */
export function labStats(id: string, name: string, rows: readonly Pick<LabResult, 'pnlPct'>[]): LabStats {
  const xs = rows.map((r) => r.pnlPct).filter((x) => Number.isFinite(x));
  const n = xs.length;
  const wins = xs.filter((x) => x > 0);
  const losses = xs.filter((x) => x <= 0);
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n ? (n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2) : 0;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  const trimmed = sorted.slice(0, Math.max(0, n - 3));
  return {
    id,
    name,
    n,
    wins: wins.length,
    winRate: n ? Math.round((wins.length / n) * 1000) / 10 : 0,
    avgPnlPct: r1(mean),
    medianPnlPct: r1(median),
    sumPnlPct: r1(sum),
    avgWinPct: r1(wins.length ? grossWin / wins.length : 0),
    avgLossPct: r1(losses.length ? -grossLoss / losses.length : 0),
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : wins.length ? null : 0,
    lowerPct: r1(n > 1 ? mean - se : mean),
    sePct: Math.round(se * 100) / 100,
    lower2Pct: r1(n > 1 ? mean - 2 * se : mean),
    trimmedAvgPct: r1(trimmed.length ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : 0),
  };
}

/**
 * Pure: the variant to switch the live exits to, or null. It needs enough trades, a cautious
 * average (lower bound) above zero, and to beat the setup in use (`current`) by `minEdgePct`.
 */
export function pickBest(stats: readonly LabStats[], current: string, c: { minTrades: number; minEdgePct: number }): LabStats | null {
  const cur = stats.find((s) => s.id === current);
  const ok = stats.filter((s) => s.id !== current && s.n >= c.minTrades && s.lowerPct > 0);
  if (!ok.length) return null;
  const best = [...ok].sort((a, b) => b.lowerPct - a.lowerPct)[0]!;
  if (cur && cur.n >= c.minTrades && best.avgPnlPct < cur.avgPnlPct + c.minEdgePct) return null;
  return best;
}

/** The variant's exit rules: the live rules with the variant's settings layered on top. */
export function variantRules(live: ExitRules, v: Pick<LabVariant, 'exit' | 'ownerOnly'>): ExitRules {
  const merged = deepMerge(live, v.exit) as ExitRules;
  // The owner's stop-loss band is not something an auto-applicable variant may change; an
  // owner-only variant may TEST another one (it is never applied automatically).
  return v.ownerOnly ? merged : { ...merged, stopLoss: live.stopLoss, hardStopLossPct: live.hardStopLossPct };
}

export class StrategyLab {
  private readonly book: VirtualBook;
  /** Last signal per coin + strategy (one lab trade per coin + strategy per `SIGNAL_COOLDOWN_MS`). */
  private readonly lastSignal = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private applyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    crowd: CrowdTracker,
  ) {
    this.book = new VirtualBook(
      crowd,
      (tag, live) => {
        const v = (this.cfg().variants as LabVariant[]).find((x) => x.id === tag.variant);
        return v ? variantRules(live, v) : null;
      },
      (r) => this.save(r),
      () => this.cfg().maxOpen,
    );
  }

  private cfg(): BotConfigShape['lab'] {
    return getConfig().lab ?? DEFAULT_CONFIG.lab;
  }

  start(): void {
    this.timer = setInterval(() => this.book.stepAll(), 1_000);
    this.timer.unref?.();
    this.applyTimer = setInterval(() => void this.maybeApply(), 15 * 60_000);
    this.applyTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.applyTimer) clearInterval(this.applyTimer);
  }

  openCount(): number {
    return this.book.size;
  }

  /**
   * A signal from the evaluator: 'buy' = the bot decided to buy (whether or not the trader
   * had room), 'near' = rules passed but the score fell just short. Opens one virtual
   * position per variant (once per coin + strategy + variant while open).
   */
  onSignal(s: { mint: string; symbol: string; strategy: StrategyName; kind: 'buy' | 'near'; priceSol: number; onAmm: boolean }, now = Date.now()): void {
    const c = this.cfg();
    if (!c.enabled || !(s.priceSol > 0)) return;
    // One lab trade per coin + strategy per half hour (a coin re-checked every minute isn't 30 samples).
    const sk = `${s.mint}:${s.strategy}`;
    if (now - (this.lastSignal.get(sk) ?? 0) < SIGNAL_COOLDOWN_MS) return;
    this.lastSignal.set(sk, now);
    if (this.lastSignal.size > 20_000) for (const [k, t] of this.lastSignal) if (now - t > SIGNAL_COOLDOWN_MS) this.lastSignal.delete(k);
    for (const v of c.variants) {
      this.book.add({ key: `${v.id}:${s.mint}:${s.strategy}`, mint: s.mint, symbol: s.symbol, strategy: s.strategy, onAmm: s.onAmm, priceSol: s.priceSol, tag: { variant: v.id, kind: s.kind } }, now);
    }
  }

  /** A trade happened on `mint` (wired from the token registry): step its virtual positions. */
  onTrade(mint: string, now = Date.now()): void {
    this.book.onTrade(mint, now);
  }

  private save(v: VirtualResult): void {
    const r: LabResult = {
      variant: String(v.tag.variant),
      mint: v.mint,
      symbol: v.symbol,
      strategy: v.strategy,
      kind: v.tag.kind === 'near' ? 'near' : 'buy',
      pnlPct: v.pnlPct,
      peakX: v.peakX,
      holdSec: v.holdSec,
      reason: v.reason,
      at: v.at,
    };
    const keep = this.cfg().keepResults;
    void this.redis
      .multi()
      .lpush(resKey(r.variant), JSON.stringify(r))
      .ltrim(resKey(r.variant), 0, keep - 1)
      .exec()
      .catch((err: Error) => log.warn({ err: err.message }, 'lab result not saved'));
  }

  async results(variant: string, limit?: number): Promise<LabResult[]> {
    const raw = await this.redis.lrange(resKey(variant), 0, (limit ?? this.cfg().keepResults) - 1);
    return raw.map((x) => JSON.parse(x) as LabResult);
  }

  /** Stats per variant (BUY signals only by default — near-misses are reported separately). */
  async report(): Promise<{ variants: Array<LabStats & { live: boolean; ownerOnly: boolean; near: LabStats }>; applied: { id: string; at: number } | null; open: number; autoApply: boolean; minTrades: number }> {
    const c = this.cfg();
    const applied = await this.appliedVariant();
    const current = applied?.id ?? c.liveVariant;
    const out = [];
    for (const v of c.variants as LabVariant[]) {
      const rows = await this.results(v.id);
      out.push({ ...labStats(v.id, v.name, rows.filter((r) => r.kind === 'buy')), live: v.id === current, ownerOnly: !!v.ownerOnly, near: labStats(v.id, v.name, rows.filter((r) => r.kind === 'near')) });
    }
    return { variants: out, applied, open: this.book.size, autoApply: c.autoApply, minTrades: c.minTrades };
  }

  private async appliedVariant(): Promise<{ id: string; at: number } | null> {
    const raw = await this.redis.get(APPLIED_KEY);
    return raw ? (JSON.parse(raw) as { id: string; at: number }) : null;
  }

  /** Switch the live exits to the best variant when the evidence is strong (see pickBest). */
  async maybeApply(now = Date.now()): Promise<string | null> {
    const c = this.cfg();
    if (!c.enabled || !c.autoApply) return null;
    try {
      const applied = await this.appliedVariant();
      if (applied && now - applied.at < c.applyEveryHours * 3_600_000) return null;
      const current = applied?.id ?? c.liveVariant;
      const stats: LabStats[] = [];
      // Owner-only variants (e.g. a stop outside the owner's band) are reported, never applied.
      for (const v of c.variants as LabVariant[]) if (!v.ownerOnly) stats.push(labStats(v.id, v.name, (await this.results(v.id)).filter((r) => r.kind === 'buy')));
      const best = pickBest(stats, current, c);
      if (!best) return null;
      const v = (c.variants as LabVariant[]).find((x) => x.id === best.id)!;
      const live = getConfig().exit;
      const next = variantRules(live, v);
      await updateConfigSection('exit', next);
      await this.redis.set(APPLIED_KEY, JSON.stringify({ id: v.id, at: now }));
      const msg = `Strategy lab: switched the exits to "${v.name}" (${best.n} test trades, avg ${best.avgPnlPct}% per trade, ${best.winRate}% wins)`;
      log.info({ variant: v.id, stats: best }, msg);
      void recordEvent({ module: 'strategy-lab', type: 'lab_applied', message: msg, data: { variant: v.id, n: best.n, avgPnlPct: best.avgPnlPct, winRate: best.winRate, lowerPct: best.lowerPct } });
      return v.id;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'lab auto-apply failed');
      return null;
    }
  }
}
