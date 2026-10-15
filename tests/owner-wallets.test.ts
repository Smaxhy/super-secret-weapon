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
  it('copy trades buy at once at the normal bar and size', () => {
    const c = DEFAULT_CONFIG.copy;
    expect(c.scoreThresholdDelta).toBe(0);
    expect(c.sizeMultiplier).toBe(1);
    expect(c.minHoldSec).toBe(0);
    expect(c.skipDipWait && c.skipConfirm && c.mirrorSells).toBe(true);
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
