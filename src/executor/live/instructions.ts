/**
 * Pure transaction-instruction builders for pump.fun (bonding curve) and PumpSwap — no RPC, no keys.
 *
 * Layouts (Chainstack pumpfun-bonkfun-bot, Oct 2026):
 *  - curve `buy_v2` (27 accounts) / `sell_v2` (26 = buy_v2 minus global_volume_accumulator):
 *    _BUY_V2_ACCOUNTS in platforms/pumpfun/instruction_builder.py; data = discriminator + u64 amount + u64
 *    max_sol_cost / min_sol_output (24 bytes, no track_volume). SOL-paired coins pass WRAPPED SOL as quote_mint and
 *    the user's WSOL ATA is only seed-checked — never created (it would burn rent for nothing).
 *  - PumpSwap `buy` / `sell`: the IDL's 23 / 21 accounts, then the cashback pair (sell, cashback pools), `pool-v2`
 *    ONLY on a canonical pool (coin_creator set), then the buyback recipient + its quote ATA LAST (read positionally).
 *    Quote settles through a throwaway WSOL account opened and closed in the same transaction.
 * Discriminators from the vendored IDLs (pump_fun_idl.json / pump_swap_idl.json).
 */
import { createHash } from 'crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createInitializeAccountInstruction } from '@solana/spl-token';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  PUMP,
  PUMP_AMM,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_PROGRAM,
  PUMP_GLOBAL,
  SYSTEM_PROGRAM,
  TOKEN_ACCOUNT_RENT,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM,
  WSOL,
  ammCreatorVaultPda,
  ammEventAuthorityPda,
  ammFeeConfigPda,
  ammGlobalConfigPda,
  ammGlobalVolumeAccumulatorPda,
  ammPoolV2Pda,
  ammUserVolumeAccumulatorPda,
  ata,
  bondingCurvePda,
  creatorVaultPda,
  globalVolumeAccumulatorPda,
  pumpFeeConfigPda,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from './addresses';

export const DISC = {
  curveBuyV2: Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]),
  curveSellV2: Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]),
  ammBuy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  ammSell: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
} as const;

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });

