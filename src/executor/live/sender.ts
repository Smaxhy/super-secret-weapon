/**
 * Where a signed live transaction goes. In order of preference:
 *  - Helius Sender (`LIVE_SENDER_URL`): dual-routes to validators + Jito; needs a tip (≥ 0.001 SOL) to one of its tip
 *    accounts, listed in `LIVE_TIP_ACCOUNTS` (comma-separated, copied from Helius' docs — they can't be fetched here);
 *  - the owner's MEV-protected endpoint (`LIVE_SHIELD_URL`, e.g. FluxRPC shield): plain JSON-RPC sendTransaction;
 *  - fallback: sendTransaction on the normal RPC (RPC_HTTP_URL).
 * Every send is an essential request in the usage budget.
 */
import { PublicKey } from '@solana/web3.js';
import { redactUrl } from '../../config/env';
import { noteUsage, providerOf } from '../../lib/usage-budget';

export interface Sender {
  name: string;
  /** Tip account to pay in the same transaction (null = no tip needed). */
  tipAccount(): PublicKey | null;
  send(rawTx: Buffer): Promise<string>;
}

export interface SenderEnv { LIVE_SENDER_URL?: string; LIVE_SHIELD_URL?: string; LIVE_TIP_ACCOUNTS?: string }

/** Pure: comma/space-separated tip accounts → valid public keys (invalid entries dropped). */
export function parseTipAccounts(raw: string | undefined): PublicKey[] {
  if (!raw) return [];
  const out: PublicKey[] = [];
  for (const s of raw.split(/[\s,]+/)) {
    if (!s) continue;
    try {
      out.push(new PublicKey(s));
    } catch {
      /* skip */
    }
  }
  return out;
}

async function jsonRpcSend(url: string, rawTx: Buffer, skipPreflight: boolean, fetchFn: typeof fetch): Promise<string> {
  noteUsage(providerOf(url), 1);
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [rawTx.toString('base64'), { encoding: 'base64', skipPreflight, maxRetries: 0 }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.result) throw new Error(`${redactUrl(url)}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

/** Pick the sender from the environment. `rpcSend` is the plain-RPC fallback. Never throws; `ready` says if it can send. */
export function pickSender(env: SenderEnv, rpcSend: (raw: Buffer) => Promise<string>, fetchFn: typeof fetch = fetch): { sender: Sender; ready: boolean; why: string | null } {
  if (env.LIVE_SENDER_URL) {
    const tips = parseTipAccounts(env.LIVE_TIP_ACCOUNTS);
    const url = env.LIVE_SENDER_URL;
    const sender: Sender = {
      name: 'helius-sender',
      tipAccount: () => (tips.length ? tips[Math.floor(Math.random() * tips.length)]! : null),
      send: (raw) => jsonRpcSend(url, raw, true, fetchFn),
    };
    return tips.length ? { sender, ready: true, why: null } : { sender, ready: false, why: 'LIVE_SENDER_URL is set but LIVE_TIP_ACCOUNTS is empty (copy the tip accounts from Helius docs)' };
  }
  if (env.LIVE_SHIELD_URL) {
    const url = env.LIVE_SHIELD_URL;
    return { sender: { name: 'shield', tipAccount: () => null, send: (raw) => jsonRpcSend(url, raw, false, fetchFn) }, ready: true, why: null };
  }
  return { sender: { name: 'rpc', tipAccount: () => null, send: rpcSend }, ready: true, why: null };
}
