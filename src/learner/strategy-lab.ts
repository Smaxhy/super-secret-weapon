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
import { decideExit, exitCostPctFor, settledHigh, trailRules, type ExitInput } from '../executor/sell-manager';
import { poolFeeBps } from '../lib/pumpfun';

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
}

interface VPos {
  variant: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  kind: 'buy' | 'near';
  onAmm: boolean;
  sizeSol: number;
  costSol: number;
  tokens: number;
  entryPriceSol: number;
  openedAt: number;
  remainingPct: number;
  proceedsSol: number;
  peakPriceSol: number;
  trailingActive: boolean;
  tpTiersHit: number[];
  refPriceSol: number;
  lastMoveAtMs: number;
  breachSinceMs: number | null;
  breachTicks: number;
  lastCheck: number;
  peakAtMs: number;
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
    lowerPct: r1(n > 1 ? mean - sd / Math.sqrt(n) : mean),
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
  private readonly open = new Map<string, VPos>();
  private readonly lastStep = new Map<string, number>();
  /** Last signal per coin + strategy (one lab trade per coin + strategy per `SIGNAL_COOLDOWN_MS`). */
  private readonly lastSignal = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private applyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly crowd: CrowdTracker,
  ) {}

  private cfg(): BotConfigShape['lab'] {
    return getConfig().lab ?? DEFAULT_CONFIG.lab;
  }

  start(): void {
    this.timer = setInterval(() => this.stepAll(), 1_000);
    this.timer.unref?.();
    this.applyTimer = setInterval(() => void this.maybeApply(), 15 * 60_000);
    this.applyTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.applyTimer) clearInterval(this.applyTimer);
  }

  openCount(): number {
    return this.open.size;
  }

  /**
   * A signal from the evaluator: 'buy' = the bot decided to buy (whether or not the trader
   * had room), 'near' = rules passed but the score fell just short. Opens one virtual
   * position per variant (once per coin + strategy + variant while open).
   */
  onSignal(s: { mint: string; symbol: string; strategy: StrategyName; kind: 'buy' | 'near'; priceSol: number; onAmm: boolean }, now = Date.now()): void {
    const c = this.cfg();
    if (!c.enabled || !(s.priceSol > 0)) return;
    if (this.open.size >= c.maxOpen) return;
    // One lab trade per coin + strategy per half hour (a coin re-checked every minute isn't 30 samples).
    const sk = `${s.mint}:${s.strategy}`;
    if (now - (this.lastSignal.get(sk) ?? 0) < SIGNAL_COOLDOWN_MS) return;
    this.lastSignal.set(sk, now);
    if (this.lastSignal.size > 20_000) for (const [k, t] of this.lastSignal) if (now - t > SIGNAL_COOLDOWN_MS) this.lastSignal.delete(k);
    const p = getConfig().paper;
    const feeBps = poolFeeBps(p, s.onAmm, s.priceSol * 1e9);
    const sizeSol = getConfig().trading.maxPositionSol;
    const tokens = (sizeSol * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100)) / s.priceSol;
    if (!(tokens > 0)) return;
    for (const v of c.variants) {
      const key = `${v.id}:${s.mint}:${s.strategy}`;
      if (this.open.has(key)) continue;
      this.open.set(key, {
        variant: v.id,
        mint: s.mint,
        symbol: s.symbol,
        strategy: s.strategy,
        kind: s.kind,
        onAmm: s.onAmm,
        sizeSol,
        costSol: sizeSol + p.txFeeSol,
        tokens,
        entryPriceSol: sizeSol / tokens,
        openedAt: now,
        remainingPct: 100,
        proceedsSol: 0,
        peakPriceSol: sizeSol / tokens,
        trailingActive: false,
        tpTiersHit: [],
        refPriceSol: sizeSol / tokens,
        lastMoveAtMs: now,
        breachSinceMs: null,
        breachTicks: 0,
        lastCheck: now,
        peakAtMs: now,
      });
    }
  }

  /** A trade happened on `mint` (wired from the token registry): step its virtual positions. */
  onTrade(mint: string, now = Date.now()): void {
    if ((now - (this.lastStep.get(mint) ?? 0)) < 200) return;
    let any = false;
    for (const vp of this.open.values()) {
      if (vp.mint !== mint) continue;
      any = true;
      this.step(vp, now);
    }
    if (any) this.lastStep.set(mint, now);
  }

  private stepAll(now = Date.now()): void {
    for (const vp of [...this.open.values()]) this.step(vp, now);
    if (this.lastStep.size > 5_000) this.lastStep.clear();
  }

  private step(vp: VPos, now: number): void {
    const key = `${vp.variant}:${vp.mint}:${vp.strategy}`;
    const variant = this.cfg().variants.find((v) => v.id === vp.variant);
    if (!variant) {
      this.open.delete(key);
      return;
    }
    const trades = this.crowd.trades(vp.mint);
    const last = trades[trades.length - 1];
    const price = last ? (last.pp && last.pp > 0 ? last.pp : last.px) : 0;
    // No price for a long time (coin went quiet / dropped from the log) → close at the last price we had.
    if (!(price > 0)) {
      if (now - vp.openedAt > 60 * 60_000) this.finish(vp, key, vp.refPriceSol, 'no price', now);
      return;
    }
    const cfg = getConfig();
    const rules = variantRules(cfg.exit, variant);
    const holdMs = trailRules(rules).peakHoldMs ?? 1_200;
    const since = Math.max(vp.openedAt, vp.lastCheck - holdMs - 2_000);
    vp.lastCheck = now;
    const p = cfg.paper;
    const input: ExitInput = {
      entryPriceSol: vp.entryPriceSol,
      peakPriceSol: vp.peakPriceSol,
      remainingPct: vp.remainingPct,
      tpTiersHit: vp.tpTiersHit,
      trailingActive: vp.trailingActive,
      refPriceSol: vp.refPriceSol,
      lastMoveAtMs: vp.lastMoveAtMs,
      staleMinutes: cfg.exit.staleMinutes[vp.strategy],
      priceSol: price,
      migratedNoMarket: false,
      bundlePctEntry: 0,
      bundlePctNow: 0,
      devHoldingPctEntry: 0,
      devHoldingPctNow: 0,
      top10PctEntry: 0,
      top10PctNow: 0,
      nowMs: now,
      copyWalletSold: false,
      risk: 0,
      riskWhy: '',
      openedAtMs: vp.openedAt,
      maxHoldMinutes: cfg.exit.maxHoldMinutes[vp.strategy],
      resistance: { hit: false, level: 0, touches: 0 },
      sizeSol: vp.sizeSol,
      costSol: vp.costSol,
      proceedsSol: vp.proceedsSol,
      volatilityPct: null,
      txFeeSol: p.txFeeSol,
      priceTrusted: true,
      breachSinceMs: vp.breachSinceMs,
      breachTicks: vp.breachTicks,
      exitCostPct: exitCostPctFor(p, vp.onAmm, (vp.sizeSol * vp.remainingPct) / 100, price * 1e9),
      strategy: vp.strategy,
      instantPeak: true,
      recentHighSol: settledHigh(trades, since, now, holdMs, price * 2.5),
      peakAtMs: vp.peakAtMs,
      migratedAgoSec: null,
    };
    const d = decideExit(input, rules);
    vp.peakPriceSol = d.state.peakPriceSol;
    vp.trailingActive = d.state.trailingActive;
    vp.refPriceSol = d.state.refPriceSol;
    vp.lastMoveAtMs = d.state.lastMoveAtMs;
    vp.tpTiersHit = d.state.tpTiersHit;
    vp.breachSinceMs = d.state.breachSinceMs;
    vp.breachTicks = d.state.breachTicks;
    vp.peakAtMs = d.state.peakAtMs;
    const feeBps = poolFeeBps(p, vp.onAmm, price * 1e9);
    for (const s of d.sells) {
      const pct = Math.min(s.pct, vp.remainingPct);
      if (!(pct > 0)) continue;
      // Same costs as a paper sell: pool fee, slippage, tx fee.
      vp.proceedsSol += ((vp.tokens * pct) / 100) * price * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100) - p.txFeeSol;
      vp.remainingPct = Math.max(0, vp.remainingPct - pct);
      if (vp.remainingPct <= 0.01) {
        this.finish(vp, key, price, `${s.reason}: ${s.detail}`, now);
        return;
      }
    }
  }

  private finish(vp: VPos, key: string, price: number, reason: string, now: number): void {
    this.open.delete(key);
    const p = getConfig().paper;
    const feeBps = poolFeeBps(p, vp.onAmm, price * 1e9);
    if (vp.remainingPct > 0.01) {
      vp.proceedsSol += ((vp.tokens * vp.remainingPct) / 100) * price * (1 - feeBps / 10_000) * (1 - p.slippagePct / 100) - p.txFeeSol;
      vp.remainingPct = 0;
    }
    const r: LabResult = {
      variant: vp.variant,
      mint: vp.mint,
      symbol: vp.symbol,
      strategy: vp.strategy,
      kind: vp.kind,
      pnlPct: Math.round(((vp.proceedsSol - vp.costSol) / vp.costSol) * 10_000) / 100,
      peakX: Math.round((vp.peakPriceSol / vp.entryPriceSol) * 1000) / 1000,
      holdSec: Math.round((now - vp.openedAt) / 1000),
      reason: reason.slice(0, 160),
      at: now,
    };
    const keep = this.cfg().keepResults;
    void this.redis
      .multi()
      .lpush(resKey(vp.variant), JSON.stringify(r))
      .ltrim(resKey(vp.variant), 0, keep - 1)
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
    return { variants: out, applied, open: this.open.size, autoApply: c.autoApply, minTrades: c.minTrades };
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
