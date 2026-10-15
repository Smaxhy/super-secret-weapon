import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { OWNER_COPY_WALLETS, OWNER_PICKS, TOP_PICK_WEIGHT } from '../src/config/kol-wallets';
import { decideExit, mirrorSellReason, type ExitInput } from '../src/executor/sell-manager';
import { isValidPubkey } from '../src/lib/pumpfun';
import { effectiveKols } from '../src/scanner/kol-signal';

const NOW = 1_760_000_000_000;

describe("owner's wallet picks (v10.25)", () => {
  it('are all real Solana addresses (the 0x… EVM ones were left out)', () => {
    for (const p of OWNER_PICKS) expect(isValidPubkey(p.address)).toBe(true);
    for (const a of OWNER_COPY_WALLETS) expect(isValidPubkey(a)).toBe(true);
    expect(OWNER_PICKS.filter((p) => p.top)).toHaveLength(5);
  });
  it('a trusted (top pick) wallet counts as two KOLs, so one trusted buy starts a KOL-follow check', () => {
    const tw = DEFAULT_CONFIG.kol.trustedMinWeight;
    expect(TOP_PICK_WEIGHT).toBeGreaterThanOrEqual(tw);
    expect(effectiveKols([{ weight: TOP_PICK_WEIGHT }], tw)).toBe(2);
    expect(effectiveKols([{ weight: TOP_PICK_WEIGHT }], tw)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.kol.follow.minKols);
    expect(effectiveKols([{ weight: 1 }], tw)).toBe(1);
    expect(effectiveKols([{ weight: 1 }, { weight: 0.6 }, { weight: 1.5 }], tw)).toBe(4);
  });
  it("copies are never blind (owner: \"don't blindly copy KOLs\"): normal bar + size, and they wait for a good entry", () => {
    const c = DEFAULT_CONFIG.copy;
    expect(c.scoreThresholdDelta).toBe(0);
    expect(c.sizeMultiplier).toBe(1);
    expect(c.skipDipWait || c.skipConfirm).toBe(false);
    expect(c.mirrorSells).toBe(true);
  });
  it('KOLs buying only triggers a check: no easier bar, no bigger size', () => {
    const f = DEFAULT_CONFIG.kol.follow;
    expect([f.barDelta2, f.barDelta3]).toEqual([0, 0]);
    expect([f.sizeMultiplier2, f.sizeMultiplier3]).toEqual([1, 1]);
  });
});

describe('mirror sell: he sells → we sell instantly', () => {
  const opened = NOW - 60_000;
  const sold = (t: number) => JSON.stringify({ wallet: 'w', name: 'Copy 1', t });
  it('only a sell AFTER our buy counts', () => {
    expect(mirrorSellReason(sold(NOW), opened)).toMatch(/Copy 1 sold/);
    expect(mirrorSellReason(sold(opened - 1000), opened)).toBeNull();
    expect(mirrorSellReason(null, opened)).toBeNull();
    expect(mirrorSellReason('garbage', opened)).toBeNull();
  });
  it('sells everything, before the stop / min-hold / take-profit logic', () => {
    const base: ExitInput = {
      entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: NOW,
      staleMinutes: 120, priceSol: 0.97, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0,
      top10PctEntry: 0, top10PctNow: 0, nowMs: NOW, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: opened, maxHoldMinutes: 720,
      resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015, strategy: 'MIGRATION_MOMENTUM',
      minHoldUntilMs: NOW + 300_000,
    };
    const ex = DEFAULT_CONFIG.exit;
    expect(decideExit(base, ex).sells).toEqual([]);
    const why = mirrorSellReason(sold(NOW), opened);
    expect(decideExit({ ...base, mirrorSell: why }, ex).sells).toEqual([{ pct: 100, reason: 'COPY_EXIT', detail: why }]);
    // In profit too — he sells, we sell.
    expect(decideExit({ ...base, priceSol: 1.3, peakPriceSol: 1.3, mirrorSell: why }, ex).sells[0]).toMatchObject({ pct: 100, reason: 'COPY_EXIT' });
  });
});

describe('fee-aware take-profits (real sell fee 0.006 SOL per sale)', () => {
  const ex = DEFAULT_CONFIG.exit;
  const at = (sizeSol: number, x: number, tiers: Array<{ multiple: number; sellPct: number }>) => {
    const input: ExitInput = {
      entryPriceSol: 1, peakPriceSol: x, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: NOW,
      staleMinutes: 120, priceSol: x, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0,
      top10PctEntry: 0, top10PctNow: 0, nowMs: NOW, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: NOW - 60_000, maxHoldMinutes: 720,
      resistance: { hit: false, level: 0, touches: 0 }, sizeSol, costSol: sizeSol + 0.0011, proceedsSol: 0, volatilityPct: null, txFeeSol: DEFAULT_CONFIG.paper.txFeeSol, strategy: 'SOON',
    };
    return decideExit(input, { ...ex, takeProfitTiers: tiers }).sells.filter((s) => s.reason === 'TAKE_PROFIT').map((s) => s.pct);
  };
  it('a small trade sells a bigger first slice so the fee is a small part of it', () => {
    const pct = at(0.1, 1.25, [{ multiple: 1.2, sellPct: 30 }])[0]!;
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(100);
  });
  it('a big trade keeps the normal slices', () => {
    expect(at(1, 1.25, [{ multiple: 1.2, sellPct: 30 }])).toEqual([30]);
  });
  it('a leftover too small for its own sale goes with this one', () => {
    expect(at(0.2, 1.25, [{ multiple: 1.2, sellPct: 90 }])).toEqual([100]);
  });
});
