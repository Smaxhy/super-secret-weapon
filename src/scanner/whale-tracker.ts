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
 *
 * KOL wallets (kind KOL — Cupsey, Cented…) are NOT copied one by one: their buys
 * and sells are recorded (kol-signal.ts) and when `kol.minKols` different KOLs
 * buy the same coin within `kol.windowMin`, the coin is checked right away
 * (`onKolCluster`). The starter KOL list (config/kol-wallets.ts) is added once.
 */
import type { Redis } from 'ioredis';
import type { PumpEventEnvelope, PumpTradeEvent } from '../config/types';
import { getConfig } from '../config/runtime-config';
import { recordEvent } from '../lib/bot-events';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { Evaluator } from '../evaluator/evaluator';
import type { LiveState } from './live-state';
import { recordKolTrade, setKolDirectory } from './kol-signal';
import { KNOWN_KOLS } from '../config/kol-wallets';
import { isValidPubkey } from '../lib/pumpfun';

/** Add the starter KOL list once (a marker row remembers it, so KOLs you delete stay deleted). */
async function seedKnownKols(): Promise<void> {
  const MARK = '_kolSeed';
  if (await prisma.botConfig.findUnique({ where: { key: MARK } })) return;
  const rows = KNOWN_KOLS.filter((k) => isValidPubkey(k.address));
  await prisma.trackedWallet.createMany({
    data: rows.map((k) => ({ address: k.address, label: k.name, kind: 'KOL', weight: k.weight, notes: k.source, source: 'MANUAL' as const })),
    skipDuplicates: true,
  });
  await prisma.botConfig.create({ data: { key: MARK, value: { version: 1, added: rows.map((k) => k.name) } } });
  log.info({ kols: rows.map((k) => k.name) }, 'starter KOL wallets added (verify them on kolscan)');
}

const log = moduleLogger('whale-tracker');
const RELOAD_MS = 30_000;
const SOLD_FLAG_TTL = 24 * 3600;

export const copySoldKey = (mint: string, wallet: string) => `copy:sold:${mint}:${wallet}`;

export class WhaleTracker {
  private wallets = new Map<string, { label: string | null; kind: string; weight: number }>();
  /** Enough KOLs bought this coin → check it now. */
  onKolCluster: ((mint: string, kols: number) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Called with the full wallet list whenever it changes (PumpPortal account subscriptions). */
  onWalletsChanged: ((addresses: string[]) => void) | null = null;
  /** Called when a tracked wallet trades a token we should stream. */
  onWatchToken: ((mint: string) => void) | null = null;
  /** Start tracking a token we never saw launch (a tracked wallet bought it). */
  onAdopt: ((ev: PumpTradeEvent) => Promise<void>) | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly evaluator: Evaluator,
  ) {}

  async start(): Promise<void> {
    await seedKnownKols().catch((err: Error) => log.warn({ err: err.message }, 'could not seed the starter KOL list'));
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
      const rows = await prisma.trackedWallet.findMany({ where: { active: true }, select: { address: true, label: true, kind: true, weight: true } });
      const next = new Map(rows.map((r) => [r.address, { label: r.label, kind: r.kind, weight: r.weight }]));
      setKolDirectory(new Map(rows.filter((r) => r.kind === 'KOL').map((r) => [r.address, { name: r.label ?? `${r.address.slice(0, 4)}…`, weight: r.weight }])));
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
    if (w.kind === 'KOL') {
      void this.handleKol(e.kind === 'trade' ? e.mint : null, e.kind === 'ammTrade' ? e.pool : null, e.user, e.isBuy, w.label, e.kind === 'trade' ? e : null).catch((err: Error) =>
        log.warn({ err: err.message }, 'KOL trade handling failed'),
      );
      return;
    }
    void this.handle(
      e.kind === 'trade' ? e.mint : null,
      e.kind === 'ammTrade' ? e.pool : null,
      e.user,
      e.isBuy,
      e.kind === 'trade' ? e.solAmount : e.quoteAmount,
      w.label,
      e.kind === 'trade' ? e : null,
    ).catch((err: Error) => log.warn({ err: err.message }, 'whale trade handling failed'));
  };

