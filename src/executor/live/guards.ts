/**
 * Pure maths + safety rules for live trading (all unit-tested, no I/O).
 */
import { quoteBuy, quoteSell } from '../../lib/pumpfun';

export interface LiveConfig {
  dryRun: { enabled: boolean };
  maxPositionSol: number;
  maxOpen: number;
  reserveSol: number;
  minBalanceSol: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  priorityFeePercentile: number;
  minPriorityMicroLamports: number;
  maxPriorityMicroLamports: number;
  tipLamports: number;
  confirmTimeoutMs: number;
  loadedAccountsDataSizeLimit: number;
  reconcileSec: number;
  reconcileTolPct: number;
}

export const DEFAULT_LIVE: LiveConfig = {
  dryRun: { enabled: true },
  maxPositionSol: 0.1,
  maxOpen: 2,
  reserveSol: 0.05,
  minBalanceSol: 0.5,
  buySlippageBps: 1500,
  sellSlippageBps: 2000,
  priorityFeePercentile: 75,
  minPriorityMicroLamports: 10_000,
  maxPriorityMicroLamports: 1_000_000,
  tipLamports: 1_000_000,
  confirmTimeoutMs: 30_000,
  loadedAccountsDataSizeLimit: 0,
  reconcileSec: 60,
  reconcileTolPct: 2,
};

const BPS = 10_000n;
const clampBps = (bps: number) => BigInt(Math.max(0, Math.min(9_900, Math.round(bps))));

/**
 * Buy plan: spend at most `sizeLamports` (the on-chain max_sol_cost / max_quote_amount_in — a worse fill reverts and
 * costs only the fee + tip) for the tokens `sizeLamports` buys now, less the slippage tolerance.
 */
export function buyPlan(sizeLamports: bigint, quoteReserve: bigint, baseReserve: bigint, feeBps: number, slippageBps: number): { tokens: bigint; maxCostLamports: bigint } {
  const { tokensOut } = quoteBuy(sizeLamports, quoteReserve, baseReserve, feeBps);
  return { tokens: (tokensOut * (BPS - clampBps(slippageBps))) / BPS, maxCostLamports: sizeLamports };
}

/** Sell floor: what `tokens` fetch now (after fee), less the slippage tolerance → min_sol_output / min_quote_amount_out. */
export function sellMinOut(tokens: bigint, quoteReserve: bigint, baseReserve: bigint, feeBps: number, slippageBps: number): bigint {
  const { solOutLamports } = quoteSell(tokens, quoteReserve, baseReserve, feeBps);
  return (solOutLamports * (BPS - clampBps(slippageBps))) / BPS;
}

/** Nearest-rank percentile (p 0–100). Empty → 0. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.max(0, Math.min(100, p)) / 100) * s.length);
  return s[Math.max(0, rank - 1)]!;
}

/** Priority fee (micro-lamports / CU) from getRecentPrioritizationFees on our writable accounts: percentile, clamped. */
export function priorityFee(recent: readonly number[], c: Pick<LiveConfig, 'priorityFeePercentile' | 'minPriorityMicroLamports' | 'maxPriorityMicroLamports'>): number {
  const nonZero = recent.filter((x) => x > 0);
  const base = percentile(nonZero.length >= 5 ? nonZero : recent, c.priorityFeePercentile);
  return Math.round(Math.max(c.minPriorityMicroLamports, Math.min(c.maxPriorityMicroLamports, base)));
}

/**
 * Live per-trade gates ON TOP of every normal cap. `balance` = the live executor's free balance, which already keeps
 * `reserveSol` back for fees. Returns the (possibly smaller) size or why not.
 */
export function liveEntryGuard(o: { openLive: number; size: number; minPositionSol: number; balance: number }, c: Pick<LiveConfig, 'maxOpen' | 'maxPositionSol' | 'reserveSol'>): { refuse: string } | { size: number } {
  if (o.openLive >= c.maxOpen) return { refuse: `live: max ${c.maxOpen} trades open` };
  const size = Math.min(o.size, c.maxPositionSol, o.balance);
  if (size < o.minPositionSol) return { refuse: `live: size ${Math.max(0, size).toFixed(3)} SOL under the minimum (cap ${c.maxPositionSol} SOL, keeping ${c.reserveSol} SOL for fees)` };
  return { size };
}

/** The owner types the wallet's first 4 characters to go live. Exact, case-sensitive. */
export function confirmMatches(typed: unknown, walletAddress: string | null): boolean {
  return typeof typed === 'string' && !!walletAddress && walletAddress.length >= 4 && typed.trim() === walletAddress.slice(0, 4);
}

