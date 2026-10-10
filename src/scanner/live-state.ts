/**
 * Live per-token state, kept in Redis and updated on every trade.
 *
 * The trick that makes Phase 1 cheap: every Pump.fun TradeEvent tells us who
 * traded, how much, and the curve's reserves afterwards. So by replaying the
 * event stream we can keep, for every token, without ANY extra RPC calls:
 *   - buy/sell counts and SOL volume,
 *   - current price, market cap, bonding-curve %,
 *   - a ledger of wallet balances → holder count, dev %, top-10 concentration.
 *
 * Limitation (documented, fixed in Phase 2): wallet-to-wallet transfers don't
 * go through the curve, so the ledger can't see them. The market analyzer will
 * cross-check with on-chain getTokenLargestAccounts for tokens we might trade.
 *
 * Redis keys per token (all expire ~26h after the last trade):
 *   tok:<mint>:live  HASH   counters, reserves, creator, flags
 *   tok:<mint>:bal   HASH   wallet → raw token balance (only > 0 kept)
 *   tok:<mint>:hll   HLL    every wallet that ever traded (approximate count)
 *   tok:<mint>:early SET    wallets (not the dev) that bought within ~1s of launch
 *                           — snipers / bundled wallets controlled by the dev
 *   tracked          ZSET   mint → creation time (ms), used to rebuild on restart
 */
import type { Redis } from 'ioredis';
import { LIVE_STATE_TTL_SECONDS } from '../config/default';
import type { AmmPoolEvent, AmmTradeEvent, PumpCompleteEvent, PumpCreateEvent, PumpTradeEvent } from '../config/types';
import { moduleLogger } from '../lib/logger';
import {
  bondingCurvePct,
  curveLiquiditySol,
  curvePriceSol,
  marketCapSol,
  ammEffectiveQuoteAfter,
  type CurveParams,
  WSOL_MINT,
  PUMP_MIGRATION_POOL_TOKENS,
  PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
  PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  PUMP_DEFAULT_TOTAL_SUPPLY,
} from '../lib/pumpfun';

const log = moduleLogger('live-state');

const TRACKED_KEY = 'tracked';
/** HASH pool → mint for PumpSwap pools of tokens we track. */
const POOLS_KEY = 'amm:pools';
const key = {
  live: (mint: string) => `tok:${mint}:live`,
  bal: (mint: string) => `tok:${mint}:bal`,
  hll: (mint: string) => `tok:${mint}:hll`,
  early: (mint: string) => `tok:${mint}:early`,
};

/** A PumpSwap pool's opening price must be within this factor of the final curve price. */
const POOL_OPEN_MAX_DEVIATION = 3;
/** Event reserves must agree with the trade's own execution price within this factor. */
const EVENT_EXEC_TOLERANCE = 2;
/**
 * PumpSwap: the effective quote reserve implied by a trade may differ from the raw vault balance
 * (virtual reserves, unswept fees) — but not by more than this (else the event is mis-decoded).
 */
const EFFECTIVE_VS_VAULT_MIN = 0.1;
const EFFECTIVE_VS_VAULT_MAX = 20;
/** …and one trade can't move the effective price more than this factor. */
const EFFECTIVE_MAX_JUMP = 5;
/** Derived reserves are re-anchored when they drift this far from the traded price. */
const DERIVED_REANCHOR_FACTOR = 1.5;
/** Trades smaller than this (0.001 SOL) are too small to read a reliable price from. */
const MIN_PRICED_TRADE_LAMPORTS = 1_000_000n;

/**
 * Reference price (SOL per whole token) from a curve trade's own amounts, if it
 * agrees with the reserves the event reports (exec price = geometric mean of
 * the price before and after on x*y=k). undefined = not usable.
 */
export function curveTradeRefPx(ev: PumpTradeEvent): number | undefined {
  if (ev.solAmount < MIN_PRICED_TRADE_LAMPORTS || ev.tokenAmount <= 0n) return undefined;
  const exec = Number(ev.solAmount) / Number(ev.tokenAmount);
  const post = ev.virtualTokenReserves > 0n ? Number(ev.virtualSolReserves) / Number(ev.virtualTokenReserves) : 0;
  const preSol = ev.isBuy ? ev.virtualSolReserves - ev.solAmount : ev.virtualSolReserves + ev.solAmount;
  const preTok = ev.isBuy ? ev.virtualTokenReserves + ev.tokenAmount : ev.virtualTokenReserves - ev.tokenAmount;
  const pre = preSol > 0n && preTok > 0n ? Number(preSol) / Number(preTok) : 0;
  if (!(post > 0) || !(pre > 0)) return undefined;
  const mid = Math.sqrt(pre * post);
  if (Math.max(mid / exec, exec / mid) > EVENT_EXEC_TOLERANCE) return undefined;
  return exec * 1e-3; // lamports per raw token → SOL per whole token
}

/** Buys within this many seconds of the create are counted as snipes / bundles. */
const EARLY_WINDOW_SECONDS = 1;

/**
 * Lua script: add `delta` to a wallet's balance, and delete the entry if it
 * drops to zero or below (so HLEN == number of current holders).
 * Runs atomically inside Redis.
 */
const BALANCE_DELTA_LUA = `
local v = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
if v <= 0 then redis.call('HDEL', KEYS[1], ARGV[1]) end
return v
`;

