/**
 * Whale Tracker — monitors tracked smart-money wallets for new buys.
 *
 * How it works:
 *   1. On startup, loads all active TrackedWallet records from the database.
 *   2. Subscribes to the PumpFun trade stream via the event bus.
 *   3. When a tracked wallet buys a token, emits a 'smart_money_buy' event
 *      that the evaluator can use to fast-track evaluation or boost the score.
 *   4. Periodically refreshes the wallet list in case new ones are added
 *      via the API or seeded from trade data.
 *
 * Wallet discovery:
 *   - The bot can discover smart-money wallets from its own trade data:
 *     wallets whose buys consistently precede price increases.
 *   - These are added with source='DISCOVERED' and a low initial weight.
 *   - The wallet scorer (daily) updates their scores and weight.
 *
 * The tracker does NOT make on-chain RPC calls. It works purely from the
 * trade data the PumpFun listener already streams, so it's free.
 */
import { moduleLogger } from '../lib/logger';
import { bus, type BusEvent } from '../lib/bus';
import { prisma } from '../lib/prisma';

const log = moduleLogger('whale-tracker');

const REFRESH_INTERVAL_MS = 5 * 60_000; // reload wallet list every 5 min

export interface SmartMoneyBuy {
  wallet: string;
  label: string | null;
  weight: number;
  mint: string;
  solAmount: number;
  timestamp: Date;
}

export class WhaleTracker {
  private wallets = new Map<string, { label: string | null; weight: number; score14d: number | null }>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Listeners for smart money buy events */
  private listeners: Array<(buy: SmartMoneyBuy) => void> = [];

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);

    // Subscribe to trade events from the bus
    this.unsubscribe = bus.subscribe((event: BusEvent) => {
      if (event.type === 'trade' && event.data.side === 'buy') {
        // Check if the buyer is a tracked wallet
        // Note: bus trade events don't include the buyer wallet address.
        // Smart money detection happens in onTrade() called directly
        // by the token registry when it processes raw PumpFun trades.
      }
    });

    log.info({ wallets: this.wallets.size }, 'whale tracker started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.unsubscribe) this.unsubscribe();
  }

  /** Called directly by the token registry for each trade — checks if it's a tracked wallet. */
  onTrade(trade: { user: string; mint: string; isBuy: boolean; solAmount: number; tsMs: number }): void {
    if (!trade.isBuy) return;
    const w = this.wallets.get(trade.user);
    if (!w) return;

    const buy: SmartMoneyBuy = {
      wallet: trade.user,
      label: w.label,
      weight: w.weight,
      mint: trade.mint,
      solAmount: trade.solAmount,
      timestamp: new Date(trade.tsMs),
    };

    log.info(
      { wallet: trade.user, label: w.label, mint: trade.mint, sol: trade.solAmount.toFixed(4) },
      `🐋 Smart money buy: ${w.label ?? trade.user.slice(0, 8)}`,
    );

    // Update last seen
    void prisma.trackedWallet.update({
      where: { address: trade.user },
      data: { lastSeenAt: new Date(trade.tsMs) },
    }).catch(() => { /* non-critical */ });

    for (const listener of this.listeners) {
      try {
        listener(buy);
      } catch { /* listener errors don't propagate */ }
    }
  }

  /** Register a callback for smart money buy events. */
  onSmartMoneyBuy(fn: (buy: SmartMoneyBuy) => void): void {
    this.listeners.push(fn);
  }

  /** Check if a wallet is tracked. */
  isTracked(address: string): { tracked: true; label: string | null; weight: number; score14d: number | null } | { tracked: false } {
    const w = this.wallets.get(address);
    if (!w) return { tracked: false };
    return { tracked: true, ...w };
  }

  /** Get all tracked wallets. */
  getAll(): Array<{ address: string; label: string | null; weight: number; score14d: number | null }> {
    return [...this.wallets.entries()].map(([address, w]) => ({ address, ...w }));
  }

  /** Add a wallet to track (persists to DB). */
  async addWallet(address: string, opts: { label?: string; source?: 'MANUAL' | 'DISCOVERED'; weight?: number } = {}): Promise<void> {
    const existing = await prisma.trackedWallet.findUnique({ where: { address } });
    if (existing) {
      log.info({ address, label: existing.label }, 'wallet already tracked');
      return;
    }

    await prisma.trackedWallet.create({
      data: {
        address,
        label: opts.label ?? null,
        source: opts.source ?? 'MANUAL',
        weight: opts.weight ?? (opts.source === 'DISCOVERED' ? 0.3 : 0.5),
      },
    });

    this.wallets.set(address, {
      label: opts.label ?? null,
      weight: opts.weight ?? (opts.source === 'DISCOVERED' ? 0.3 : 0.5),
      score14d: null,
    });

    log.info({ address, label: opts.label }, '🐋 New wallet tracked');
  }

  /** Reload wallet list from the database. */
  private async refresh(): Promise<void> {
    try {
      const rows = await prisma.trackedWallet.findMany({
        where: { active: true },
        select: { address: true, label: true, weight: true, score14d: true },
      });

      this.wallets.clear();
      for (const r of rows) {
        this.wallets.set(r.address, { label: r.label, weight: r.weight, score14d: r.score14d });
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'failed to refresh wallet list');
    }
  }
}

/** Singleton */
export const whaleTracker = new WhaleTracker();
