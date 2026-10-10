/**
 * Trader — turns a BUY decision into an open position, if risk rules allow.
 *
 * Every entry passes these gates, in order (each refusal is logged with why):
 *   1. Kill switch / paused
 *   2. Strategy enabled
 *   3. Daily circuit breaker (realised P&L today ≤ −20% of capital → no new entries)
 *   4. Max concurrent positions
 *   5. Never enter the same token twice
 *   6. Strategy capital allocation (e.g. curve snipes may use 15% of capital)
 *   7. Wallet balance check
 * Then: size the position, execute through the Executor, and record it.
 *
 * Entries run one at a time (a small mutex) so two tokens can't both grab the
 * last free slot.
 */
import type { Strategy } from '@prisma/client';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { strategySince } from '../config/migrations';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { logTrade } from '../learner/trade-logger';
import { currentHourFactor, currentRegime } from '../learner/regime-detector';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { Executor } from './types';

const log = moduleLogger('trader');

export interface EntryRequest {
  mint: string;
  symbol: string;
  strategy: Strategy;
  evaluationId: string | null;
  score: number;
  market: MarketRaw;
  maxSlippageBps: number;
  features: Record<string, number>;
  /** Copy trades: the wallet we copied (its sells trigger our exit). */
  copiedWallet?: string;
  /** < 1 for higher-risk entries (e.g. bundled tokens bought at half size). */
  sizeMultiplier?: number;
  /** Swing re-entry: may buy a token we traded before (up to focus.swing.maxReentries; SWING: see swingReentryReason). */
  swing?: boolean;
  /** Learning trade (config `explore`): a near-miss bought small so the bot learns from it. */
  explore?: boolean;
  /** Builds the human-readable "why we bought" once the size is known. */
  explain?: (sizeSol: number) => string;
}

export interface EntryResult {
  entered: boolean;
  reason: string;
  positionId?: string;
}

export class Trader {
  private lock: Promise<unknown> = Promise.resolve();
  private breakerTrippedDay: string | null = null;
  /** Pre-entry rug screen, run right before every buy (set in index.ts). Returns a reason to refuse, or null. */
  screen: ((req: EntryRequest) => Promise<string | null>) | null = null;

  constructor(private readonly executor: Executor) {}

