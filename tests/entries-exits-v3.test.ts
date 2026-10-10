import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { applyMigration, MIGRATIONS } from '../src/config/migrations';
import { STRATEGIES } from '../src/config/strategies';
import type { MarketRaw } from '../src/evaluator/market-analyzer';
import { checkEntryRules, convictionFactor, manipulationCheck } from '../src/evaluator/scorer';
import { rugScreen, type RugScreenInput } from '../src/executor/rug-screen';
import { decideExit, ladderTrailPct, stopLossLevel, trailingStopLevel, type ExitInput } from '../src/executor/sell-manager';
import { buildCalibration, calibrationAdjust } from '../src/learner/score-calibration';
import { computeCrowdMetrics, type CrowdTrade } from '../src/scanner/crowd-tracker';
import { V4_EXIT } from './legacy-exit';

const rules = V4_EXIT;
const now = 50_000_000;
const base: ExitInput = {
  entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
  staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
  top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now, maxHoldMinutes: 45,
  resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015,
};
const trail = (peakX: number, vol: number | null = null) =>
  trailingStopLevel({ entryPriceSol: 1, peakPriceSol: peakX, trailingActive: true, initialsOut: false, volatilityPct: vol, sizeSol: 1, costSol: 1.0015, remainingPct: 100, txFeeSol: 0.0015 }, rules);

describe('dynamic trailing ladder', () => {
  it('tight on small moves, wider on big ones', () => {
    expect(ladderTrailPct(1.15, rules.trail.ladder)).toBe(6);
    expect(ladderTrailPct(1.75, rules.trail.ladder)).toBeCloseTo(10, 5);
    expect(ladderTrailPct(4, rules.trail.ladder)).toBeCloseTo(15.5, 5);
    expect(ladderTrailPct(20, rules.trail.ladder)).toBe(20);
    expect(trail(1.25)!.trailPct).toBeLessThan(trail(3)!.trailPct);
    expect(trail(3)!.trailPct).toBeLessThan(trail(10)!.trailPct);
  });
  it('volatility nudges the ladder value within 0.8–1.15×', () => {
    expect(trail(2, 1)!.trailPct).toBeCloseTo(8.8, 1); // calm → 11 × 0.8
    expect(trail(2, 20)!.trailPct).toBeCloseTo(12.65, 0); // wild → 11 × 1.15
  });
});

describe('break-even stop from 1.2x', () => {
  it('a winner that reached 1.2x can no longer close red', () => {
    const lvl = trail(1.2)!;
    expect(lvl.floorPriceSol).not.toBeNull();
    expect(lvl.stopPriceSol).toBeGreaterThan(1.04);
    // Back to 1.03 after a 1.22x peak → out (gapped below the stop at once).
    const d = decideExit({ ...base, peakPriceSol: 1.22, trailingActive: true, priceSol: 1.0 }, rules);
    expect(d.sells.map((s) => s.reason)).toEqual(['TRAILING_STOP']);
  });
  it('below 1.15x nothing trails; 1.15–1.2x trails 6% without the break-even floor yet', () => {
    const lvl = (peak: number) => trailingStopLevel({ entryPriceSol: 1, peakPriceSol: peak, trailingActive: false, initialsOut: false, volatilityPct: null, sizeSol: 1, costSol: 1, remainingPct: 100, txFeeSol: 0 }, rules);
    expect(lvl(1.1)).toBeNull();
    expect(lvl(1.15)!.trailPct).toBe(6);
    expect(lvl(1.15)!.floorPriceSol).toBeNull();
  });
  it('a spike between checks registers as the peak (live mode) and is sold into at once', () => {
    // Price is back to 1.5x, but a real trade printed 2.0x since the last check.
    const d = decideExit({ ...base, peakPriceSol: 1.3, trailingActive: true, tpTiersHit: [1.3], remainingPct: 75, priceSol: 1.5, instantPeak: true, recentHighSol: 2.0 }, rules);
    expect(d.state.peakPriceSol).toBe(2.0);
    expect(d.sells.map((s) => s.reason)).toContain('TRAILING_STOP');
  });
});