/** Set a wallet's exact balance (from sources that report it); remove at zero. */
const BALANCE_SET_LUA = `
if tonumber(ARGV[2]) <= 0 then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
return 1
`;

/**
 * Learning: after an evaluation we record the best/worst price that follows.
 * Runs on every trade but only does work while an outcome window is open.
 */
const OUTCOME_TRACK_LUA = `
if redis.call('HEXISTS', KEYS[1], 'evalBase') == 0 then return 0 end
local p = tonumber(ARGV[1])
if not p or p <= 0 then return 0 end
local mx = tonumber(redis.call('HGET', KEYS[1], 'evalMax') or '0')
local mn = tonumber(redis.call('HGET', KEYS[1], 'evalMin') or '0')
if p > mx then redis.call('HSET', KEYS[1], 'evalMax', ARGV[1]) end
if mn == 0 or p < mn then redis.call('HSET', KEYS[1], 'evalMin', ARGV[1]) end
return 1
`;

type RedisWithBalance = Redis & {
  balanceDelta(key: string, wallet: string, delta: string): Promise<number>;
};

/** Everything the observation logger needs to build a snapshot. */
export interface LiveTokenView {
  mint: string;
  creator: string;
  createdAtMs: number;
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  /** Total trading fees (protocol + creator) paid on this token, in SOL. */
  feesSol: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  complete: boolean;
  lastTradeAtMs: number | null;
  curve: CurveParams;
  /** PumpSwap pool reserves once migrated (null while on the curve). */
  ammBaseReserve: bigint | null;
  ammQuoteReserve: bigint | null;
  migratedAtMs: number | null;
  /** PumpSwap trades seen — 0 means we have no live post-migration price yet. */
  ammTrades: number;
  /**
   * Independent reference price (SOL per whole token): what the most recent real
   * trade actually executed at (or the on-chain poll / pool opening price). Paper
   * fills far from it are treated as pricing bugs. null = none seen yet.
   */
  refPriceSol?: number | null;
  refPriceAtMs?: number | null;
  balances: Map<string, bigint>;
  uniqueWallets: number;
  earlyBuyers: string[];
  /** Raw tokens the dev bought / sold in total. */
  devBought: bigint;
  devSold: bigint;
  /**
   * Adopted after it migrated (swing trading bigger coins): we never saw its launch, so the trade
   * counters and the holder ledger only cover trades since `adoptedAtMs` — holder %, dev and bundle
   * numbers from the ledger mean nothing for it.
   */
  adopted?: boolean;
  adoptedAtMs?: number | null;
}

/** Creator placeholder for adopted coins (never matches a wallet). */
export const ADOPTED_CREATOR = '(adopted)';

export interface DerivedMetrics {
  priceSol: number;
  marketCapSol: number;
  bondingCurvePct: number;
  liquiditySol: number;
  holderCount: number;
  devHoldingPct: number;
  top10HolderPct: number;
  buySellRatio: number;
  volumeSol: number;
  /** % of supply still held by early (sniper/bundle) wallets, dev excluded. */
  earlyBuyerPct: number;
  /** Fraction of the dev's purchased tokens they've sold (0-1). */
  devSoldFraction: number;
  /** % of supply held by the single biggest wallet other than the dev. */
  maxHolderPct: number;
}

export class LiveState {
  /** In-memory mirror of `tracked` (mint → creation time + dev) so trade filtering never waits on Redis. */
  private readonly tracked = new Map<string, { createdSec: number; creator: string | null }>();
  /** PumpSwap pool → mint, for tracked tokens that migrated. */
  private readonly pools = new Map<string, string>();
  private readonly r: RedisWithBalance;

  constructor(redis: Redis) {
    redis.defineCommand('balanceDelta', { numberOfKeys: 1, lua: BALANCE_DELTA_LUA });
    redis.defineCommand('balanceSet', { numberOfKeys: 1, lua: BALANCE_SET_LUA });
    redis.defineCommand('trackOutcome', { numberOfKeys: 1, lua: OUTCOME_TRACK_LUA });
    this.r = redis as RedisWithBalance;
  }

  /** Rebuild the in-memory tracked set after a restart, dropping expired tokens. */
  async restore(): Promise<number> {
    const cutoff = Date.now() - LIVE_STATE_TTL_SECONDS * 1000;
    await this.r.zremrangebyscore(TRACKED_KEY, '-inf', String(cutoff));
    const flat = await this.r.zrange(TRACKED_KEY, '0', '-1', 'WITHSCORES');
    const mints: string[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      mints.push(flat[i]!);
      this.tracked.set(flat[i]!, { createdSec: Math.floor(Number(flat[i + 1]) / 1000), creator: null });
    }
    // Recover PumpSwap pools of tracked tokens.
    for (const [pool, mint] of Object.entries(await this.r.hgetall(POOLS_KEY))) {
      if (this.tracked.has(mint)) this.pools.set(pool, mint);
      else await this.r.hdel(POOLS_KEY, pool);
    }
    // Recover each token's dev so dev buy/sell tracking keeps working after a restart.
    const p = this.r.pipeline();
    for (const m of mints) p.hget(key.live(m), 'creator');
    const creators = (await p.exec()) ?? [];
    mints.forEach((m, i) => {
      const c = creators[i]?.[1];
      if (typeof c === 'string') this.tracked.get(m)!.creator = c;
    });
    log.info({ restored: mints.length }, 'restored tracked tokens from redis');
    return mints.length;
  }

