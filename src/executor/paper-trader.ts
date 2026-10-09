/**
 * Paper executor — simulates fills against the real, live bonding curve
 * (or the token's PumpSwap pool once it has migrated).
 *
 * It reads the curve's current reserves from Redis (kept fresh by every
 * trade event), runs the exact constant-product maths the on-chain program
 * uses, charges the curve fee and a transaction fee. Before filling it waits
 * a random 0.4–1.2s (like a real tx landing), so the fill uses the price
 * *after* the delay, then applies a small extra adverse slippage on top.
 *
 * Sanity guard: every fill is also checked against an INDEPENDENT reference —
 * the price the token's most recent real trade executed at (live-state keeps
 * it). A sell quoted > `paper.maxFillVsRefMultiple`× above it, or a buy that
 * many times below it, can only be a pricing bug (bad pool, drifted reserves),
 * so it's clamped to the reference price minus fees/slippage and logged as a
 * WARN 'suspicious_fill' bot event. Real runs still pay: the reference moves
 * with every real trade.
 *
 * Balance = starting balance − SOL spent on buys − tx fees + SOL from sells,
 * all from the PAPER trades in the database, so it survives restarts.
 */
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { curvePriceSol, PUMP_TOKEN_DECIMALS, quoteBuy, quoteSell } from '../lib/pumpfun';
import { lamportsToSol, solToLamports } from '../lib/solana';
import type { LiveState, LiveTokenView } from '../scanner/live-state';
import type { BuyRequest, Executor, Fill, SellRequest } from './types';

const log = moduleLogger('paper-trader');

export class PaperExecutor implements Executor {
  readonly mode = 'PAPER' as const;

  constructor(private readonly liveState: LiveState) {}

  async getBalanceSol(): Promise<number> {
    const start = getConfig().paper.startingBalanceSol;
    const [buys, sells] = await Promise.all([
      prisma.trade.aggregate({ where: { mode: 'PAPER', side: 'BUY', status: 'SIMULATED' }, _sum: { amountSol: true, feeSol: true } }),
      prisma.trade.aggregate({ where: { mode: 'PAPER', side: 'SELL', status: 'SIMULATED' }, _sum: { amountSol: true, feeSol: true } }),
    ]);
    return start - (buys._sum.amountSol ?? 0) - (buys._sum.feeSol ?? 0) + (sells._sum.amountSol ?? 0) - (sells._sum.feeSol ?? 0);
  }

  async buy(req: BuyRequest): Promise<Fill> {
    await landingDelay();
    const view = await this.liveState.read(req.mint);
    if (!view) return failed('no live state');
    const p = getConfig().paper;
    const pool = poolOf(view, p);
    if (!pool) return failed('migrating — PumpSwap pool not seen yet');

    const lamports = solToLamports(req.solAmount);
    const { tokensOut } = quoteBuy(lamports, pool.sol, pool.tokens, pool.feeBps);
    // Latency slippage: assume we get slightly fewer tokens than the quote.
    let filled = (tokensOut * BigInt(Math.round((100 - p.slippagePct) * 100))) / 10_000n;
    if (filled <= 0n) return failed('quote returned zero tokens');

    // Sanity guard: far more tokens than the last real trade price allows → clamp.
    const ref = referencePrice(view);
    const factor = p.maxFillVsRefMultiple ?? 3;
    const quotedPx = req.solAmount / (Number(filled) / 10 ** PUMP_TOKEN_DECIMALS);
    if (ref && factor > 0 && quotedPx < ref.priceSol / factor) {
      const netSol = req.solAmount * (1 - pool.feeBps / 10_000) * (1 - p.slippagePct / 100);
      const clamped = BigInt(Math.floor((netSol / ref.priceSol) * 10 ** PUMP_TOKEN_DECIMALS));
      await suspicious('BUY', req.mint, quotedPx, ref, factor);
      if (clamped <= 0n) return failed('reference price unusable');
      filled = clamped;
    }

    return {
      ok: true,
      status: 'SIMULATED',
      signature: null,
      solAmount: req.solAmount,
      tokenAmountRaw: filled,
      priceSol: req.solAmount / (Number(filled) / 10 ** PUMP_TOKEN_DECIMALS),
      feeSol: p.txFeeSol,
    };
  }

