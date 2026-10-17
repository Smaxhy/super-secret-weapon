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
import { QUEUE_NAMES, safetyQueue, type SafetyJob } from '../lib/queues';
import { bullConnection } from '../lib/redis';
import type { SafetyChecker } from '../evaluator/safety-checker';
import type { ObservationLogger } from '../learner/observation-logger';
import type { Evaluator } from '../evaluator/evaluator';
import { ADOPTED_CREATOR, type LiveState } from './live-state';
import { curvePriceSol, isSolQuote } from '../lib/pumpfun';
import { bondingCurveAddress, checkPoolEvent, pdaCheck } from '../lib/pump-pda';
import { decodePumpSwapPool } from '../lib/pumpswap-pool';
import { getConnection } from '../lib/solana';
import { PublicKey } from '@solana/web3.js';
import type { InsiderTracker } from '../evaluator/insider-cluster';
import type { CrowdTracker } from './crowd-tracker';
import type { TapeRecorder } from '../learner/tape-recorder';
import type { DeployerBook } from '../learner/deployer-book';
import type { WalletBook } from '../learner/wallet-book';
import type { WalletPnl } from '../learner/wallet-pnl';

const log = moduleLogger('token-registry');
/** pump.fun's BOOST buys run ~5 min after migration (focus.migrated.noEntryFirstSec 330) — re-read the pool just after. */
const BOOST_REREAD_SEC = 345;