describe('stops per strategy', () => {
  it('migration plays never risk more than 15%', () => {
    expect(stopLossLevel(1, 40, rules, 0, 0, 'MIGRATION_MOMENTUM').hardPct).toBe(15);
    expect(stopLossLevel(1, 40, rules, 0, 0, 'MIGRATION_MOMENTUM').stopPct).toBe(15);
    expect(stopLossLevel(1, 40, rules, 0, 0, 'SOON').hardPct).toBe(20);
    expect(decideExit({ ...base, strategy: 'MIGRATION_MOMENTUM', priceSol: 0.84 }, rules).sells[0]?.reason).toBe('STOP_LOSS');
    expect(decideExit({ ...base, strategy: 'SOON', priceSol: 0.84, volatilityPct: 9 }, rules).sells).toEqual([]);
  });
  it('copy trades: minimum hold ignores the copied wallet selling and wobbles, not the stop', () => {
    const copy = { ...base, strategy: 'SMART_MONEY_COPY', minHoldUntilMs: now + 60_000 };
    expect(decideExit({ ...copy, copyWalletSold: true }, rules).sells).toEqual([]);
    expect(decideExit({ ...copy, copyWalletSold: true, nowMs: now + 61_000 }, rules).sells[0]?.reason).toBe('COPY_EXIT');
    expect(decideExit({ ...copy, priceSol: 0.75 }, rules).sells[0]?.reason).toBe('STOP_LOSS');
  });
});

describe('fake volume, bundles, chasing', () => {
  const NOW = 10_000_000;
  const t = (secAgo: number, w: string, buy: boolean, sol: number, px = 1e-6, slot?: number): CrowdTrade => ({ t: NOW - secAgo * 1000, w, buy, sol, tok: sol / px, px, s: slot });
  it('detects wash trading and same-slot bundles', () => {
    const trades: CrowdTrade[] = [];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) trades.push(t(300 - i * 40 - k * 5, `wash${i}`, k % 2 === 0, 2));
    for (let i = 0; i < 5; i++) trades.push(t(100, `b${i}`, true, 1.0 + i * 0.01, 1e-6, 777));
    for (let i = 0; i < 6; i++) trades.push(t(50 + i, `r${i}`, true, 0.3));
    const m = computeCrowdMetrics(trades.sort((a, b) => a.t - b.t), NOW, { fullAttentionWallets: 50 });
    expect(m.fakeVolumePct).toBeGreaterThan(60);
    expect(m.bundledBuyPct).toBeGreaterThan(20);
    expect(manipulationCheck(m, DEFAULT_CONFIG.entry.manipulation).fails.join()).toContain('fake volume');
    // Bundles alone: 5 wallets, same slot, same size.
    const bundles = [...Array.from({ length: 5 }, (_, i) => t(100, `b${i}`, true, 1.0 + i * 0.01, 1e-6, 777)), ...Array.from({ length: 6 }, (_, i) => t(50 + i, `r${i}`, true, 0.3))];
    const mb = computeCrowdMetrics(bundles.sort((a, b2) => a.t - b2.t), NOW, { fullAttentionWallets: 50 });
    expect(mb.bundledBuyPct).toBeGreaterThan(60);
    expect(manipulationCheck(mb, DEFAULT_CONFIG.entry.manipulation).fails.join()).toContain('bundled buys');
    // Same sizes in DIFFERENT slots are not a bundle.
    const spread = Array.from({ length: 11 }, (_, i) => t(100 - i * 5, `s${i}`, true, 1.0, 1e-6, 1000 + i));
    expect(computeCrowdMetrics(spread, NOW, { fullAttentionWallets: 50 }).bundledBuyPct).toBe(0);
  });
  it('penalises a vertical candle', () => {
    const chk = manipulationCheck({ trades5m: 30, fakeVolumePct: 0, bundledBuyPct: 0, top3VolumePct: 20, dustTradePct: 0, priceChange3mPct: 70 }, DEFAULT_CONFIG.entry.manipulation);
    expect(chk.fails).toEqual([]);
    expect(chk.penalty).toBe(8);
    expect(chk.notes[0]).toContain('chasing');
  });
  it('organic volume (minus fake) must meet the minimum; coins under 15s are never bought', () => {
    const m: MarketRaw = {
      ageSec: 300, holders: 80, uniqueWallets: 100, buys: 200, sells: 50, buySellRatio: 4, volumeSol: 100, liquiditySol: 20, bondingCurvePct: 40,
      curveVelocity: 5, priceSol: 1e-7, marketCapSol: 100, devHoldingPct: 2, devSoldFraction: 0, top10HolderPct: 20, earlyBuyerPct: 2, maxHolderPct: 4,
      volumeSpikeRatio: 1, retention: 0.8, complete: false, onAmm: false, totalFeesSol: 2, volumeUsd: 15_000, marketCapUsd: 15_000, liquidityUsd: 3000,
    };
    const run = (mm: MarketRaw, crowd: { activeWallets5m: number; fakeVolumePct?: number; trades5m?: number } | null) =>
      checkEntryRules({ safetyScore: 90, safetyHardFail: false, market: mm, strategy: STRATEGIES.CURVE_SNIPE, entry: DEFAULT_CONFIG.entry, crowd });
    expect(run(m, { activeWallets5m: 40, fakeVolumePct: 10, trades5m: 50 })).toEqual([]);
    expect(run(m, { activeWallets5m: 40, fakeVolumePct: 40, trades5m: 50 }).join()).toContain('organic volume $9000 < $12000');
    expect(run({ ...m, ageSec: 8 }, null).join()).toContain('too young');
  });
});

