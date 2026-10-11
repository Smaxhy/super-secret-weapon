/**
 * Sell manager — watches every open position and executes the exit rules.
 *
 * Runs every 2 seconds. For each open position it reads the live curve state
 * and the trade tape, and asks `decideExit()` (a pure function — easy to test,
 * no side effects) what to do. Rules, checked in this order:
 *
 *   1. MIGRATED        curve completed → exit (post-migration tracking is Phase 6)
 *   2. RUG_DETECTED    the dev sells (any meaningful amount if they held > 2%,
 *                      or ≥ 10% of their bag), top-10 concentration jumps ≥ 15
 *                      points while we're underwater, a sell-side avalanche
 *                      (≥ 70% of last-minute volume is sells and price −25%),
 *                      or a single whale sell ≥ 15% of curve liquidity
 *   3. STOP_LOSS       price ≤ entry × 0.6 (−40%) — the disaster stop
 *   4. STOP_LOSS       break-even: once up 50%, never let it close below entry + costs
 *   5. TAKE_PROFIT     sell 30% of the original at 2x, another 30% at 5x
 *   6. STRUCTURE_BREAK after being up ≥ 30%, a close below the last swing low
 *                      → the uptrend is over, sell the rest
 *   7. TRAILING_STOP   once the peak hits 2x, sell the rest if price falls X%
 *                      from peak — X adapts to chart strength (18% weak … 40%
 *                      strong) so a strong coin isn't shaken out on noise
 *   8. MOMENTUM_FADE   up ≥ 25% but sellers own the tape and price is 12% off
 *                      the peak → bank half, once
 *   9. TIME_STOP       still ≤ −3% after the strategy's time budget (8 min for
 *                      curve snipes) with no uptrend → cut it; the capital is
 *                      worth more in the next setup
 *  10. STALE           price hasn't moved >5% for 30 min (curve) / 2h (migration)
 *
 * Positions are re-read from the database every tick, so a restart loses nothing.
 */