  /** Called with each mint we stop tracking (used to unsubscribe its trades). */
  readonly onForget: Array<(mint: string) => void> = [];

  trackedMints(): string[] {
    return [...this.tracked.keys()];
  }

  /** Total volume (SOL), age and status for every tracked token traded in the last minute. */
  async activeVolumes(): Promise<Array<{ mint: string; volumeSol: number; ageSec: number; complete: boolean }>> {
    const mints = [...this.tracked.keys()];
    const out: Array<{ mint: string; volumeSol: number; ageSec: number; complete: boolean }> = [];
    const now = Date.now();
    for (let i = 0; i < mints.length; i += 500) {
      const chunk = mints.slice(i, i + 500);
      const p = this.r.pipeline();
      for (const m of chunk) p.hmget(key.live(m), 'buyVol', 'sellVol', 'lastTradeAt', 'complete');
      const res = (await p.exec()) ?? [];
      chunk.forEach((m, j) => {
        const [bv, sv, lt, c] = (res[j]?.[1] as Array<string | null>) ?? [];
        if (!lt || now - Number(lt) > 60_000) return;
        out.push({ mint: m, volumeSol: (Number(bv ?? 0) + Number(sv ?? 0)) / 1e9, ageSec: now / 1000 - this.tracked.get(m)!.createdSec, complete: c === '1' });
      });
    }
    return out;
  }

  /**
   * Tokens older than `minAgeSec` that never reached `minHolders` and haven't
   * migrated — i.e. dead launches. Used to stop streaming their trades.
   */
  async dormantMints(minAgeSec: number, minHolders: number): Promise<string[]> {
    const cutoff = Date.now() / 1000 - minAgeSec;
    const candidates = [...this.tracked.entries()].filter(([, t]) => t.createdSec < cutoff).map(([m]) => m);
    if (!candidates.length) return [];
    const p = this.r.pipeline();
    for (const m of candidates) {
      p.hlen(key.bal(m));
      p.hget(key.live(m), 'complete');
    }
    const res = (await p.exec()) ?? [];
    return candidates.filter((_, i) => Number(res[i * 2]?.[1] ?? 0) < minHolders && res[i * 2 + 1]?.[1] !== '1');
  }

  /**
   * Dead launches to forget completely (memory + Redis): older than `minAgeSec`, fewer than
   * `minHolders`, never migrated, not adopted and no trade for `quietSec`. Checked in chunks
   * so a sweep never blocks the event loop for long.
   */
  async deadMints(minAgeSec: number, minHolders: number, quietSec: number, now = Date.now(), limit = 5_000): Promise<string[]> {
    const cutoff = now / 1000 - minAgeSec;
    const candidates = [...this.tracked.entries()].filter(([, t]) => t.createdSec < cutoff).map(([m]) => m);
    const out: string[] = [];
    for (let i = 0; i < candidates.length && out.length < limit; i += 500) {
      const chunk = candidates.slice(i, i + 500);
      const p = this.r.pipeline();
      for (const m of chunk) {
        p.hlen(key.bal(m));
        p.hmget(key.live(m), 'complete', 'adopted', 'lastTradeAt');
      }
      const res = (await p.exec()) ?? [];
      chunk.forEach((m, j) => {
        const holders = Number(res[j * 2]?.[1] ?? 0);
        const [complete, adopted, lastTradeAt] = (res[j * 2 + 1]?.[1] as Array<string | null> | undefined) ?? [];
        if (holders >= minHolders || complete === '1' || adopted === '1') return;
        if (lastTradeAt && now - Number(lastTradeAt) < quietSec * 1000) return;
        out.push(m);
      });
      await new Promise((r) => setImmediate(r));
    }
    return out.slice(0, limit);
  }

  isTracked(mint: string): boolean {
    return this.tracked.has(mint);
  }

  get trackedCount(): number {
    return this.tracked.size;
  }

  /** Start tracking a newly created token. Synchronously marks it tracked first. */
  async onCreate(ev: PumpCreateEvent, detectedAtMs: number): Promise<void> {
    this.tracked.set(ev.mint, { createdSec: ev.timestamp || Math.floor(detectedAtMs / 1000), creator: ev.creator });
    const k = key.live(ev.mint);
    await this.r
      .multi()
      .hset(k, {
        creator: ev.creator,
        createdAt: String(ev.timestamp * 1000 || detectedAtMs),
        buys: '0',
        sells: '0',
        buyVol: '0',
        sellVol: '0',
        vSol: ev.virtualSolReserves.toString(),
        vTok: ev.virtualTokenReserves.toString(),
        initVSol: ev.virtualSolReserves.toString(),
        initVTok: ev.virtualTokenReserves.toString(),
        initRTok: ev.realTokenReserves.toString(),
        supply: ev.tokenTotalSupply.toString(),
        complete: '0',
        devBought: '0',
        devSold: '0',
      })
      .expire(k, LIVE_STATE_TTL_SECONDS)
      .zadd(TRACKED_KEY, (ev.timestamp || Math.floor(detectedAtMs / 1000)) * 1000, ev.mint)
      .exec();
  }

