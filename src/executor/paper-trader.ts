/**
 * Paper executor — simulates fills against the real, live bonding curve
 * (or the token's PumpSwap pool once it has migrated).
 *
 * It reads the curve's current reserves from Redis (kept fresh by every
 * trade event), runs the exact constant-product maths the on-chain program
 * uses, charges the curve fee and a transaction fee, then applies an extra
 * adverse slippage to account for the 1-2s we'd really take to land a tx.
 *
 * Balance = starting balance − SOL spent on buys − tx fees + SOL from sells,
 * all from the PAPER trades in the database, so it survives restarts.
 */
import { getConfig } from '../config/runtime-config';
import { prisma } from '../lib/prisma';
import { curvePriceSol, PUMP_TOKEN_DECIMALS, quoteBuy, quoteSell } from '../lib/pumpfun';
import { lamportsToSol, solToLamports } from '../lib/solana';
import type { LiveState, LiveTokenView } from '../scanner/live-state';
import type { BuyRequest, Executor, Fill, SellRequest } from './types';

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
    const view = await this.liveState.read(req.mint);
    if (!view) return failed('no live state');
    const p = getConfig().paper;
    const pool = poolOf(view, p);
    if (!pool) return failed('migrating — PumpSwap pool not seen yet');

    const lamports = solToLamports(req.solAmount);
    const { tokensOut } = quoteBuy(lamports, pool.sol, pool.tokens, pool.feeBps);
    // Latency slippage: assume we get slightly fewer tokens than the quote.
    const filled = (tokensOut * BigInt(Math.round((100 - p.slippagePct) * 100))) / 10_000n;
    if (filled <= 0n) return failed('quote returned zero tokens');

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
    const view = await this.liveState.read(req.mint);
    if (!view) return failed('no live state');
    const p = getConfig().paper;
    // Migrated but pool not seen yet: value at the final curve price (≈ the migration price).
    const pool = poolOf(view, p) ?? { sol: view.virtualSolReserves, tokens: view.virtualTokenReserves, feeBps: p.curveFeeBps };

    const { solOutLamports } = quoteSell(req.tokenAmountRaw, pool.sol, pool.tokens, pool.feeBps);
    const received = lamportsToSol(solOutLamports) * (1 - p.slippagePct / 100);
    const tokens = Number(req.tokenAmountRaw) / 10 ** PUMP_TOKEN_DECIMALS;
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
