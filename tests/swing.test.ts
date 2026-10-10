/**
 * v7: swing trading bigger coins — canonical pool address, bounce-back power, the dip-and-bounce
 * entry, the decision, re-entry cooldowns, swing exits / holding big winners longer, and adopting
 * an already-migrated coin's pool in the live state.
 */
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../src/config/default';
import type { Candle } from '../src/evaluator/chart-reader';
import { bounceBack, parseGeckoOhlcv, pickPumpSwapPair, swingDecision, swingSetup, type Bar, type SwingInput } from '../src/evaluator/swing';
import { decideExit, exitRulesFor, holdLongerNow, INITIALS_MARKER, type ExitInput } from '../src/executor/sell-manager';
import { swingReentryReason } from '../src/executor/trader';
import { canonicalPumpPool, checkPoolEvent, pdaCheck, pumpPoolAuthority } from '../src/lib/pump-pda';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT } from '../src/lib/pumpfun';
import { deriveMetrics, LiveState } from '../src/scanner/live-state';
import { swingFilter, swingRank } from '../src/scanner/swing-universe';
import { FakeRedis } from './profit-fake-redis';

const NOW = 1_760_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112'.replace('So111', 'Bc9Qz'); // any valid-looking base58
const REAL_MINT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

describe('canonical PumpSwap pool (pump.fun SDK seeds)', () => {
  it('matches the SDK formula exactly (index as BN u16 LE, pool authority under the pump program)', () => {
    // Re-implementation straight from @pump-fun/pump-swap-sdk src/sdk/pda.ts.
    const m = new PublicKey(REAL_MINT);
    const authority = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0];
    const sdkPool = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), new BN(0).toArrayLike(Buffer, 'le', 2), authority.toBuffer(), m.toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
      new PublicKey(PUMP_AMM_PROGRAM_ID),
    )[0];
    expect(canonicalPumpPool(REAL_MINT)).toBe(sdkPool.toBase58());
    expect(pumpPoolAuthority(REAL_MINT)).toBe(authority.toBase58());
    expect(canonicalPumpPool('not a key')).toBeNull();
  });
  it('the live self-check counts real migrations that match, mismatch, or come from another creator', () => {
    const before = { ...pdaCheck };
    checkPoolEvent({ pool: canonicalPumpPool(REAL_MINT)!, baseMint: REAL_MINT, quoteMint: WSOL_MINT, creator: pumpPoolAuthority(REAL_MINT)!, index: 0 });
    checkPoolEvent({ pool: 'SomeOtherPool1111111111111111111111111111111', baseMint: REAL_MINT, quoteMint: WSOL_MINT, creator: pumpPoolAuthority(REAL_MINT)!, index: 0 });
    checkPoolEvent({ pool: 'X', baseMint: REAL_MINT, quoteMint: WSOL_MINT, creator: REAL_MINT, index: 0 });
    checkPoolEvent({ pool: 'X', baseMint: REAL_MINT, quoteMint: WSOL_MINT, creator: pumpPoolAuthority(REAL_MINT)!, index: 3 }); // not canonical index → ignored
    expect(pdaCheck.match - before.match).toBe(1);
    expect(pdaCheck.mismatch - before.mismatch).toBe(1);
  });
  it('picks DexScreener’s pair: canonical first, else a clearly dominant PumpSwap SOL pair, else none', () => {
    const can = canonicalPumpPool(REAL_MINT);
    const pairs = [
      { pairAddress: 'FAKE', dexId: 'pumpswap', quoteToken: { address: WSOL_MINT }, liquidity: { usd: 900_000 } },
      { pairAddress: can!, dexId: 'pumpswap', quoteToken: { address: WSOL_MINT }, liquidity: { usd: 50_000 } },
      { pairAddress: 'RAY', dexId: 'raydium', quoteToken: { address: WSOL_MINT }, liquidity: { usd: 2_000_000 } },
    ];
    expect(pickPumpSwapPair(pairs, can, WSOL_MINT)).toMatchObject({ verified: true, pair: { pairAddress: can } });
    expect(pickPumpSwapPair(pairs.slice(0, 1), can, WSOL_MINT)).toMatchObject({ verified: false, pair: { pairAddress: 'FAKE' } });
    const close = [pairs[0]!, { ...pairs[0]!, pairAddress: 'FAKE2', liquidity: { usd: 500_000 } }];
    expect(pickPumpSwapPair(close, can, WSOL_MINT)).toBeNull();
    expect(pickPumpSwapPair([pairs[2]!], can, WSOL_MINT)).toBeNull();
  });
});

