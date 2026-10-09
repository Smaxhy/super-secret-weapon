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
import type { PumpCompleteEvent, PumpCreateEvent, PumpTradeEvent } from '../config/types';
import { moduleLogger } from '../lib/logger';
import {
  bondingCurvePct,
  curveLiquiditySol,
  curvePriceSol,
  marketCapSol,
  type CurveParams,
} from '../lib/pumpfun';

const log = moduleLogger('live-state');

const TRACKED_KEY = 'tracked';
const key = {
  live: (mint: string) => `tok:${mint}:live`,
  bal: (mint: string) => `tok:${mint}:bal`,
  hll: (mint: string) => `tok:${mint}:hll`,
  early: (mint: string) => `tok:${mint}:early`,
};

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
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  complete: boolean;
  lastTradeAtMs: number | null;
  curve: CurveParams;
  balances: Map<string, bigint>;
  uniqueWallets: number;
  earlyBuyers: string[];
  /** Raw tokens the dev bought / sold in total. */
  devBought: bigint;
  devSold: bigint;
}

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
}

export class LiveState {
  /** In-memory mirror of `tracked` (mint → creation time + dev) so trade filtering never waits on Redis. */
  private readonly tracked = new Map<string, { createdSec: number; creator: string | null }>();
  private readonly r: RedisWithBalance;

  constructor(redis: Redis) {
    redis.defineCommand('balanceDelta', { numberOfKeys: 1, lua: BALANCE_DELTA_LUA });
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

  /** Apply one buy or sell. Ignores tokens we didn't see being created. */
  async onTrade(ev: PumpTradeEvent): Promise<void> {
    const t = this.tracked.get(ev.mint);
    if (!t) return;
    const live = key.live(ev.mint);
    const bal = key.bal(ev.mint);
    const hll = key.hll(ev.mint);
    const delta = ev.isBuy ? ev.tokenAmount : -ev.tokenAmount;

    const p = this.r.pipeline();
    p.hincrby(live, ev.isBuy ? 'buys' : 'sells', 1);
    p.hincrby(live, ev.isBuy ? 'buyVol' : 'sellVol', ev.solAmount.toString());
    p.hset(live, {
      vSol: ev.virtualSolReserves.toString(),
      vTok: ev.virtualTokenReserves.toString(),
      lastTradeAt: String(ev.timestamp * 1000),
    });
    // ioredis pipelines support custom commands; typed loosely here.
    (p as unknown as { balanceDelta(k: string, w: string, d: string): void }).balanceDelta(bal, ev.user, delta.toString());
    p.pfadd(hll, ev.user);
    if (t.creator && ev.user === t.creator) {
      p.hincrby(live, ev.isBuy ? 'devBought' : 'devSold', ev.tokenAmount.toString());
    } else if (ev.isBuy && ev.timestamp - t.createdSec <= EARLY_WINDOW_SECONDS) {
      p.sadd(key.early(ev.mint), ev.user);
      p.expire(key.early(ev.mint), LIVE_STATE_TTL_SECONDS);
    }
    p.expire(live, LIVE_STATE_TTL_SECONDS);
    p.expire(bal, LIVE_STATE_TTL_SECONDS);
    p.expire(hll, LIVE_STATE_TTL_SECONDS);
    const results = await p.exec();
    const failed = results?.find(([err]) => err);
    if (failed) log.warn({ mint: ev.mint, err: failed[0]?.message }, 'trade pipeline had an error');
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
      virtualSolReserves: big(h.vSol),
      virtualTokenReserves: big(h.vTok),
      complete: h.complete === '1',
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
    };
  }

  /** Stop tracking a token and free its Redis memory. */
  async forget(mint: string): Promise<void> {
    this.tracked.delete(mint);
    await this.r.multi().del(key.live(mint), key.bal(mint), key.hll(mint), key.early(mint)).zrem(TRACKED_KEY, mint).exec();
  }
}

/** Turn raw live state into the numbers we actually care about. Pure function. */
export function deriveMetrics(v: LiveTokenView): DerivedMetrics {
  const price = curvePriceSol(v.virtualSolReserves, v.virtualTokenReserves);
  const supply = Number(v.curve.totalSupply) || 1;

  const balances = [...v.balances.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top10 = balances.slice(0, 10).reduce((s, b) => s + Number(b), 0);
  const dev = Number(v.balances.get(v.creator) ?? 0n);
  const early = v.earlyBuyers.reduce((s, w) => s + Number(v.balances.get(w) ?? 0n), 0);

  return {
    priceSol: price,
    marketCapSol: marketCapSol(price, v.curve.totalSupply),
    bondingCurvePct: v.complete ? 100 : bondingCurvePct(v.virtualTokenReserves, v.curve),
    liquiditySol: curveLiquiditySol(v.virtualSolReserves, v.curve),
    holderCount: v.balances.size,
    devHoldingPct: (dev / supply) * 100,
    top10HolderPct: (top10 / supply) * 100,
    // Ratio of buy count to sell count; when nobody has sold yet we report the buy count itself.
    buySellRatio: v.sells === 0 ? v.buys : v.buys / v.sells,
    volumeSol: v.buyVolumeSol + v.sellVolumeSol,
    earlyBuyerPct: (early / supply) * 100,
    devSoldFraction: v.devBought > 0n ? Math.min(1, Number(v.devSold) / Number(v.devBought)) : 0,
  };
}
