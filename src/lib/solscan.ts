/**
 * Solscan Pro API (v2) — a wallet's swap history, for the wallet analyzer.
 *
 * The owner's plan has a limited number of credits, so:
 *   - only called when someone asks for a wallet report (never in a loop),
 *   - every call is counted per day in Redis (`solscan:calls:<day>`) and stops at `SOLSCAN_MAX_CALLS_PER_DAY`,
 *   - reports are cached (see wallet-report.ts).
 * Key: SOLSCAN_API_KEY in /root/bot/.env (never in git).
 */
import { redis } from './redis';
import { moduleLogger } from './logger';

const log = moduleLogger('solscan');
const BASE = 'https://pro-api.solscan.io/v2.0';

export interface SolscanSwap {
  block_time: number;
  trans_id: string;
  activity_type: string;
  platform?: string[] | string;
  routers?: { token1?: string; token1_decimals?: number; amount1?: number | string; token2?: string; token2_decimals?: number; amount2?: number | string };
}

export interface SolscanPage {
  swaps: SolscanSwap[];
  tokens: Record<string, { token_symbol?: string; token_name?: string }>;
}

export function solscanKey(): string | null {
  return process.env.SOLSCAN_API_KEY?.trim() || null;
}

export function maxCallsPerDay(): number {
  const n = Number(process.env.SOLSCAN_MAX_CALLS_PER_DAY ?? 200);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

/** Calls used today (UTC) and the daily cap. */
export async function solscanUsage(): Promise<{ today: number; cap: number }> {
  const today = Number((await redis.get(`solscan:calls:${new Date().toISOString().slice(0, 10)}`)) ?? 0);
  return { today, cap: maxCallsPerDay() };
}

async function take(): Promise<boolean> {
  const k = `solscan:calls:${new Date().toISOString().slice(0, 10)}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 3 * 86_400);
  return n <= maxCallsPerDay();
}

/** One page (newest first) of a wallet's token swaps. Throws with a readable message. */
export async function walletSwaps(address: string, page: number, pageSize = 100): Promise<SolscanPage> {
  const key = solscanKey();
  if (!key) throw new Error('SOLSCAN_API_KEY is not set on the server (/root/bot/.env)');
  if (!(await take())) throw new Error(`daily Solscan budget used (${maxCallsPerDay()} calls) — try again tomorrow or raise SOLSCAN_MAX_CALLS_PER_DAY`);
  const qs = new URLSearchParams({ address, page: String(page), page_size: String(pageSize), sort_by: 'block_time', sort_order: 'desc' });
  qs.append('activity_type[]', 'ACTIVITY_TOKEN_SWAP');
  qs.append('activity_type[]', 'ACTIVITY_AGG_TOKEN_SWAP');
  const res = await fetch(`${BASE}/account/defi/activities?${qs}`, { headers: { token: key, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: SolscanSwap[]; metadata?: { tokens?: SolscanPage['tokens'] }; errors?: { message?: string } } | null;
  if (!res.ok || !body?.success) {
    const why = body?.errors?.message ?? `HTTP ${res.status}`;
    log.warn({ status: res.status, why }, 'Solscan request failed');
    throw new Error(`Solscan: ${why}`);
  }
  return { swaps: body.data ?? [], tokens: body.metadata?.tokens ?? {} };
}