export class TokenRegistry {
  private safetyWorker: Worker<SafetyJob> | null = null;
  readonly stats: { created: number; createErrors: number; completed: number; tradeErrors: number; latencyMsAvg: number; nonSolSkipped?: number } = { created: 0, createErrors: 0, completed: 0, tradeErrors: 0, latencyMsAvg: 0, nonSolSkipped: 0 };
  /** Smart-money discovery: every trade's realised profit per wallet (set in index.ts). */
  pnl: WalletPnl | null = null;
  /** Called with the mint after every trade is applied to the live state (exits react instantly). */
  readonly onTradeApplied: Array<(mint: string) => void> = [];
  /** v11.5: the tape recorder (set in index.ts) — every applied trade, curve and PumpSwap, is recorded. */
  tape: TapeRecorder | null = null;
  /** v11.6: the wallet book (set in index.ts) — every wallet's record, from the same trades. */
  book: WalletBook | null = null;
  /** v11.10: the deployer book (set in index.ts) — launches and graduations per creator. */
  deployers: DeployerBook | null = null;

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
        this.liveState.onTrade(event).then(async () => {
          if (!this.liveState.isTracked(event.mint)) {
            // A running coin we never saw launch (trending lists) → start following it from this trade.
            const until = this.wanted.get(event.mint);
            if (!until || until < Date.now()) return;
            this.wanted.delete(event.mint);
            await this.adopt(event);
            if (!this.liveState.isTracked(event.mint)) return;
          }
          this.crowd?.onCurveTrade(event, envelope.slot);
          this.tape?.onCurveTrade(event, envelope.slot);
          if (this.book) {
            const sol = Number(event.solAmount) / 1e9;
            const tokens = Number(event.tokenAmount) / 1e6;
            this.book.onTrade({ mint: event.mint, wallet: event.user, isBuy: event.isBuy, sol, tokens, t: Date.now(), price: tokens > 0 ? sol / tokens : 0, creator: this.liveState.meta(event.mint)?.creator ?? null });
          }
          for (const f of this.onTradeApplied) f(event.mint);
          if (this.pnl) {
            const meta = this.liveState.meta(event.mint);
            void this.pnl.onTrade({ mint: event.mint, wallet: event.user, isBuy: event.isBuy, sol: Number(event.solAmount) / 1e9, tokens: Number(event.tokenAmount) / 1e6, ageSec: meta ? event.timestamp - meta.createdSec : null, creator: meta?.creator ?? null });
          }
          if (!this.insiders) return;
          return this.insiders.onTrade({
            mint: event.mint, user: event.user, isBuy: event.isBuy, lamports: event.solAmount, tokens: event.tokenAmount, timestamp: event.timestamp, slot: envelope.slot,
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
          this.crowd?.onAmmTrade(mint, event, envelope.slot);
          this.tape?.onAmmTrade(mint, event, envelope.slot);
          if (this.book) {
            const sol = Number(event.quoteAmount) / 1e9;
            const tokens = Number(event.baseAmount) / 1e6;
            this.book.onTrade({ mint, wallet: event.user, isBuy: event.isBuy, sol, tokens, t: Date.now(), price: tokens > 0 ? sol / tokens : 0, creator: this.liveState.meta(mint)?.creator ?? null });
          }
          for (const f of this.onTradeApplied) f(mint);
          if (this.pnl) {
            const meta = this.liveState.meta(mint);
            void this.pnl.onTrade({ mint, wallet: event.user, isBuy: event.isBuy, sol: Number(event.quoteAmount) / 1e9, tokens: Number(event.baseAmount) / 1e6, ageSec: null, creator: meta?.creator ?? null });
          }
          if (!this.insiders) return;
          return this.insiders.onTrade({ mint, user: event.user, isBuy: event.isBuy, lamports: event.quoteAmount, tokens: event.baseAmount, timestamp: event.timestamp, slot: envelope.slot });
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
    // Coins paired with USDC / another token (not SOL): every amount in their events is in that token's units, so the
    // SOL maths (price, market cap, fills) would be wrong by orders of magnitude → not followed at all.
    if (!isSolQuote(ev.quoteMint)) {
      this.stats.nonSolSkipped = (this.stats.nonSolSkipped ?? 0) + 1;
      if (this.stats.nonSolSkipped % 50 === 1) log.info({ mint: ev.mint, quoteMint: ev.quoteMint, skipped: this.stats.nonSolSkipped }, 'skipping a coin that is not paired with SOL');
      return;
    }
    const detectedAt = Date.now();
    const createdAtMs = ev.timestamp > 0 ? ev.timestamp * 1000 : detectedAt;
    try {
      // Live state first: trades from the same transaction arrive right behind this.
      await this.liveState.onCreate(ev, detectedAt);
      if (this.insiders) void this.insiders.onCreate({ mint: ev.mint, creator: ev.creator, timestamp: ev.timestamp }).catch(() => undefined);
      this.deployers?.onLaunch(ev.creator, ev.mint, createdAtMs);

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
  /** Curve coins to start following on their next trade (mint → until, ms). */
  private readonly wanted = new Map<string, number>();
  want(mint: string, forMs = 15 * 60_000): void {
    if (this.liveState.isTracked(mint)) return;
    if (this.wanted.size > 3_000) for (const [m, t] of this.wanted) if (t < Date.now()) this.wanted.delete(m);
    if (this.wanted.size <= 3_000) this.wanted.set(mint, Date.now() + forMs);
  }

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

  /**
   * Start following a coin that ALREADY migrated (swing trading bigger coins): a Token row (it
   * never had a create event here), its canonical PumpSwap pool → live state, and a safety check
   * (1 RPC call: mint / freeze authority, token program, extensions). Returns 'adopted' for a coin
   * new to us, 'tracked' if we already follow it.
   */
  async adoptMigrated(c: { mint: string; pool: string; symbol: string; name: string; uri?: string | null; createdAtMs: number | null; migratedAtMs: number | null; baseReserve?: bigint | null; quoteReserve?: bigint | null }): Promise<'adopted' | 'tracked'> {
    const res = await this.liveState.adoptPool(c);
    if (res === 'adopted') void this.readPoolAccount(c.mint, c.pool, 'adopt');
    if (res === 'tracked') return res;
    const now = Date.now();
    const createdAt = new Date(c.createdAtMs ?? c.migratedAtMs ?? now);
    const token = await prisma.token.upsert({
      where: { mint: c.mint },
      update: {},
      create: {
        mint: c.mint,
        name: (c.name || c.symbol || c.mint.slice(0, 6)).slice(0, 64),
        symbol: (c.symbol || c.mint.slice(0, 5)).slice(0, 24),
        uri: c.uri ?? '',
        bondingCurve: bondingCurveAddress(c.mint) ?? '',
        creator: ADOPTED_CREATOR,
        createSignature: `adopt:${c.mint}`,
        createSlot: 0n,
        createdAt,
        detectedAt: new Date(now),
        initialVirtualSolReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
        initialVirtualTokenReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
        initialRealTokenReserves: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
        totalSupply: PUMP_DEFAULT_TOTAL_SUPPLY,
        status: 'COMPLETED',
        completedAt: c.migratedAtMs ? new Date(c.migratedAtMs) : createdAt,
      },
      select: { safetyScore: true },
    });
    if (token.safetyScore === null && env.ENABLE_SAFETY_CHECKS) await safetyQueue.add('check', { mint: c.mint }, { jobId: `safety-${c.mint}` }).catch(() => undefined);
    log.info({ mint: c.mint, symbol: c.symbol, pool: c.pool }, `🔭 following ${c.symbol || c.mint.slice(0, 6)} (bigger coin, for swing trading)`);
    return res;
  }

  /**
   * v11.8: read the PumpSwap pool ACCOUNT (one RPC call, counted by the usage budget) for its virtual quote reserve
   * (exact pricing from then on) and `coin_creator` (canonical-pool second signal). Once per migration / adoption,
   * and again after the BOOST window, when pump.fun's virtual reserves change.
   */
  private async readPoolAccount(mint: string, pool: string, why: string): Promise<void> {
    try {
      const info = await getConnection().getAccountInfo(new PublicKey(pool), 'confirmed');
      const st = info ? decodePumpSwapPool(info.data) : null;
      if (!st || st.baseMint !== mint) return;
      if (st.canonical) pdaCheck.creatorSet++;
      else pdaCheck.creatorNotSet++;
      await this.liveState.applyPoolAccount(mint, st);
      log.debug({ mint, why, virtualQuote: st.virtualQuoteReserves?.toString() ?? null, canonical: st.canonical, size: st.size }, 'pool account read');
    } catch (err) {
      log.debug({ mint, pool, why, err: (err as Error).message }, 'pool account read failed');
    }
  }

  /** A tracked token's PumpSwap pool appeared: it can be traded again → start migration checkpoints. */
  private async onAmmPool(ev: AmmPoolEvent): Promise<void> {
    try {
      checkPoolEvent(ev);
      const mint = await this.liveState.onAmmPool(ev);
      if (!mint) return;
      await prisma.token.updateMany({ where: { mint, status: { not: 'COMPLETED' } }, data: { status: 'COMPLETED', completedAt: new Date(ev.timestamp * 1000) } });
      log.info({ mint, pool: ev.pool, liquiditySol: Number(ev.quoteReserve) / 1e9 }, '🌊 migrated to PumpSwap');
      await this.evaluator?.scheduleMigration(mint, ev.timestamp > 0 ? ev.timestamp * 1000 : Date.now());
      void this.readPoolAccount(mint, ev.pool, 'migration');
      const t = setTimeout(() => void this.readPoolAccount(mint, ev.pool, 'boost-end'), BOOST_REREAD_SEC * 1000);
      t.unref();
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
        this.deployers?.onGraduated(this.liveState.meta(ev.mint)?.creator, ev.mint, null, ev.timestamp * 1000 || Date.now());
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