/** Bars along waypoints (linear), `per` bars per leg, 5 minutes apart. */
function path(points: number[], per = 12, step = 300_000): Bar[] {
  const out: Bar[] = [];
  let t = NOW - (points.length - 1) * per * step;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    for (let i = 0; i < per; i++) {
      const o = a + ((b - a) * i) / per;
      const c = a + ((b - a) * (i + 1)) / per;
      out.push({ t, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1 });
      t += step;
    }
  }
  return out;
}

describe('bounce-back power (24 h history)', () => {
  it('a coin whose 20%+ dips keep getting bought back scores high', () => {
    const b = bounceBack(path([1, 1.3, 0.98, 1.35, 1.0, 1.4, 1.08, 1.42]), { dipPct: 20, recoverPct: 60 }, NOW)!;
    expect(b.dips).toBe(3);
    expect(b.recovered).toBe(3);
    expect(b.failed).toBe(0);
    expect(b.recoveryRate).toBe(1);
    expect(b.score).toBeGreaterThan(0.8);
    expect(b.inDip).toBeNull();
  });
  it('a dying coin (dips that keep falling) scores low', () => {
    const b = bounceBack(path([1, 1.2, 0.9, 0.95, 0.45, 0.5, 0.42]), { dipPct: 20, recoverPct: 60 }, NOW)!;
    expect(b.failed).toBeGreaterThanOrEqual(1);
    expect(b.recovered).toBe(0);
    expect(b.score).toBeLessThan(0.2);
  });
  it('knows when the coin is in a dip right now', () => {
    const b = bounceBack(path([1, 1.3, 1.0]), { dipPct: 20, recoverPct: 60 }, NOW)!;
    expect(b.inDip).not.toBeNull();
    expect(b.inDip!.depthPct).toBeGreaterThan(20);
    expect(bounceBack(path([1, 1.1], 4), { dipPct: 20, recoverPct: 60 })).toBeNull(); // < 12 bars
  });
  it('GeckoTerminal OHLCV (newest first, seconds) → bars oldest first; bad rows skipped', () => {
    const body = { data: { attributes: { ohlcv_list: [[1_760_000_600, 2, 2.2, 1.9, 2.1, 50], [1_760_000_300, '1.8', '2.05', '1.7', '2', '40'], [1_760_000_000, 0, 1, 1, 1, 1], ['x']] } } };
    const bars = parseGeckoOhlcv(body);
    expect(bars.map((b) => b.t)).toEqual([1_760_000_300_000, 1_760_000_600_000]);
    expect(bars[0]).toMatchObject({ o: 1.8, h: 2.05, l: 1.7, c: 2 });
    expect(parseGeckoOhlcv(null)).toEqual([]);
  });
});

/** 15 s candles along closes; buy/sell SOL per candle. */
function candles(closes: number[], flow: (i: number) => { bv: number; sv: number } = () => ({ bv: 1, sv: 1 })): Candle[] {
  const t0 = NOW - closes.length * 15_000;
  return closes.map((c, i) => {
    const o = i ? closes[i - 1]! : c;
    const f = flow(i);
    return { t: t0 + i * 15_000, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: f.bv + f.sv, bv: f.bv, sv: f.sv, n: 6 };
  });
}
const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);
const SETUP = { minPullbackPct: 12, maxPullbackPct: 45, minBouncePct: 3, maxBouncePct: 12, minBuyRatio: 1.15 };