describe('score calibration', () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => ({ strategy: 'SOON', score: 87, win: i < 4 })), // 85-90: 10%
    ...Array.from({ length: 40 }, (_, i) => ({ strategy: 'SOON', score: 76, win: i < 16 })), // 75-80: 40%
  ];
  const cal = buildCalibration(rows);
  it('marks down a high band that keeps losing, rewards one that wins', () => {
    const hi = calibrationAdjust(cal, 'SOON', 88);
    expect(hi.points).toBeLessThan(0);
    expect(hi.factor).toBeLessThan(1);
    expect(hi.note).toContain('85–90 won 10%');
    expect(calibrationAdjust(cal, 'SOON', 77).points).toBeGreaterThan(0);
    expect(calibrationAdjust(cal, 'MIGRATION_MOMENTUM', 88).points).toBe(0); // no data
  });
});

describe('conviction sizing', () => {
  it('scales with the margin over the bar, the band record and the crowd', () => {
    const lo = convictionFactor({ scoreMargin: 0, calibrationFactor: 1, crowdScore: 0.5, min: 0.4, max: 1.6 });
    const hi = convictionFactor({ scoreMargin: 20, calibrationFactor: 1.2, crowdScore: 0.9, min: 0.4, max: 1.6 });
    expect(lo.factor).toBeLessThan(0.7);
    expect(hi.factor).toBe(1.6);
    expect(hi.note).toContain('conviction');
  });
});

describe('pre-entry rug screen', () => {
  const snap = { devHoldingPct: 3, devSoldFraction: 0, earlyBuyerPct: 6, top10HolderPct: 20, liquiditySol: 40, priceSol: 1 };
  const ok: RugScreenInput = { atSignal: snap, now: snap, onAmm: true, flow60s: { buySol: 5, sellSol: 3, biggestSellSol: 1, highPx: 1.02, lastPx: 1 }, insider: null, maxDevHoldingPct: 10 };
  it('passes a clean coin and blocks the rug signs', () => {
    expect(rugScreen(ok)).toBeNull();
    expect(rugScreen({ ...ok, now: { ...snap, devSoldFraction: 0.3 } })).toContain('dev started selling');
    expect(rugScreen({ ...ok, now: { ...snap, earlyBuyerPct: 3 } })).toContain('bundlers dumping');
    expect(rugScreen({ ...ok, now: { ...snap, liquiditySol: 20 } })).toContain('liquidity dropped');
    expect(rugScreen({ ...ok, flow60s: { buySol: 1, sellSol: 6, biggestSellSol: 2, highPx: 1.2, lastPx: 1 } })).toContain('dumping right now');
    expect(rugScreen({ ...ok, flow60s: { buySol: 9, sellSol: 7, biggestSellSol: 8, highPx: 1, lastPx: 1 } })).toContain('whale just sold');
    expect(rugScreen({ ...ok, insider: { dumping: true, reason: 'cluster sold 40%' } })).toContain('insiders dumping');
    expect(rugScreen({ ...ok, now: { ...snap, priceSol: 0.8 } })).toContain('down 20% since the signal');
  });
});

describe('saved-settings migrations', () => {
  it('changes only the listed settings in saved sections, keeps the owner edits', () => {
    const saved = {
      exit: { trailingStopActivateMultiple: 1.25, trail: { breakEvenAfterMultiple: 1.5, confirmTicks: 3 }, hardStopLossPct: 40 },
      trading: { maxPositionSol: 0.5, allocation: { SMART_MONEY_COPY: 0.25, MIGRATION_MOMENTUM: 0.6 } },
    };
    const out = applyMigration(saved, MIGRATIONS[0]!) as typeof saved;
    expect(out.exit.trail.breakEvenAfterMultiple).toBe(1.2);
    expect(out.exit.trail.confirmTicks).toBe(3);
    expect(out.exit.trailingStopActivateMultiple).toBe(1.2);
    expect(out.trading.allocation.SMART_MONEY_COPY).toBe(0.05);
    expect(out.trading.maxPositionSol).toBe(0.5);
    expect(Object.keys(out)).not.toContain('copy'); // never saved → defaults apply anyway
    expect(saved.exit.trail.breakEvenAfterMultiple).toBe(1.5); // input untouched
  });
});
