import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { holderGrowth, holderGrowthVerdict, type HolderGrowthState } from '../src/executor/holder-growth';
import { decideExit, HOLDER_GROWTH_MARKER, trailingStopLevel, type ExitInput } from '../src/executor/sell-manager';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const HG = DEFAULT_CONFIG.exit.holderGrowth;
const ct = (w: string, buy: boolean, sol: number, t: number): CrowdTrade => ({ t, w, buy, sol, tok: sol * 1e6, px: 1e-6, pp: 1e-6 });
const OPEN = 1_800_000_000_000;

/** 30 new wallets arrive 2 s apart after our entry, then nobody new; old wallets sell from +90 s. */
function synthetic(sellers: boolean): CrowdTrade[] {
  const out: CrowdTrade[] = [];
  for (let i = 0; i < 30; i++) out.push(ct(`n${i}`, true, 0.5, OPEN + i * 2_000));
  for (let i = 0; i < 40; i++) out.push(sellers ? ct(`n${i % 30}`, false, 0.6, OPEN + 90_000 + i * 2_500) : ct(`n${i % 30}`, true, 0.2, OPEN + 90_000 + i * 2_500));
  return out;
}

describe('holder growth: the arrival rate of new buyers', () => {
  it('measures the rate and its settled peak since entry', () => {
    const s = holderGrowth(synthetic(true), OPEN, OPEN + 60_000, null, HG);
    expect(s.peakNewBuyersPerMin).toBeGreaterThanOrEqual(20);
    expect(s.newBuyersPerMin).toBeGreaterThanOrEqual(20);
    expect(s.belowSinceMs).toBeNull();
  });
  it('collapse is tracked from its first observation (prev state carries "below since")', () => {
    const trades = synthetic(true);
    const s1 = holderGrowth(trades, OPEN, OPEN + 150_000, null, HG);
    expect(s1.newBuyersPerMin).toBe(0);
    expect(s1.belowSinceMs).toBe(OPEN + 150_000);
    expect(s1.sellerSharePct60).toBe(100);
    const s2 = holderGrowth(trades, OPEN, OPEN + 200_000, s1, HG);
    expect(s2.belowSinceMs).toBe(OPEN + 150_000);
    expect(s2.peakNewBuyersPerMin).toBe(s1.peakNewBuyersPerMin);
  });
  it('verdict: collapse + sellers in profit → sell once; no sellers / under minMultiple / already sold → nothing', () => {
    const trades = synthetic(true);
    const s1 = holderGrowth(trades, OPEN, OPEN + 150_000, null, HG);
    const s2 = holderGrowth(trades, OPEN, OPEN + 200_000, s1, HG);
    expect(holderGrowthVerdict(s2, OPEN + 200_000, 1.3, false, HG).action).toBe('sell');
    expect(holderGrowthVerdict(s1, OPEN + 150_000, 1.3, false, HG).action).toBe('none'); // not yet held 45 s
    expect(holderGrowthVerdict(s2, OPEN + 200_000, 1.05, false, HG).action).toBe('none');
    expect(holderGrowthVerdict(s2, OPEN + 200_000, 1.3, true, HG).action).toBe('none');
    expect(holderGrowthVerdict(s2, OPEN + 200_000, 1.3, false, { ...HG, enabled: false }).action).toBe('none');
    const calm = synthetic(false);
    const c1 = holderGrowth(calm, OPEN, OPEN + 150_000, null, HG);
    const c2 = holderGrowth(calm, OPEN, OPEN + 200_000, c1, HG);
    expect(c2.belowSinceMs).not.toBeNull();
    expect(holderGrowthVerdict(c2, OPEN + 200_000, 1.3, false, HG).action).toBe('none'); // buyers, no sellers
    expect(holderGrowthVerdict({ newBuyersPerMin: 0, peakNewBuyersPerMin: 2, peakAtMs: OPEN, belowSinceMs: OPEN, sellerSharePct60: 90 }, OPEN + 500_000, 2, false, HG).action).toBe('none'); // too few to judge
  });
  it('decideExit: sells 50% once, marks it, tightens the trail; the virtual-book path uses the same state', () => {
    const now = OPEN + 200_000;
    const state: HolderGrowthState = { newBuyersPerMin: 1, peakNewBuyersPerMin: 25, peakAtMs: OPEN + 30_000, belowSinceMs: now - 60_000, sellerSharePct60: 70 };
    const base: ExitInput = {
      entryPriceSol: 1e-7, peakPriceSol: 1.3e-7, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1e-7, lastMoveAtMs: now - 1000, staleMinutes: 60,
      priceSol: 1.3e-7, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0, top10PctEntry: 0, top10PctNow: 0, nowMs: now,
      copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: OPEN, maxHoldMinutes: 240, resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 0.2, costSol: 0.2011,
      proceedsSol: 0, volatilityPct: 5, txFeeSol: 0.002, priceTrusted: true, instantPeak: true, recentHighSol: 1.3e-7, strategy: 'MIGRATION_MOMENTUM', peakAtMs: now - 1000,
      holderGrowth: state,
    };
    const rules = { ...DEFAULT_CONFIG.exit, takeProfitTiers: [{ multiple: 5, sellPct: 40 }], spikeSell: { ...DEFAULT_CONFIG.exit.spikeSell, enabled: false } } as unknown as Parameters<typeof decideExit>[1];
    const d = decideExit(base, rules);
    const g = d.sells.find((s) => s.detail.startsWith('holder growth'));
    expect(g?.pct).toBe(50);
    expect(g?.reason).toBe('TAKE_PROFIT');
    expect(d.state.tpTiersHit).toContain(HOLDER_GROWTH_MARKER);
    const again = decideExit({ ...base, tpTiersHit: d.state.tpTiersHit, remainingPct: 50 }, rules);
    expect(again.sells.find((s) => s.detail.startsWith('holder growth'))).toBeUndefined();
    // the trail is tighter once the marker is set
    const lvl = (f: number) => trailingStopLevel({ entryPriceSol: 1e-7, peakPriceSol: 2e-7, trailingActive: true, initialsOut: false, volatilityPct: 5, sizeSol: 0.2, costSol: 0.2011, remainingPct: 50, txFeeSol: 0.002, trailFactor: f }, rules)!;
    expect(lvl(HG.tightenTrailFactor).stopPriceSol).toBeGreaterThan(lvl(1).stopPriceSol);
    // off → no sale
    const off = decideExit(base, { ...(rules as object), holderGrowth: { ...HG, enabled: false } } as typeof rules);
    expect(off.sells.find((s) => s.detail.startsWith('holder growth'))).toBeUndefined();
  });
});
