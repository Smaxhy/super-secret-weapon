/** Biggest token accounts of a coin over RPC (getTokenLargestAccounts, 1 call, top 20). */
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { bondingCurveAddress } from './pump-pda';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './pumpfun';
import { getConnection } from './solana';

/**
 * Raw amounts of the biggest holder accounts, biggest first. The pool's own token vault and the
 * bonding curve's account don't count. Throws on RPC failure.
 */
export async function largestHolderAccounts(mint: string, pool: string | null): Promise<Array<{ account: string; amount: number }>> {
  const mintKey = new PublicKey(mint);
  const exclude = new Set<string>();
  for (const owner of [pool, bondingCurveAddress(mint)]) {
    if (!owner) continue;
    for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) exclude.add(getAssociatedTokenAddressSync(mintKey, new PublicKey(owner), true, new PublicKey(prog)).toBase58());
  }
  const res = await getConnection().getTokenLargestAccounts(mintKey, 'confirmed');
  return res.value
    .filter((a) => !exclude.has(a.address.toBase58()))
    .map((a) => ({ account: a.address.toBase58(), amount: Number(a.amount) }))
    .sort((a, b) => b.amount - a.amount);
}
