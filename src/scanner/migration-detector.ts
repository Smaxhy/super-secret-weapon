/**
 * Migration Detector — watches for bonding-curve completions and detects
 * the PumpSwap/Raydium pool that follows.
 *
 * When a bonding curve fills (100%), PumpFun migrates the liquidity to a
 * DEX pool (historically Raydium, now PumpSwap). The MIGRATION_MOMENTUM
 * strategy wants to buy right after migration lands — this detector:
 *
 *   1. Tracks tokens whose curve just completed (from the token registry)
 *   2. Polls for the AMM pool account on-chain (getAccountInfo on known seeds)
 *   3. Emits a 'migration_detected' bus event with the pool address
 *   4. Records the migration in the database for the evaluator
 *
 * Polling is cheap: one getAccountInfo call per pending token, and tokens
 * are only pending for ~30-90 seconds (the migration tx is usually fast).
 * We cap at 20 concurrent pending tokens and drop old ones after 5 minutes.
 */
import { PublicKey } from '@solana/web3.js';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getConnection } from '../lib/solana';

const log = moduleLogger('migration-detector');

/** PumpFun migration program (PumpSwap). */
const PUMPSWAP_PROGRAM = new PublicKey('PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP');

/** Legacy Raydium AMM program. */
const RAYDIUM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

const MAX_PENDING = 20;
const EXPIRY_MS = 5 * 60_000; // drop tokens after 5 min if no pool found
const POLL_INTERVAL_MS = 3_000; // check every 3 seconds

interface PendingMigration {
  mint: string;
  bondingCurve: string;
  completedAt: number;
  creator: string;
}

export class MigrationDetector {
  private pending = new Map<string, PendingMigration>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners: Array<(event: MigrationEvent) => void> = [];

  start(): void {
    // Listen for curve completions from the token registry
    this.unsubscribe = bus.subscribe((event) => {
      // We need to hook into curve completions — those come through the token registry
      // directly. For now we poll the DB for recently completed tokens.
    });

    // Poll for pending migrations
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);

    // On startup, check for any tokens that completed recently but haven't migrated
    void this.loadRecentCompletions();

    log.info('migration detector started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.unsubscribe) this.unsubscribe();
  }

