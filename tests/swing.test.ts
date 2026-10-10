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
import { bounceBack, parseGeckoOhlcv, pickPumpSwapPair, swingDecision, swingSetup, swingSizeForMc, type Bar, type SwingInput } from '../src/evaluator/swing';
import { decideExit, exitRulesFor, holdLongerNow, INITIALS_MARKER, SPIKE_MARKER, spikeRisePct, stopLossLevel, type ExitInput } from '../src/executor/sell-manager';
import { candidateKeys, findVamp, originalKeys, replacesOriginal, VampGuard } from '../src/evaluator/vamp-guard';
import { classifyTrade, computeCoachState } from '../src/learner/trade-coach';
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

describe('swing exits: fast profits, spike sells, tight stop (owner: "10% is good profit, be faster")', () => {
  const swing = exitRulesFor('SWING', DEFAULT_CONFIG.exit);
  it('SWING gets its own exit settings layered on the shared ones; other strategies are untouched', () => {
    expect(swing.takeProfitTiers.map((t) => [t.multiple, t.sellPct])).toEqual([[1.1, 50], [1.2, 25], [1.5, 15]]);
    expect(swing.trail.breakEvenAfterMultiple).toBe(1.1);
    expect(swing.trail.confirmSec).toBe(DEFAULT_CONFIG.exit.trail.confirmSec); // not overridden → shared value
    expect(swing.spikeSell.enabled).toBe(true);
    expect(DEFAULT_CONFIG.exit.spikeSell.enabled).toBe(false); // only swings sell spikes by default
    expect(exitRulesFor('CURVE_SNIPE', DEFAULT_CONFIG.exit)).toBe(DEFAULT_CONFIG.exit);
    expect(exitRulesFor('SWING', DEFAULT_CONFIG.exit)).toBe(swing); // cached
  });
  it('half out at +10%, a quarter more at +20%', () => {
    const d = decideExit({ ...exitBase, priceSol: 1.11, peakPriceSol: 1.11 }, swing);
    expect(d.sells[0]).toMatchObject({ pct: 50, reason: 'TAKE_PROFIT' });
    const d2 = decideExit({ ...exitBase, priceSol: 1.21, peakPriceSol: 1.21, remainingPct: 50, tpTiersHit: [1.1] }, swing);
    expect(d2.sells[0]).toMatchObject({ pct: 25, reason: 'TAKE_PROFIT' });
  });
  it('stop 10–12% after fees for swings (shared band stays 12–20%)', () => {
    const sw = stopLossLevel(1, null, swing, 0, 0, 'SWING');
    expect(sw.stopPct).toBe(12); // fallback 15% clamped to the 12% swing max
    expect(sw.hardPct).toBe(12);
    expect(stopLossLevel(1, 2, swing, 0, 0, 'SWING').stopPct).toBe(10); // calm coin → the 10% floor
    expect(stopLossLevel(1, 2, DEFAULT_CONFIG.exit, 0, 0, 'CURVE_SNIPE').stopPct).toBe(12);
    expect(decideExit({ ...exitBase, priceSol: 0.85 }, swing).sells[0]?.reason).toBe('STOP_LOSS');
  });
  it('sells half of what is left into a +8% spike (once), never below 1.04x', () => {
    const spike = decideExit({ ...exitBase, priceSol: 1.07, peakPriceSol: 1.07, spikeRisePct: 9 }, swing);
    expect(spike.sells[0]).toMatchObject({ pct: 50, reason: 'TAKE_PROFIT' });
    expect(spike.sells[0]!.detail).toMatch(/spike/);
    expect(spike.state.tpTiersHit).toContain(SPIKE_MARKER);
    expect(spike.state.tpTiersHit).toContain(1.1); // the spike sale stands in for the +10% tier
    // so at 1.2x the next tier sells its 25% and the rest keeps riding
    const at12 = decideExit({ ...exitBase, priceSol: 1.21, peakPriceSol: 1.21, remainingPct: 50, tpTiersHit: spike.state.tpTiersHit }, swing);
    expect(at12.sells[0]).toMatchObject({ pct: 25, reason: 'TAKE_PROFIT' });
    const again = decideExit({ ...exitBase, priceSol: 1.08, peakPriceSol: 1.08, remainingPct: 50, tpTiersHit: spike.state.tpTiersHit, spikeRisePct: 10 }, swing);
    expect(again.sells.filter((x) => /spike/.test(x.detail))).toEqual([]);
    expect(decideExit({ ...exitBase, priceSol: 1.02, peakPriceSol: 1.02, spikeRisePct: 12 }, swing).sells).toEqual([]);
    expect(decideExit({ ...exitBase, priceSol: 1.07, peakPriceSol: 1.07, spikeRisePct: 9 }, DEFAULT_CONFIG.exit).sells).toEqual([]); // off elsewhere
  });
  it('spikeRisePct: now vs the lowest real trade in the window, only since we bought', () => {
    const tr = [
      { t: NOW - 200_000, sol: 1, px: 0.8 }, // before the window
      { t: NOW - 100_000, sol: 1, px: 1.0, pp: 1.0 },
      { t: NOW - 60_000, sol: 0.001, px: 0.5 }, // dust — ignored
      { t: NOW - 30_000, sol: 1, px: 1.05 },
    ];
    expect(spikeRisePct(tr, 1.1, NOW - 120_000)).toBeCloseTo(10, 5);
    expect(spikeRisePct(tr, 1.1, NOW - 40_000)).toBeCloseTo(4.8, 1); // opened 40 s ago: the earlier low doesn't count
    expect(spikeRisePct([], 1.1, NOW - 120_000)).toBeNull();
  });
  it('no follow-through after 30 min / no new high for 45 min → out (faster than before)', () => {
    const early = decideExit({ ...exitBase, priceSol: 0.99, peakPriceSol: 1.03, openedAtMs: NOW - 20 * 60_000, lastMoveAtMs: NOW - 60_000 }, swing);
    expect(early.sells).toEqual([]);
    const late = decideExit({ ...exitBase, priceSol: 0.99, peakPriceSol: 1.03, openedAtMs: NOW - 31 * 60_000, lastMoveAtMs: NOW - 60_000 }, swing);
    expect(late.sells[0]?.detail).toMatch(/no follow-through/);
  });
  it('max hold 4 h (8 h for the runner); a big coin still trending up may ride on, the trail still protects it', () => {
    const held = { ...exitBase, maxHoldMinutes: swing.maxHoldMinutes.SWING, priceSol: 2.2, peakPriceSol: 2.3, remainingPct: 10, tpTiersHit: [1.1, 1.2, 1.5, INITIALS_MARKER], trailingActive: true, openedAtMs: NOW - 9 * 3600_000, lastMoveAtMs: NOW - 60_000 };
    expect(decideExit(held, swing).sells[0]?.detail).toMatch(/max hold/);
    expect(decideExit({ ...held, holdLonger: true }, swing).sells).toEqual([]);
    expect(decideExit({ ...held, priceSol: 1.5, holdLonger: true }, swing).sells[0]?.reason).toBe('TRAILING_STOP');
  });
  it('holdLongerNow: banked profit + big market cap + uptrend + low risk + under the cap (8 h for swings)', () => {
    const ok = { rules: DEFAULT_CONFIG.exit, tpTiersHit: [1.4, INITIALS_MARKER], marketCapUsd: 300_000, chart: { trend: 'up', higherLows: true, verdict: 'neutral' }, risk: 0.1, heldMs: 3 * 3600_000 };
    expect(holdLongerNow(ok)).toBe(true);
    expect(holdLongerNow({ ...ok, tpTiersHit: [] })).toBe(false);
    expect(holdLongerNow({ ...ok, tpTiersHit: [SPIKE_MARKER] })).toBe(true); // a spike sell banked profit too
    expect(holdLongerNow({ ...ok, marketCapUsd: 30_000 })).toBe(false);
    expect(holdLongerNow({ ...ok, chart: { trend: 'down', higherLows: false, verdict: 'avoid' } })).toBe(false);
    expect(holdLongerNow({ ...ok, chart: { trend: 'range', higherLows: true, verdict: 'neutral' } })).toBe(true);
    expect(holdLongerNow({ ...ok, risk: 0.8 })).toBe(false);
    expect(holdLongerNow({ ...ok, heldMs: 49 * 3600_000 })).toBe(false);
    expect(holdLongerNow({ ...ok, rules: swing, heldMs: 9 * 3600_000 })).toBe(false);
  });
});