  tryEnter(req: EntryRequest): Promise<EntryResult> {
    const run = this.lock.then(() => this.enter(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async enter(req: EntryRequest): Promise<EntryResult> {
    const cfg = getConfig();
    const mode = this.executor.mode;
    const refuse = (reason: string): EntryResult => {
      log.info({ mint: req.mint, symbol: req.symbol, reason }, `⏭  not entering ${req.symbol}: ${reason}`);
      return { entered: false, reason };
    };

    if (cfg.state.killSwitch) return refuse('kill switch active');
    if (cfg.state.paused) return refuse('bot paused');
    if (!cfg.trading.enabledStrategies[req.strategy]) return refuse(`strategy ${req.strategy} disabled`);

    const open = await prisma.position.findMany({ where: { mode, status: { in: ['OPEN', 'CLOSING'] } } });
    const balance = await this.executor.getBalanceSol();
    const openCost = open.reduce((s, p) => s + (p.sizeSol * p.remainingPct) / 100, 0);
    const capital = balance + openCost;

    const dailyPnl = await realisedPnlToday(mode);
    if (dailyPnl <= -(cfg.exit.dailyLossCircuitBreakerPct / 100) * capital) {
      const day = new Date().toISOString().slice(0, 10);
      if (this.breakerTrippedDay !== day) {
        this.breakerTrippedDay = day;
        void recordEvent({ level: 'WARN', module: 'trader', type: 'circuit_breaker', message: `Daily P&L ${dailyPnl.toFixed(3)} SOL hit the −${cfg.exit.dailyLossCircuitBreakerPct}% breaker — no new entries until 00:00 UTC` });
      }
      return refuse('daily loss circuit breaker');
    }

    if (open.length >= cfg.trading.maxConcurrentPositions) return refuse(`max ${cfg.trading.maxConcurrentPositions} positions open`);
    const perStrategy = (cfg.trading.maxOpenByStrategy as Partial<Record<string, number>> | undefined)?.[req.strategy];
    if (perStrategy !== undefined && open.filter((p) => p.strategy === req.strategy).length >= perStrategy) return refuse(`max ${perStrategy} ${req.strategy} positions open`);
    // Strategy cool-off: its recent trades are clearly losing → no new entries for a while.
    const cool = await strategyCoolOff(req.strategy, mode, cfg.trading.strategyBreaker);
    if (cool) return refuse(cool);
    // Copy trades are heavily restricted.
    if (req.strategy === 'SMART_MONEY_COPY' && open.filter((p) => p.strategy === 'SMART_MONEY_COPY').length >= (cfg.copy.maxOpen ?? 1)) return refuse('copy trade limit reached');
    // Learning trades: a few at a time, a few per hour.
    if (req.explore) {
      const ex = cfg.explore ?? DEFAULT_CONFIG.explore;
      if (!ex.enabled) return refuse('learning trades are off');
      if (open.filter(isExplore).length >= ex.maxOpen) return refuse(`max ${ex.maxOpen} learning trades open`);
      const lastHour = await prisma.position.findMany({ where: { mode, openedAt: { gte: new Date(Date.now() - 3600_000) } }, select: { entryContext: true } });
      if (lastHour.filter(isExplore).length >= ex.maxPerHour) return refuse(`max ${ex.maxPerHour} learning trades per hour`);
    }
    const before = await prisma.position.findMany({ where: { mint: req.mint, mode }, select: { status: true, closedAt: true, exitReason: true, realizedPnlSol: true } });
    if (before.length && req.strategy === 'SWING') {
      // Swing trading a coin that keeps bouncing means trading it again and again — with cooldowns.
      const why = swingReentryReason(
        before.map((p) => ({ status: p.status, closedAtMs: p.closedAt?.getTime() ?? null, exitReason: p.exitReason, pnlSol: p.realizedPnlSol })),
        Date.now(),
        cfg.swing ?? DEFAULT_CONFIG.swing,
      );
      if (why) return refuse(why);
    } else if (before.length) {
      const sw = cfg.focus.swing;
      if (!req.swing || !sw.enabled) return refuse('already traded this token');
      if (before.some((p) => p.status !== 'CLOSED')) return refuse('still holding this token');
      if (before.some((p) => p.exitReason === 'RUG_DETECTED')) return refuse('rugged before — no swing re-entry');
      // Re-buying a coin that already beat us was the bot's worst habit (same coin, 4 stop losses in a row).
      // Only a coin we made money on gets another go.
      if ((sw.onlyAfterProfit ?? true) && before.some((p) => p.realizedPnlSol <= 0)) return refuse('lost on this coin before — no re-entry');
      if (before.length > sw.maxReentries) return refuse(`swing re-entries used up (${sw.maxReentries})`);
      const last = Math.max(...before.map((p) => p.closedAt?.getTime() ?? 0));
      if (Date.now() - last < sw.cooldownSec * 1000) return refuse('swing cooldown');
    }

    const strategyOpen = open.filter((p) => p.strategy === req.strategy).reduce((s, p) => s + (p.sizeSol * p.remainingPct) / 100, 0);
    const budget = capital * cfg.trading.allocation[req.strategy] - strategyOpen;
    const reserve = cfg.paper.txFeeSol * 4 + 0.01; // keep enough to pay for the exits
    // Market mood scales position size (e.g. ×1.2 when hot, ×0.5 when rug-heavy).
    // …and by time of day: hours that historically produce more winners get bigger size.
    const sized = Math.min(cfg.trading.maxPositionSol * cfg.regimeAdjustments[currentRegime()].sizeMultiplier * currentHourFactor(), cfg.trading.maxPositionSolCeiling);
    // Conviction & other multipliers scale around maxPositionSol, capped at ×maxConvictionMultiple
    // of it and at maxPositionPctOfCapital % of capital.
    const t = cfg.trading;
    const cap = Math.min(t.maxPositionSol * (t.maxConvictionMultiple ?? 1.6), (capital * (t.maxPositionPctOfCapital ?? 100)) / 100);
    let size = Math.min(sized * (req.sizeMultiplier ?? 1), cap, budget, balance - reserve);
    // A learning trade is small on purpose — the minimum size, if the budget allows it.
    if (req.explore && size < cfg.trading.minPositionSol && Math.min(cap, budget, balance - reserve) >= cfg.trading.minPositionSol) size = cfg.trading.minPositionSol;
    if (size < cfg.trading.minPositionSol) {
      return refuse(`size ${size.toFixed(3)} SOL below minimum (balance ${balance.toFixed(3)}, ${req.strategy} budget ${budget.toFixed(3)})`);
    }

    // Last look before the money moves: has anything rug-like happened since the signal?
    const rug = this.screen ? await this.screen(req) : null;
    if (rug) {
      void recordEvent({ level: 'WARN', module: 'trader', type: 'rug_screen', mint: req.mint, message: `${req.symbol}: buy blocked — ${rug}` });
      return refuse(`rug screen: ${rug}`);
    }

    const fill = await this.executor.buy({ mint: req.mint, solAmount: round4(size), maxSlippageBps: req.maxSlippageBps, expectedPriceSol: req.market.priceSol });
    const explanation = req.explain?.(size) ?? null;
    const context = { score: req.score, market: req.market, features: req.features, balanceBefore: balance, explanation };
    if (!fill.ok) {
      await logTrade({ positionId: null, mint: req.mint, symbol: req.symbol, side: 'BUY', mode, strategy: req.strategy, fill, reason: 'entry failed', context });
      return refuse(`execution failed: ${fill.error}`);
    }

    const position = await prisma.$transaction(async (tx) => {
      const p = await tx.position.create({
        data: {
          mint: req.mint,
          strategy: req.strategy,
          mode,
          evaluationId: req.evaluationId,
          entryPriceSol: fill.priceSol,
          sizeSol: fill.solAmount,
          tokenAmountRaw: fill.tokenAmountRaw,
          peakPriceSol: fill.priceSol,
          refPriceSol: fill.priceSol,
          lastMoveAt: new Date(),
          entryContext: {
            devHoldingPct: req.market.devHoldingPct,
            earlyBuyerPct: req.market.earlyBuyerPct,
            copiedWallet: req.copiedWallet ?? null,
            swing: req.swing === true,
            explore: req.explore === true,
            // Counted into each sell's cost basis so P&L includes the buy's gas/tip.
            buyFeeSol: fill.feeSol,
            explanation,
            top10HolderPct: req.market.top10HolderPct,
            holders: req.market.holders,
            marketCapSol: req.market.marketCapSol,
            // For the dashboard's "bought at" market cap + price chart.
            marketCapUsd: req.market.marketCapUsd,
            priceSol: fill.priceSol,
            // Whole tokens in existence (pump.fun = 1 billion). Worked out from the
            // evaluator's market cap ÷ price; falls back to 1e9 if that's unusable.
            totalSupplyTokens: supplyTokensFrom(req.market.marketCapSol, req.market.priceSol),
          },
        },
      });
      await logTrade({ positionId: p.id, mint: req.mint, symbol: req.symbol, side: 'BUY', mode, strategy: req.strategy, fill, reason: `entry: score ${req.score.toFixed(1)}`, context }, tx);
      return p;
    });
    return { entered: true, reason: 'entered', positionId: position.id };
  }
}

/**
 * Strategy cool-off (pure part): the last trades of a strategy, newest first, as % P&L on their
 * size + when each closed. Tripped → the reason string, else null. Pure.
 */
export function coolOffReason(
  closed: ReadonlyArray<{ pnlPct: number; closedAtMs: number }>,
  now: number,
  b: { enabled: boolean; lastN: number; minTrades: number; maxAvgPnlPct: number; pauseMinutes: number },
): string | null {
  if (!b.enabled) return null;
  const last = closed.slice(0, b.lastN);
  if (last.length < b.minTrades) return null;
  const avg = last.reduce((s, x) => s + x.pnlPct, 0) / last.length;
  const latest = last[0]!.closedAtMs;
  const left = latest + b.pauseMinutes * 60_000 - now;
  if (avg >= b.maxAvgPnlPct || left <= 0) return null;
  return `cooling off: last ${last.length} trades average ${avg.toFixed(1)}% — paused ${Math.ceil(left / 60_000)} more min (the strategy lab keeps testing)`;
}

async function strategyCoolOff(strategy: Strategy, mode: 'PAPER' | 'LIVE', b: { enabled: boolean; lastN: number; minTrades: number; maxAvgPnlPct: number; pauseMinutes: number } | undefined): Promise<string | null> {
  if (!b?.enabled) return null;
  // Only trades of the current strategy version count (the old setup's losses aren't this one's).
  const since = await strategySince();
  // Learning trades (near-misses bought small) don't count: they're expected to lose more often.
  const rows = (await prisma.position.findMany({ where: { strategy, mode, status: 'CLOSED', ...(since ? { openedAt: { gte: since } } : {}) }, orderBy: { closedAt: 'desc' }, take: b.lastN * 2, select: { realizedPnlSol: true, sizeSol: true, closedAt: true, entryContext: true } }))
    .filter((r) => !isExplore(r))
    .slice(0, b.lastN);
  return coolOffReason(rows.map((r) => ({ pnlPct: r.sizeSol > 0 ? (r.realizedPnlSol / r.sizeSol) * 100 : 0, closedAtMs: r.closedAt?.getTime() ?? 0 })), Date.now(), b);
}

/** A learning trade (entryContext.explore)? */
export function isExplore(p: { entryContext?: unknown }): boolean {
  return (p.entryContext as { explore?: boolean } | null | undefined)?.explore === true;
}

/**
 * SWING re-entries (pure): a coin that keeps bouncing is traded again and again — but not right
 * after a close (`reentryCooldownMin`, `lossCooldownMin` after a loss), at most
 * `maxTradesPerCoinPerDay` a day, never after a rug, and two losses in a row pause it for
 * `lossStreakPauseHours`. Returns the reason to refuse, or null.
 */
export function swingReentryReason(
  before: ReadonlyArray<{ status: string; closedAtMs: number | null; exitReason: string | null; pnlSol: number }>,
  now: number,
  c: { reentryCooldownMin: number; lossCooldownMin: number; maxTradesPerCoinPerDay: number; lossStreakPauseHours: number },
): string | null {
  if (before.some((p) => p.status !== 'CLOSED')) return 'still holding this token';
  if (before.some((p) => p.exitReason === 'RUG_DETECTED')) return 'rugged before — no more swings on it';
  const closed = before.filter((p): p is typeof p & { closedAtMs: number } => p.closedAtMs !== null).sort((a, b) => b.closedAtMs - a.closedAtMs);
  const last = closed[0];
  if (last) {
    const wait = (last.pnlSol > 0 ? c.reentryCooldownMin : c.lossCooldownMin) * 60_000;
    if (now - last.closedAtMs < wait) return `swing cooldown (${Math.ceil((wait - (now - last.closedAtMs)) / 60_000)} min left${last.pnlSol > 0 ? '' : ' after a loss'})`;
  }
  const today = closed.filter((p) => now - p.closedAtMs < 24 * 3600_000).length;
  if (today >= c.maxTradesPerCoinPerDay) return `traded ${today}× in 24 h (max ${c.maxTradesPerCoinPerDay})`;
  if (closed.length >= 2 && closed[0]!.pnlSol <= 0 && closed[1]!.pnlSol <= 0 && now - closed[0]!.closedAtMs < c.lossStreakPauseHours * 3600_000) return 'lost twice in a row on this coin — paused';
  return null;
}

/** Sum of realised P&L from sells since 00:00 UTC. */
export async function realisedPnlToday(mode: 'PAPER' | 'LIVE'): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const sells = await prisma.trade.findMany({
    where: { mode, side: 'SELL', createdAt: { gte: midnight }, status: { in: ['SIMULATED', 'CONFIRMED'] } },
    select: { context: true },
  });
  return sells.reduce((s, t) => s + Number((t.context as { pnlSol?: number } | null)?.pnlSol ?? 0), 0);
}

/** Total supply in whole tokens = market cap ÷ price (pump.fun default 1e9 if unknown). */
function supplyTokensFrom(marketCapSol: number, priceSol: number): number {
  const s = priceSol > 0 ? marketCapSol / priceSol : 0;
  return Number.isFinite(s) && s > 0 ? Math.round(s) : 1_000_000_000;
}

function round4(x: number): number {
  return Math.floor(x * 10_000) / 10_000;
}
