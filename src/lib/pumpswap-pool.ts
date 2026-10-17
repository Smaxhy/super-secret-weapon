/**
 * PumpSwap `Pool` account (pump-amm) — decoded straight from the chain, so pricing can use the
 * program's EFFECTIVE quote reserve instead of inferring it from trades.
 *
 * Layout (Chainstack pumpfun-bonkfun-bot docs/pumpfun-protocol.md, Oct 2026):
 *   0   discriminator (8)        8   pool_bump u8        9   index u16
 *   11  creator (32)             43  base_mint (32)      75  quote_mint (32)      107 lp_mint (32)
 *   139 pool_base_token_account  171 pool_quote_token_account                      203 lp_supply u64
 *   211 coin_creator (32)        243 is_mayhem_mode u8   244 is_cashback_coin u8
 *   245 virtual_quote_reserves i128 (16) → fields end at 261; live accounts are 301 bytes (padding).
 * Quote against `pool_quote_token_account.amount + virtual_quote_reserves` (the raw vault balance
 * under-prices any pool carrying some). `coin_creator != default` = a canonical (graduated) pool.
 */
import { PublicKey } from '@solana/web3.js';

export const POOL_MIN_LEN = 243;
export const POOL_VIRTUAL_LEN = 261;
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

export interface PumpSwapPoolState {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  lpSupply: bigint;
  coinCreator: string;
  /** `coin_creator` set = graduated from a pump.fun curve (canonical pool). */
  canonical: boolean;
  isMayhemMode: boolean | null;
  /** Signed; null when the account predates the field (< 261 bytes). */
  virtualQuoteReserves: bigint | null;
  size: number;
}

/** Pure. null if the data can't be a pool account. */
export function decodePumpSwapPool(data: Buffer): PumpSwapPoolState | null {
  if (data.length < POOL_MIN_LEN) return null;
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  const hasVirtual = data.length >= POOL_VIRTUAL_LEN;
  let virtualQuoteReserves: bigint | null = null;
  if (hasVirtual) {
    const lo = data.readBigUInt64LE(245);
    const hi = data.readBigInt64LE(253);
    virtualQuoteReserves = (hi << 64n) + lo;
  }
  const coinCreator = pk(211);
  return {
    index: data.readUInt16LE(9),
    creator: pk(11),
    baseMint: pk(43),
    quoteMint: pk(75),
    lpMint: pk(107),
    poolBaseTokenAccount: pk(139),
    poolQuoteTokenAccount: pk(171),
    lpSupply: data.readBigUInt64LE(203),
    coinCreator,
    canonical: coinCreator !== DEFAULT_PUBKEY,
    isMayhemMode: hasVirtual ? data.readUInt8(243) !== 0 : null,
    virtualQuoteReserves,
    size: data.length,
  };
}

/** The reserve the program quotes against: vault balance + (signed) virtual quote reserves, never below 0. */
export function effectiveQuoteReserve(vaultAmount: bigint, virtualQuoteReserves: bigint | null): bigint {
  const v = vaultAmount + (virtualQuoteReserves ?? 0n);
  return v > 0n ? v : 0n;
}

/** Pure: do the on-chain and the trade-implied reserves agree within `tolPct`? */
export function reservesAgree(onchain: bigint, implied: bigint, tolPct = 5): boolean {
  if (onchain <= 0n || implied <= 0n) return false;
  const a = Number(onchain), b = Number(implied);
  return Math.max(a / b, b / a) <= 1 + tolPct / 100;
}
