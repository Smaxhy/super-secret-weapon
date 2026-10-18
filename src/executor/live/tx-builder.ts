/**
 * Builds the real pump.fun / PumpSwap transaction for a buy or sell — reads fresh chain state (one
 * getMultipleAccountsInfo per side, plus the pool vaults on PumpSwap), never sends anything. Shared by the
 * LiveExecutor (signs + sends) and the paper dry run (simulates only).
 */
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import { getConfig } from '../../config/runtime-config';
import { canonicalPumpPool } from '../../lib/pump-pda';
import { decodePumpSwapPool, effectiveQuoteReserve } from '../../lib/pumpswap-pool';
import { curvePriceSol, decodeBondingCurveAccount, poolFeeBps, PUMP_TOKEN_DECIMALS, WSOL_MINT } from '../../lib/pumpfun';
import { solToLamports } from '../../lib/solana';
import {
  AMM_CONFIG,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_FEE,
  PUMP_MAYHEM_FEE,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ammGlobalConfigPda,
  ata,
  bondingCurvePda,
  pick,
  pubkeysAt,
} from './addresses';
import { buyPlan, DEFAULT_LIVE, priorityFee, sellMinOut, type LiveConfig } from './guards';
import { ammBuy, ammSell, computeBudget, curveBuyV2, curveSellV2, tipIx } from './instructions';

export type TxKind = 'curve-buy' | 'curve-sell' | 'amm-buy' | 'amm-sell';
/** Compute-unit fallbacks until a simulation measured the real figure (Chainstack's defaults: buy 100k, sell 60k). */
export const DEFAULT_CU: Record<TxKind, number> = { 'curve-buy': 120_000, 'curve-sell': 90_000, 'amm-buy': 220_000, 'amm-sell': 180_000 };

export interface PreparedTx {
  kind: TxKind;
  ixs: TransactionInstruction[];
  writable: PublicKey[];
  /** Tokens we expect (buy) / sell (sell), raw units. */
  tokens: bigint;
  /** Price (SOL per whole token) the plan was made at. */
  priceSol: number;
  /** The on-chain limit: max SOL in (buy) / min SOL out (sell), lamports. */
  limitLamports: bigint;
  userTokenBalance: bigint | null;
}

const TOKEN_AMOUNT_OFFSET = 64;
const DEFAULT_PK = '11111111111111111111111111111111';
export const liveConfig = (): LiveConfig => ({ ...DEFAULT_LIVE, ...((getConfig() as { live?: Partial<LiveConfig> }).live ?? {}) });

function tokenAmount(data: Buffer | null | undefined): bigint | null {
  return data && data.length >= TOKEN_AMOUNT_OFFSET + 8 ? data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : null;
}

export class LiveTxBuilder {
  private ammConfig: { data: Buffer; at: number } | null = null;
  private readonly fees = new Map<string, { fee: number; at: number }>();
  private readonly cu = new Map<TxKind, number>();

  constructor(private readonly conn: Connection) {}

  cuFor(kind: TxKind): number {
    return this.cu.get(kind) ?? DEFAULT_CU[kind];
  }
  hasMeasured(kind: TxKind): boolean {
    return this.cu.has(kind);
  }
  /** Record a simulation's consumed units (+20% headroom). */
  noteCu(kind: TxKind, units: number | null | undefined): void {
    if (units && units > 0) this.cu.set(kind, Math.min(1_400_000, Math.ceil(units * 1.2)));
  }

  private async ammGlobalConfig(): Promise<Buffer> {
    if (this.ammConfig && Date.now() - this.ammConfig.at < 10 * 60_000) return this.ammConfig.data;
    const info = await this.conn.getAccountInfo(ammGlobalConfigPda(), 'confirmed');
    if (!info) throw new Error('PumpSwap GlobalConfig not found');
    this.ammConfig = { data: info.data, at: Date.now() };
    return info.data;
  }

