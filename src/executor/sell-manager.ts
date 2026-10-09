/**
 * Sell manager — watches every open position and executes the exit rules.
 *
 * Runs every 2 seconds. For each open position it reads the live state and
 * asks `decideExit()` (a pure function — easy to test) what to do. In order:
 *
 *   1. MIGRATED       curve completed but no PumpSwap market appeared in 10 min
 *   2. RUG_DETECTED   bundlers dumped / dev dumped / concentration spike while underwater
 *   3. COPY_EXIT      the tracked wallet we copied sold
 *   4. STOP_LOSS      hard −40%, or an early cut when risk is high and we're down 15%+
 *   5. TAKE_PROFIT    tiers: 30% at 1.3×, 40% at 1.8×, 20% at 3×
 *   6. TRAILING_STOP  after 1.25×, sell the rest 20% below the peak
 *   7. Protect profit once it reached 1.3×, never let it fall back below 1.05×
 *   7b. TAKE_PROFIT   resistance: rejected 2+ times at the same ceiling while ≥1.2× → sell
 *   8. TAKE_PROFIT    "risk rising": in profit (≥1.2×) and momentum is fading
 *                     (sells outnumber buys, holders leaving, falling from peak)
 *   9. Max hold time  don't sit in a trade forever (45m curve / 2h migration / 90m copy)
 *  10. STALE          price hasn't moved >5% for 30 min
 *
 * Positions are re-read from the database every tick, so a restart loses nothing.
 */
import type { ExitReason, Position } from '@prisma/client';
import type { BotConfigShape } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { explainSell } from '../learner/explain';
import { logTrade } from '../learner/trade-logger';
import { quoteSell } from '../lib/pumpfun';
import { deriveMetrics, type LiveState } from '../scanner/live-state';
import type { Redis } from 'ioredis';
import { PublicKey } from '@solana/web3.js';
import { decodeBondingCurveAccount } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';
import { copySoldKey } from '../scanner/whale-tracker';
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
  /** Curve completed, no PumpSwap pool seen for 10+ minutes — nowhere left to price it. */
  migratedNoMarket: boolean;
  bundlePctEntry: number;
  bundlePctNow: number;
  devHoldingPctEntry: number;
  devHoldingPctNow: number;
  top10PctEntry: number;
  top10PctNow: number;
  nowMs: number;
  /** The wallet this copy trade followed has sold. */
  copyWalletSold: boolean;
  /** 0-1 "this is turning" score from recent activity (see computeRisk). */
  risk: number;
  riskWhy: string;
  openedAtMs: number;
  maxHoldMinutes: number;
  /** Price keeps getting rejected at the same ceiling (see detectResistance). */
  resistance: { hit: boolean; level: number; touches: number };
}

export interface ActivitySample {
  t: number;
  buys: number;
  sells: number;
  holders: number;
  priceSol: number;
}

/**
 * Resistance: has the price touched the same high at least `minTouches`
 * separate times, falling back `rejectPct`% between touches, and is it below
 * that ceiling now? Pure — exported for tests.
 */