describe('swing sizing: small market caps less, big ones more (owner)', () => {
  const steps = DEFAULT_CONFIG.swing.sizeByMarketCap;
  it('steps by market cap', () => {
    expect(swingSizeForMc(60_000, steps)).toBe(0.5);
    expect(swingSizeForMc(200_000, steps)).toBe(0.8);
    expect(swingSizeForMc(900_000, steps)).toBe(1);
    expect(swingSizeForMc(3_000_000, steps)).toBe(1.3);
    expect(swingSizeForMc(20_000_000, steps)).toBe(1.6);
    expect(swingSizeForMc(null, steps)).toBe(0.5);
    expect(swingSizeForMc(1_000_000, [])).toBe(1);
  });
  it('swings may use a bigger position cap', () => {
    expect(DEFAULT_CONFIG.trading.maxPositionMultipleByStrategy.SWING).toBeGreaterThan(DEFAULT_CONFIG.trading.maxConvictionMultiple);
  });
});

describe('stricter swing entries', () => {
  it('falling knife over 30% in an hour, or a downtrend on the bigger chart → no buy', () => {
    expect(swingDecision(goodInput({ priceChange1hPct: -33 }), C).fails.join()).toMatch(/falling knife/);
    const lowerLows = bounceBack(path([1.4, 1.2, 1.3, 1.0, 1.1, 0.8, 0.9, 0.7]), { dipPct: 20, recoverPct: 60 }, NOW)!;
    expect(lowerLows.higherLows).toBe(false);
    expect(lowerLows.lowerLows).toBe(true);
    // a range with one dip lower is not a downtrend
    const range = bounceBack(path([1, 1.3, 1.0, 1.3, 0.97, 1.3, 1.05, 1.3]), { dipPct: 20, recoverPct: 60 }, NOW)!;
    expect(range.lowerLows).toBe(false);
    expect(swingDecision(goodInput({ bounce: lowerLows }), C).fails.join()).toMatch(/downtrend/);
    expect(swingDecision(goodInput({ bounce: lowerLows, watchlist: true }), C).fails.join()).not.toMatch(/downtrend/);
  });
  it('the bar is higher and learning trades never apply to swings', () => {
    expect(C.minScore).toBeGreaterThanOrEqual(78);
    expect(DEFAULT_CONFIG.explore.strategies).not.toContain('SWING');
  });
});