  /** Apply one bonding-curve buy or sell. Ignores tokens we didn't see being created. */
  async onTrade(ev: PumpTradeEvent): Promise<void> {
    await this.applyTrade(ev.mint, {
      refPx: curveTradeRefPx(ev),
      user: ev.user,
      isBuy: ev.isBuy,
      tokens: ev.tokenAmount,
      lamports: ev.solAmount,
      // Older events lack the fee field → estimate at 1.25%.
      feeLamports: ev.feeLamports ?? (ev.solAmount * 125n) / 10_000n,
      timestamp: ev.timestamp,
      reserves: { vSol: ev.virtualSolReserves.toString(), vTok: ev.virtualTokenReserves.toString() },
      balanceAfter: ev.balanceAfter,
    });
  }

  /**
   * A PumpSwap pool was created. If it's THE market for a token we track, start
   * following its trades there.
   *
   * Anyone can create a PumpSwap pool for any mint, at any price. Pricing our
   * paper fills against such a pool is how a 0.5 SOL position "sold" for 30+ SOL
   * (selling into a pool returns up to all the SOL in it). So a real pool is only
   * accepted if:
   *   - the token's curve is complete (or ~fully sold) — it really migrated,
   *   - its opening price is within POOL_OPEN_MAX_DEVIATION of the final curve price,
   *   - no other real pool was accepted for the token before (first one wins; the
   *     PumpPortal placeholder `amm:<mint>` is replaced by the real pool).
   * Returns the mint when the pool became the token's market, else null.
   */
  async onAmmPool(ev: AmmPoolEvent): Promise<string | null> {
    const mint = this.tracked.has(ev.baseMint) && ev.quoteMint === WSOL_MINT ? ev.baseMint : null;
    if (!mint) return null;
    const placeholder = ev.pool.startsWith('amm:');
    const [current, vSolS, vTokS, initVSolS, initVTokS, initRTokS, completeS] = await this.r.hmget(key.live(mint), 'ammPool', 'vSol', 'vTok', 'initVSol', 'initVTok', 'initRTok', 'complete');
    if (current === ev.pool) return null; // duplicate notification
    if (current && !current.startsWith('amm:')) {
      // Already following a real pool — never let another pool (or the placeholder) take over.
      this.rejectedAmmPools++;
      return null;
    }
    const vSol = BigInt(vSolS ?? '0');
    const vTok = BigInt(vTokS ?? '0');
    let base = ev.baseReserve;
    let quote = ev.quoteReserve;
    if (placeholder) {
      if (current) return null; // placeholder already in place
      if (base <= 0n || quote <= 0n) {
        // Source didn't give reserves: the pool starts with the SOL raised on the
        // curve and the 206.9M tokens that were held back for liquidity — NOT the
        // curve's remaining sellable tokens (≈0 at completion, which would fake a huge price).
        const initVSol = BigInt(initVSolS ?? '0');
        base = PUMP_MIGRATION_POOL_TOKENS;
        quote = vSol - (initVSol > 0n ? initVSol : 30_000_000_000n);
      }
      if (base <= 0n || quote <= 0n) return null;
    } else {
      if (base <= 0n || quote <= 0n) return null;
      const params: CurveParams = {
        initialVirtualSolReserves: BigInt(initVSolS ?? '0'),
        initialVirtualTokenReserves: BigInt(initVTokS ?? '0'),
        initialRealTokenReserves: BigInt(initRTokS ?? '0'),
        totalSupply: 0n,
      };
      const migrated = completeS === '1' || (params.initialRealTokenReserves > 0n && bondingCurvePct(vTok, params) >= 95);
      const curvePx = vTok > 0n ? Number(vSol) / Number(vTok) : 0;
      const poolPx = Number(quote) / Number(base);
      const off = curvePx > 0 ? Math.max(poolPx / curvePx, curvePx / poolPx) : 1;
      if (!migrated || off > POOL_OPEN_MAX_DEVIATION) {
        this.rejectedAmmPools++;
        log.warn({ mint, pool: ev.pool, migrated, priceVsCurve: +off.toFixed(2) }, 'ignored PumpSwap pool that is not the token\'s migration pool');
        return null;
      }
    }
    if (current) {
      // The real pool replaces the PumpPortal placeholder.
      this.pools.delete(current);
      await this.r.hdel(POOLS_KEY, current);
    }
    this.pools.set(ev.pool, mint);
    const px = Number(quote) / 1e9 / (Number(base) / 1e6);
    await this.r
      .multi()
      .hset(POOLS_KEY, ev.pool, mint)
      .hset(key.live(mint), {
        complete: '1',
        ammPool: ev.pool,
        ammBase: base.toString(),
        ammQuote: quote.toString(),
        refPx: String(px),
        refAt: String(Date.now()),
        migratedAt: String((ev.timestamp || Math.floor(Date.now() / 1000)) * 1000),
      })
      .exec();
    return mint;
  }