export function detectResistance(
  samples: ActivitySample[],
  now: number,
  r: { minTouches: number; bandPct: number; rejectPct: number; windowSec: number },
): { hit: boolean; level: number; touches: number } {
  const win = samples.filter((x) => now - x.t <= r.windowSec * 1000 && x.priceSol > 0);
  const cur = win[win.length - 1];
  if (!cur || win.length < 10) return { hit: false, level: 0, touches: 0 };
  const top = Math.max(...win.map((x) => x.priceSol));
  const bandLow = top * (1 - r.bandPct / 100);
  const rejectBelow = top * (1 - r.rejectPct / 100);
  let touches = 0;
  let inTouch = false;
  for (const x of win) {
    if (!inTouch && x.priceSol >= bandLow) {
      touches++;
      inTouch = true;
    } else if (inTouch && x.priceSol <= rejectBelow) {
      inTouch = false;
    }
  }
  return { hit: touches >= r.minTouches && cur.priceSol <= rejectBelow, level: top, touches };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * How likely the move is over, 0-1, from the last ~90 seconds of activity:
 * sells outnumbering buys, holders leaving, price falling from its peak and
 * over the window. Pure — exported for tests.
 */
export function computeRisk(samples: ActivitySample[], peakPriceSol: number, now: number, windowMs = 90_000): { risk: number; why: string } {
  const cur = samples[samples.length - 1];
  const old = samples.find((x) => now - x.t <= windowMs);
  if (!cur || !old || cur.t - old.t < windowMs / 2) return { risk: 0, why: 'not enough history' };
  const dB = cur.buys - old.buys;
  const dS = cur.sells - old.sells;
  const sellShare = dB + dS >= 4 ? dS / (dB + dS) : 0.5;
  const holderDelta = old.holders > 0 ? (cur.holders - old.holders) / old.holders : 0;
  const fromPeak = peakPriceSol > 0 ? 1 - cur.priceSol / peakPriceSol : 0;
  const windowMove = old.priceSol > 0 ? cur.priceSol / old.priceSol - 1 : 0;
  const parts = {
    sellPressure: clamp01((sellShare - 0.5) / 0.3),
    holdersLeaving: clamp01(-holderDelta / 0.1),
    offPeak: clamp01(fromPeak / 0.3),
    falling: clamp01(-windowMove / 0.2),
  };
  const risk = 0.35 * parts.sellPressure + 0.25 * parts.holdersLeaving + 0.2 * parts.offPeak + 0.2 * parts.falling;
  const why = `${Math.round(sellShare * 100)}% sells, holders ${holderDelta >= 0 ? '+' : ''}${(holderDelta * 100).toFixed(0)}%, ${(fromPeak * 100).toFixed(0)}% off peak`;
  return { risk, why };
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

  if (i.migratedNoMarket) return all('MIGRATED', 'migrated, no PumpSwap pool found');

  if (i.bundlePctEntry - i.bundlePctNow >= rules.rugExit.bundleDumpPct) {
    return all('RUG_DETECTED', `bundlers dumped ${(i.bundlePctEntry - i.bundlePctNow).toFixed(1)}% of supply`);
  }

  if (i.devHoldingPctEntry > 0.1) {
    const devSoldPct = ((i.devHoldingPctEntry - i.devHoldingPctNow) / i.devHoldingPctEntry) * 100;
    if (devSoldPct >= rules.rugExit.devDumpPct) return all('RUG_DETECTED', `dev sold ${devSoldPct.toFixed(0)}% of their bag`);
  }
  if (multiple < 1 && i.top10PctNow - i.top10PctEntry >= rules.rugExit.holderConcentrationSpikePct) {
    return all('RUG_DETECTED', `top-10 concentration ${i.top10PctEntry.toFixed(1)}% → ${i.top10PctNow.toFixed(1)}%`);
  }

  if (i.copyWalletSold) return all('COPY_EXIT', 'the wallet we copied sold');

  if (multiple <= 1 - rules.hardStopLossPct / 100) return all('STOP_LOSS', `${((multiple - 1) * 100).toFixed(1)}%`);
  // Don't wait for −40% when it's clearly turning against us.
  if (multiple <= rules.riskExit.cutLossBelowMultiple && i.risk >= rules.riskExit.threshold) {
    return all('STOP_LOSS', `early exit at ${((multiple - 1) * 100).toFixed(0)}%: ${i.riskWhy}`);
  }

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
  const peakX = state.peakPriceSol / i.entryPriceSol;
  const trailPct = rules.trailingTightening.reduce<number>((pct, t) => (peakX >= t.fromMultiple ? Math.min(pct, t.pct) : pct), rules.trailingStopPct);
  if (state.trailingActive && remaining > 0 && i.priceSol <= state.peakPriceSol * (1 - trailPct / 100)) {
    sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `${peakX.toFixed(2)}x peak, fell ${trailPct}% to ${multiple.toFixed(2)}x` });
    return { sells, state };
  }

  // Once it reached e.g. 1.5×, a winner must not turn into a loser.
  if (remaining > 0 && state.peakPriceSol >= i.entryPriceSol * rules.protectProfit.afterMultiple && multiple <= rules.protectProfit.floorMultiple) {
    sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `protecting profit: peaked ${(state.peakPriceSol / i.entryPriceSol).toFixed(2)}x, back to ${multiple.toFixed(2)}x` });
    return { sells, state };
  }

  // Keeps failing at the same ceiling → take what's there.
  if (remaining > 0 && i.resistance.hit && multiple >= rules.resistance.minProfitMultiple) {
    sells.push({ pct: remaining, reason: 'TAKE_PROFIT', detail: `resistance at ${(i.resistance.level / i.entryPriceSol).toFixed(2)}x (${i.resistance.touches} rejections), sold at ${multiple.toFixed(2)}x` });
    return { sells, state };
  }

  // In profit and momentum is fading → bank it instead of riding it back down.
  if (remaining > 0 && multiple >= rules.riskExit.minProfitMultiple && i.risk >= rules.riskExit.threshold) {
    sells.push({ pct: remaining, reason: 'TAKE_PROFIT', detail: `${multiple.toFixed(2)}x, risk rising: ${i.riskWhy}` });
    return { sells, state };
  }

  // Don't hold forever.
  if (remaining > 0 && i.nowMs - i.openedAtMs >= i.maxHoldMinutes * 60_000) {
    sells.push({ pct: remaining, reason: multiple >= 1 ? 'TAKE_PROFIT' : 'STALE', detail: `max hold ${i.maxHoldMinutes}m reached at ${multiple.toFixed(2)}x` });
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
  private readonly samples = new Map<string, ActivitySample[]>();
  private readonly lastPoll = new Map<string, number>();
  private updates: Array<{ id: string; priceSol: number; multiple: number; peakMultiple: number; unrealizedPnlSol: number; risk: number; holders: number; ownSupplyPct: number; exitImpactPct: number }> = [];

  constructor(
    private readonly executor: Executor,
    private readonly liveState: LiveState,
    private readonly redis: Redis,
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
      const positions = await prisma.position.findMany({ where: { mode: this.executor.mode, status: 'OPEN' }, include: { token: { select: { symbol: true, bondingCurve: true } } } });
      this.updates = [];
      const openIds = new Set(positions.map((x) => x.id));
      for (const id of this.samples.keys()) if (!openIds.has(id)) this.samples.delete(id);
      for (const p of positions) {
        try {
          await this.refreshIfStale(p.mint, p.token.bondingCurve);
          await this.manage(p, p.token.symbol);
        } catch (err) {
          log.error({ positionId: p.id, err: (err as Error).message }, 'failed to manage position');
        }
      }
      // Live prices for the dashboard's Positions page.
      if (this.updates.length) bus.publish({ type: 'positions', data: { updates: this.updates } });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'sell manager tick failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Safety net: if the live stream hasn't updated a token we HOLD for 20s,
   * read its bonding curve straight from the chain (1 Helius credit, at most
   * every 15s per position) so exits never act on a frozen price.
   */
  private async refreshIfStale(mint: string, bondingCurve: string): Promise<void> {
    const view = await this.liveState.read(mint);
    if (!view || view.complete || !bondingCurve) return;
    const now = Date.now();
    if (now - (view.lastTradeAtMs ?? 0) < 20_000 || now - (this.lastPoll.get(mint) ?? 0) < 15_000) return;
    this.lastPoll.set(mint, now);
    try {
      const info = await getConnection().getAccountInfo(new PublicKey(bondingCurve), 'confirmed');
      const state = info ? decodeBondingCurveAccount(info.data) : null;
      if (state) await this.liveState.applyCurveState(mint, state);
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, 'curve poll failed');
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
    const entry = (p.entryContext ?? {}) as { devHoldingPct?: number; top10HolderPct?: number; earlyBuyerPct?: number };
    // Migrated but no PumpSwap trades seen 10 min later → we can't price it anymore.
    const completedLongAgo = view.complete && view.ammTrades === 0 && Date.now() - (view.migratedAtMs ?? view.lastTradeAtMs ?? 0) > 10 * 60_000;
    // Recent activity for the risk score (kept in memory, last ~3 minutes).
    const now = Date.now();
    const hist = this.samples.get(p.id) ?? [];
    hist.push({ t: now, buys: view.buys, sells: view.sells, holders: m.holderCount, priceSol: m.priceSol });
    while (hist.length && now - hist[0]!.t > Math.max(180_000, cfg.exit.resistance.windowSec * 1000)) hist.shift();
    this.samples.set(p.id, hist);
    const { risk, why } = computeRisk(hist, Math.max(p.peakPriceSol, m.priceSol), now);
    {
      const costLeft = (p.sizeSol * p.remainingPct) / 100;
      const multiple = m.priceSol / p.entryPriceSol;
      const feeBps = view.ammBaseReserve ? cfg.paper.ammFeeBps : cfg.paper.curveFeeBps;
      // How much of the supply we hold, and how much our own sell would push the price down.
      const tokensLeft = (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n;
      const [rs, rt] = view.ammBaseReserve && view.ammQuoteReserve ? [view.ammQuoteReserve, view.ammBaseReserve] : [view.virtualSolReserves, view.virtualTokenReserves];
      const ideal = (Number(tokensLeft) / 1e6) * m.priceSol;
      const real = Number(quoteSell(tokensLeft, rs, rt, 0).solOutLamports) / 1e9;
      this.updates.push({
        id: p.id,
        ownSupplyPct: (Number(tokensLeft) / Number(view.curve.totalSupply || 1n)) * 100,
        exitImpactPct: ideal > 0 ? (1 - real / ideal) * 100 : 0,
        priceSol: m.priceSol,
        multiple,
        peakMultiple: Math.max(p.peakPriceSol, m.priceSol) / p.entryPriceSol,
        unrealizedPnlSol: costLeft * multiple * (1 - feeBps / 10_000) - costLeft,
        risk,
        holders: m.holderCount,
      });
    }
    const copied = (entry as { copiedWallet?: string | null }).copiedWallet;
    const copyWalletSold = !!copied && (await this.redis.exists(copySoldKey(p.mint, copied))) === 1;

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
        priceSol: m.priceSol,
        migratedNoMarket: completedLongAgo,
        bundlePctEntry: entry.earlyBuyerPct ?? m.earlyBuyerPct,
        bundlePctNow: m.earlyBuyerPct,
        devHoldingPctEntry: entry.devHoldingPct ?? 0,
        devHoldingPctNow: m.devHoldingPct,
        top10PctEntry: entry.top10HolderPct ?? m.top10HolderPct,
        top10PctNow: m.top10HolderPct,
        nowMs: now,
        copyWalletSold,
        risk,
        riskWhy: why,
        openedAtMs: p.openedAt.getTime(),
        maxHoldMinutes: cfg.exit.maxHoldMinutes[p.strategy],
        resistance: detectResistance(hist, now, cfg.exit.resistance),
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
    // Cost = what we paid for this slice, including its share of the buy's gas/priority/tip.
    const buyFee = Number((p.entryContext as { buyFeeSol?: number } | null)?.buyFeeSol ?? 0);
    const costBasis = ((p.sizeSol + buyFee) * pct) / 100;
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
          context: {
            pct,
            costBasis,
            multiple: fill.priceSol / p.entryPriceSol,
            peakMultiple: p.peakPriceSol / p.entryPriceSol,
            explanation: explainSell({
              symbol,
              reason,
              detail,
              multiple: fill.priceSol / p.entryPriceSol,
              peakMultiple: p.peakPriceSol / p.entryPriceSol,
              pct,
              closing,
              heldMinutes: (Date.now() - p.openedAt.getTime()) / 60_000,
              pnlSol: pnl,
            }),
          },
          pnlSol: fill.ok ? pnl : undefined,
          peakMultiple: p.peakPriceSol / p.entryPriceSol,
          closed: fill.ok && closing,
          totalPnlSol: fill.ok ? p.realizedPnlSol + pnl : undefined,
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
