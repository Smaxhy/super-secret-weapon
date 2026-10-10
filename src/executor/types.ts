/**
 * The contract every executor (paper or live) implements.
 *
 * The trader and sell manager only ever talk to this interface, which is what
 * makes paper mode "indistinguishable from live except it doesn't send
 * transactions": swap PaperExecutor for the live one (Phase 4) and nothing
 * else changes.
 */
import type { TradeStatus, TradingMode } from '@prisma/client';

export interface BuyRequest {
  mint: string;
  solAmount: number; // SOL to spend (including curve fee)
  maxSlippageBps: number;
  /** Price (SOL per token) the decision was made at: a fill more than maxSlippageBps worse is refused. */
  expectedPriceSol?: number;
}

export interface SellRequest {
  mint: string;
  tokenAmountRaw: bigint;
  maxSlippageBps: number;
}

export interface Fill {
  ok: boolean;
  status: TradeStatus;
  signature: string | null;
  /** BUY: SOL spent incl. curve fee. SELL: SOL received after curve fee. */
  solAmount: number;
  tokenAmountRaw: bigint;
  /** Effective price per whole token, in SOL. */
  priceSol: number;
  /** Network + priority fees on top (SOL). */
  feeSol: number;
  error?: string;
}

export interface Executor {
  readonly mode: TradingMode;
  /** SOL available to trade with. Checked before every buy. */
  getBalanceSol(): Promise<number>;
  buy(req: BuyRequest): Promise<Fill>;
  sell(req: SellRequest): Promise<Fill>;
}
