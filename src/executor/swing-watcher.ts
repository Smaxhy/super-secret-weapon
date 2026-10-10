/**
 * Swing watcher — trade the same Soon / migrated coin more than once.
 *
 * After a SOON or MIGRATION_MOMENTUM position closes (anything but a rug), the
 * coin stays on a watch list for `focus.swing.watchMinutes`. Every
 * `focus.swing.everySec` the crowd log is checked for a healthy pullback that
 * is bouncing with buyers in control (see swingSignal). When it is, the coin
 * gets a full re-evaluation flagged as a swing: all the normal rules and the
 * score still have to pass; the trader allows up to `maxReentries` re-buys.
 */
import type { Redis } from 'ioredis';
import { getConfig } from '../config/runtime-config';
import type { StrategyName } from '../config/types';
import type { Evaluator } from '../evaluator/evaluator';
import { bus, type BusEvent } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { closedPosition, prisma } from '../lib/prisma';
import { swingSignal, type CrowdTracker } from '../scanner/crowd-tracker';
import type { LiveState } from '../scanner/live-state';

const log = moduleLogger('swing-watcher');
const K_WATCH = 'swing:watch';
const coolKey = (mint: string) => `swing:cool:${mint}`;

export class SwingWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly onBus = (e: BusEvent) => {
    if (e.type !== 'trade') return;
    const d = e.data as { mint?: string; side?: string; closed?: boolean };
    if (d.side === 'SELL' && d.closed && d.mint) void this.onClosed(d.mint).catch((err: Error) => log.warn({ err: err.message }, 'swing: watch failed'));
  };

  constructor(
    private readonly redis: Redis,
    private readonly liveState: LiveState,
    private readonly crowd: CrowdTracker,
    private readonly evaluator: Evaluator,
  ) {}

  start(): void {
    bus.on('event', this.onBus);
    const every = Math.max(5, getConfig().focus.swing.everySec) * 1000;
    this.timer = setInterval(() => void this.tick().catch((err: Error) => log.warn({ err: err.message }, 'swing tick failed')), every);
  }

  stop(): void {
    bus.off('event', this.onBus);
    if (this.timer) clearInterval(this.timer);
  }

  async onClosed(mint: string, now = Date.now()): Promise<void> {
    const sw = getConfig().focus.swing;
    if (!sw.enabled) return;
    const p = await closedPosition(mint);
    if (!p || (p.strategy !== 'SOON' && p.strategy !== 'MIGRATION_MOMENTUM') || p.exitReason === 'RUG_DETECTED' || p.exitReason === 'KILL_SWITCH') return;
    // A coin that beat us isn't worth watching for a re-entry (the trader refuses those anyway).
    if ((sw.onlyAfterProfit ?? true) && p.realizedPnlSol <= 0) return;
    await this.redis.zadd(K_WATCH, String(now + sw.watchMinutes * 60_000), mint);
    await this.redis.set(coolKey(mint), '1', 'EX', Math.max(30, sw.cooldownSec));
    log.info({ mint }, `🔁 watching for a swing re-entry (${sw.watchMinutes} min)`);
  }

  private async tick(now = Date.now()): Promise<void> {
    const sw = getConfig().focus.swing;
    await this.redis.zremrangebyscore(K_WATCH, '-inf', String(now));
    if (!sw.enabled) return;
    const mints = await this.redis.zrange(K_WATCH, '0', '-1');
    for (const mint of mints) {
      if (await this.redis.exists(coolKey(mint))) continue;
      const open = await prisma.position.count({ where: { mint, status: { in: ['OPEN', 'CLOSING'] } } });
      if (open) continue;
      const sig = swingSignal(this.crowd.trades(mint), now, sw);
      if (!sig.ok) continue;
      const complete = await this.liveState.isComplete(mint);
      const strategy: StrategyName = complete ? 'MIGRATION_MOMENTUM' : 'SOON';
      await this.redis.set(coolKey(mint), '1', 'EX', Math.max(30, sw.cooldownSec));
      log.info({ mint, strategy, why: sig.why }, '🔁 swing setup — re-checking');
      await this.evaluator.checkNow(mint, strategy, sig.why, { swing: true });
    }
  }

  static async reset(redis: Redis): Promise<void> {
    await redis.del(K_WATCH);
  }
}
