import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../src/config/default';
import { STRATEGIES } from '../src/config/strategies';
import { marketFeatures, type MarketRaw } from '../src/evaluator/market-analyzer';
import { checkEntryRules, decide, scoreFeatures } from '../src/evaluator/scorer';
import { walletFeatures, type CreatorProfile } from '../src/evaluator/wallet-analyzer';
import { decideExit, type ExitInput } from '../src/executor/sell-manager';
import { quoteBuy, quoteSell } from '../src/lib/pumpfun';

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
  devHoldingPct: 2, devSoldFraction: 0, top10HolderPct: 14, earlyBuyerPct: 1, retention: 0.875, complete: false,
  totalFeesSol: 1.2, volumeUsd: 15_000, marketCapUsd: 13_000,
};
const goodWallet: CreatorProfile = { creator: 'c', balanceSol: 3, walletAgeHours: 24 * 60, veryActive: false, funder: 'f', funderBlacklisted: false, funderCreatorCount: 1, launches24h: 0, priorLaunches: 0, priorCompleted: 0 };

describe('scoring', () => {
  it('a strong token scores above the 75 threshold', () => {
    const { score } = scoreFeatures({ safety: 1, ...marketFeatures(goodMarket), ...walletFeatures(goodWallet) }, DEFAULT_WEIGHTS);
    expect(score).toBeGreaterThan(75);
  });
  it('a serial launcher with a sniped, concentrated token scores low', () => {
    const bad = { ...goodMarket, top10HolderPct: 55, earlyBuyerPct: 25, buySellRatio: 1, devSoldFraction: 1, curveVelocity: 0.2 };
    const { score } = scoreFeatures({ safety: 1, ...marketFeatures(bad), ...walletFeatures({ ...goodWallet, launches24h: 15, funderCreatorCount: 6 }) }, DEFAULT_WEIGHTS);
    expect(score).toBeLessThan(50);
  });
  it('contributions add up to the score', () => {
    const r = scoreFeatures({ safety: 1, ...marketFeatures(goodMarket), ...walletFeatures(goodWallet) }, DEFAULT_WEIGHTS);
    expect(Object.values(r.contributions).reduce((a, b) => a + b, 0)).toBeCloseTo(r.score, 0);
  });
  it('default weights sum to 1', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe('entry rules', () => {
  const base = { safetyScore: 100, safetyHardFail: false, market: goodMarket, strategy: STRATEGIES.CURVE_SNIPE, entry: DEFAULT_CONFIG.entry };
  it('passes a good token', () => expect(checkEntryRules(base)).toEqual([]));
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
    staleMinutes: 30, priceSol: 1, complete: false, devHoldingPctEntry: 3, devHoldingPctNow: 3, top10PctEntry: 15, top10PctNow: 15, nowMs: now,
  };
  const rules = DEFAULT_CONFIG.exit;
  const reasons = (i: Partial<ExitInput>) => decideExit({ ...base, ...i }, rules).sells.map((s) => `${s.reason}:${s.pct}`);

  it('holds when nothing happens', () => expect(reasons({})).toEqual([]));
  it('stop loss at -40%', () => expect(reasons({ priceSol: 0.59 })).toEqual(['STOP_LOSS:100']));
  it('take profit 30% at 2x, activates trailing', () => {
    const d = decideExit({ ...base, priceSol: 2.1 }, rules);
    expect(d.sells.map((s) => `${s.reason}:${s.pct}`)).toEqual(['TAKE_PROFIT:30']);
    expect(d.state.trailingActive).toBe(true);
  });
  it('both tiers fire on a jump straight to 5x', () => expect(reasons({ priceSol: 5.5 })).toEqual(['TAKE_PROFIT:30', 'TAKE_PROFIT:30']));
  it('does not re-fire a tier', () => expect(reasons({ priceSol: 2.5, tpTiersHit: [2], remainingPct: 70, trailingActive: true, peakPriceSol: 2.5 })).toEqual([]));
  it('trailing stop sells the rest 30% below peak', () =>
    expect(reasons({ priceSol: 2.7, peakPriceSol: 4, tpTiersHit: [2], remainingPct: 70, trailingActive: true })).toEqual(['TRAILING_STOP:70']));
  it('rug: dev dumps', () => expect(reasons({ devHoldingPctNow: 1 })).toEqual(['RUG_DETECTED:100']));
  it('rug: concentration spike while underwater', () => expect(reasons({ top10PctNow: 31, priceSol: 0.9 })).toEqual(['RUG_DETECTED:100']));
  it('whales concentrating a pump is not a rug', () => expect(reasons({ top10PctNow: 40, priceSol: 1.5 })).toEqual([]));
  it('migration exits', () => expect(reasons({ complete: true, priceSol: 3 })).toEqual(['MIGRATED:100']));
  it('stale after 30 flat minutes', () => expect(reasons({ priceSol: 1.02, nowMs: now + 31 * 60_000 })).toEqual(['STALE:100']));
  it('a real move resets the stale clock', () => {
    const d = decideExit({ ...base, priceSol: 1.2, nowMs: now + 31 * 60_000 }, rules);
    expect(d.sells).toEqual([]);
    expect(d.state.lastMoveAtMs).toBe(now + 31 * 60_000);
  });
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
