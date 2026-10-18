/**
 * Program addresses and PDA derivations for live trading — no RPC.
 *
 * Source of truth (Oct 2026): Chainstack pumpfun-bonkfun-bot — docs/pumpfun-protocol.md,
 * src/platforms/pumpfun/address_provider.py (PumpFunAddresses + _get_v2_common_accounts),
 * src/platforms/pumpfun/pumpswap_market.py (PumpSwap pool / GlobalConfig offsets). These are the
 * public program / fee accounts every trader uses; no wallet of ours appears here.
 */
import { PublicKey } from '@solana/web3.js';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../../lib/pumpfun';

export const PUMP = new PublicKey(PUMP_PROGRAM_ID);
export const PUMP_AMM = new PublicKey(PUMP_AMM_PROGRAM_ID);
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
/** v2 `fee_recipient`: the standard one, or the mayhem one (address_provider.get_fee_recipient). */
export const PUMP_FEE = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_MAYHEM_FEE = new PublicKey('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS');
/** One is required on every buy_v2 / sell_v2 (`buyback_fee_recipient`), picked at random per tx. */
export const PUMP_BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map((a) => new PublicKey(a));

export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
export const TOKEN_2022_PROGRAM = new PublicKey(TOKEN_2022_PROGRAM_ID);
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111');
export const WSOL = new PublicKey(WSOL_MINT);
/** Rent-exempt minimum of a 165-byte token account (lamports). */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;
export const TOKEN_ACCOUNT_SIZE = 165;

const pda = (seeds: Array<Buffer | Uint8Array>, program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM);
}

export const bondingCurvePda = (mint: PublicKey) => pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
export const creatorVaultPda = (creator: PublicKey) => pda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP);
export const globalVolumeAccumulatorPda = () => pda([Buffer.from('global_volume_accumulator')], PUMP);
export const userVolumeAccumulatorPda = (user: PublicKey) => pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);
/** Lives under the pump FEES program, not the pump program (doc: "easy to derive against the wrong program"). */
export const sharingConfigPda = (mint: PublicKey) => pda([Buffer.from('sharing-config'), mint.toBuffer()], PUMP_FEE_PROGRAM);
export const pumpFeeConfigPda = () => pda([Buffer.from('fee_config'), PUMP.toBuffer()], PUMP_FEE_PROGRAM);

// PumpSwap (pump-amm)
export const ammGlobalConfigPda = () => pda([Buffer.from('global_config')], PUMP_AMM);
export const ammEventAuthorityPda = () => pda([Buffer.from('__event_authority')], PUMP_AMM);
export const ammFeeConfigPda = () => pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], PUMP_FEE_PROGRAM);
export const ammCreatorVaultPda = (coinCreator: PublicKey) => pda([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMP_AMM);
export const ammPoolV2Pda = (mint: PublicKey) => pda([Buffer.from('pool-v2'), mint.toBuffer()], PUMP_AMM);
export const ammUserVolumeAccumulatorPda = (user: PublicKey) => pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_AMM);
export const ammGlobalVolumeAccumulatorPda = () => pda([Buffer.from('global_volume_accumulator')], PUMP_AMM);

/** PumpSwap GlobalConfig offsets (pumpswap_market.py): protocol fee recipients[8], reserved (mayhem) recipient, buyback recipients[8]. */
export const AMM_CONFIG = { protocolRecipients: 57, reservedRecipient: 385, buybackRecipients: 643 } as const;

export function pubkeysAt(data: Buffer, offset: number, count: number): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = 0; i < count; i++) out.push(new PublicKey(data.subarray(offset + 32 * i, offset + 32 * (i + 1))));
  return out;
}

export function pick<T>(xs: readonly T[], rnd: () => number = Math.random): T {
  return xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))]!;
}