  /**
   * Start following an ALREADY-MIGRATED coin we never saw launch (swing trading bigger coins):
   * `pool` — its canonical PumpSwap pool (lib/pump-pda.ts) — becomes its market. There is no
   * history: counters and the holder ledger start now (`adopted`). Known reserves (e.g. the pool
   * liquidity DexScreener reports) seed the price until the first real trade replaces them with
   * the program's effective reserves (onAmmTrade). Idempotent: a coin we already track keeps its
   * state — it only gets the pool if it had none — and is kept alive (see keepAlive).
   */
  async adoptPool(a: { mint: string; pool: string; createdAtMs: number | null; migratedAtMs: number | null; baseReserve?: bigint | null; quoteReserve?: bigint | null }, now = Date.now()): Promise<'adopted' | 'tracked'> {
    const k = key.live(a.mint);
    if (this.tracked.has(a.mint)) {
      const current = await this.r.hget(k, 'ammPool');
      if (!current || current.startsWith('amm:')) {
        if (current) {
          this.pools.delete(current);
          await this.r.hdel(POOLS_KEY, current);
        }
        this.pools.set(a.pool, a.mint);
        // (its `complete` flag stays the stream's call — a coin still on the curve has no trades on this pool)
        await this.r.multi().hset(POOLS_KEY, a.pool, a.mint).hset(k, { ammPool: a.pool, ...(a.migratedAtMs ? { migratedAt: String(a.migratedAtMs) } : {}) }).exec();
      }
      await this.keepAlive(a.mint, now);
      return 'tracked';
    }
    const createdMs = a.createdAtMs ?? a.migratedAtMs ?? now - 24 * 3600_000;
    // createdSec is the real launch time: the "bought within 1 s of launch" sniper rule never fires.
    this.tracked.set(a.mint, { createdSec: Math.floor(createdMs / 1000), creator: ADOPTED_CREATOR });
    this.pools.set(a.pool, a.mint);
    const seeded = a.baseReserve && a.quoteReserve && a.baseReserve > 0n && a.quoteReserve > 0n;
    const px = seeded ? Number(a.quoteReserve) / 1e9 / (Number(a.baseReserve) / 1e6) : 0;
    await this.r
      .multi()
      .hset(k, {
        creator: ADOPTED_CREATOR,
        createdAt: String(createdMs),
        buys: '0',
        sells: '0',
        buyVol: '0',
        sellVol: '0',
        vSol: '0',
        vTok: '0',
        initVSol: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES.toString(),
        initVTok: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES.toString(),
        initRTok: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES.toString(),
        supply: PUMP_DEFAULT_TOTAL_SUPPLY.toString(),
        complete: '1',
        devBought: '0',
        devSold: '0',
        ammPool: a.pool,
        migratedAt: String(a.migratedAtMs ?? createdMs),
        adopted: '1',
        adoptedAt: String(now),
        ...(seeded ? { ammBase: a.baseReserve!.toString(), ammQuote: a.quoteReserve!.toString(), refPx: String(px), refAt: String(now) } : {}),
      })
      .expire(k, LIVE_STATE_TTL_SECONDS)
      .hset(POOLS_KEY, a.pool, a.mint)
      // Scored by adoption time (not launch time) so a restart doesn't drop it as expired.
      .zadd(TRACKED_KEY, now, a.mint)
      .exec();
    return 'adopted';
  }

  /** Keep a coin across restarts while something still wants it (restore() drops entries older than ~26 h). */
  async keepAlive(mint: string, now = Date.now()): Promise<void> {
    if (!this.tracked.has(mint)) return;
    await this.r.multi().zadd(TRACKED_KEY, now, mint).expire(key.live(mint), LIVE_STATE_TTL_SECONDS).exec();
  }

  /** Which tracked token a PumpSwap pool belongs to (null if not ours). */
  mintForPool(pool: string): string | null {
    return this.pools.get(pool) ?? null;
  }

  /** Price-sanity rejections (garbled / mis-decoded pool events). */
  rejectedAmmTrades = 0;
  /** PumpSwap pools ignored because they aren't the token's real migration pool. */
  rejectedAmmPools = 0;
  /** Times derived (PumpPortal) pool reserves were re-anchored to the trades' own price. */
  reanchoredAmm = 0;
  /** PumpSwap trades whose effective (virtual-reserve) price differed from the raw vault ratio by >2%. */
  effectiveAmm = 0;

  /**
   * A buy or sell on PumpSwap. Same bookkeeping as curve trades, price from the pool.
   *
   * Every trade carries its own execution price (SOL paid ÷ tokens). On a
   * constant-product pool that price is exactly the geometric mean of the price
   * before and after the trade, so the reserves we store must agree with it:
   *   - reserves from the event (logs): disagree by >2x → mis-decoded → ignored.
   *     Agree → accepted even if the price moved a lot since our last update
   *     (a real whale buy, or trades we missed), so a genuine run is never frozen out.
   *   - reserves we derive ourselves (PumpPortal gives only amounts): if our model
   *     has drifted >1.5x from where trades actually happen (missed trades,
   *     duplicates), re-anchor it to the trade's price before applying it. This
   *     stops a chain of small steps walking the price up 50x.
   */
  async onAmmTrade(ev: AmmTradeEvent): Promise<string | null> {
    const mint = this.pools.get(ev.pool);
    if (!mint) return null;
    const [primary, pb, pq, adoptedS, tradesS] = await this.r.hmget(key.live(mint), 'ammPool', 'ammBase', 'ammQuote', 'adopted', 'ammTrades');
    // An adopted coin's seed reserves (from an outside API) never block its first real trade's price.
    const firstOfAdopted = adoptedS === '1' && !Number(tradesS ?? 0);
    // Only the token's own market moves its price (old pools / stale mappings are ignored).
    if (primary && primary !== ev.pool) return null;
    const b0 = BigInt(pb ?? '0');
    const q0 = BigInt(pq ?? '0');
    const priced = ev.quoteAmount >= MIN_PRICED_TRADE_LAMPORTS && ev.baseAmount > 0n;
    const exec = priced ? Number(ev.quoteAmount) / Number(ev.baseAmount) : 0; // lamports per raw token
    const ratio = (a: number, b: number) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : Infinity);