describe('swing entry: dip → higher low → bounce with buyers', () => {
  const run = ramp(1, 1.4, 30);
  const dump = ramp(1.4, 1.05, 16);
  const bounce = [1.06, 1.07, 1.08, 1.09, 1.1];
  const buyers = (n: number) => (i: number) => (i >= n - 8 ? { bv: 2, sv: 1 } : { bv: 1, sv: 1 });
  it('buys a 25% pullback that held its low and bounced ~5% with buyers ahead', () => {
    const c = [...run, ...dump, ...bounce];
    const s = swingSetup(candles(c, buyers(c.length)), 1.1, SETUP);
    expect(s.ok).toBe(true);
    expect(s.pullbackPct).toBeCloseTo(25, 0);
    expect(s.bouncePct).toBeCloseTo(4.8, 0);
    expect(s.higherLow).toBe(true);
    expect(s.target).toBeCloseTo(1.4, 5);
    expect(s.stop).toBeLessThan(1.05);
    expect(s.strength).toBeGreaterThan(0.4);
  });
  it('waits while it is still making new lows, when the bounce already ran, or sellers lead', () => {
    const falling = [...run, ...dump, 1.04, 1.03];
    expect(swingSetup(candles(falling, buyers(falling.length)), 1.03, SETUP).why).toMatch(/higher low|bounce/);
    const ran = [...run, ...dump, 1.08, 1.12, 1.16, 1.2, 1.22];
    expect(swingSetup(candles(ran, buyers(ran.length)), 1.22, SETUP).why).toMatch(/not chasing/);
    const c = [...run, ...dump, ...bounce];
    expect(swingSetup(candles(c, () => ({ bv: 1, sv: 2 })), 1.1, SETUP).why).toMatch(/buyers not in control/);
  });
  it('too shallow or a broken trend is no setup; the 3-hour high counts when the pullback began earlier', () => {
    const shallow = [...run, ...ramp(1.4, 1.3, 10), 1.31, 1.33, 1.35];
    expect(swingSetup(candles(shallow, buyers(shallow.length)), 1.35, SETUP).ok).toBe(false);
    const deep = [...run, ...ramp(1.4, 0.65, 16), 0.66, 0.67, 0.68, 0.69];
    expect(swingSetup(candles(deep, buyers(deep.length)), 0.69, SETUP).why).toMatch(/trend broken/);
    // A flat last hour after a bigger drop: only the 3-hour high shows the 25% pullback.
    const flat = [...ramp(1.12, 1.05, 30), 1.05, 1.06, 1.07, 1.08, 1.09, 1.1];
    expect(swingSetup(candles(flat, buyers(flat.length)), 1.1, SETUP).ok).toBe(false);
    expect(swingSetup(candles(flat, buyers(flat.length)), 1.1, SETUP, 1.4).ok).toBe(true);
  });
});

const C = DEFAULT_CONFIG.swing;
function goodInput(over: Partial<SwingInput> = {}): SwingInput {
  const c = [...ramp(1, 1.4, 30), ...ramp(1.4, 1.05, 16), 1.06, 1.07, 1.08, 1.09, 1.1];
  return {
    watchlist: false,
    trendingLists: 1,
    marketCapUsd: 900_000,
    liquidityUsd: 120_000,
    volume24hUsd: 2_500_000,
    ageMin: 600,
    priceChange1hPct: -12,
    priceChange24hPct: 30,
    trades10m: 240,
    activeWallets5m: 45,
    safety: { checked: true, hardFail: false },
    banned: false,
    mayhem: false,
    bounce: bounceBack(path([1, 1.3, 0.98, 1.35, 1.0, 1.4, 1.08, 1.42]), { dipPct: 20, recoverPct: 60 }, NOW),
    liveBounce: null,
    setup: swingSetup(candles(c, (i) => (i >= c.length - 8 ? { bv: 2.5, sv: 1 } : { bv: 1, sv: 1 })), 1.1, SETUP),
    ta: [],
    crowd: { fakeVolumePct: 5, top3VolumePct: 20, whaleSellPct: 10 },
    top10Pct: 22,
    kolDumping: false,
    kolBuyers: 0,
    barDelta: 0,
    ...over,
  };
}