import type { ExitReason, Position } from '@prisma/client';
import type { BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { logTrade } from '../learner/trade-logger';
import { curvePriceSol } from '../lib/pumpfun';
import { deriveMetrics, type LiveState } from '../scanner/live-state';
import { analyzePriceAction, type PriceAction } from '../evaluator/price-action';
import type { EntryContext } from './trader';
import type { Executor } from './types';

const log = moduleLogger('sell-manager');
const TICK_MS = 2_000;
/** A price change smaller than this doesn't count as "movement" for the stale rule. */
const MOVE_THRESHOLD = 0.05;

/** The slice of the chart read the exit rules use (so tests don't need a full PriceAction). */
export type ExitChart = Pick<PriceAction, 'strength' | 'buyVolShare60' | 'netFlowSol60' | 'change60Pct' | 'trendSlopePctPerMin' | 'recentSlopePctPerMin' | 'lastSwingLow' | 'largestSellSol60' | 'trades60' | 'higherLows'>;

export interface PositionFlags {
  fadeSold?: boolean;
}

export interface ExitInput {
  entryPriceSol: number;
  peakPriceSol: number;
  remainingPct: number;
  tpTiersHit: number[];
  trailingActive: boolean;
  refPriceSol: number;
  lastMoveAtMs: number;
  staleMinutes: number;
  priceSol: number;
  complete: boolean;
  devHoldingPctEntry: number;
  devHoldingPctNow: number;
  top10PctEntry: number;
  top10PctNow: number;
  nowMs: number;
  // --- trader-style inputs (all optional so the classic rules still work alone) ---
  openedAtMs?: number;
  timeStopMinutes?: number;
  liquiditySol?: number;
  chart?: ExitChart | null;
  flags?: PositionFlags;
}

export interface ExitDecision {
  /** Sells to execute now, each as % of the ORIGINAL position. */
  sells: Array<{ pct: number; reason: ExitReason; detail: string }>;
  state: { peakPriceSol: number; trailingActive: boolean; refPriceSol: number; lastMoveAtMs: number; tpTiersHit: number[]; flags: PositionFlags };
}

/** Trailing distance for the current chart: weak → tight, strong → wide. */
export function adaptiveTrailingPct(chart: ExitChart | null | undefined, rules: BotConfigShape['exit']): number {
  if (!chart || chart.trades60 === 0) return rules.trailingStopPct;
  return rules.trailingStopPctWeak + (rules.trailingStopPctStrong - rules.trailingStopPctWeak) * Math.max(0, Math.min(1, chart.strength));
}

export function decideExit(i: ExitInput, rules: BotConfigShape['exit']): ExitDecision {
  const state = {
    peakPriceSol: Math.max(i.peakPriceSol, i.priceSol),
    trailingActive: i.trailingActive,
    refPriceSol: i.refPriceSol,
    lastMoveAtMs: i.lastMoveAtMs,
    tpTiersHit: [...i.tpTiersHit],
    flags: { ...(i.flags ?? {}) },
  };
  const all = (reason: ExitReason, detail: string): ExitDecision => ({ sells: [{ pct: i.remainingPct, reason, detail }], state });
  const multiple = i.priceSol / i.entryPriceSol;
  const peakMultiple = state.peakPriceSol / i.entryPriceSol;
  const chart = i.chart ?? null;

  if (i.complete) return all('MIGRATED', 'bonding curve completed');

  // --- rugs ---------------------------------------------------------------
  if (i.devHoldingPctEntry > 0.1) {
    const devSoldPct = ((i.devHoldingPctEntry - i.devHoldingPctNow) / i.devHoldingPctEntry) * 100;
    const limit = i.devHoldingPctEntry >= rules.rugExit.devAnySellMinHoldingPct ? Math.min(2, rules.rugExit.devDumpPct) : rules.rugExit.devDumpPct;
    if (devSoldPct >= limit) return all('RUG_DETECTED', `dev sold ${devSoldPct.toFixed(0)}% of their bag`);
  }
  if (multiple < 1 && i.top10PctNow - i.top10PctEntry >= rules.rugExit.holderConcentrationSpikePct) {
    return all('RUG_DETECTED', `top-10 concentration ${i.top10PctEntry.toFixed(1)}% → ${i.top10PctNow.toFixed(1)}%`);
  }
  if (chart && chart.trades60 >= 3) {
    const sellShare = (1 - chart.buyVolShare60) * 100;
    if (sellShare >= rules.rugExit.sellSpike.sellSharePct && chart.change60Pct <= -rules.rugExit.sellSpike.dropPct) {
      return all('RUG_DETECTED', `sell avalanche: ${sellShare.toFixed(0)}% of last-minute volume sold, price ${chart.change60Pct.toFixed(0)}% in 60s`);
    }
    if (i.liquiditySol && i.liquiditySol > 0 && chart.largestSellSol60 >= (rules.rugExit.singleSellLiquidityPct / 100) * i.liquiditySol && i.priceSol < state.peakPriceSol * 0.9) {
      return all('RUG_DETECTED', `whale exit: single sell of ${chart.largestSellSol60.toFixed(2)} SOL (${((chart.largestSellSol60 / i.liquiditySol) * 100).toFixed(0)}% of liquidity)`);
    }
  }

  // --- stops --------------------------------------------------------------
  if (multiple <= 1 - rules.hardStopLossPct / 100) return all('STOP_LOSS', `${((multiple - 1) * 100).toFixed(1)}%`);
  if (peakMultiple >= rules.breakEvenActivateMultiple && multiple <= rules.breakEvenStopMultiple) {
    return all('STOP_LOSS', `break-even stop: peaked ${peakMultiple.toFixed(2)}x, now ${multiple.toFixed(2)}x`);
  }

  // --- take profit --------------------------------------------------------
  const sells: ExitDecision['sells'] = [];
  let remaining = i.remainingPct;
  for (const tier of rules.takeProfitTiers) {
    if (multiple >= tier.multiple && !state.tpTiersHit.includes(tier.multiple) && remaining > 0) {
      const pct = Math.min(tier.sellPct, remaining);
      sells.push({ pct, reason: 'TAKE_PROFIT', detail: `${tier.multiple}x tier` });
      state.tpTiersHit.push(tier.multiple);
      remaining -= pct;
    }
  }

  // --- structure stop: the uptrend that paid us is broken -------------------
  if (remaining > 0 && chart?.lastSwingLow && peakMultiple >= rules.structureStop.minPeakMultiple && i.priceSol < state.peakPriceSol) {
    if (i.priceSol <= chart.lastSwingLow * (1 - rules.structureStop.breakPct / 100) && chart.lastSwingLow > i.entryPriceSol * 0.9) {
      sells.push({ pct: remaining, reason: 'STRUCTURE_BREAK', detail: `closed ${((1 - i.priceSol / chart.lastSwingLow) * 100).toFixed(1)}% below swing low after ${peakMultiple.toFixed(2)}x peak` });
      return { sells, state };
    }
  }

  // --- trailing stop (adaptive) -------------------------------------------
  if (state.peakPriceSol >= i.entryPriceSol * rules.trailingStopActivateMultiple) state.trailingActive = true;
  const trailPct = adaptiveTrailingPct(chart, rules);
  if (state.trailingActive && remaining > 0 && i.priceSol <= state.peakPriceSol * (1 - trailPct / 100)) {
    sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `${peakMultiple.toFixed(2)}x peak, now ${multiple.toFixed(2)}x (trail ${trailPct.toFixed(0)}%)` });
    return { sells, state };
  }

  // --- momentum fade: bank half when sellers take over a winner ------------
  const fade = rules.momentumFade;
  if (remaining > 0 && chart && !state.flags.fadeSold && multiple >= fade.minMultiple && i.priceSol <= state.peakPriceSol * (1 - fade.dropFromPeakPct / 100)) {
    if (chart.trades60 >= 3 && chart.buyVolShare60 < 0.45 && chart.netFlowSol60 < 0) {
      let pct = (remaining * fade.sellPct) / 100;
      if (remaining - pct < rules.minSellChunkPct) pct = remaining; // don't leave a crumb
      sells.push({ pct, reason: 'MOMENTUM_FADE', detail: `buy share ${(chart.buyVolShare60 * 100).toFixed(0)}%, ${((1 - i.priceSol / state.peakPriceSol) * 100).toFixed(0)}% off peak at ${multiple.toFixed(2)}x` });
      state.flags.fadeSold = true;
      remaining -= pct;
    }
  }

  // --- time stop: a trade that never worked ---------------------------------
  if (remaining > 0 && i.openedAtMs !== undefined && i.timeStopMinutes !== undefined && i.nowMs - i.openedAtMs >= i.timeStopMinutes * 60_000 && multiple <= rules.timeStopMaxMultiple) {
    const recovering = chart !== null && chart.trades60 >= 3 && chart.trendSlopePctPerMin > 0.5 && chart.buyVolShare60 >= 0.55;
    if (!recovering) {
      sells.push({ pct: remaining, reason: 'TIME_STOP', detail: `${multiple.toFixed(2)}x after ${Math.round((i.nowMs - i.openedAtMs) / 60_000)}m with no uptrend` });
      return { sells, state };
    }
  }

  // --- stale ----------------------------------------------------------------
  if (Math.abs(i.priceSol / state.refPriceSol - 1) > MOVE_THRESHOLD) {
    state.refPriceSol = i.priceSol;
    state.lastMoveAtMs = i.nowMs;
  } else if (remaining > 0 && i.nowMs - state.lastMoveAtMs >= i.staleMinutes * 60_000) {
    sells.push({ pct: remaining, reason: 'STALE', detail: `no movement for ${i.staleMinutes}m` });
  }
  return { sells, state };
}