  /** A KOL traded: record it; enough KOLs in the same coin → check it now. */
  private async handleKol(curveMint: string | null, pool: string | null, wallet: string, isBuy: boolean, label: string | null, curveTrade: PumpTradeEvent | null): Promise<void> {
    const kc = getConfig().kol;
    if (!kc?.enabled) return;
    const mint = curveMint ?? (pool ? (this.liveState.mintForPool(pool) ?? (pool.startsWith('amm:') ? pool.slice(4) : null)) : null);
    if (!mint) return;
    const kols = await recordKolTrade(this.redis, mint, wallet, isBuy);
    await prisma.trackedWallet.update({ where: { address: wallet }, data: { lastSeenAt: new Date(), tradeCount: { increment: 1 } } }).catch(() => undefined);
    if (!isBuy) return;
    const name = label ?? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
    log.info({ wallet, mint, kols }, `⭐ KOL ${name} bought (${kols} KOL${kols === 1 ? '' : 's'} in this coin)`);
    if (!this.liveState.isTracked(mint) && curveTrade && this.onAdopt) await this.onAdopt(curveTrade);
    if (kols >= kc.minKols && this.liveState.isTracked(mint)) {
      const fresh = await this.redis.set(`kol:check:${mint}`, '1', 'EX', Math.max(30, kc.checkCooldownSec), 'NX');
      if (fresh) {
        void recordEvent({ module: 'whale-tracker', type: 'kol_cluster', mint, message: `${kols} KOLs bought this coin — checking it now`, data: { kols } });
        this.onWatchToken?.(mint);
        this.onKolCluster?.(mint, kols);
      }
    }
  }

  private async handle(curveMint: string | null, pool: string | null, wallet: string, isBuy: boolean, lamports: bigint, label: string | null, curveTrade: PumpTradeEvent | null): Promise<void> {
    // PumpSwap trades are keyed by pool address (or "amm:<mint>" from PumpPortal).
    const mint = curveMint ?? (pool ? (this.liveState.mintForPool(pool) ?? (pool.startsWith('amm:') ? pool.slice(4) : null)) : null);
    if (!mint) {
      // A PumpSwap pool we don't follow — still record that the wallet is active.
      await prisma.trackedWallet.update({ where: { address: wallet }, data: { lastSeenAt: new Date(), tradeCount: { increment: 1 } } }).catch(() => undefined);
      return;
    }
    const sol = Number(lamports) / 1e9;
    const name = label ?? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

    await prisma.trackedWallet.update({ where: { address: wallet }, data: { lastSeenAt: new Date(), tradeCount: { increment: 1 } } }).catch(() => undefined);

    if (isBuy) {
      log.info({ wallet, mint, sol }, `🐋 ${name} bought ${sol.toFixed(2)} SOL`);
      void recordEvent({ module: 'whale-tracker', type: 'wallet_buy', mint, message: `${name} bought ${sol.toFixed(3)} SOL`, data: { wallet, sol } });
      bus.publish({ type: 'stats', data: { whale: { wallet, label, mint, side: 'BUY', sol } } });
      if (!this.liveState.isTracked(mint)) {
        // We never saw this launch — start tracking it now from the wallet's trade.
        if (curveTrade && this.onAdopt) await this.onAdopt(curveTrade);
        if (!this.liveState.isTracked(mint)) {
          log.debug({ mint }, 'tracked wallet bought a token we cannot follow — skipping');
          return;
        }
      }
      this.onWatchToken?.(mint);
      await this.evaluator.scheduleCopy(mint, wallet);
    } else {
      log.info({ wallet, mint, sol }, `🐋 ${name} sold for ${sol.toFixed(2)} SOL`);
      if (getConfig().copy.exitWhenWalletSells) await this.redis.set(copySoldKey(mint, wallet), '1', 'EX', SOLD_FLAG_TTL);
    }
  }
}
