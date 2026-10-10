/**
 * Pump.fun addresses we can work out ourselves — no RPC, no API.
 *
 * The CANONICAL PumpSwap pool of a graduated pump.fun coin is the pool pump.fun itself creates
 * at migration. Anyone can create other PumpSwap pools for a mint at any price (pricing paper
 * fills against one of those is how a 0.5 SOL position once "sold" for 30 SOL) — only this one
 * is THE market. Same seeds as pump.fun's own SDK (@pump-fun/pump-swap-sdk 2.1, src/sdk/pda.ts):
 *   pool authority = PDA(["pool-authority", mint], pump program)
 *   pool           = PDA(["pool", u16 LE index 0, pool authority, mint, WSOL], PumpSwap program)
 *   bonding curve  = PDA(["bonding-curve", mint], pump program)
 */
import { PublicKey } from '@solana/web3.js';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT } from './pumpfun';

const PUMP = new PublicKey(PUMP_PROGRAM_ID);
const AMM = new PublicKey(PUMP_AMM_PROGRAM_ID);
const WSOL = new PublicKey(WSOL_MINT);
const CANONICAL_POOL_INDEX = 0;

const poolCache = new Map<string, string | null>();
const curveCache = new Map<string, string | null>();

function key(mint: string): PublicKey | null {
  try {
    return new PublicKey(mint);
  } catch {
    return null;
  }
}

/** pump.fun's pool-authority PDA for a mint (the `creator` of its canonical pool). null = not a valid address. */
export function pumpPoolAuthority(mint: string): string | null {
  const m = key(mint);
  return m ? PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], PUMP)[0].toBase58() : null;
}

/** The canonical (pump.fun-created, SOL-quoted) PumpSwap pool of a mint. null = not a valid address. Cached. */
export function canonicalPumpPool(mint: string): string | null {
  const hit = poolCache.get(mint);
  if (hit !== undefined) return hit;
  const m = key(mint);
  let out: string | null = null;
  if (m) {
    const authority = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], PUMP)[0];
    const index = Buffer.alloc(2);
    index.writeUInt16LE(CANONICAL_POOL_INDEX);
    out = PublicKey.findProgramAddressSync([Buffer.from('pool'), index, authority.toBuffer(), m.toBuffer(), WSOL.toBuffer()], AMM)[0].toBase58();
  }
  if (poolCache.size > 50_000) poolCache.clear();
  poolCache.set(mint, out);
  return out;
}

/** The mint's pump.fun bonding-curve account. null = not a valid address. Cached. */
export function bondingCurveAddress(mint: string): string | null {
  const hit = curveCache.get(mint);
  if (hit !== undefined) return hit;
  const m = key(mint);
  const out = m ? PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), m.toBuffer()], PUMP)[0].toBase58() : null;
  if (curveCache.size > 50_000) curveCache.clear();
  curveCache.set(mint, out);
  return out;
}

/**
 * Live self-check of the derivation above, from real migrations on the stream: a pool created by
 * pump.fun's pool authority (index 0, SOL-quoted) must be exactly canonicalPumpPool(mint).
 * `foreignCreator` counts pump.fun-looking pools whose creator isn't the derived authority (if
 * that grows while `match` stays 0, the derivation is wrong — shown in /api/swing).
 */
export const pdaCheck = { match: 0, mismatch: 0, foreignCreator: 0, lastMismatch: null as null | { mint: string; pool: string; derived: string | null } };

export function checkPoolEvent(ev: { pool: string; baseMint: string; quoteMint: string; creator?: string; index?: number }): void {
  if (!ev.creator || ev.quoteMint !== WSOL_MINT || (ev.index ?? 0) !== 0) return;
  if (ev.creator !== pumpPoolAuthority(ev.baseMint)) {
    if (ev.baseMint.endsWith('pump')) pdaCheck.foreignCreator++;
    return;
  }
  const derived = canonicalPumpPool(ev.baseMint);
  if (derived === ev.pool) pdaCheck.match++;
  else {
    pdaCheck.mismatch++;
    pdaCheck.lastMismatch = { mint: ev.baseMint, pool: ev.pool, derived };
  }
}