    let baseReserve = ev.baseReserve;
    let quoteReserve = ev.quoteReserve;
    if (baseReserve === undefined || quoteReserve === undefined) {
      // Derive the pool's new reserves from the old ones and this trade.
      if (!b0 || !q0) return mint;
      let base = b0;
      if (priced) {
        const after = ev.isBuy ? [b0 - ev.baseAmount, q0 + ev.quoteAmount] : [b0 + ev.baseAmount, q0 - ev.quoteAmount];
        const mid = after[0]! > 0n && after[1]! > 0n ? Math.sqrt((Number(q0) / Number(b0)) * (Number(after[1]) / Number(after[0]))) : Infinity;
        if (ratio(mid, exec) > DERIVED_REANCHOR_FACTOR) {
          // Our model drifted from the real market: put the price back where this trade happened.
          base = BigInt(Math.max(1, Math.round(Number(q0) / exec)));
          this.reanchoredAmm++;
          if (this.reanchoredAmm % 50 === 1) log.warn({ mint, model: Number(q0) / Number(b0), trade: exec }, 're-anchored derived PumpSwap reserves to the traded price');
        }
      }
      baseReserve = ev.isBuy ? base - ev.baseAmount : base + ev.baseAmount;
      quoteReserve = ev.isBuy ? q0 + ev.quoteAmount : q0 - ev.quoteAmount;
      if (baseReserve <= 0n || quoteReserve <= 0n) return mint;
    } else {
      if (baseReserve <= 0n || quoteReserve <= 0n || Number(quoteReserve) > 1e17) return this.rejectAmm(mint, 'bad reserves');
      const prev = b0 > 0n && q0 > 0n && !firstOfAdopted ? Number(q0) / Number(b0) : 0;
      if (priced) {
        // The vault balances in the event are NOT the price the program trades at: BOOST pools
        // carry (signed) virtual quote reserves and unswept fees sit in the vault (pump.fun docs:
        // "do not read the raw vault balance"). Pricing from them put migrated coins ~20% under
        // their real trades, so every real trade looked like a +20% spike. The swap amounts give
        // the program's effective quote reserve exactly (ammEffectiveQuoteAfter) — store that.
        const eff = ammEffectiveQuoteAfter({ isBuy: ev.isBuy, baseAmount: ev.baseAmount, quoteAmount: ev.quoteAmount, baseReserve });
        const vaultRatio = eff ? Number(eff) / Number(quoteReserve) : 0;
        if (!eff || vaultRatio < EFFECTIVE_VS_VAULT_MIN || vaultRatio > EFFECTIVE_VS_VAULT_MAX) return this.rejectAmm(mint, 'reserves disagree with the trade', { vaultRatio, exec });
        const effPx = Number(eff) / Number(baseReserve);
        if (prev > 0 && ratio(effPx, prev) > EFFECTIVE_MAX_JUMP) return this.rejectAmm(mint, 'implausible price jump', { prev, next: effPx });
        if (Math.abs(vaultRatio - 1) > 0.02) this.effectiveAmm++;
        quoteReserve = eff;
      } else {
        // Dust trade: no price of its own → apply it to OUR (effective) reserves; the event's raw
        // vault number would undo the virtual-reserve correction. Only small moves allowed.
        if (q0 > 0n) quoteReserve = ev.isBuy ? q0 + ev.quoteAmount : q0 - ev.quoteAmount;
        if (quoteReserve <= 0n) return mint;
        const next = Number(quoteReserve) / Number(baseReserve);
        if (prev > 0 && ratio(next, prev) > 2.5) return this.rejectAmm(mint, 'dust trade with a big price jump', { prev, next });
      }
    }
    await this.r.hincrby(key.live(mint), 'ammTrades', 1);
    await this.applyTrade(mint, {
      user: ev.user,
      isBuy: ev.isBuy,
      tokens: ev.baseAmount,
      lamports: ev.quoteAmount,
      feeLamports: ev.feeLamports,
      timestamp: ev.timestamp,
      reserves: { ammBase: baseReserve.toString(), ammQuote: quoteReserve.toString() },
      balanceAfter: ev.balanceAfter,
      refPx: priced ? exec * 1e-3 : undefined, // lamports/raw → SOL per whole token (1e6 / 1e9)
    });
    return mint;
  }

  private rejectAmm(mint: string, why: string, data: Record<string, number> = {}): string {
    this.rejectedAmmTrades++;
    if (this.rejectedAmmTrades % 50 === 1) log.warn({ mint, why, ...data }, 'ignored implausible PumpSwap trade');
    return mint;
  }

  private async applyTrade(
    mint: string,
    t: { user: string; isBuy: boolean; tokens: bigint; lamports: bigint; feeLamports: bigint; timestamp: number; reserves: Record<string, string>; balanceAfter?: bigint; refPx?: number },
  ): Promise<void> {
    const info = this.tracked.get(mint);
    if (!info) return;
    const live = key.live(mint);
    const bal = key.bal(mint);
    const hll = key.hll(mint);
    const delta = t.isBuy ? t.tokens : -t.tokens;

    const p = this.r.pipeline();
    p.hincrby(live, t.isBuy ? 'buys' : 'sells', 1);
    p.hincrby(live, t.isBuy ? 'buyVol' : 'sellVol', t.lamports.toString());
    p.hincrby(live, 'fees', t.feeLamports.toString());
    p.hset(live, { ...t.reserves, lastTradeAt: String(t.timestamp * 1000) });
    // The price this trade actually happened at: the independent reference paper fills are checked against.
    if (t.refPx !== undefined && Number.isFinite(t.refPx) && t.refPx > 0) p.hset(live, { refPx: String(t.refPx), refAt: String(Date.now()) });
    // ioredis pipelines support custom commands; typed loosely here.
    const pp = p as unknown as { balanceDelta(k: string, w: string, d: string): void; balanceSet(k: string, w: string, v: string): void; trackOutcome(k: string, price: string): void };
    // Price after this trade, for the learning outcome window.
    const r = t.reserves;
    const px = r.ammQuote && r.ammBase ? Number(r.ammQuote) / 1e9 / (Number(r.ammBase) / 1e6) : r.vSol && r.vTok ? Number(r.vSol) / 1e9 / (Number(r.vTok) / 1e6) : 0;
    if (px > 0) pp.trackOutcome(live, String(px));
    if (t.balanceAfter !== undefined) pp.balanceSet(bal, t.user, t.balanceAfter.toString());
    else pp.balanceDelta(bal, t.user, delta.toString());
    p.pfadd(hll, t.user);
    if (info.creator && t.user === info.creator) {
      p.hincrby(live, t.isBuy ? 'devBought' : 'devSold', t.tokens.toString());
    } else if (t.isBuy && t.timestamp - info.createdSec <= EARLY_WINDOW_SECONDS) {
      p.sadd(key.early(mint), t.user);
      p.expire(key.early(mint), LIVE_STATE_TTL_SECONDS);
    }
    p.expire(live, LIVE_STATE_TTL_SECONDS);
    p.expire(bal, LIVE_STATE_TTL_SECONDS);
    p.expire(hll, LIVE_STATE_TTL_SECONDS);
    const results = await p.exec();
    const failed = results?.find(([err]) => err);
    if (failed) log.warn({ mint, err: failed[0]?.message }, 'trade pipeline had an error');
  }

  /** Open (or restart) the learning window: track best/worst price from now on. */
  async startOutcomeWindow(mint: string, evaluationId: string, priceSol: number): Promise<void> {
    if (!this.tracked.has(mint) || !(priceSol > 0)) return;
    const p = String(priceSol);
    await this.r.hset(key.live(mint), { evalId: evaluationId, evalBase: p, evalMax: p, evalMin: p, evalAt: String(Date.now()) });
  }

  /** Launch time + creator for a tracked coin (memory only, no Redis). */
  meta(mint: string): { createdSec: number; creator: string | null } | null {
    return this.tracked.get(mint) ?? null;
  }

  /** Has the curve completed (migrated)? One cheap read. */
  async isComplete(mint: string): Promise<boolean> {
    return (await this.r.hget(key.live(mint), 'complete')) === '1';
  }

  /** Current price (SOL per whole token) from the stored reserves — one cheap read. null = unknown. */
  async priceNow(mint: string): Promise<number | null> {
    const [vSol, vTok, aQ, aB] = await this.r.hmget(key.live(mint), 'vSol', 'vTok', 'ammQuote', 'ammBase');
    const px = aQ && aB && Number(aB) > 0 ? Number(aQ) / 1e9 / (Number(aB) / 1e6) : vSol && vTok && Number(vTok) > 0 ? Number(vSol) / 1e9 / (Number(vTok) / 1e6) : 0;
    return px > 0 && Number.isFinite(px) ? px : null;
  }

  /** Read the learning window. null if none is open for this evaluation. */
  async readOutcomeWindow(mint: string, evaluationId: string): Promise<{ base: number; max: number; min: number; current: number } | null> {
    const [id, base, max, min, vSol, vTok, aQ, aB] = await this.r.hmget(key.live(mint), 'evalId', 'evalBase', 'evalMax', 'evalMin', 'vSol', 'vTok', 'ammQuote', 'ammBase');
    if (id !== evaluationId || !base) return null;
    const current = aQ && aB ? Number(aQ) / 1e9 / (Number(aB) / 1e6) : vSol && vTok ? Number(vSol) / 1e9 / (Number(vTok) / 1e6) : Number(base);
    return { base: Number(base), max: Number(max), min: Number(min), current };
  }

  /**
   * Price refresh read straight from the chain (used when the stream goes quiet on a token we hold).
   * A completed (migrated) curve account no longer describes the market, so its
   * reserves are ignored — only the flag is taken. Empty reserves are ignored too.
   */
  async applyCurveState(mint: string, s: { virtualSolReserves: bigint; virtualTokenReserves: bigint; complete: boolean }): Promise<void> {
    if (!this.tracked.has(mint)) return;
    const polledAt = String(Date.now());
    if (s.complete || s.virtualSolReserves <= 0n || s.virtualTokenReserves <= 0n) {
      await this.r.hset(key.live(mint), { ...(s.complete ? { complete: '1' } : {}), polledAt });
      return;
    }
    // Chain state is the truth → it is also the new reference price.
    const px = curvePriceSol(s.virtualSolReserves, s.virtualTokenReserves);
    await this.r.hset(key.live(mint), { vSol: s.virtualSolReserves.toString(), vTok: s.virtualTokenReserves.toString(), refPx: String(px), refAt: polledAt, polledAt });
  }

  async onComplete(ev: PumpCompleteEvent): Promise<void> {
    if (!this.tracked.has(ev.mint)) return;
    await this.r.hset(key.live(ev.mint), { complete: '1', completedAt: String(ev.timestamp * 1000) });
  }

  /** Read everything about one token. Returns null if its state has expired. */
  async read(mint: string): Promise<LiveTokenView | null> {
    const [liveRes, balRes, hllRes, earlyRes] = (await this.r
      .pipeline()
      .hgetall(key.live(mint))
      .hgetall(key.bal(mint))
      .pfcount(key.hll(mint))
      .smembers(key.early(mint))
      .exec()) as [
      [Error | null, Record<string, string>],
      [Error | null, Record<string, string>],
      [Error | null, number],
      [Error | null, string[]],
    ];

    const h = liveRes[1];
    if (!h || !h.creator) return null;

    const balances = new Map<string, bigint>();
    for (const [wallet, amount] of Object.entries(balRes[1] ?? {})) balances.set(wallet, BigInt(amount));

    const big = (v: string | undefined, d = 0n) => (v ? BigInt(v) : d);
    return {
      mint,
      creator: h.creator,
      createdAtMs: Number(h.createdAt),
      buys: Number(h.buys ?? 0),
      sells: Number(h.sells ?? 0),
      buyVolumeSol: Number(h.buyVol ?? 0) / 1e9,
      sellVolumeSol: Number(h.sellVol ?? 0) / 1e9,
      feesSol: Number(h.fees ?? 0) / 1e9,
      virtualSolReserves: big(h.vSol),
      virtualTokenReserves: big(h.vTok),
      complete: h.complete === '1',
      ammBaseReserve: h.ammBase ? BigInt(h.ammBase) : null,
      ammQuoteReserve: h.ammQuote ? BigInt(h.ammQuote) : null,
      migratedAtMs: h.migratedAt ? Number(h.migratedAt) : null,
      ammTrades: Number(h.ammTrades ?? 0),
      refPriceSol: h.refPx && Number(h.refPx) > 0 ? Number(h.refPx) : null,
      refPriceAtMs: h.refAt ? Number(h.refAt) : null,
      lastTradeAtMs: h.lastTradeAt ? Number(h.lastTradeAt) : null,
      curve: {
        initialVirtualSolReserves: big(h.initVSol),
        initialVirtualTokenReserves: big(h.initVTok),
        initialRealTokenReserves: big(h.initRTok),
        totalSupply: big(h.supply),
      },
      balances,
      uniqueWallets: hllRes[1] ?? 0,
      earlyBuyers: earlyRes[1] ?? [],
      devBought: big(h.devBought),
      devSold: big(h.devSold),
      adopted: h.adopted === '1',
      adoptedAtMs: h.adoptedAt ? Number(h.adoptedAt) : null,
    };
  }

  /** Stop tracking a token and free its Redis memory. */
  async forget(mint: string): Promise<void> {
    this.tracked.delete(mint);
    for (const f of this.onForget) f(mint);
    for (const [pool, m] of this.pools) if (m === mint) this.pools.delete(pool);
    await this.r.multi().del(key.live(mint), key.bal(mint), key.hll(mint), key.early(mint)).zrem(TRACKED_KEY, mint).exec();
  }
}