describe('vamps (copycat coins)', () => {
  const vc = DEFAULT_CONFIG.vamp;
  it('candidate keys strip the usual vamp dressing; originals are stored under their exact names', () => {
    expect(candidateKeys('BABYCLUDE', 'Baby Clude')).toEqual(expect.arrayContaining(['babyclude', 'clude']));
    expect(candidateKeys('CLUDE2', 'Clude 2.0')).toEqual(expect.arrayContaining(['clude2', 'clude']));
    expect(candidateKeys('REALCLUDE', 'The Real Clude')).toContain('clude');
    expect(candidateKeys('AI', 'AI')).toEqual([]); // too generic to guard
    expect(originalKeys('CLUDE', 'Clude')).toEqual(['clude']);
  });
  it('a different mint with an original’s ticker or name is a vamp; the original itself is not', () => {
    const map = new Map([['clude', { mint: 'REAL', symbol: 'CLUDE', mcUsd: 900_000, at: NOW, why: 'big' as const }]]);
    expect(findVamp('FAKE', 'CLUDE', 'Clude', map, vc, NOW)?.mint).toBe('REAL');
    expect(findVamp('FAKE', 'BABYCLUDE', 'Baby Clude', map, vc, NOW)?.mint).toBe('REAL');
    expect(findVamp('REAL', 'CLUDE', 'Clude', map, vc, NOW)).toBeNull();
    expect(findVamp('X', 'DOGWIF', 'Dog Wif', map, vc, NOW)).toBeNull();
    expect(findVamp('FAKE', 'CLUDE', 'Clude', map, vc, NOW + 8 * 86_400_000)).toBeNull(); // expired
  });
  it('the clearly bigger coin wins a ticker (a small vamp we traded first is replaced by the real one)', () => {
    const small = { mint: 'SMALL', symbol: 'CLUDE', mcUsd: 8_000, at: NOW, why: 'traded' as const };
    const big = { mint: 'REAL', symbol: 'CLUDE', mcUsd: 900_000, at: NOW, why: 'big' as const };
    expect(replacesOriginal(small, big, vc, NOW)).toBe(true);
    expect(replacesOriginal(big, small, vc, NOW)).toBe(false);
    expect(replacesOriginal(big, { ...big, mcUsd: 1_000_000 }, vc, NOW)).toBe(true); // same coin refreshes
  });
  it('the guard: a coin we traded becomes the original; the next coin with its ticker is refused', async () => {
    const redis = new FakeRedis();
    const g = new VampGuard(redis as unknown as Redis);
    await g.record({ mint: 'WIN1', symbol: 'FROGGY', name: 'Froggy', mcUsd: 9_000, why: 'traded' });
    expect(await g.check('WIN1', 'FROGGY', 'Froggy')).toBeNull();
    expect(await g.check('VAMP1', 'FROGGY', 'Froggy')).toMatch(/vamp: copies \$FROGGY/);
    expect(await g.check('VAMP2', 'BABYFROGGY', 'Baby Froggy')).toMatch(/vamp/);
    expect(await g.check('OTHER', 'TOADY', 'Toady')).toBeNull();
    // A much bigger FROGGY takes the ticker over; now the coin we traded counts as the copy.
    await g.record({ mint: 'BIGFROG', symbol: 'FROGGY', name: 'Froggy', mcUsd: 2_000_000, why: 'big' });
    expect(await g.check('BIGFROG', 'FROGGY', 'Froggy')).toBeNull();
    expect(await g.check('WIN1', 'FROGGY', 'Froggy')).toMatch(/the real coin/);
    expect(await g.prune(Date.now() + 30 * 86_400_000)).toBeGreaterThan(0);
  });
});