export interface CurveTradeAccounts {
  user: PublicKey;
  mint: PublicKey;
  /** Token program owning the mint (Token-2022 for create_v2 coins, SPL Token for legacy create). */
  baseTokenProgram: PublicKey;
  /** BondingCurve.creator (a pump.fun PDA on holder-reward coins — still the right seed for creator-vault). */
  creator: PublicKey;
  isMayhem: boolean;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

/** Ordered (name, account, writable) for curve buy_v2 / sell_v2 — the exact _BUY_V2_ACCOUNTS order. */
export function curveV2Accounts(a: CurveTradeAccounts, side: 'buy' | 'sell'): Array<{ name: string; meta: AccountMeta }> {
  const quoteProgram = TOKEN_PROGRAM;
  const curve = bondingCurvePda(a.mint);
  const creatorVault = creatorVaultPda(a.creator);
  const uva = userVolumeAccumulatorPda(a.user);
  const list: Array<[string, PublicKey, boolean]> = [
    ['global', PUMP_GLOBAL, false],
    ['base_mint', a.mint, false],
    ['quote_mint', WSOL, false],
    ['base_token_program', a.baseTokenProgram, false],
    ['quote_token_program', quoteProgram, false],
    ['associated_token_program', ASSOCIATED_TOKEN_PROGRAM, false],
    ['fee_recipient', a.feeRecipient, true],
    ['associated_quote_fee_recipient', ata(a.feeRecipient, WSOL, quoteProgram), true],
    ['buyback_fee_recipient', a.buybackFeeRecipient, true],
    ['associated_quote_buyback_fee_recipient', ata(a.buybackFeeRecipient, WSOL, quoteProgram), true],
    ['bonding_curve', curve, true],
    ['associated_base_bonding_curve', ata(curve, a.mint, a.baseTokenProgram), true],
    ['associated_quote_bonding_curve', ata(curve, WSOL, quoteProgram), true],
    ['user', a.user, true],
    ['associated_base_user', ata(a.user, a.mint, a.baseTokenProgram), true],
    ['associated_quote_user', ata(a.user, WSOL, quoteProgram), true],
    ['creator_vault', creatorVault, true],
    ['associated_creator_vault', ata(creatorVault, WSOL, quoteProgram), true],
    ['sharing_config', sharingConfigPda(a.mint), false],
    ['global_volume_accumulator', globalVolumeAccumulatorPda(), false],
    ['user_volume_accumulator', uva, true],
    ['associated_user_volume_accumulator', ata(uva, WSOL, quoteProgram), true],
    ['fee_config', pumpFeeConfigPda(), false],
    ['fee_program', PUMP_FEE_PROGRAM, false],
    ['system_program', SYSTEM_PROGRAM, false],
    ['event_authority', PUMP_EVENT_AUTHORITY, false],
    ['program', PUMP, false],
  ];
  return list
    .filter(([name]) => side === 'buy' || name !== 'global_volume_accumulator')
    .map(([name, pubkey, w]) => ({ name, meta: meta(pubkey, w, pubkey.equals(a.user)) }));
}

/** buy_v2: create the user's base ATA (idempotent), then buy exactly `tokens` paying at most `maxSolCostLamports`. */
export function curveBuyV2(a: CurveTradeAccounts, tokens: bigint, maxSolCostLamports: bigint): TransactionInstruction[] {
  const userAta = ata(a.user, a.mint, a.baseTokenProgram);
  return [
    createAssociatedTokenAccountIdempotentInstruction(a.user, userAta, a.user, a.mint, a.baseTokenProgram, ASSOCIATED_TOKEN_PROGRAM),
    new TransactionInstruction({ programId: PUMP, keys: curveV2Accounts(a, 'buy').map((x) => x.meta), data: Buffer.concat([DISC.curveBuyV2, u64(tokens), u64(maxSolCostLamports)]) }),
  ];
}

/** sell_v2: sell `tokens`, receive at least `minSolOutLamports`; `closeAta` closes the emptied base ATA (rent back). */
export function curveSellV2(a: CurveTradeAccounts, tokens: bigint, minSolOutLamports: bigint, closeAta: boolean): TransactionInstruction[] {
  const ixs = [new TransactionInstruction({ programId: PUMP, keys: curveV2Accounts(a, 'sell').map((x) => x.meta), data: Buffer.concat([DISC.curveSellV2, u64(tokens), u64(minSolOutLamports)]) })];
  if (closeAta) ixs.push(createCloseAccountInstruction(ata(a.user, a.mint, a.baseTokenProgram), a.user, a.user, [], a.baseTokenProgram));
  return ixs;
}

export interface AmmPoolAccounts {
  user: PublicKey;
  pool: PublicKey;
  mint: PublicKey;
  baseTokenProgram: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  coinCreator: PublicKey;
  canonical: boolean;
  cashback: boolean;
  protocolFeeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

/** A throwaway WSOL account (seed-derived) funded with `lamports`, opened before and closed after the swap. */
export function wsolSettlement(user: PublicKey, seed: string, lamports: bigint): { account: PublicKey; open: TransactionInstruction[]; close: TransactionInstruction[] } {
  if (seed.length > 32) throw new Error('seed too long');
  const account = createWithSeedSync(user, seed, TOKEN_PROGRAM);
  return {
    account,
    open: [
      SystemProgram.createAccountWithSeed({ fromPubkey: user, newAccountPubkey: account, basePubkey: user, seed, lamports: Number(lamports + TOKEN_ACCOUNT_RENT), space: TOKEN_ACCOUNT_SIZE, programId: TOKEN_PROGRAM }),
      createInitializeAccountInstruction(account, WSOL, user, TOKEN_PROGRAM),
    ],
    close: [createCloseAccountInstruction(account, user, user, [], TOKEN_PROGRAM)],
  };
}

/** PublicKey.createWithSeed (sha256(base ‖ seed ‖ program)) without the async wrapper. */
export function createWithSeedSync(base: PublicKey, seed: string, program: PublicKey): PublicKey {
  return new PublicKey(createHash('sha256').update(Buffer.concat([base.toBuffer(), Buffer.from(seed), program.toBuffer()])).digest());
}

/** Ordered metas for a PumpSwap buy / sell (IDL accounts, then cashback pair (sell), pool-v2 (canonical), buyback pair). */
export function ammAccounts(a: AmmPoolAccounts, side: 'buy' | 'sell', userQuote: PublicKey): AccountMeta[] {
  const quoteProgram = TOKEN_PROGRAM;
  const creatorVault = ammCreatorVaultPda(a.coinCreator);
  const keys: AccountMeta[] = [
    meta(a.pool, true),
    meta(a.user, true, true),
    meta(ammGlobalConfigPda(), false),
    meta(a.mint, false),
    meta(WSOL, false),
    meta(ata(a.user, a.mint, a.baseTokenProgram), true),
    meta(userQuote, true),
    meta(a.poolBaseTokenAccount, true),
    meta(a.poolQuoteTokenAccount, true),
    meta(a.protocolFeeRecipient, false),
    meta(ata(a.protocolFeeRecipient, WSOL, quoteProgram), true),
    meta(a.baseTokenProgram, false),
    meta(quoteProgram, false),
    meta(SYSTEM_PROGRAM, false),
    meta(ASSOCIATED_TOKEN_PROGRAM, false),
    meta(ammEventAuthorityPda(), false),
    meta(PUMP_AMM, false),
    meta(ata(creatorVault, WSOL, quoteProgram), true),
    meta(creatorVault, false),
  ];
  if (side === 'buy') keys.push(meta(ammGlobalVolumeAccumulatorPda(), false), meta(ammUserVolumeAccumulatorPda(a.user), true));
  keys.push(meta(ammFeeConfigPda(), false), meta(PUMP_FEE_PROGRAM, false));
  if (side === 'sell' && a.cashback) {
    const acc = ammUserVolumeAccumulatorPda(a.user);
    keys.push(meta(ata(acc, WSOL, quoteProgram), true), meta(acc, true));
  }
  if (a.canonical) keys.push(meta(ammPoolV2Pda(a.mint), false));
  keys.push(meta(a.buybackFeeRecipient, false), meta(ata(a.buybackFeeRecipient, WSOL, quoteProgram), true));
  return keys;
}

/** PumpSwap buy: wrap at most `maxQuoteInLamports`, receive exactly `baseOut` tokens (track_volume = true). */
export function ammBuy(a: AmmPoolAccounts, baseOut: bigint, maxQuoteInLamports: bigint, seed: string): TransactionInstruction[] {
  const s = wsolSettlement(a.user, seed, maxQuoteInLamports);
  const userAta = ata(a.user, a.mint, a.baseTokenProgram);
  return [
    createAssociatedTokenAccountIdempotentInstruction(a.user, userAta, a.user, a.mint, a.baseTokenProgram, ASSOCIATED_TOKEN_PROGRAM),
    ...s.open,
    new TransactionInstruction({ programId: PUMP_AMM, keys: ammAccounts(a, 'buy', s.account), data: Buffer.concat([DISC.ammBuy, u64(baseOut), u64(maxQuoteInLamports), Buffer.from([1])]) }),
    ...s.close,
  ];
}

/** PumpSwap sell: `baseIn` tokens for at least `minQuoteOutLamports`, settled as native SOL. */
export function ammSell(a: AmmPoolAccounts, baseIn: bigint, minQuoteOutLamports: bigint, seed: string, closeAta: boolean): TransactionInstruction[] {
  const s = wsolSettlement(a.user, seed, 0n);
  const ixs = [...s.open, new TransactionInstruction({ programId: PUMP_AMM, keys: ammAccounts(a, 'sell', s.account), data: Buffer.concat([DISC.ammSell, u64(baseIn), u64(minQuoteOutLamports)]) }), ...s.close];
  if (closeAta) ixs.push(createCloseAccountInstruction(ata(a.user, a.mint, a.baseTokenProgram), a.user, a.user, [], a.baseTokenProgram));
  return ixs;
}

/** Compute-budget prefix: [data-size limit (optional, must be first)], CU limit, CU price. */
export function computeBudget(cuLimit: number, microLamports: number, loadedAccountsDataSizeLimit = 0): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (loadedAccountsDataSizeLimit > 0) {
    const data = Buffer.alloc(5);
    data.writeUInt8(4, 0); // SetLoadedAccountsDataSizeLimit
    data.writeUInt32LE(loadedAccountsDataSizeLimit, 1);
    out.push(new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data }));
  }
  out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(1, Math.round(cuLimit)) }));
  if (microLamports > 0) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.round(microLamports) }));
  return out;
}

/** Sender / Jito tip: a plain SOL transfer to a tip account. */
export function tipIx(from: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) });
}
