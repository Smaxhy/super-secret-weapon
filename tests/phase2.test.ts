import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../src/config/default';
import { STRATEGIES } from '../src/config/strategies';
import { marketFeatures, type MarketRaw } from '../src/evaluator/market-analyzer';
import { checkEntryRules, decide, scoreFeatures } from '../src/evaluator/scorer';
import { walletFeatures, type CreatorProfile } from '../src/evaluator/wallet-analyzer';
import { computeRisk, computeVolatilityPct, decideExit, detectResistance, INITIALS_MARKER, runnerTrailPct, type ExitInput } from '../src/executor/sell-manager';
import { curvePriceSol, quoteBuy, quoteSell } from '../src/lib/pumpfun';

const V_SOL = 30_000_000_000n;
const V_TOK = 1_073_000_000_000_000n;

describe('curve quotes', () => {
  it('1 SOL at launch buys ~34.6M tokens before fees', () => {
    expect(Number(quoteBuy(1_000_000_000n, V_SOL, V_TOK, 0).tokensOut) / 1e6).toBeCloseTo(34_612_903, -1);
  });
  it('round trip loses roughly two fees', () => {
    const { tokensOut } = quoteBuy(1_000_000_000n, V_SOL, V_TOK, 125);
    const after = { sol: V_SOL + 987_500_000n, tok: V_TOK - tokensOut };
    const back = Number(quoteSell(tokensOut, after.sol, after.tok, 125).solOutLamports) / 1e9;
    expect(back).toBeGreaterThan(0.97);
    expect(back).toBeLessThan(0.98);
  });
});

const goodMarket: MarketRaw = {
  ageSec: 120, holders: 70, uniqueWallets: 80, buys: 120, sells: 30, buySellRatio: 4, volumeSol: 40,
  liquiditySol: 12, bondingCurvePct: 25, curveVelocity: 5, priceSol: 5e-8, marketCapSol: 50,
  devHoldingPct: 2, devSoldFraction: 0, top10HolderPct: 14, earlyBuyerPct: 1, maxHolderPct: 3, volumeSpikeRatio: 1, retention: 0.875, complete: false, onAmm: false,
  totalFeesSol: 1.2, volumeUsd: 15_000, marketCapUsd: 13_000,
};
const goodWallet: CreatorProfile = { creator: 'c', balanceSol: 3, walletAgeHours: 24 * 60, veryActive: false, funder: 'f', funderBlacklisted: false, funderCreatorCount: 1, launches24h: 0, priorLaunches: 0, priorCompleted: 0 };