describe('swing decision', () => {
  it('a resilient big coin on a clean dip-and-bounce is a BUY', () => {
    const v = swingDecision(goodInput(), C);
    expect(v.fails).toEqual([]);
    expect(v.decision).toBe('BUY');
    expect(v.score).toBeGreaterThanOrEqual(v.threshold);
    expect(v.sizeFactor).toBe(1);
  });
  it('hard rules: safety, size, liquidity, activity, holders, falling knife, fake volume, KOLs', () => {
    const fails = (o: Partial<SwingInput>) => swingDecision(goodInput(o), C).fails.join(' | ');
    expect(fails({ safety: { checked: false, hardFail: false } })).toMatch(/safety check pending/);
    expect(fails({ marketCapUsd: 20_000 })).toMatch(/MC/);
    expect(fails({ marketCapUsd: 90_000_000 })).toMatch(/MC/);
    expect(fails({ liquidityUsd: 4_000 })).toMatch(/liquidity/);
    expect(fails({ trades10m: 5 })).toMatch(/trades in 10 min/);
    expect(fails({ top10Pct: 70 })).toMatch(/top 10/);
    expect(fails({ priceChange1hPct: -55 })).toMatch(/falling knife/);
    expect(fails({ crowd: { fakeVolumePct: 60, top3VolumePct: 20, whaleSellPct: 0 } })).toMatch(/fake volume/);
    expect(fails({ kolDumping: true })).toMatch(/KOLs dumping/);
    expect(fails({ ageMin: 20 })).toMatch(/migrated/);
  });
  it('weak bounce-back power blocks it — unless it is on your watchlist (which also lowers the bar)', () => {
    const weak = bounceBack(path([1, 1.2, 0.9, 0.95, 0.45, 0.5, 0.42]), { dipPct: 20, recoverPct: 60 }, NOW);
    expect(swingDecision(goodInput({ bounce: weak }), C).fails.join()).toMatch(/bounce-back power/);
    const w = swingDecision(goodInput({ bounce: weak, watchlist: true }), C);
    expect(w.fails.join()).not.toMatch(/bounce-back power/);
    expect(w.threshold).toBe(C.minScore + C.watchlistScoreDelta);
  });
  it('concentrated holders → half size; no setup → no buy', () => {
    const v = swingDecision(goodInput({ top10Pct: 45 }), C);
    expect(v.sizeFactor).toBe(0.5);
    const none = swingDecision(goodInput({ setup: { ...goodInput().setup, ok: false, why: 'no higher low yet' } }), C);
    expect(none.decision).toBe('SKIP');
    expect(none.fails.join()).toMatch(/no swing setup/);
  });
  it('a strong dip-type chart strategy can be the entry; proven ones add points', () => {
    const noSetup = { ...goodInput().setup, ok: false, why: 'bounce 2% (need 3%)', bouncePct: 2 };
    const ta = [{ id: 'fib_golden_pocket', strength: 0.8, why: 'golden pocket reclaim', proven: true }];
    const v = swingDecision(goodInput({ setup: noSetup, ta }), C);
    expect(v.fails).toEqual([]);
    expect(v.parts.proven).toBe(3);
  });
});

describe('swing universe filter + rank', () => {
  const coin = { pool: 'P', marketCapUsd: 500_000, liquidityUsd: 80_000, volume24hUsd: 900_000, migratedAtMs: NOW - 5 * 3600_000, banned: false, mayhem: false };
  it('keeps established PumpSwap coins in the size band only', () => {
    expect(swingFilter(coin, C, NOW)).toBeNull();
    expect(swingFilter({ ...coin, pool: null }, C, NOW)).toMatch(/PumpSwap/);
    expect(swingFilter({ ...coin, marketCapUsd: 10_000 }, C, NOW)).toMatch(/MC under/);
    expect(swingFilter({ ...coin, migratedAtMs: NOW - 10 * 60_000 }, C, NOW)).toMatch(/migrated under/);
    expect(swingFilter({ ...coin, banned: true }, C, NOW)).toMatch(/banned/);
  });
  it('watchlist first, then the busiest coins', () => {
    const r = (o: object) => swingRank({ watchlist: false, volume1hUsd: 50_000, volume24hUsd: 1_000_000, txns24h: 5_000, trendingLists: [], sources: ['trending'], priceChange24hPct: 10, ...o } as never);
    expect(r({ watchlist: true })).toBeGreaterThan(r({ volume1hUsd: 5_000_000 }));
    expect(r({ volume1hUsd: 500_000 })).toBeGreaterThan(r({ volume1hUsd: 5_000 }));
  });
});

describe('swing re-entries (a coin that keeps bouncing is traded again — with cooldowns)', () => {
  const c = { reentryCooldownMin: 20, lossCooldownMin: 120, maxTradesPerCoinPerDay: 4, lossStreakPauseHours: 24 };
  const closed = (minAgo: number, pnl: number, exitReason = 'TAKE_PROFIT') => ({ status: 'CLOSED', closedAtMs: NOW - minAgo * 60_000, exitReason, pnlSol: pnl });
  it('after a win: 20 min; after a loss: 2 h', () => {
    expect(swingReentryReason([closed(10, 0.05)], NOW, c)).toMatch(/cooldown/);
    expect(swingReentryReason([closed(25, 0.05)], NOW, c)).toBeNull();
    expect(swingReentryReason([closed(60, -0.03)], NOW, c)).toMatch(/after a loss/);
    expect(swingReentryReason([closed(130, -0.03)], NOW, c)).toBeNull();
  });
  it('max 4 a day, two losses in a row pause it, never after a rug, never while holding', () => {
    expect(swingReentryReason([closed(30, 0.1), closed(90, 0.1), closed(200, 0.1), closed(400, 0.1)], NOW, c)).toMatch(/4× in 24 h/);
    expect(swingReentryReason([closed(130, -0.02), closed(300, -0.04)], NOW, c)).toMatch(/twice in a row/);
    expect(swingReentryReason([closed(500, 0.1, 'RUG_DETECTED')], NOW, c)).toMatch(/rugged/);
    expect(swingReentryReason([{ status: 'OPEN', closedAtMs: null, exitReason: null, pnlSol: 0 }], NOW, c)).toMatch(/still holding/);
  });
});