/** Turn raw live state into the numbers we actually care about. Pure function. */
export function deriveMetrics(v: LiveTokenView): DerivedMetrics {
  const onAmm = v.ammBaseReserve !== null && v.ammQuoteReserve !== null && v.ammBaseReserve > 0n;
  // After migration the price comes from the PumpSwap pool (same x*y=k maths).
  const price = onAmm ? curvePriceSol(v.ammQuoteReserve!, v.ammBaseReserve!) : curvePriceSol(v.virtualSolReserves, v.virtualTokenReserves);
  const supply = Number(v.curve.totalSupply) || 1;

  const balances = [...v.balances.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top10 = balances.slice(0, 10).reduce((s, b) => s + Number(b), 0);
  const dev = Number(v.balances.get(v.creator) ?? 0n);
  const early = v.earlyBuyers.reduce((s, w) => s + Number(v.balances.get(w) ?? 0n), 0);
  let maxHolder = 0n;
  for (const [w, b] of v.balances) if (w !== v.creator && b > maxHolder) maxHolder = b;

  return {
    priceSol: price,
    marketCapSol: marketCapSol(price, v.curve.totalSupply),
    bondingCurvePct: v.complete ? 100 : bondingCurvePct(v.virtualTokenReserves, v.curve),
    liquiditySol: onAmm ? Number(v.ammQuoteReserve) / 1e9 : curveLiquiditySol(v.virtualSolReserves, v.curve),
    holderCount: v.balances.size,
    devHoldingPct: (dev / supply) * 100,
    top10HolderPct: (top10 / supply) * 100,
    // Ratio of buy count to sell count; when nobody has sold yet we report the buy count itself.
    buySellRatio: v.sells === 0 ? v.buys : v.buys / v.sells,
    volumeSol: v.buyVolumeSol + v.sellVolumeSol,
    earlyBuyerPct: (early / supply) * 100,
    devSoldFraction: v.devBought > 0n ? Math.min(1, Number(v.devSold) / Number(v.devBought)) : 0,
    maxHolderPct: (Number(maxHolder) / supply) * 100,
  };
}