describe('scoring', () => {
  it('a strong token scores above the 75 threshold', () => {
    const { score } = scoreFeatures({ safety: 1, ...marketFeatures(goodMarket), ...walletFeatures(goodWallet), socials: 0.7, narrative: 0.5 }, DEFAULT_WEIGHTS);
    expect(score).toBeGreaterThan(75);
  });
  it('a serial launcher with a sniped, concentrated token scores low', () => {
    const bad = { ...goodMarket, top10HolderPct: 55, earlyBuyerPct: 25, buySellRatio: 1, devSoldFraction: 1, curveVelocity: 0.2 };
    const { score } = scoreFeatures({ safety: 1, ...marketFeatures(bad), ...walletFeatures({ ...goodWallet, launches24h: 15, funderCreatorCount: 6 }), socials: 0, narrative: 0.5 }, DEFAULT_WEIGHTS);
    expect(score).toBeLessThan(50);
  });
  it('contributions add up to the score', () => {
    const r = scoreFeatures({ safety: 1, ...marketFeatures(goodMarket), ...walletFeatures(goodWallet), socials: 0.7, narrative: 0.5 }, DEFAULT_WEIGHTS);
    expect(Object.values(r.contributions).reduce((a, b) => a + b, 0)).toBeCloseTo(r.score, 0);
  });
  it('default weights sum to 1', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe('entry rules', () => {
  const base = { safetyScore: 100, safetyHardFail: false, market: goodMarket, strategy: STRATEGIES.CURVE_SNIPE, entry: DEFAULT_CONFIG.entry };
  it('passes a good token', () => expect(checkEntryRules(base)).toEqual([]));
  it('anti-rug limits: bundles, top 10, single wallet, dev dumping', () => {
    const fails = checkEntryRules({ ...base, market: { ...goodMarket, earlyBuyerPct: 20, top10HolderPct: 55, maxHolderPct: 12, devSoldFraction: 0.95 } });
    expect(fails).toEqual(['bundlers hold 20.0% > 18%', 'top 10 hold 55.0% > 50%', 'one wallet holds 12.0% > 10%', 'dev sold 95% of their bag']);
  });
  it('migration strategy accepts completed curves only once on PumpSwap', () => {
    const mig = { ...base, strategy: STRATEGIES.MIGRATION_MOMENTUM, market: { ...goodMarket, holders: 80, complete: true, bondingCurvePct: 100 } };
    expect(checkEntryRules(mig)).toEqual(['waiting for PumpSwap pool']);
    expect(checkEntryRules({ ...mig, market: { ...mig.market, onAmm: true } })).toEqual([]);
    expect(checkEntryRules({ ...base, market: { ...goodMarket, complete: true } })).toContain('curve already complete');
  });
  it('lists every failed rule', () => {
    const fails = checkEntryRules({ ...base, safetyScore: 60, market: { ...goodMarket, holders: 5, devHoldingPct: 15, liquiditySol: 2 } });
    expect(fails).toHaveLength(4);
  });
  it('enforces USD volume, USD market cap and total fees minimums', () => {
    const fails = checkEntryRules({ ...base, market: { ...goodMarket, volumeUsd: 11_999, marketCapUsd: 5_000, totalFeesSol: 0.5 } });
    expect(fails).toEqual(['fees 0.50 SOL < 1', 'volume $11999 < $12000', 'MC $5000 < $12000']);
  });
  it('fails closed when the SOL price is unknown', () => {
    expect(checkEntryRules({ ...base, market: { ...goodMarket, volumeUsd: null, marketCapUsd: null } })).toEqual(['SOL/USD price unknown']);
  });
  it('decide: BUY / SKIP / REJECT', () => {
    expect(decide(80, 75, [], false).decision).toBe('BUY');
    expect(decide(70, 75, [], false).decision).toBe('SKIP');
    expect(decide(90, 75, ['x'], false).decision).toBe('SKIP');
    expect(decide(90, 75, ['safety hard fail'], true).decision).toBe('REJECT');
  });
});

describe('exit rules', () => {
  const now = 10_000_000;
  const base: ExitInput = {
    entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
    staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
    top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45,
    resistance: { hit: false, level: 0, touches: 0 },
    sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015,
  };
  const rules = DEFAULT_CONFIG.exit;
  const reasons = (i: Partial<ExitInput>) => decideExit({ ...base, ...i }, rules).sells.map((s) => `${s.reason}:${s.pct}`);

  it('holds when nothing happens', () => expect(reasons({})).toEqual([]));
  it('stop loss at -40%', () => expect(reasons({ priceSol: 0.59 })).toEqual(['STOP_LOSS:100']));
  it('takes 25% at 1.3x and arms the trailing stop', () => {
    const d = decideExit({ ...base, priceSol: 1.35, peakPriceSol: 1.35 }, rules);
    expect(d.sells.map((s) => `${s.reason}:${s.pct}`)).toEqual(['TAKE_PROFIT:25']);
    expect(d.state.trailingActive).toBe(true);
  });
  it('does not re-fire a tier', () => expect(reasons({ priceSol: 1.4, peakPriceSol: 1.4, tpTiersHit: [1.3], remainingPct: 75, trailingActive: true })).toEqual([]));
  it('before initials the trail tightens to 15% after a 2x-ish peak', () => {
    // peak 1.9x (no initials yet) → 20% trail: 1.55 holds, 1.5 sells
    expect(reasons({ priceSol: 1.55, peakPriceSol: 1.9, tpTiersHit: [1.3], remainingPct: 75, trailingActive: true })).toEqual([]);
    expect(reasons({ priceSol: 1.5, peakPriceSol: 1.9, tpTiersHit: [1.3], remainingPct: 75, trailingActive: true })).toEqual(['TRAILING_STOP:75']);
  });
  it('sells at resistance once in profit', () => expect(reasons({ priceSol: 1.25, peakPriceSol: 1.29, resistance: { hit: true, level: 1.29, touches: 3 } })).toEqual(['TAKE_PROFIT:100']));
  it('ignores resistance below 1.2x', () => expect(reasons({ priceSol: 1.1, peakPriceSol: 1.15, resistance: { hit: true, level: 1.15, touches: 3 } })).toEqual([]));
  it('protects profit: peaked 1.6x, back to 1.04x → out', () => expect(reasons({ priceSol: 1.04, peakPriceSol: 1.6 })).toEqual(['TRAILING_STOP:100']));
  it('in profit + risk rising → take profit early', () => expect(reasons({ priceSol: 1.2, peakPriceSol: 1.22, risk: 0.7, riskWhy: 'x' })).toEqual(['TAKE_PROFIT:100']));
  it('in profit + low risk → keep holding', () => expect(reasons({ priceSol: 1.2, peakPriceSol: 1.22, risk: 0.3 })).toEqual([]));
  it('losing + risk rising → cut early at -15%', () => expect(reasons({ priceSol: 0.84, risk: 0.7, riskWhy: 'x' })).toEqual(['STOP_LOSS:100']));
  it('max hold time closes the trade', () => expect(reasons({ priceSol: 1.1, refPriceSol: 1.1, nowMs: now + 46 * 60_000, lastMoveAtMs: now + 40 * 60_000 })).toEqual(['TAKE_PROFIT:100']));
  it('copied wallet sold → out', () => expect(reasons({ copyWalletSold: true, priceSol: 1.4 })).toEqual(['COPY_EXIT:100']));
  it('rug: dev dumps', () => expect(reasons({ devHoldingPctNow: 1 })).toEqual(['RUG_DETECTED:100']));
  it('rug: concentration spike while underwater', () => expect(reasons({ top10PctNow: 31, priceSol: 0.9 })).toEqual(['RUG_DETECTED:100']));
  it('whales concentrating a pump is not a rug', () => expect(reasons({ top10PctNow: 40, priceSol: 1.2, peakPriceSol: 1.2 })).toEqual([]));
  it('exits if migrated but no PumpSwap pool ever appeared', () => expect(reasons({ migratedNoMarket: true, priceSol: 3 })).toEqual(['MIGRATED:100']));
  it('rug: bundlers dumping', () => expect(reasons({ bundlePctNow: 2 })).toEqual(['RUG_DETECTED:100']));
  it('bundlers selling a little is fine', () => expect(reasons({ bundlePctNow: 5 })).toEqual([]));
  it('stale after 30 flat minutes', () => expect(reasons({ priceSol: 1.02, nowMs: now + 31 * 60_000, maxHoldMinutes: 120 })).toEqual(['STALE:100']));
  it('a real move resets the stale clock', () => {
    const d = decideExit({ ...base, priceSol: 1.12, peakPriceSol: 1.12, nowMs: now + 31 * 60_000, maxHoldMinutes: 120 }, rules);
    expect(d.sells).toEqual([]);
    expect(d.state.lastMoveAtMs).toBe(now + 31 * 60_000);
  });
});

describe('take initials + runner', () => {
  const now = 10_000_000;
  const base: ExitInput = {
    entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
    staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
    top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45,
    resistance: { hit: false, level: 0, touches: 0 },
    sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015,
  };
  const rules = DEFAULT_CONFIG.exit;
  // After the 1.3x tier: 25% sold at ~1.3x minus fees.
  const afterTier = { ...base, tpTiersHit: [1.3], remainingPct: 75, trailingActive: true, proceedsSol: 0.25 * 1.3 * 0.985 - 0.0015 };
  const runner = { ...afterTier, tpTiersHit: [1.3, INITIALS_MARKER], remainingPct: 40, peakPriceSol: 2.5, priceSol: 2.4, proceedsSol: 1.01 };

  it('sells just enough at 2x so proceeds cover the full cost', () => {
    const d = decideExit({ ...afterTier, priceSol: 2.05, peakPriceSol: 2.05 }, rules);
    expect(d.sells).toHaveLength(1);
    const sell = d.sells[0]!;
    expect(sell.reason).toBe('TAKE_PROFIT');
    expect(sell.detail).toContain('initials out at 2.05x');
    // Realistic fill: price × (1 − 1.25% curve fee − 1.5% slippage) − tx fee.
    const got = afterTier.proceedsSol + (sell.pct / 100) * 2.05 * (1 - 0.0275) - 0.0015;
    expect(got).toBeGreaterThanOrEqual(base.costSol);
    expect(sell.pct).toBeLessThan(40); // didn't dump much more than needed
    expect(d.state.tpTiersHit).toContain(INITIALS_MARKER);
  });
  it('initials really pay back the full cost through the paper fill maths (fees, slippage, impact, tx fee)', () => {
    const paper = DEFAULT_CONFIG.paper;
    /** Run one position through the same quote maths as the paper trader. Returns SOL received − cost. */
    const simulate = (sizeSol: number, pricePath: number[]): number => {
      let sol = 40_000_000_000n;
      let tok = (sol * V_TOK) / V_SOL;
      const k = sol * tok;
      const { tokensOut } = quoteBuy(BigInt(Math.round(sizeSol * 1e9)), sol, tok, paper.curveFeeBps);
      const tokens = (tokensOut * BigInt(Math.round((100 - paper.slippagePct) * 100))) / 10_000n;
      sol += BigInt(Math.round(sizeSol * 1e9 * (1 - paper.curveFeeBps / 10_000)));
      tok = k / sol;
      const entryPriceSol = sizeSol / (Number(tokens) / 1e6);
      const costSol = sizeSol + paper.txFeeSol;
      let state = { ...base, entryPriceSol, peakPriceSol: entryPriceSol, refPriceSol: entryPriceSol, sizeSol, costSol, proceedsSol: 0, txFeeSol: paper.txFeeSol };
      let received = 0;
      for (const multiple of pricePath) {
        // Other buyers push the curve price to `multiple`× our entry (price ∝ sol² / k).
        sol = BigInt(Math.round(Number(sol) * Math.sqrt((multiple * entryPriceSol) / curvePriceSol(sol, tok))));
        tok = k / sol;
        const d = decideExit({ ...state, priceSol: curvePriceSol(sol, tok), peakPriceSol: Math.max(state.peakPriceSol, curvePriceSol(sol, tok)) }, rules);
        for (const sell of d.sells) {
          const amount = (tokens * BigInt(Math.round(sell.pct * 100))) / 10_000n;
          const out = (Number(quoteSell(amount, sol, tok, paper.curveFeeBps).solOutLamports) / 1e9) * (1 - paper.slippagePct / 100) - paper.txFeeSol;
          received += out;
          sol -= BigInt(Math.round(Number(quoteSell(amount, sol, tok, 0).solOutLamports)));
          tok += amount;
          state = { ...state, remainingPct: state.remainingPct - sell.pct };
        }
        state = { ...state, ...d.state, proceedsSol: received };
        if (multiple >= 2) expect(d.state.tpTiersHit).toContain(INITIALS_MARKER);
      }
      return received - costSol;
    };
    for (const size of [0.025, 0.05, 0.1, 0.2]) {
      expect(simulate(size, [2.05])).toBeGreaterThanOrEqual(0); // tier + initials in the same tick
      expect(simulate(size, [1.32, 2.05])).toBeGreaterThanOrEqual(0); // tier first, initials later
    }
  });
  it('initials never repeat', () => {
    expect(decideExit({ ...afterTier, tpTiersHit: [1.3, INITIALS_MARKER], remainingPct: 40, priceSol: 2.3, peakPriceSol: 2.3 }, rules).sells).toEqual([]);
  });
  it('jumping straight to 5x: tiers already cover the cost → marker only, no extra sell', () => {
    const d = decideExit({ ...base, priceSol: 5.2, peakPriceSol: 5.2 }, rules);
    expect(d.sells.map((s) => `${s.reason}:${s.pct}`)).toEqual(['TAKE_PROFIT:25', 'TAKE_PROFIT:15']);
    expect(d.state.tpTiersHit).toContain(INITIALS_MARKER);
  });
  it('runner ignores resistance and risk-rising exits', () => {
    expect(decideExit({ ...runner, resistance: { hit: true, level: 2.5, touches: 3 } }, rules).sells).toEqual([]);
    expect(decideExit({ ...runner, risk: 0.9, riskWhy: 'x' }, rules).sells).toEqual([]);
  });
  it('runner still exits on rug, copy exit and stop loss', () => {
    expect(decideExit({ ...runner, devHoldingPctNow: 0 }, rules).sells[0]!.reason).toBe('RUG_DETECTED');
    expect(decideExit({ ...runner, copyWalletSold: true }, rules).sells[0]!.reason).toBe('COPY_EXIT');
    expect(decideExit({ ...runner, priceSol: 0.5 }, rules).sells[0]!.reason).toBe('STOP_LOSS');
  });
  it('runner trail follows volatility', () => {
    // 2.5x peak, at 2.0x = 20% off the peak
    const at2 = { ...runner, priceSol: 2.0 };
    expect(decideExit({ ...at2, volatilityPct: 4 }, rules).sells.map((s) => s.reason)).toEqual(['TRAILING_STOP']); // 12% trail
    expect(decideExit({ ...at2, volatilityPct: 10 }, rules).sells).toEqual([]); // 30% trail
  });
  it('runner gets twice the max hold', () => {
    expect(decideExit({ ...runner, nowMs: now + 60 * 60_000, lastMoveAtMs: now + 59 * 60_000 }, rules).sells).toEqual([]);
    expect(decideExit({ ...runner, nowMs: now + 91 * 60_000, lastMoveAtMs: now + 90 * 60_000 }, rules).sells[0]!.reason).toBe('TAKE_PROFIT');
  });
  it('runnerTrailPct widens with volatility and is clamped', () => {
    const r = rules.runner;
    expect(runnerTrailPct(1, 3, r)).toBe(12);
    expect(runnerTrailPct(6, 3, r)).toBe(18);
    expect(runnerTrailPct(9, 3, r)).toBeGreaterThan(runnerTrailPct(6, 3, r));
    expect(runnerTrailPct(50, 3, r)).toBe(35);
    expect(runnerTrailPct(null, 3, r)).toBe(25);
  });
  it('caps the trail at 20% after a 10x peak', () => {
    expect(runnerTrailPct(50, 10, rules.runner)).toBe(20);
    expect(decideExit({ ...runner, tpTiersHit: [1.3, INITIALS_MARKER, 5], peakPriceSol: 12, priceSol: 9.5, volatilityPct: 50 }, rules).sells.map((s) => s.reason)).toEqual(['TRAILING_STOP']);
  });
});

describe('computeVolatilityPct', () => {
  const series = (prices: number[], every = 2000) => prices.map((p, i) => ({ t: i * every, buys: 0, sells: 0, holders: 0, priceSol: p }));
  it('needs enough history', () => expect(computeVolatilityPct(series([1, 1.1, 1.2]), 4000)).toBeNull());
  it('a steady climb has ~0 volatility', () => {
    const s = series(Array.from({ length: 10 }, (_, k) => 1.05 ** k), 10_000);
    expect(computeVolatilityPct(s, 90_000)).toBeCloseTo(0, 6);
  });
  it('a choppy chart has higher volatility than a calm one', () => {
    const calm = series(Array.from({ length: 10 }, (_, k) => (k % 2 ? 1.01 : 1)), 10_000);
    const wild = series(Array.from({ length: 10 }, (_, k) => (k % 2 ? 1.2 : 1)), 10_000);
    expect(computeVolatilityPct(wild, 90_000)!).toBeGreaterThan(computeVolatilityPct(calm, 90_000)! * 5);
  });
  it('re-samples 2s ticks into ~10s steps and ignores old samples', () => {
    const s = series(Array.from({ length: 200 }, () => 1)); // 400s of flat price
    expect(computeVolatilityPct(s, 398_000)).toBe(0);
  });
});

describe('computeRisk', () => {
  const s = (t: number, buys: number, sells: number, holders: number, priceSol: number) => ({ t, buys, sells, holders, priceSol });
  it('is low when buyers dominate and price rises', () => {
    expect(computeRisk([s(0, 100, 50, 80, 1), s(90_000, 140, 55, 95, 1.3)], 1.3, 90_000).risk).toBeLessThan(0.1);
  });
  it('is high when sellers dominate, holders leave and price falls', () => {
    expect(computeRisk([s(0, 100, 50, 100, 1.5), s(90_000, 103, 75, 85, 1.1)], 1.6, 90_000).risk).toBeGreaterThan(0.7);
  });
  it('needs enough history', () => expect(computeRisk([s(0, 1, 1, 1, 1)], 1, 1_000).risk).toBe(0));
});


import { Keypair, MessageV0, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { extraFeeLamports } from '../src/evaluator/fee-estimator';

describe('fee estimator', () => {
  it('adds the network fee and Jito tips from a transaction', () => {
    const payer = Keypair.generate().publicKey;
    const tip = new (require('@solana/web3.js').PublicKey)('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
    const msg = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      staticAccountKeys: [payer, tip],
      recentBlockhash: '11111111111111111111111111111111',
      compiledInstructions: [],
      addressTableLookups: [],
    });
    const tx = {
      slot: 1,
      transaction: new VersionedTransaction(msg),
      meta: { fee: 105_000, preBalances: [5_000_000_000, 1_000], postBalances: [4_998_895_000, 1_001_000], err: null, loadedAddresses: { writable: [], readonly: [] } },
    } as unknown as VersionedTransactionResponse;
    expect(extraFeeLamports(tx)).toBe(105_000 + 1_000_000);
  });
});

describe('detectResistance', () => {
  const r = { minTouches: 2, bandPct: 3, rejectPct: 6, windowSec: 300 };
  const series = (prices: number[]) => prices.map((p, i) => ({ t: i * 2000, buys: 0, sells: 0, holders: 0, priceSol: p }));
  it('spots a double top that got rejected', () => {
    const s = series([1, 1.1, 1.2, 1.3, 1.2, 1.15, 1.2, 1.29, 1.3, 1.2, 1.18, 1.17]);
    expect(detectResistance(s, 22_000, r)).toMatchObject({ hit: true, touches: 2 });
  });
  it('a clean uptrend is not resistance', () => {
    const s = series([1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.55]);
    expect(detectResistance(s, 22_000, r).hit).toBe(false);
  });
});