export class SellManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly executor: Executor,
    private readonly liveState: LiveState,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private async tick(): Promise<void> {
    if (this.running) return; // previous tick still working
    this.running = true;
    try {
      const positions = await prisma.position.findMany({ where: { mode: this.executor.mode, status: 'OPEN' }, include: { token: { select: { symbol: true } } } });
      for (const p of positions) {
        try {
          await this.manage(p, p.token.symbol);
        } catch (err) {
          log.error({ positionId: p.id, err: (err as Error).message }, 'failed to manage position');
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'sell manager tick failed');
    } finally {
      this.running = false;
    }
  }

  /** Force-sell everything left in a position (manual sell / kill switch). */
  async closeNow(positionId: string, reason: ExitReason): Promise<void> {
    const p = await prisma.position.findUnique({ where: { id: positionId }, include: { token: { select: { symbol: true } } } });
    if (!p || p.status !== 'OPEN') return;
    await this.executeSell(p, p.token.symbol, p.remainingPct, reason, 'forced');
  }

  private async manage(p: Position, symbol: string): Promise<void> {
    const cfg = getConfig();
    const view = await this.liveState.read(p.mint);
    if (!view) {
      log.warn({ mint: p.mint }, 'no live state for open position — closing as STALE at zero value');
      await this.writeOff(p);
      return;
    }
    const m = deriveMetrics(view);
    const now = Date.now();
    const entry = (p.entryContext ?? {}) as Partial<EntryContext>;
    const chart = view.tape.length ? analyzePriceAction(view.tape, view.athPriceSol, now, m.priceSol) : null;
    const decision = decideExit(
      {
        entryPriceSol: p.entryPriceSol,
        peakPriceSol: p.peakPriceSol,
        remainingPct: p.remainingPct,
        tpTiersHit: (p.tpTiersHit as number[]) ?? [],
        trailingActive: p.trailingActive,
        refPriceSol: p.refPriceSol ?? p.entryPriceSol,
        lastMoveAtMs: (p.lastMoveAt ?? p.openedAt).getTime(),
        staleMinutes: cfg.exit.staleMinutes[p.strategy],
        priceSol: curvePriceSol(view.virtualSolReserves, view.virtualTokenReserves),
        complete: view.complete,
        devHoldingPctEntry: entry.devHoldingPct ?? 0,
        devHoldingPctNow: m.devHoldingPct,
        top10PctEntry: entry.top10HolderPct ?? m.top10HolderPct,
        top10PctNow: m.top10HolderPct,
        nowMs: now,
        openedAtMs: p.openedAt.getTime(),
        timeStopMinutes: cfg.exit.timeStopMinutes[p.strategy],
        liquiditySol: m.liquiditySol,
        chart,
        flags: (p.flags as PositionFlags | null) ?? {},
      },
      cfg.exit,
    );

    const s = decision.state;
    await prisma.position.update({
      where: { id: p.id },
      data: { peakPriceSol: s.peakPriceSol, trailingActive: s.trailingActive, refPriceSol: s.refPriceSol, lastMoveAt: new Date(s.lastMoveAtMs), tpTiersHit: s.tpTiersHit, flags: s.flags as object },
    });

    let current: Position = { ...p, peakPriceSol: s.peakPriceSol };
    for (const sell of decision.sells) {
      current = await this.executeSell(current, symbol, sell.pct, sell.reason, sell.detail);
      if (current.status !== 'OPEN') break;
    }
  }

  private async executeSell(p: Position, symbol: string, pct: number, reason: ExitReason, detail: string): Promise<Position> {
    const closing = p.remainingPct - pct <= 0.01;
    // On the final sell, sell exactly what's left (avoids rounding dust).
    const tokens = closing
      ? (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n
      : (p.tokenAmountRaw * BigInt(Math.round(pct * 100))) / 10_000n;
    const fill = await this.executor.sell({ mint: p.mint, tokenAmountRaw: tokens, maxSlippageBps: 2_500 });
    const soldPct = closing ? p.remainingPct : pct;
    const costBasis = (p.sizeSol * soldPct) / 100;
    const pnl = fill.ok ? fill.solAmount - fill.feeSol - costBasis : 0;

    return prisma.$transaction(async (tx) => {
      await logTrade(
        {
          positionId: p.id,
          mint: p.mint,
          symbol,
          side: 'SELL',
          mode: p.mode,
          strategy: p.strategy,
          fill,
          reason: `${reason}: ${detail}`,
          context: { pct: soldPct, costBasis, multiple: fill.priceSol / p.entryPriceSol, peakMultiple: p.peakPriceSol / p.entryPriceSol, heldSec: Math.round((Date.now() - p.openedAt.getTime()) / 1000) },
          pnlSol: fill.ok ? pnl : undefined,
        },
        tx,
      );
      if (!fill.ok) return p;
      if (closing && reason === 'RUG_DETECTED') await tx.token.update({ where: { mint: p.mint }, data: { status: 'RUGGED' } });
      return tx.position.update({
        where: { id: p.id },
        data: {
          remainingPct: closing ? 0 : p.remainingPct - pct,
          realizedPnlSol: { increment: pnl },
          ...(closing ? { status: 'CLOSED' as const, closedAt: new Date(), exitReason: reason } : {}),
        },
      });
    });
  }

  private async writeOff(p: Position): Promise<void> {
    await prisma.position.update({
      where: { id: p.id },
      data: { status: 'CLOSED', closedAt: new Date(), exitReason: 'STALE', remainingPct: 0, realizedPnlSol: { decrement: (p.sizeSol * p.remainingPct) / 100 } },
    });
  }
}
