import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { deepMerge } from '../src/config/runtime-config';
import { STRATEGIES } from '../src/config/strategies';
import type { MarketRaw } from '../src/evaluator/market-analyzer';
import { checkEntryRules, strategyMinimums } from '../src/evaluator/scorer';
import { decideExit, stopLossLevel, type ExitInput } from '../src/executor/sell-manager';
import { classifyTrade, computeCoachState, type TradeReview } from '../src/learner/trade-coach';
import { shrunk } from '../src/learner/wallet-reputation';
import { computeCrowdMetrics, swingSignal, type CrowdTrade } from '../src/scanner/crowd-tracker';
import { V4_EXIT } from './legacy-exit';

const NOW = 10_000_000;
const t = (secAgo: number, w: string, buy: boolean, sol: number, px = 1e-6): CrowdTrade => ({ t: NOW - secAgo * 1000, w, buy, sol, tok: sol / px, px });

describe('crowd metrics', () => {
  it('counts active wallets in the last 5 minutes as eyes on the coin', () => {
    const trades = Array.from({ length: 60 }, (_, i) => t(250 - i * 4, `w${i}`, true, 0.3));
    trades.push(t(400, 'old', true, 0.3)); // outside 5m
    const m = computeCrowdMetrics(trades.sort((a, b) => a.t - b.t), NOW, { fullAttentionWallets: 50 });
    expect(m.activeWallets5m).toBe(60);
    expect(m.attentionScore).toBe(1);
    expect(m.summary).toContain('60 active wallets');
  });

  it('flags paper hands and bot churn', () => {
    const trades: CrowdTrade[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(t(200 - i * 10, `p${i}`, true, 0.5));
      trades.push(t(190 - i * 10, `p${i}`, false, 0.5)); // dumped within 10s
    }
    for (let i = 0; i < 6; i++) trades.push(t(100 - i, 'bot', i % 2 === 0, 1)); // flipping
    const m = computeCrowdMetrics(trades.sort((a, b) => a.t - b.t), NOW, { fullAttentionWallets: 50 });
    expect(m.paperHandsPct).toBe(100);
    expect(m.churnPct).toBeGreaterThan(20);
    expect(m.crowdScore).toBeLessThan(0.5);
  });

  it('rewards dip buyers and holders', () => {
    const trades: CrowdTrade[] = [];
    for (let i = 0; i < 20; i++) trades.push(t(280 - i * 5, `h${i}`, true, 0.4, 1e-6 * (1 + i * 0.01))); // run up
    for (let i = 0; i < 15; i++) trades.push(t(150 - i * 5, `d${i}`, true, 0.6, 0.85e-6)); // buying the dip
    trades.push(t(140, 'seller', false, 0.3, 0.85e-6));
    const m = computeCrowdMetrics(trades.sort((a, b) => a.t - b.t), NOW, { fullAttentionWallets: 50 });
    expect(m.dipBuyRatio).toBeGreaterThan(0.8);
    expect(m.crowdScore).toBeGreaterThan(0.6);
  });

  it('not enough data → neutral', () => {
    expect(computeCrowdMetrics([t(10, 'a', true, 1)], NOW, { fullAttentionWallets: 50 }).crowdScore).toBe(0.5);
  });
});

describe('swing signal', () => {
  const c = DEFAULT_CONFIG.focus.swing;
  const path = (pxs: number[], buyerFlow = true) =>
    pxs.map((px, i) => ({ t: NOW - (pxs.length - i) * 20_000, w: `w${i}`, buy: buyerFlow ? i % 4 !== 0 : i % 4 === 0, sol: 0.5, tok: 0.5 / px, px }));
  it('buys a 25% pullback that bounces with buyers in control', () => {
    const pxs = [...Array.from({ length: 10 }, (_, i) => 1 + i * 0.1), ...Array.from({ length: 10 }, (_, i) => 1.9 - i * 0.05), 1.45, 1.5, 1.52, 1.55, 1.56];
    const s = swingSignal(path(pxs), NOW, c);
    expect(s.ok).toBe(true);
    expect(s.why).toContain('pulled back');
  });
  it('skips a dump (> maxPullback) and a coin still falling', () => {
    const dump = [...Array.from({ length: 10 }, (_, i) => 1 + i * 0.1), ...Array.from({ length: 10 }, (_, i) => 1.9 - i * 0.12), 0.8, 0.82, 0.84];
    expect(swingSignal(path(dump), NOW, c).ok).toBe(false);
    const falling = [...Array.from({ length: 10 }, (_, i) => 1 + i * 0.1), ...Array.from({ length: 12 }, (_, i) => 1.9 - i * 0.04)];
    expect(swingSignal(path(falling), NOW, c).ok).toBe(false);
  });
  it('skips when sellers are in control', () => {
    const pxs = [...Array.from({ length: 10 }, (_, i) => 1 + i * 0.1), ...Array.from({ length: 10 }, (_, i) => 1.9 - i * 0.05), 1.45, 1.5, 1.52, 1.55, 1.56];
    expect(swingSignal(path(pxs, false), NOW, c).ok).toBe(false);
  });
});