  async sell(req: SellRequest): Promise<Fill> {
    await landingDelay();
    const view = await this.liveState.read(req.mint);
    if (!view) return failed('no live state');
    const p = getConfig().paper;
    // Migrated but pool not seen yet: value at the final curve price (≈ the migration price).
    const pool = poolOf(view, p) ?? { sol: view.virtualSolReserves, tokens: view.virtualTokenReserves, feeBps: p.curveFeeBps };

    const { solOutLamports } = quoteSell(req.tokenAmountRaw, pool.sol, pool.tokens, pool.feeBps);
    let received = lamportsToSol(solOutLamports) * (1 - p.slippagePct / 100);
    const tokens = Number(req.tokenAmountRaw) / 10 ** PUMP_TOKEN_DECIMALS;

    // Sanity guard: never sell far above where the token last really traded.
    const ref = referencePrice(view);
    const factor = p.maxFillVsRefMultiple ?? 3;
    if (ref && factor > 0 && tokens > 0) {
      const grossPx = lamportsToSol(solOutLamports) / (1 - pool.feeBps / 10_000) / tokens;
      if (grossPx > ref.priceSol * factor) {
        received = tokens * ref.priceSol * (1 - pool.feeBps / 10_000) * (1 - p.slippagePct / 100);
        await suspicious('SELL', req.mint, grossPx, ref, factor);
      }
    }
    return {
      ok: true,
      status: 'SIMULATED',
      signature: null,
      solAmount: received,
      tokenAmountRaw: req.tokenAmountRaw,
      priceSol: tokens > 0 ? received / tokens : curvePriceSol(pool.sol, pool.tokens),
      feeSol: p.txFeeSol,
    };
  }
}

/**
 * The independent price a fill is checked against: the last real trade's
 * execution price. A stale one is still right — without trades the price
 * can't have moved. If a migrated token has none yet, the final curve price
 * (≈ the migration price) stands in. On the curve without one: no check.
 */
function referencePrice(view: LiveTokenView): { priceSol: number; source: string; ageSec: number | null } | null {
  if (view.refPriceSol && view.refPriceSol > 0) {
    return { priceSol: view.refPriceSol, source: 'last trade', ageSec: view.refPriceAtMs ? Math.round((Date.now() - view.refPriceAtMs) / 1000) : null };
  }
  if (view.ammBaseReserve || view.complete) {
    const px = curvePriceSol(view.virtualSolReserves, view.virtualTokenReserves);
    if (px > 0) return { priceSol: px, source: 'final curve price', ageSec: null };
  }
  return null;
}

async function suspicious(side: 'BUY' | 'SELL', mint: string, quotedPx: number, ref: { priceSol: number; source: string; ageSec: number | null }, factor: number): Promise<void> {
  const x = side === 'SELL' ? quotedPx / ref.priceSol : ref.priceSol / quotedPx;
  const message = `paper ${side} quoted ${x.toFixed(1)}x ${side === 'SELL' ? 'above' : 'below'} the ${ref.source} price (limit ${factor}x) — clamped to the reference price`;
  log.warn({ mint, side, quotedPx, refPx: ref.priceSol, refSource: ref.source, refAgeSec: ref.ageSec }, message);
  await recordEvent({ level: 'WARN', module: 'paper', type: 'suspicious_fill', mint, message, data: { side, quotedPx, refPx: ref.priceSol, refSource: ref.source, refAgeSec: ref.ageSec, factor } });
}

/** Wait as long as a real transaction would take to land (random within the configured range). */
function landingDelay(): Promise<void> {
  const { latencyMinMs: lo = 0, latencyMaxMs: hi = 0 } = getConfig().paper;
  const ms = lo + Math.random() * Math.max(0, hi - lo);
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Where the token trades right now: the bonding curve, or its PumpSwap pool
 * after migration. Both are constant-product (x*y=k), so the same quote maths
 * applies — only the reserves and the fee differ. null = migrating.
 */
function poolOf(view: LiveTokenView, p: { curveFeeBps: number; ammFeeBps: number }): { sol: bigint; tokens: bigint; feeBps: number } | null {
  if (view.ammBaseReserve && view.ammQuoteReserve) return { sol: view.ammQuoteReserve, tokens: view.ammBaseReserve, feeBps: p.ammFeeBps };
  if (view.complete) return null;
  return { sol: view.virtualSolReserves, tokens: view.virtualTokenReserves, feeBps: p.curveFeeBps };
}

function failed(error: string): Fill {
  return { ok: false, status: 'FAILED', signature: null, solAmount: 0, tokenAmountRaw: 0n, priceSol: 0, feeSol: 0, error };
}