  async priorityFeeFor(writable: PublicKey[]): Promise<number> {
    const c = liveConfig();
    const k = writable.map((w) => w.toBase58()).join(',');
    const hit = this.fees.get(k);
    if (hit && Date.now() - hit.at < 10_000) return hit.fee;
    const recent = await this.conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable }).catch(() => []);
    const fee = priorityFee(recent.map((r) => r.prioritizationFee), c);
    if (this.fees.size > 500) this.fees.clear();
    this.fees.set(k, { fee, at: Date.now() });
    return fee;
  }

  /** Where the coin trades now (curve unless it's complete), with everything the instructions need. */
  private async market(mint: PublicKey, user: PublicKey, withUser: boolean) {
    const curvePk = bondingCurvePda(mint);
    const userAtas = [ata(user, mint, TOKEN_PROGRAM), ata(user, mint, TOKEN_2022_PROGRAM)];
    const [curveInfo, mintInfo, ataSpl, ata2022] = await this.conn.getMultipleAccountsInfo([curvePk, mint, ...(withUser ? userAtas : [])], 'confirmed');
    if (!mintInfo) throw new Error('mint not found');
    const baseTokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const userTokenBalance = withUser ? tokenAmount((baseTokenProgram.equals(TOKEN_2022_PROGRAM) ? ata2022 : ataSpl)?.data) : null;
    const curve = curveInfo ? decodeBondingCurveAccount(curveInfo.data) : null;
    if (curve && !curve.complete && curve.virtualTokenReserves > 0n) {
      if (curve.quoteMint && curve.quoteMint !== DEFAULT_PK && curve.quoteMint !== WSOL_MINT) throw new Error('not a SOL-paired coin');
      if (!curve.creator) throw new Error('curve account too short (no creator)');
      return { where: 'curve' as const, curve, baseTokenProgram, userTokenBalance };
    }
    const poolAddr = canonicalPumpPool(mint.toBase58());
    if (!poolAddr) throw new Error('no canonical pool');
    const poolPk = new PublicKey(poolAddr);
    const poolInfo = await this.conn.getAccountInfo(poolPk, 'confirmed');
    const pool = poolInfo ? decodePumpSwapPool(poolInfo.data) : null;
    if (!pool || !poolInfo) throw new Error('migrating — PumpSwap pool not found yet');
    if (pool.quoteMint !== WSOL_MINT) throw new Error('pool is not SOL-quoted');
    const [baseVault, quoteVault] = await this.conn.getMultipleAccountsInfo([new PublicKey(pool.poolBaseTokenAccount), new PublicKey(pool.poolQuoteTokenAccount)], 'confirmed');
    const baseReserve = tokenAmount(baseVault?.data);
    const vaultQuote = tokenAmount(quoteVault?.data);
    if (!baseReserve || vaultQuote === null) throw new Error('pool vaults unreadable');
    const cashback = poolInfo.data.length > 244 ? poolInfo.data.readUInt8(244) !== 0 : false;
    return { where: 'amm' as const, pool, poolPk, cashback, baseReserve, quoteReserve: effectiveQuoteReserve(vaultQuote, pool.virtualQuoteReserves), baseTokenProgram, userTokenBalance };
  }

  private async ammFeeAccounts(isMayhem: boolean): Promise<{ protocolFeeRecipient: PublicKey; buybackFeeRecipient: PublicKey }> {
    const cfgData = await this.ammGlobalConfig();
    const protocolFeeRecipient = isMayhem ? pubkeysAt(cfgData, AMM_CONFIG.reservedRecipient, 1)[0]! : pick(pubkeysAt(cfgData, AMM_CONFIG.protocolRecipients, 8));
    const buybackFeeRecipient = pick(pubkeysAt(cfgData, AMM_CONFIG.buybackRecipients, 8));
    return { protocolFeeRecipient, buybackFeeRecipient };
  }

  async prepareBuy(req: { mint: string; solAmount: number; maxSlippageBps: number; expectedPriceSol?: number }, user: PublicKey): Promise<PreparedTx> {
    const c = liveConfig();
    const p = getConfig().paper;
    const mint = new PublicKey(req.mint);
    const m = await this.market(mint, user, false);
    const slip = Math.min(req.maxSlippageBps > 0 ? req.maxSlippageBps : c.buySlippageBps, c.buySlippageBps);
    const lamports = solToLamports(req.solAmount);
    const checkPrice = (px: number) => {
      if (req.expectedPriceSol && req.expectedPriceSol > 0 && px > req.expectedPriceSol * (1 + slip / 10_000)) {
        throw new Error(`price moved +${((px / req.expectedPriceSol - 1) * 100).toFixed(1)}% since the decision (limit ${(slip / 100).toFixed(0)}%)`);
      }
    };
    if (m.where === 'curve') {
      const px = curvePriceSol(m.curve.virtualSolReserves, m.curve.virtualTokenReserves);
      checkPrice(px);
      const feeBps = p.curveFeeBps + Math.max(0, m.curve.creatorFeeBps ?? 0);
      const plan = buyPlan(lamports, m.curve.virtualSolReserves, m.curve.virtualTokenReserves, feeBps, slip);
      if (plan.tokens <= 0n) throw new Error('quote returned zero tokens');
      const ixs = curveBuyV2(
        { user, mint, baseTokenProgram: m.baseTokenProgram, creator: new PublicKey(m.curve.creator!), isMayhem: m.curve.isMayhemMode === true, feeRecipient: m.curve.isMayhemMode ? PUMP_MAYHEM_FEE : PUMP_FEE, buybackFeeRecipient: pick(PUMP_BUYBACK_FEE_RECIPIENTS) },
        plan.tokens,
        plan.maxCostLamports,
      );
      return { kind: 'curve-buy', ixs, writable: [bondingCurvePda(mint)], tokens: plan.tokens, priceSol: px, limitLamports: plan.maxCostLamports, userTokenBalance: null };
    }
    const px = Number(m.quoteReserve) / 1e9 / (Number(m.baseReserve) / 10 ** PUMP_TOKEN_DECIMALS);
    checkPrice(px);
    const supply = 1_000_000_000;
    const feeBps = poolFeeBps(p, true, px * supply);
    const plan = buyPlan(lamports, m.quoteReserve, m.baseReserve, feeBps, slip);
    if (plan.tokens <= 0n) throw new Error('quote returned zero tokens');
    const fees = await this.ammFeeAccounts(m.pool.isMayhemMode === true);
    const ixs = ammBuy(
      { user, pool: m.poolPk, mint, baseTokenProgram: m.baseTokenProgram, poolBaseTokenAccount: new PublicKey(m.pool.poolBaseTokenAccount), poolQuoteTokenAccount: new PublicKey(m.pool.poolQuoteTokenAccount), coinCreator: new PublicKey(m.pool.coinCreator), canonical: m.pool.canonical, cashback: m.cashback, ...fees },
      plan.tokens,
      plan.maxCostLamports,
      randomBytes(16).toString('hex'),
    );
    return { kind: 'amm-buy', ixs, writable: [m.poolPk], tokens: plan.tokens, priceSol: px, limitLamports: plan.maxCostLamports, userTokenBalance: null };
  }

  /** `capToBalance` (live): never try to sell more than the wallet holds; a full sale also closes the token account. */
  async prepareSell(req: { mint: string; tokenAmountRaw: bigint; maxSlippageBps: number }, user: PublicKey, capToBalance: boolean): Promise<PreparedTx> {
    const c = liveConfig();
    const p = getConfig().paper;
    const mint = new PublicKey(req.mint);
    const m = await this.market(mint, user, true);
    let tokens = req.tokenAmountRaw;
    if (capToBalance) {
      if (!m.userTokenBalance) throw new Error('wallet holds none of this token');
      if (tokens > m.userTokenBalance) tokens = m.userTokenBalance;
    }
    if (tokens <= 0n) throw new Error('nothing to sell');
    const closeAta = capToBalance && m.userTokenBalance !== null && tokens >= m.userTokenBalance;
    const slip = Math.min(req.maxSlippageBps > 0 ? req.maxSlippageBps : c.sellSlippageBps, c.sellSlippageBps);
    if (m.where === 'curve') {
      const feeBps = p.curveFeeBps + Math.max(0, m.curve.creatorFeeBps ?? 0);
      const minOut = sellMinOut(tokens, m.curve.virtualSolReserves, m.curve.virtualTokenReserves, feeBps, slip);
      const ixs = curveSellV2(
        { user, mint, baseTokenProgram: m.baseTokenProgram, creator: new PublicKey(m.curve.creator!), isMayhem: m.curve.isMayhemMode === true, feeRecipient: m.curve.isMayhemMode ? PUMP_MAYHEM_FEE : PUMP_FEE, buybackFeeRecipient: pick(PUMP_BUYBACK_FEE_RECIPIENTS) },
        tokens,
        minOut,
        closeAta,
      );
      return { kind: 'curve-sell', ixs, writable: [bondingCurvePda(mint)], tokens, priceSol: curvePriceSol(m.curve.virtualSolReserves, m.curve.virtualTokenReserves), limitLamports: minOut, userTokenBalance: m.userTokenBalance };
    }
    const px = Number(m.quoteReserve) / 1e9 / (Number(m.baseReserve) / 10 ** PUMP_TOKEN_DECIMALS);
    const feeBps = poolFeeBps(p, true, px * 1_000_000_000);
    const minOut = sellMinOut(tokens, m.quoteReserve, m.baseReserve, feeBps, slip);
    const fees = await this.ammFeeAccounts(m.pool.isMayhemMode === true);
    const ixs = ammSell(
      { user, pool: m.poolPk, mint, baseTokenProgram: m.baseTokenProgram, poolBaseTokenAccount: new PublicKey(m.pool.poolBaseTokenAccount), poolQuoteTokenAccount: new PublicKey(m.pool.poolQuoteTokenAccount), coinCreator: new PublicKey(m.pool.coinCreator), canonical: m.pool.canonical, cashback: m.cashback, ...fees },
      tokens,
      minOut,
      randomBytes(16).toString('hex'),
      closeAta,
    );
    return { kind: 'amm-sell', ixs, writable: [m.poolPk], tokens, priceSol: px, limitLamports: minOut, userTokenBalance: m.userTokenBalance };
  }

  /** Compute budget + (optional) tip + the trade, as a v0 transaction (unsigned). */
  async toTransaction(prep: PreparedTx, payer: PublicKey, tip: { to: PublicKey; lamports: bigint } | null, cuLimit: number, blockhash?: string): Promise<VersionedTransaction> {
    const c = liveConfig();
    const fee = await this.priorityFeeFor(prep.writable);
    const ixs = [...computeBudget(cuLimit, fee, c.loadedAccountsDataSizeLimit), ...prep.ixs, ...(tip ? [tipIx(payer, tip.to, tip.lamports)] : [])];
    const recentBlockhash = blockhash ?? (await this.conn.getLatestBlockhash('confirmed')).blockhash;
    return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash, instructions: ixs }).compileToV0Message());
  }

  async simulate(tx: VersionedTransaction): Promise<{ err: unknown; logs: string[] | null; unitsConsumed: number | null }> {
    const r = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
    return { err: r.value.err ?? null, logs: r.value.logs ?? null, unitsConsumed: r.value.unitsConsumed ?? null };
  }
}