const market: MarketRaw = {
  ageSec: 3600, holders: 300, uniqueWallets: 500, buys: 2000, sells: 1500, buySellRatio: 1.3, volumeSol: 600,
  liquiditySol: 60, bondingCurvePct: 100, curveVelocity: 2, priceSol: 4e-7, marketCapSol: 400,
  devHoldingPct: 0, devSoldFraction: 1, top10HolderPct: 25, earlyBuyerPct: 2, maxHolderPct: 4, volumeSpikeRatio: 1, retention: 0.6, complete: true, onAmm: true,
  totalFeesSol: 12, volumeUsd: 90_000, marketCapUsd: 60_000, liquidityUsd: 18_000,
};
const entry = { ...DEFAULT_CONFIG.entry, maxDevSoldFraction: 1 };
const rulesFor = (m: MarketRaw, strategy: keyof typeof STRATEGIES, crowd: { activeWallets5m: number } | null = { activeWallets5m: 60 }) =>
  checkEntryRules({ safetyScore: 90, safetyHardFail: false, market: m, strategy: STRATEGIES[strategy], entry, focus: DEFAULT_CONFIG.focus, crowd });

describe('focus entry rules', () => {
  it('migrated coins need 9 SOL fees, $25k MC, $2k liquidity and active wallets', () => {
    expect(rulesFor(market, 'MIGRATION_MOMENTUM')).toEqual([]);
    expect(rulesFor({ ...market, totalFeesSol: 8 }, 'MIGRATION_MOMENTUM').join()).toContain('fees 8.00 SOL < 9');
    expect(rulesFor({ ...market, marketCapUsd: 24_000 }, 'MIGRATION_MOMENTUM').join()).toContain('MC $24000 < $25000');
    expect(rulesFor({ ...market, liquidityUsd: 1500 }, 'MIGRATION_MOMENTUM').join()).toContain('liquidity $1500 < $2000');
    expect(rulesFor(market, 'MIGRATION_MOMENTUM', { activeWallets5m: 5 }).join()).toContain('only 5 active wallets');
  });
  it('Soon coins: curve 70%+, not complete', () => {
    const soon = { ...market, complete: false, onAmm: false, bondingCurvePct: 82, totalFeesSol: 4, marketCapUsd: 30_000, volumeUsd: 40_000 };
    expect(rulesFor(soon, 'SOON')).toEqual([]);
    expect(rulesFor({ ...soon, bondingCurvePct: 60 }, 'SOON').join()).toContain('curve 60.0% outside 70-90%');
    // v5: the last stretch before graduation (where holders dump into it) is skipped.
    expect(rulesFor({ ...soon, bondingCurvePct: 94 }, 'SOON').join()).toContain('curve 94.0% outside 70-90%');
    expect(rulesFor({ ...soon, complete: true }, 'SOON').join()).toContain('curve already complete');
  });
  it('new pairs (curve snipes) use their own zone instead of the $12k minimums', () => {
    const m = strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'CURVE_SNIPE');
    const np = DEFAULT_CONFIG.focus.newPair;
    expect(m.minTotalFeesSol).toBe(np.minTotalFeesSol);
    expect(m.minMarketCapUsd).toBe(np.minMarketCapUsd);
    expect(m.maxMarketCapUsd).toBe(15_000);
    expect(m.ageSec).toEqual({ min: 45, max: 720 });
    expect(m.minActiveWallets5m).toBe(0);
    // Other strategies keep their minimums (no max market cap).
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'SOON').maxMarketCapUsd).toBeNull();
  });
});

describe('stop loss 10–20%', () => {
  const rules = V4_EXIT;
  it('stays inside the band whatever the volatility', () => {
    expect(stopLossLevel(1, 1, rules).stopPct).toBe(10);
    expect(stopLossLevel(1, 7, rules).stopPct).toBe(14);
    expect(stopLossLevel(1, 40, rules).stopPct).toBe(20);
    expect(stopLossLevel(1, null, rules).stopPct).toBe(15);
    expect(stopLossLevel(1, 9.5, rules, 5).stopPct).toBe(20);
    // An old saved config with a 40% hard stop is still capped at 20%.
    expect(stopLossLevel(1, 40, { ...rules, hardStopLossPct: 40 }).hardPct).toBe(20);
  });
  const now = 50_000_000;
  const base: ExitInput = {
    entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
    staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
    top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45,
    resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: 5, txFeeSol: 0.0015,
  };
  it('a dip to −11% with a 10% stop needs confirmation; −21% sells at once', () => {
    const first = decideExit({ ...base, priceSol: 0.89 }, rules);
    expect(first.sells).toEqual([]);
    expect(first.state.breachTicks).toBe(1);
    const confirmed = decideExit({ ...base, priceSol: 0.89, breachTicks: 1, breachSinceMs: now - 4000 }, rules);
    expect(confirmed.sells[0]?.reason).toBe('STOP_LOSS');
    expect(decideExit({ ...base, priceSol: 0.79 }, rules).sells[0]?.detail).toContain('hard limit −20%');
  });
  it('a −8% dip never triggers the stop', () => {
    expect(decideExit({ ...base, priceSol: 0.92 }, rules).sells).toEqual([]);
  });
});

