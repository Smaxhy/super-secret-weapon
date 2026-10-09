/**
 * Token registry — the glue between the listener and everything else.
 *
 * For every decoded Pump.fun event:
 *   CreateEvent   → save Token row, start live tracking, schedule 7 snapshots,
 *                   schedule evaluations (which trigger the safety check)
 *   TradeEvent    → update live state in Redis (no DB write — too many)
 *   CompleteEvent → mark the token COMPLETED (curve filled, migrating)
 *
 * Every handler catches its own errors: one bad token must never stop the scanner.
 */
import { Worker } from 'bullmq';
import { env } from '../config/env';
import type { AmmPoolEvent, PumpCompleteEvent, PumpCreateEvent, PumpEventEnvelope, PumpTradeEvent } from '../config/types';
import { PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES, PUMP_DEFAULT_TOTAL_SUPPLY } from '../lib/pumpfun';
import { recordEvent } from '../lib/bot-events';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { QUEUE_NAMES, type SafetyJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import type { SafetyChecker } from '../evaluator/safety-checker';
import type { ObservationLogger } from '../learner/observation-logger';
import type { Evaluator } from '../evaluator/evaluator';
import type { LiveState } from './live-state';
import { curvePriceSol } from '../lib/pumpfun';
import type { InsiderTracker } from '../evaluator/insider-cluster';
import type { CrowdTracker } from './crowd-tracker';

const log = moduleLogger('token-registry');

export class TokenRegistry {
  private safetyWorker: Worker<SafetyJob> | null = null;
  readonly stats = { created: 0, createErrors: 0, completed: 0, tradeErrors: 0, latencyMsAvg: 0 };

  constructor(
    private readonly liveState: LiveState,
    private readonly observations: ObservationLogger | null,
    private readonly safety: SafetyChecker | null,
    private readonly evaluator: Evaluator | null = null,
    /** Hidden-dev / bundle / insider signals from the trade stream (no RPC). */
    private readonly insiders: InsiderTracker | null = null,
    /** Per-trade crowd log (behaviour, eyes, Soon detection). */
    private readonly crowd: CrowdTracker | null = null,
  ) {}

  /** Wire this to `listener.on('event', ...)`. */
  handle = (envelope: PumpEventEnvelope): void => {
    const { event } = envelope;
    switch (event.kind) {
      case 'create':
        void this.onCreate(event, envelope);
        break;
      case 'trade':
        this.liveState.onTrade(event).then(() => {
          if (!this.liveState.isTracked(event.mint)) return;
          this.crowd?.onCurveTrade(event);
          if (!this.insiders) return;
          return this.insiders.onTrade({
            mint: event.mint, user: event.user, isBuy: event.isBuy, lamports: event.solAmount, tokens: event.tokenAmount, timestamp: event.timestamp,
            priceSol: event.virtualTokenReserves > 0n ? curvePriceSol(event.virtualSolReserves, event.virtualTokenReserves) : undefined,
          });
        }).catch((err: Error) => {
          this.stats.tradeErrors++;
          if (this.stats.tradeErrors % 100 === 1) log.warn({ err: err.message }, 'trade update failed');
        });
        break;
      case 'complete':
        void this.onComplete(event);
        break;
      case 'ammPool':
        void this.onAmmPool(event);
        break;
      case 'ammTrade':
        this.liveState.onAmmTrade(event).then((mint) => {
          if (!mint) return;
          this.crowd?.onAmmTrade(mint, event);
          if (!this.insiders) return;
          return this.insiders.onTrade({ mint, user: event.user, isBuy: event.isBuy, lamports: event.quoteAmount, tokens: event.baseAmount, timestamp: event.timestamp });
        }).catch((err: Error) => {
          this.stats.tradeErrors++;
          if (this.stats.tradeErrors % 100 === 1) log.warn({ err: err.message }, 'pumpswap trade update failed');
        });
        break;
    }
  };

  private async onCreate(ev: PumpCreateEvent, envelope: PumpEventEnvelope): Promise<void> {
    // Already tracking it (duplicate notification / fallback fetch raced the logs).
    if (this.liveState.isTracked(ev.mint)) return;
    const detectedAt = Date.now();
    const createdAtMs = ev.timestamp > 0 ? ev.timestamp * 1000 : detectedAt;
    try {
      // Live state first: trades from the same transaction arrive right behind this.
      await this.liveState.onCreate(ev, detectedAt);
      if (this.insiders) void this.insiders.onCreate({ mint: ev.mint, creator: ev.creator, timestamp: ev.timestamp }).catch(() => undefined);

      await prisma.token.upsert({
        where: { mint: ev.mint },
        update: {},
        create: {
          mint: ev.mint,
          name: ev.name,
          symbol: ev.symbol,
          uri: ev.uri,
          bondingCurve: ev.bondingCurve,
          creator: ev.creator,
          tokenProgram: ev.tokenProgram,
          createSignature: envelope.signature,
          createSlot: BigInt(envelope.slot),
          createdAt: new Date(createdAtMs),
          detectedAt: new Date(detectedAt),
          initialVirtualSolReserves: ev.virtualSolReserves,
          initialVirtualTokenReserves: ev.virtualTokenReserves,
          initialRealTokenReserves: ev.realTokenReserves,
          totalSupply: ev.tokenTotalSupply,
        },
      });

      this.stats.created++;
      const latency = Math.max(0, detectedAt - createdAtMs);
      this.stats.latencyMsAvg = this.stats.latencyMsAvg * 0.95 + latency * 0.05;
      log.info({ mint: ev.mint, tokenName: ev.name, symbol: ev.symbol, creator: ev.creator, latencyMs: latency }, `🆕 ${ev.symbol}`);

      bus.publish({ type: 'token', data: { mint: ev.mint, name: ev.name, symbol: ev.symbol, creator: ev.creator, createdAt: new Date(createdAtMs).toISOString() } });
      await this.observations?.scheduleFor(ev.mint, createdAtMs);
      await this.evaluator?.scheduleFor(ev.mint, createdAtMs);
      // Safety checks cost RPC credits, so the evaluator queues them only for
      // tokens that gain real holders (see scoring.safetyMinHolders).
    } catch (err) {
      this.stats.createErrors++;
      log.error({ mint: ev.mint, err: (err as Error).message }, 'failed to register new token');
    }
  }

  /**
   * Start tracking a curve token we never saw launch (e.g. a tracked wallet
   * bought it). Name/symbol are filled in from its metadata later if possible.
   */
  async adopt(ev: PumpTradeEvent): Promise<void> {
    if (this.liveState.isTracked(ev.mint)) return;
    const create: PumpCreateEvent = {
      kind: 'create',
      name: '(joined late)',
      symbol: ev.mint.slice(0, 5),
      uri: '',
      mint: ev.mint,
      bondingCurve: '',
      user: '',
      creator: '',
      timestamp: ev.timestamp,
      virtualTokenReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
      virtualSolReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
      realTokenReserves: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
      tokenTotalSupply: PUMP_DEFAULT_TOTAL_SUPPLY,
    };
    await this.onCreate(create, { signature: `adopt:${ev.mint}`, slot: 0, event: create });
    await this.liveState.onTrade(ev);
    log.info({ mint: ev.mint }, '👀 now tracking a token a watched wallet bought');
  }

  /** A tracked token's PumpSwap pool appeared: it can be traded again → start migration checkpoints. */
  private async onAmmPool(ev: AmmPoolEvent): Promise<void> {
    try {
      const mint = await this.liveState.onAmmPool(ev);
      if (!mint) return;
      await prisma.token.updateMany({ where: { mint, status: { not: 'COMPLETED' } }, data: { status: 'COMPLETED', completedAt: new Date(ev.timestamp * 1000) } });
      log.info({ mint, pool: ev.pool, liquiditySol: Number(ev.quoteReserve) / 1e9 }, '🌊 migrated to PumpSwap');
      await this.evaluator?.scheduleMigration(mint, ev.timestamp > 0 ? ev.timestamp * 1000 : Date.now());
    } catch (err) {
      log.error({ pool: ev.pool, err: (err as Error).message }, 'failed to handle PumpSwap pool');
    }
  }

  private async onComplete(ev: PumpCompleteEvent): Promise<void> {
    try {
      await this.liveState.onComplete(ev);
      // The completion can land before the token's row is written (fast
      // curves, or create + complete close together) — retry briefly.
      let count = 0;
      for (let attempt = 0; attempt < 5 && count === 0; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));
        const res = await prisma.token.updateMany({
          where: { mint: ev.mint },
          data: { status: 'COMPLETED', completedAt: new Date(ev.timestamp * 1000) },
        });
        count = res.count;
        if (!this.liveState.isTracked(ev.mint)) break; // token launched before we started — nothing to update
      }
      if (count > 0) {
        this.stats.completed++;
        log.info({ mint: ev.mint }, '🎓 bonding curve complete');
        await recordEvent({ module: 'scanner', type: 'curve_complete', mint: ev.mint, message: 'Bonding curve completed' });
      }
    } catch (err) {
      log.error({ mint: ev.mint, err: (err as Error).message }, 'failed to handle curve completion');
    }
  }

  /** Start the background worker that runs queued safety checks. */
  startSafetyWorker(concurrency = 4): void {
    if (!this.safety || !env.ENABLE_SAFETY_CHECKS) return;
    const checker = this.safety;
    this.safetyWorker = new Worker<SafetyJob>(QUEUE_NAMES.safety, async (job) => void (await checker.check(job.data.mint)), {
      connection: bullConnection(),
      concurrency,
    });
    this.safetyWorker.on('failed', (job, err) => {
      log.warn({ mint: job?.data.mint, attempt: job?.attemptsMade, err: err.message }, 'safety check failed');
    });
  }

  async stop(): Promise<void> {
    await this.safetyWorker?.close();
  }
}