const exitBase: ExitInput = {
  entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: NOW,
  staleMinutes: 120, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0,
  top10PctEntry: 0, top10PctNow: 0, nowMs: NOW, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: NOW - 5_000, maxHoldMinutes: 720,
  resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015, strategy: 'SWING',
};

describe('swing exits + holding big winners longer', () => {
  const swing = exitRulesFor('SWING', DEFAULT_CONFIG.exit);
  it('SWING gets its own exit settings layered on the shared ones; other strategies are untouched', () => {
    expect(swing.takeProfitTiers.map((t) => t.multiple)).toEqual([1.25, 1.6, 3]);
    expect(swing.trail.breakEvenAfterMultiple).toBe(1.25);
    expect(swing.trail.confirmSec).toBe(DEFAULT_CONFIG.exit.trail.confirmSec); // not overridden → shared value
    expect(exitRulesFor('CURVE_SNIPE', DEFAULT_CONFIG.exit)).toBe(DEFAULT_CONFIG.exit);
    expect(exitRulesFor('SWING', DEFAULT_CONFIG.exit)).toBe(swing); // cached
  });
  it('first profit at 1.25x (30%), stop band 12–15%', () => {
    const d = decideExit({ ...exitBase, priceSol: 1.26, peakPriceSol: 1.26 }, swing);
    expect(d.sells[0]).toMatchObject({ pct: 30, reason: 'TAKE_PROFIT' });
    const stop = decideExit({ ...exitBase, priceSol: 0.8 }, swing);
    expect(stop.sells[0]?.reason).toBe('STOP_LOSS');
  });
  it('time stop is an hour for swings (no follow-through), not 1.5 minutes', () => {
    const early = decideExit({ ...exitBase, priceSol: 0.99, peakPriceSol: 1.03, openedAtMs: NOW - 30 * 60_000, lastMoveAtMs: NOW - 60_000 }, swing);
    expect(early.sells).toEqual([]);
    const late = decideExit({ ...exitBase, priceSol: 0.99, peakPriceSol: 1.03, openedAtMs: NOW - 61 * 60_000, lastMoveAtMs: NOW - 60_000 }, swing);
    expect(late.sells[0]?.detail).toMatch(/no follow-through/);
  });
  it('a big coin still trending up rides past the max hold (the trail still protects it)', () => {
    const held = { ...exitBase, priceSol: 2.2, peakPriceSol: 2.3, tpTiersHit: [1.25, 1.6, INITIALS_MARKER], trailingActive: true, openedAtMs: NOW - 25 * 3600_000, lastMoveAtMs: NOW - 60_000 };
    expect(decideExit(held, swing).sells[0]?.detail).toMatch(/max hold/);
    expect(decideExit({ ...held, holdLonger: true }, swing).sells).toEqual([]);
    // …but not through its trailing stop
    expect(decideExit({ ...held, priceSol: 1.5, holdLonger: true }, swing).sells[0]?.reason).toBe('TRAILING_STOP');
  });
  it('holdLongerNow: banked profit + big market cap + uptrend + low risk + under 48 h', () => {
    const ok = { rules: DEFAULT_CONFIG.exit, tpTiersHit: [1.4, INITIALS_MARKER], marketCapUsd: 300_000, chart: { trend: 'up', higherLows: true, verdict: 'neutral' }, risk: 0.1, heldMs: 3 * 3600_000 };
    expect(holdLongerNow(ok)).toBe(true);
    expect(holdLongerNow({ ...ok, tpTiersHit: [] })).toBe(false);
    expect(holdLongerNow({ ...ok, marketCapUsd: 30_000 })).toBe(false);
    expect(holdLongerNow({ ...ok, chart: { trend: 'down', higherLows: false, verdict: 'avoid' } })).toBe(false);
    expect(holdLongerNow({ ...ok, chart: { trend: 'range', higherLows: true, verdict: 'neutral' } })).toBe(true);
    expect(holdLongerNow({ ...ok, risk: 0.8 })).toBe(false);
    expect(holdLongerNow({ ...ok, heldMs: 49 * 3600_000 })).toBe(false);
  });
});