describe('trade coach', () => {
  it('classifies what went wrong', () => {
    expect(classifyTrade({ pnlSol: -0.02, peakMultiple: 1.01, exitMultiple: 0.85, postHighMultiple: 0.9, postLowMultiple: 0.6, exitReason: 'STOP_LOSS' }).verdict).toBe('late_entry');
    expect(classifyTrade({ pnlSol: -0.02, peakMultiple: 1.1, exitMultiple: 0.85, postHighMultiple: 1.6, postLowMultiple: 0.8, exitReason: 'STOP_LOSS' }).verdict).toBe('stopped_then_ran');
    expect(classifyTrade({ pnlSol: -0.01, peakMultiple: 1.45, exitMultiple: 0.95, postHighMultiple: 1, postLowMultiple: 0.9, exitReason: 'TRAILING_STOP' }).verdict).toBe('gave_back_profit');
    expect(classifyTrade({ pnlSol: 0.05, peakMultiple: 1.4, exitMultiple: 1.3, postHighMultiple: 2.5, postLowMultiple: 1.1, exitReason: 'TAKE_PROFIT' }).verdict).toBe('sold_too_early');
    expect(classifyTrade({ pnlSol: 0.05, peakMultiple: 1.4, exitMultiple: 1.3, postHighMultiple: 1.35, postLowMultiple: 0.9, exitReason: 'TAKE_PROFIT' }).verdict).toBe('good_exit');
  });
  const review = (i: number, win: boolean, verdict: TradeReview['verdict']): TradeReview => ({
    positionId: `p${i}`, mint: 'm', symbol: 'S', strategy: 'SOON', swing: false, pnlSol: win ? 0.05 : -0.03, pnlPct: win ? 25 : -15,
    peakMultiple: 1.2, lowMultiple: 0.85, exitMultiple: win ? 1.25 : 0.85, postHighMultiple: 1, postLowMultiple: 0.8, heldMin: 10, exitReason: 'STOP_LOSS',
    verdict, lesson: '', at: new Date(NOW - i * 60_000).toISOString(),
  });
  it('a losing streak of late entries → pickier, smaller size', () => {
    const list = [0, 1, 2, 3].map((i) => review(i, false, 'late_entry')).concat([4, 5].map((i) => review(i, true, 'good_exit')));
    const st = computeCoachState('SOON', list);
    expect(st.lossStreak).toBe(4);
    expect(st.sizeFactor).toBe(0.5);
    expect(st.thresholdDelta).toBeGreaterThan(4);
    expect(st.note).toContain('losses in a row');
  });
  it('stops hit right before runs → wider stop; few trades → no change', () => {
    const list = [0, 1, 2, 3].map((i) => review(i, false, 'stopped_then_ran')).concat([4, 5, 6].map((i) => review(i, true, 'good_exit')));
    expect(computeCoachState('SOON', list).stopBiasPct).toBe(3);
    expect(computeCoachState('SOON', list.slice(0, 2)).thresholdDelta).toBe(0);
    expect(computeCoachState('MIGRATION_MOMENTUM', list).trades).toBe(0);
  });
});

describe('config + learning helpers', () => {
  it('deep merge keeps stored values and adds new nested defaults (e.g. a new strategy)', () => {
    const merged = deepMerge(DEFAULT_CONFIG.trading, { allocation: { MIGRATION_MOMENTUM: 0.6, CURVE_SNIPE: 0.15, SMART_MONEY_COPY: 0.25 }, maxPositionSol: 0.25 }) as typeof DEFAULT_CONFIG.trading;
    expect(merged.allocation.SOON).toBe(DEFAULT_CONFIG.trading.allocation.SOON);
    expect(merged.allocation.MIGRATION_MOMENTUM).toBe(0.6);
    expect(merged.maxPositionSol).toBe(0.25);
    expect(merged.enabledStrategies.SOON).toBe(true);
  });
  it('wallet win rates are shrunk toward the base rate', () => {
    expect(shrunk(1, 1, 0.1)).toBeCloseTo(0.28, 2);
    expect(shrunk(20, 25, 0.1)).toBeGreaterThan(0.7);
  });
});
