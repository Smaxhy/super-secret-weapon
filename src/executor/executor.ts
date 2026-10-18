/**
 * Picks the executor at startup. The trader and sell manager only ever talk to the `Executor` interface
 * (./types.ts), so PAPER, the PAPER dry run and LIVE share one code path.
 *  - LIVE: only when every gate in live-mode.ts passes (see liveBlockers) — then the reconciler runs too.
 *  - otherwise PAPER, wrapped in the dry run (live.dryRun.enabled) so every paper fill also simulates its real tx.
 */
import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { moduleLogger } from '../lib/logger';
import { getConnection } from '../lib/solana';
import type { LiveState } from '../scanner/live-state';
import { DryRunExecutor } from './live/dry-run';
import { liveBlockers } from './live/guards';
import { LiveExecutor } from './live/live-executor';
import { loadLiveSettings, setLiveStatus } from './live/live-mode';
import { Reconciler } from './live/reconciler';
import { pickSender } from './live/sender';
import { liveConfig, LiveTxBuilder } from './live/tx-builder';
import { loadWallet } from './live/wallet';
import { PaperExecutor } from './paper-trader';
import type { Executor } from './types';

export type { BuyRequest, Executor, Fill, SellRequest } from './types';
export { PaperExecutor };

const log = moduleLogger('executor');

export async function createExecutor(liveState: LiveState, redis: Redis): Promise<{ executor: Executor; reconciler: Reconciler | null; live: LiveExecutor | null }> {
  const paper = new PaperExecutor(liveState);
  const { wallet, error: walletError } = loadWallet(env);
  let conn: ReturnType<typeof getConnection> | null = null;
  try {
    conn = getConnection();
  } catch {
    conn = null;
  }
  const builder = conn ? new LiveTxBuilder(conn) : null;
  const picked = conn ? pickSender(env, (raw) => conn!.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })) : null;
  const settings = await loadLiveSettings();
  const c = liveConfig();

  let live: LiveExecutor | null = null;
  let blockers: string[] = [];
  if (env.TRADING_MODE === 'LIVE') {
    let balance: number | null = null;
    if (conn && wallet && builder && picked) {
      live = new LiveExecutor(conn, builder, wallet, picked.sender);
      balance = await live.walletSol().catch(() => null);
    }
    blockers = liveBlockers({ envMode: env.TRADING_MODE, hasWallet: !!wallet, walletError, enabledAt: settings.enabledAt, balanceSol: balance, senderReady: !!picked?.ready, senderWhy: picked?.why ?? 'no RPC endpoint configured' }, c);
    if (!conn) blockers.push('no RPC endpoint configured');
    if (blockers.length) live = null;
  }

  setLiveStatus({
    activeMode: live ? 'LIVE' : 'PAPER',
    envMode: env.TRADING_MODE,
    wallet: wallet?.short ?? null,
    walletError: wallet ? null : walletError,
    sender: picked?.sender.name ?? 'none',
    senderReady: !!picked?.ready,
    enabledAt: settings.enabledAt,
    blockers: env.TRADING_MODE === 'LIVE' ? blockers : ['TRADING_MODE=LIVE is not set in the VPS .env'],
  });

  if (live && conn && wallet) {
    log.warn({ wallet: wallet.short, sender: picked?.sender.name }, '🔴 LIVE trading — real transactions from the bot wallet');
    const reconciler = new Reconciler(conn, wallet.publicKey);
    reconciler.start();
    return { executor: live, reconciler, live };
  }
  if (env.TRADING_MODE === 'LIVE') log.warn({ blockers }, 'TRADING_MODE=LIVE but live trading is blocked — running PAPER');
  if (builder && c.dryRun.enabled) return { executor: new DryRunExecutor(paper, builder, redis, wallet?.publicKey ?? null), reconciler: null, live: null };
  return { executor: paper, reconciler: null, live: null };
}
