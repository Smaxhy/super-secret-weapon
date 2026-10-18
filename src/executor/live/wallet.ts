/**
 * The live trading wallet. The secret comes ONLY from the VPS .env (`WALLET_SECRET`, base58 or a JSON byte array;
 * `BOT_WALLET_PRIVATE_KEY` is accepted as the older name), is parsed once, kept inside this module and never logged,
 * returned by the API or written anywhere. Callers get the public key and a signer function — not the key.
 */
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface LiveWallet {
  publicKey: PublicKey;
  address: string;
  /** first4…last4 — the only form the dashboard ever sees. */
  short: string;
  sign(tx: VersionedTransaction): void;
}

/** Pure: parse a secret string into a keypair. Throws with a message that never contains the secret. */
export function parseSecret(raw: string): Keypair {
  const s = raw.trim();
  let bytes: Uint8Array;
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s) as unknown;
      if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('bad array');
      bytes = Uint8Array.from(arr as number[]);
    } else bytes = bs58.decode(s);
  } catch {
    throw new Error('WALLET_SECRET is not a valid base58 string or JSON byte array');
  }
  if (bytes.length !== 64) throw new Error(`WALLET_SECRET must be a 64-byte secret key (got ${bytes.length} bytes)`);
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('WALLET_SECRET does not form a valid keypair');
  }
}

export const shortAddress = (a: string | null | undefined): string | null => (a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? null);

/** Remove anything that looks like the secret (or a long base58 / byte array) from text before it is logged / shown. */
export function redactSecret(text: string, secret: string | undefined): string {
  let out = text;
  if (secret && secret.trim().length >= 16) out = out.split(secret.trim()).join('***');
  return out.replace(/\[(\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, '[***]').replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, '***');
}

let cached: { wallet: LiveWallet | null; error: string | null } | null = null;

/** Load once from the environment. */
export function loadWallet(env: { WALLET_SECRET?: string; BOT_WALLET_PRIVATE_KEY?: string } = process.env): { wallet: LiveWallet | null; error: string | null } {
  if (cached) return cached;
  const raw = env.WALLET_SECRET ?? env.BOT_WALLET_PRIVATE_KEY;
  if (!raw || !raw.trim()) return (cached = { wallet: null, error: 'no WALLET_SECRET in the VPS .env' });
  try {
    const kp = parseSecret(raw);
    const address = kp.publicKey.toBase58();
    cached = { wallet: { publicKey: kp.publicKey, address, short: shortAddress(address)!, sign: (tx) => tx.sign([kp]) }, error: null };
  } catch (e) {
    cached = { wallet: null, error: (e as Error).message };
  }
  return cached;
}

/** Tests only. */
export function resetWalletCache(): void {
  cached = null;
}