  /** Called by the token registry when a curve completes. */
  onComplete(mint: string, bondingCurve: string, creator: string): void {
    if (this.pending.size >= MAX_PENDING) {
      // Drop the oldest one
      const oldest = [...this.pending.entries()]
        .sort((a, b) => a[1].completedAt - b[1].completedAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }

    this.pending.set(mint, {
      mint,
      bondingCurve,
      completedAt: Date.now(),
      creator,
    });

    log.info({ mint, bondingCurve }, '📋 Tracking migration for completed curve');
  }

  /** Register a callback for migration events. */
  onMigration(fn: (event: MigrationEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Load recently completed tokens from DB that might still be migrating. */
  private async loadRecentCompletions(): Promise<void> {
    try {
      const fiveMinAgo = new Date(Date.now() - EXPIRY_MS);
      const recent = await prisma.token.findMany({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: fiveMinAgo },
        },
        select: { mint: true, creator: true },
        take: MAX_PENDING,
      });

      for (const t of recent) {
        if (!this.pending.has(t.mint)) {
          this.pending.set(t.mint, {
            mint: t.mint,
            bondingCurve: '', // unknown from DB, but we can derive the PDA
            completedAt: Date.now(),
            creator: t.creator,
          });
        }
      }

      if (recent.length > 0) {
        log.info({ count: recent.length }, `loaded ${recent.length} recent completions to track`);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'failed to load recent completions');
    }
  }

  /** Poll for pool creation on pending tokens. */
  private async poll(): Promise<void> {
    if (this.pending.size === 0) return;

    const conn = getConnection();
    const now = Date.now();

    for (const [mint, pending] of this.pending) {
      // Expire old entries
      if (now - pending.completedAt > EXPIRY_MS) {
        this.pending.delete(mint);
        log.debug({ mint }, 'migration tracking expired');
        continue;
      }

      try {
        // Check for PumpSwap pool (the modern migration path)
        const poolAddress = await this.findPumpSwapPool(mint);
        if (poolAddress) {
          await this.handleMigration(pending, poolAddress, 'PUMPSWAP');
          this.pending.delete(mint);
          continue;
        }

        // Fallback: check for Raydium pool (legacy migration path)
        const raydiumPool = await this.findRaydiumPool(mint);
        if (raydiumPool) {
          await this.handleMigration(pending, raydiumPool, 'RAYDIUM');
          this.pending.delete(mint);
          continue;
        }
      } catch (err) {
        // RPC errors are expected occasionally — don't spam logs
        log.debug({ mint, err: (err as Error).message }, 'pool check failed');
      }
    }
  }

  /** Derive and check the PumpSwap pool PDA. */
  private async findPumpSwapPool(mint: string): Promise<string | null> {
    const conn = getConnection();
    const mintPk = new PublicKey(mint);

    // PumpSwap pool PDA = seeds ["pool", token_mint, WSOL_mint] under PumpSwap program
    const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), mintPk.toBuffer(), WSOL.toBuffer()],
      PUMPSWAP_PROGRAM,
    );

    const info = await conn.getAccountInfo(poolPda, 'confirmed');
    if (info && info.data.length > 0) {
      return poolPda.toBase58();
    }

    // Try reversed seed order (some implementations use sorted mints)
    const [poolPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), WSOL.toBuffer(), mintPk.toBuffer()],
      PUMPSWAP_PROGRAM,
    );

    const info2 = await conn.getAccountInfo(poolPda2, 'confirmed');
    if (info2 && info2.data.length > 0) {
      return poolPda2.toBase58();
    }

    return null;
  }

  /** Check for a Raydium AMM pool for this token. */
  private async findRaydiumPool(mint: string): Promise<string | null> {
    const conn = getConnection();
    const mintPk = new PublicKey(mint);

    // Raydium pool PDA = seeds ["amm_associated_seed", raydium_program, market, token_mint]
    // Since we don't have the market address, we use getProgramAccounts with a memcmp filter.
    // This is more expensive but Raydium migrations are legacy and increasingly rare.
    try {
      const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
      const [ammId] = PublicKey.findProgramAddressSync(
        [
          RAYDIUM_PROGRAM.toBuffer(),
          mintPk.toBuffer(),
          WSOL.toBuffer(),
          Buffer.from('amm_associated_seed'),
        ],
        RAYDIUM_PROGRAM,
      );

      const info = await conn.getAccountInfo(ammId, 'confirmed');
      if (info && info.data.length > 0) {
        return ammId.toBase58();
      }
    } catch {
      // PDA derivation may fail — not all seed combos are valid
    }

    return null;
  }

  /** Handle a detected migration. */
  private async handleMigration(pending: PendingMigration, poolAddress: string, dex: 'PUMPSWAP' | 'RAYDIUM'): Promise<void> {
    const migrationTimeMs = Date.now() - pending.completedAt;

    log.info(
      { mint: pending.mint, pool: poolAddress, dex, migrationMs: migrationTimeMs },
      `🚀 Migration detected: ${pending.mint.slice(0, 8)} → ${dex} pool (${(migrationTimeMs / 1000).toFixed(1)}s)`,
    );

    // Update DB
    await prisma.token.updateMany({
      where: { mint: pending.mint },
      data: {
        status: 'MIGRATED',
        poolAddress,
        dex,
        migratedAt: new Date(),
      },
    }).catch((err: Error) => {
      log.warn({ err: err.message, mint: pending.mint }, 'failed to update token migration status');
    });

    const event: MigrationEvent = {
      mint: pending.mint,
      poolAddress,
      dex,
      creator: pending.creator,
      migrationTimeMs,
    };

    // Emit bus event for the evaluator
    bus.publish({
      type: 'migration_detected',
      data: event,
    });

    // Notify listeners
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch { /* listener errors don't propagate */ }
    }
  }
}

export interface MigrationEvent {
  mint: string;
  poolAddress: string;
  dex: 'PUMPSWAP' | 'RAYDIUM';
  creator: string;
  migrationTimeMs: number;
}

/** Singleton */
export const migrationDetector = new MigrationDetector();