describe('adopting an already-migrated coin (live state)', () => {
  it('follows its pool, prices it from the first real trade (seed reserves never block it), survives a restart', async () => {
    const redis = new FakeRedis();
    const ls = new LiveState(redis as unknown as Redis);
    const pool = canonicalPumpPool(REAL_MINT)!;
    // Seed from an outside API that is 10× off — the first real trade must still set the price.
    const res = await ls.adoptPool({ mint: REAL_MINT, pool, createdAtMs: NOW - 3 * 86_400_000, migratedAtMs: NOW - 2 * 86_400_000, baseReserve: 100_000_000_000_000n, quoteReserve: 1_000_000_000_000n });
    expect(res).toBe('adopted');
    expect(ls.isTracked(REAL_MINT)).toBe(true);
    expect(ls.mintForPool(pool)).toBe(REAL_MINT);
    // Real pool: 150M tokens, 300 SOL → 2e-6 SOL per token. A 1 SOL buy.
    const B = 150_000_000_000_000n;
    const Q = 300_000_000_000n;
    const dq = 1_000_000_000n;
    const db = (B * dq) / (Q + dq);
    const mint = await ls.onAmmTrade({ kind: 'ammTrade', pool, user: 'W1', isBuy: true, baseAmount: db, quoteAmount: dq, baseReserve: B - db, quoteReserve: Q + dq, feeLamports: 0n, timestamp: Math.floor(NOW / 1000) });
    expect(mint).toBe(REAL_MINT);
    const view = (await ls.read(REAL_MINT))!;
    expect(view.adopted).toBe(true);
    expect(view.complete).toBe(true);
    const m = deriveMetrics(view);
    expect(m.priceSol).toBeGreaterThan(1.9e-6);
    expect(m.priceSol).toBeLessThan(2.1e-6);
    // No sniper / dev flags from a coin we never saw launch.
    expect(view.earlyBuyers).toEqual([]);
    expect(m.devHoldingPct).toBe(0);
    // Adopting again just keeps it; a restart keeps it (scored by adoption time, not its 3-day-old launch).
    expect(await ls.adoptPool({ mint: REAL_MINT, pool, createdAtMs: null, migratedAtMs: null })).toBe('tracked');
    const ls2 = new LiveState(redis as unknown as Redis);
    await ls2.restore();
    expect(ls2.isTracked(REAL_MINT)).toBe(true);
    expect(ls2.mintForPool(pool)).toBe(REAL_MINT);
    void MINT;
  });
});

describe('config migration v5 (v7 defaults reach saved settings)', async () => {
  const { applyMigration, MIGRATIONS } = await import('../src/config/migrations');
  it('sets the SWING allocation (capital adds up to 100%), 8 positions and the looser new-pair demand; other saved values stay', () => {
    const m = MIGRATIONS.find((x) => x.version === 5)!;
    const saved = {
      trading: { maxPositionSol: 0.3, allocation: { CURVE_SNIPE: 0.55, MIGRATION_MOMENTUM: 0.25, SOON: 0.2, SMART_MONEY_COPY: 0 }, maxConcurrentPositions: 5, enabledStrategies: { CURVE_SNIPE: true } },
      focus: { newPair: { minBuyers60s: 12, maxAgeSec: 720 } },
    };
    const out = applyMigration(saved, m) as typeof saved & { trading: { allocation: Record<string, number>; enabledStrategies: Record<string, boolean>; maxOpenByStrategy: Record<string, number> } };
    const total = Object.values(out.trading.allocation).reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(out.trading.allocation.SWING).toBe(0.3);
    expect(out.trading.enabledStrategies).toEqual({ CURVE_SNIPE: true, SWING: true });
    expect(out.trading.maxConcurrentPositions).toBe(8);
    expect(out.trading.maxOpenByStrategy.SWING).toBe(3);
    expect(out.trading.maxPositionSol).toBe(0.3); // the owner's own setting is kept
    expect(out.focus.newPair).toMatchObject({ minBuyers60s: 10, minNewBuyers60s: 6, maxAgeSec: 720 });
  });
  it('the default capital split adds up to 100% too', () => {
    expect(Object.values(DEFAULT_CONFIG.trading.allocation).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });
});
