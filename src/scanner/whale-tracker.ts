/**
 * Whale tracker — watches the wallets on your list (TrackedWallet table).
 *
 * Every trade event goes past `onEvent`. When the trader is a tracked wallet:
 *   BUY  → record it, make sure we're streaming that token, and queue
 *          SMART_MONEY_COPY evaluations (immediately, then a few follow-ups).
 *   SELL → if we hold a copy position on that token, flag it so the sell
 *          manager exits (exit reason COPY_EXIT).
 *
 * The list is reloaded from the database every 30 seconds, so wallets you add
 * or remove on the dashboard take effect without a restart.
 */
import type { Redis } from 'ioredis';
import type { PumpEventEnvelope } from '../config/types';
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { Evaluator } from '../evaluator/evaluator';
import type { LiveState } from './live-state';

const log = moduleLogger('whale-tracker');
const RELOAD_MS = 30_000;
const SOLD_FLAG_TTL = 24 * 3600;

export const copySoldKey = (mint: string, wallet: string) => `copy:sold:${mint}:${wallet}`;

export class WhaleTracker {
  private wallets = new Map<string, { label: string | null }>();
  private timer: NodeJS.Timeout | null = null;
  /** Called with the full wallet list whenever it changes (PumpPortal account subscriptions). */
  onWalletsChanged: ((addresses: string[]) => void) | null = null;
  /** Called when a tracked wallet trades a token we should stream. */
  onWatchToken: ((mint: string) => void) | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly evaluator: Evaluator,
  ) {}

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), RELOAD_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get count(): number {
    return this.wallets.size;
  }

  private async reload(): Promise<void> {
    try {
      const rows = await prisma.trackedWallet.findMany({ where: { active: true }, select: { address: true, label: true } });
      const next = new Map(rows.map((r) => [r.address, { label: r.label }]));
      const changed = next.size !== this.wallets.size || [...next.keys()].some((k) => !this.wallets.has(k));
      this.wallets = next;
      if (changed) {
        log.info({ wallets: next.size }, 'tracked wallet list loaded');
        this.onWalletsChanged?.([...next.keys()]);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'failed to load tracked wallets');
    }
  }

  /** Feed every listener event through here. Cheap: one Map lookup per trade. */
  onEvent = (env: PumpEventEnvelope): void => {
    const e = env.event;
    if (e.kind !== 'trade' && e.kind !== 'ammTrade') return;
    const w = this.wallets.get(e.user);
    if (!w) return;
    void this.handle(e.kind === 'trade' ? e.mint : null, e.kind === 'ammTrade' ? e.pool : null, e.user, e.isBuy, e.kind === 'trade' ? e.solAmount : e.quoteAmount, w.label).catch((err: Error) =>
      log.warn({ err: err.message }, 'whale trade handling failed'),
    );
  };

  private async handle(curveMint: string | null, pool: string | null, wallet: string, isBuy: boolean, lamports: bigint, label: string | null): Promise<void> {
    // PumpSwap trades are keyed by pool; PumpPortal pools are named "amm:<mint>".
    const mint = curveMint ?? (pool?.startsWith('amm:') ? pool.slice(4) : null);
    if (!mint) return;
    const sol = Number(lamports) / 1e9;
    const name = label ?? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

    await prisma.trackedWallet.update({ where: { address: wallet }, data: { lastSeenAt: new Date(), tradeCount: { increment: 1 } } }).catch(() => undefined);

    if (isBuy) {
      log.info({ wallet, mint, sol }, `🐋 ${name} bought ${sol.toFixed(2)} SOL`);
      void recordEvent({ module: 'whale-tracker', type: 'wallet_buy', mint, message: `${name} bought ${sol.toFixed(3)} SOL`, data: { wallet, sol } });
      bus.publish({ type: 'stats', data: { whale: { wallet, label, mint, side: 'BUY', sol } } });
      if (!this.liveState.isTracked(mint)) {
        log.debug({ mint }, 'tracked wallet bought a token we have no launch data for — skipping');
        return;
      }
      this.onWatchToken?.(mint);
      await this.evaluator.scheduleCopy(mint, wallet);
    } else {
      log.info({ wallet, mint, sol }, `🐋 ${name} sold for ${sol.toFixed(2)} SOL`);
      if (getConfig().copy.exitWhenWalletSells) await this.redis.set(copySoldKey(mint, wallet), '1', 'EX', SOLD_FLAG_TTL);
    }
  }
}
