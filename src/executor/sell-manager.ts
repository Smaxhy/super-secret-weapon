/**
 * Sell manager — watches every open position and executes the exit rules.
 *
 * Runs every 2 seconds. For each open position it reads the live curve state
 * and asks `decideExit()` (a pure function — easy to test, no side effects)
 * what to do. Rules, checked in this order:
 *
 *   1. MIGRATED      curve completed → exit (post-migration tracking is Phase 6)
 *   2. RUG_DETECTED  dev sold ≥10% of what they held at our entry, or top-10
 *                    concentration jumped ≥15 points while we're underwater
 *                    (whales buying a pump also raises concentration — that's
 *                    not a rug, so it only counts when price is below entry)
 *   3. STOP_LOSS     price ≤ entry × 0.6 (−40%)
 *   4. TAKE_PROFIT   sell 30% of the original at 2x, another 30% at 5x
 *   5. TRAILING_STOP once the peak hits 2x, sell the rest if price falls 30% from peak
 *   6. STALE         price hasn't moved >5% for 30 min (curve) / 2h (migration)
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
import type { Executor } from './types';

const log = moduleLogger('sell-manager');
const TICK_MS = 2_000;
/** A price change smaller than this doesn't count as "movement" for the stale rule. */
const MOVE_THRESHOLD = 0.05;

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
}

export interface ExitDecision {
  /** Sells to execute now, each as % of the ORIGINAL position. */
  sells: Array<{ pct: number; reason: ExitReason; detail: string }>;
  state: { peakPriceSol: number; trailingActive: boolean; refPriceSol: number; lastMoveAtMs: number; tpTiersHit: number[] };
}

export function decideExit(i: ExitInput, rules: BotConfigShape['exit']): ExitDecision {
  const state = {
    peakPriceSol: Math.max(i.peakPriceSol, i.priceSol),
    trailingActive: i.trailingActive,
    refPriceSol: i.refPriceSol,
    lastMoveAtMs: i.lastMoveAtMs,
    tpTiersHit: [...i.tpTiersHit],
  };
  const all = (reason: ExitReason, detail: string): ExitDecision => ({ sells: [{ pct: i.remainingPct, reason, detail }], state });
  const multiple = i.priceSol / i.entryPriceSol;

  if (i.complete) return all('MIGRATED', 'bonding curve completed');

  if (i.devHoldingPctEntry > 0.1) {
    const devSoldPct = ((i.devHoldingPctEntry - i.devHoldingPctNow) / i.devHoldingPctEntry) * 100;
    if (devSoldPct >= rules.rugExit.devDumpPct) return all('RUG_DETECTED', `dev sold ${devSoldPct.toFixed(0)}% of their bag`);
  }
  if (multiple < 1 && i.top10PctNow - i.top10PctEntry >= rules.rugExit.holderConcentrationSpikePct) {
    return all('RUG_DETECTED', `top-10 concentration ${i.top10PctEntry.toFixed(1)}% → ${i.top10PctNow.toFixed(1)}%`);
  }

  if (multiple <= 1 - rules.hardStopLossPct / 100) return all('STOP_LOSS', `${((multiple - 1) * 100).toFixed(1)}%`);

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

  if (state.peakPriceSol >= i.entryPriceSol * rules.trailingStopActivateMultiple) state.trailingActive = true;
  if (state.trailingActive && remaining > 0 && i.priceSol <= state.peakPriceSol * (1 - rules.trailingStopPct / 100)) {
    sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `${(state.peakPriceSol / i.entryPriceSol).toFixed(2)}x peak, now ${multiple.toFixed(2)}x` });
    return { sells, state };
  }

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
    const entry = (p.entryContext ?? {}) as { devHoldingPct?: number; top10HolderPct?: number };
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
        nowMs: Date.now(),
      },
      cfg.exit,
    );

    const s = decision.state;
    await prisma.position.update({
      where: { id: p.id },
      data: { peakPriceSol: s.peakPriceSol, trailingActive: s.trailingActive, refPriceSol: s.refPriceSol, lastMoveAt: new Date(s.lastMoveAtMs), tpTiersHit: s.tpTiersHit },
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
    const costBasis = (p.sizeSol * pct) / 100;
    const pnl = fill.ok ? fill.solAmount - fill.feeSol - costBasis : 0;

    return prisma.$transaction(async (tx) => {
      await logTrade(
        { positionId: p.id, mint: p.mint, symbol, side: 'SELL', mode: p.mode, strategy: p.strategy, fill, reason: `${reason}: ${detail}`, context: { pct, costBasis, multiple: fill.priceSol / p.entryPriceSol }, pnlSol: fill.ok ? pnl : undefined },
        tx,
      );
      if (!fill.ok) return p;
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
