/**
 * Shared Solana RPC connection, wrapped in the rate limiter.
 *
 * web3.js lets us pass our own `fetch` function. We wrap the global fetch so
 * every single RPC call (from any module) waits for a rate-limiter slot first.
 */
import { Connection } from '@solana/web3.js';
import { env, rpcEndpoints } from '../config/env';
import { RateLimiter } from './rate-limiter';
import { redis } from './redis';

/** Count RPC calls per UTC day and per method, so usage shows on the dashboard. */
function countCall(body: unknown): void {
  let method = 'unknown';
  let n = 1; // a batch request counts once per call inside it
  try {
    const parsed = JSON.parse(String(body)) as { method?: string } | Array<{ method?: string }>;
    method = (Array.isArray(parsed) ? parsed[0]?.method : parsed.method) ?? 'unknown';
    if (Array.isArray(parsed)) n = parsed.length;
  } catch {
    /* non-JSON body */
  }
  const k = `rpc:calls:${new Date().toISOString().slice(0, 10)}`;
  void redis.multi().hincrby(k, method, n).hincrby(k, '_total', n).expire(k, 40 * 86_400).exec().catch(() => undefined);
}

/** RPC calls made on a given UTC day (default today), by method. */
export async function rpcUsage(day = new Date().toISOString().slice(0, 10)): Promise<Record<string, number>> {
  const h = await redis.hgetall(`rpc:calls:${day}`);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
}

export const rpcLimiter = new RateLimiter(env.RPC_MAX_RPS);

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (connection) return connection;
  const { http, ws } = rpcEndpoints();
  if (!http) {
    throw new Error('No RPC endpoint configured. Set HELIUS_API_KEY (or RPC_HTTP_URL) in .env');
  }
  const limitedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    await rpcLimiter.acquire();
    countCall(init?.body);
    return fetch(input, init);
  };
  connection = new Connection(http, {
    commitment: 'confirmed',
    wsEndpoint: ws,
    // web3.js types its fetch slightly differently from Node's; they're compatible at runtime.
    fetch: limitedFetch as unknown as typeof fetch,
  });
  return connection;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** lamports (bigint) → SOL (number). Use for display / analytics only. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** SOL (number) → lamports (bigint). Rounds down so we never overspend. */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
}