describe('trade coach: your manual closes are lessons, not "good exits"', () => {
  const base = { pnlSol: 0.02, peakMultiple: 1.3, exitMultiple: 1.2, postHighMultiple: 1.2, postLowMultiple: 1.0 };
  it('a manual close is never a good exit', () => {
    expect(classifyTrade({ ...base, exitReason: 'MANUAL' }).verdict).toBe('manual_exit');
    expect(classifyTrade({ ...base, exitReason: 'MANUAL' }).lesson).toMatch(/held too long/);
    expect(classifyTrade({ ...base, pnlSol: -0.01, exitReason: 'MANUAL' }).lesson).toMatch(/pickier/);
    expect(classifyTrade({ ...base, exitReason: 'TAKE_PROFIT' }).verdict).toBe('good_exit');
  });
  it('a swing that was up 10% and closed red gave back profit (other strategies: 30%)', () => {
    const r = { pnlSol: -0.01, peakMultiple: 1.12, exitMultiple: 0.95, postHighMultiple: 1.0, postLowMultiple: 0.9, exitReason: 'STOP_LOSS' };
    expect(classifyTrade({ ...r, strategy: 'SWING' }).verdict).toBe('gave_back_profit');
    expect(classifyTrade({ ...r, strategy: 'CURVE_SNIPE' }).verdict).not.toBe('gave_back_profit');
  });
  it('manual closes tighten the trail (sell sooner); at a loss they raise the bar', () => {
    const review = (verdict: string, pnlSol: number) => ({ positionId: 'p', mint: 'm', symbol: 'S', strategy: 'SWING' as const, swing: false, pnlSol, pnlPct: pnlSol * 100, peakMultiple: 1.2, lowMultiple: 0.95, exitMultiple: 1.1, postHighMultiple: 1.2, postLowMultiple: 1, heldMin: 20, exitReason: verdict === 'manual_exit' ? 'MANUAL' : 'TAKE_PROFIT', verdict: verdict as never, lesson: '', at: '' });
    const st = computeCoachState('SWING', [review('manual_exit', 0.02), review('manual_exit', -0.01), review('good_exit', 0.03)]);
    expect(st.trailFactor).toBeLessThanOrEqual(0.8);
    expect(st.thresholdDelta).toBeGreaterThan(0);
    expect(st.note).toMatch(/by hand/);
    // swings never loosen the trail because a coin "ran after" we sold
    const early = computeCoachState('SWING', [review('sold_too_early', 0.02), review('sold_too_early', 0.02), review('sold_too_early', 0.02)]);
    expect(early.trailFactor).toBe(1);
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