/** Every reason live trading can't run right now (empty = it may). */
export function liveBlockers(o: { envMode: string; hasWallet: boolean; walletError: string | null; enabledAt: string | null; balanceSol: number | null; senderReady: boolean; senderWhy: string | null }, c: Pick<LiveConfig, 'minBalanceSol'>): string[] {
  const out: string[] = [];
  if (o.envMode !== 'LIVE') out.push('TRADING_MODE=LIVE is not set in the VPS .env');
  if (!o.hasWallet) out.push(o.walletError ?? 'no WALLET_SECRET in the VPS .env');
  if (!o.senderReady) out.push(o.senderWhy ?? 'no sender configured');
  if (!o.enabledAt) out.push('not confirmed on Controls → Live trading');
  if (o.balanceSol !== null && o.balanceSol < c.minBalanceSol) out.push(`wallet balance ${o.balanceSol.toFixed(3)} SOL < ${c.minBalanceSol} SOL minimum`);
  if (o.balanceSol === null && o.hasWallet) out.push('wallet balance unknown (RPC)');
  return out;
}

export interface ReconcilePosition { id: string; mint: string; tokenAmountRaw: bigint; remainingPct: number }
/**
 * Chain vs database: a held mint whose on-chain balance differs by more than `tolPct` → manual review (never an
 * automatic buy or sell to "fix" it); a token in the wallet that no open position explains → orphan (report only).
 */
export function reconcile(positions: readonly ReconcilePosition[], chain: ReadonlyMap<string, bigint>, tolPct: number): { mismatches: Array<{ id: string; mint: string; expected: bigint; onChain: bigint }>; orphans: Array<{ mint: string; amount: bigint }> } {
  const byMint = new Map<string, bigint>();
  for (const p of positions) byMint.set(p.mint, (byMint.get(p.mint) ?? 0n) + (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n);
  const mismatches: Array<{ id: string; mint: string; expected: bigint; onChain: bigint }> = [];
  for (const p of positions) {
    const expected = byMint.get(p.mint) ?? 0n;
    const onChain = chain.get(p.mint) ?? 0n;
    const diff = expected > onChain ? expected - onChain : onChain - expected;
    const tol = (expected * BigInt(Math.round(tolPct * 100))) / 10_000n;
    if (diff > tol) mismatches.push({ id: p.id, mint: p.mint, expected, onChain });
  }
  const orphans = [...chain.entries()].filter(([m, a]) => a > 0n && !byMint.has(m)).map(([mint, amount]) => ({ mint, amount }));
  return { mismatches, orphans };
}

export type SimCategory = 'ok' | 'funds' | 'error';
/**
 * A simulation's verdict. `funds` = failed only because the (dry-run) wallet lacks SOL / tokens — every account and
 * instruction layout was accepted up to the transfer, which is what the dry run proves.
 */
export function simCategory(err: unknown, logs: readonly string[] | null): SimCategory {
  if (!err) return 'ok';
  const text = `${JSON.stringify(err)} ${(logs ?? []).join(' ')}`.toLowerCase();
  if (/insufficient (funds|lamports)|accountnotfound|attempt to debit an account but found no record|custom":1\b|custom program error: 0x1\b/.test(text)) return 'funds';
  return 'error';
}

/** Fill from a confirmed transaction's balances (fee payer = our wallet, index 0). */
export function fillFromBalances(side: 'BUY' | 'SELL', b: { preLamports: bigint; postLamports: bigint; feeLamports: bigint; tipLamports: bigint; preTokens: bigint | null; postTokens: bigint | null }): { solAmount: number; tokens: bigint; feeSol: number } {
  const RENT = 2_039_280n;
  const pre = b.preTokens ?? 0n, post = b.postTokens ?? 0n;
  const opened = b.preTokens === null && b.postTokens !== null ? RENT : 0n; // user ATA created (rent is a deposit, not a cost)
  const closed = b.preTokens !== null && b.postTokens === null ? RENT : 0n; // ATA closed on a full sell (rent back)
  const fees = b.feeLamports + b.tipLamports;
  if (side === 'BUY') {
    const spent = b.preLamports - b.postLamports - fees - opened;
    return { solAmount: Number(spent > 0n ? spent : 0n) / 1e9, tokens: post - pre, feeSol: Number(fees) / 1e9 };
  }
  const got = b.postLamports - b.preLamports + fees - closed;
  return { solAmount: Number(got > 0n ? got : 0n) / 1e9, tokens: pre - post, feeSol: Number(fees) / 1e9 };
}
