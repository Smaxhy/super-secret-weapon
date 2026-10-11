import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { decideExit, FADE_MARKER, strengthTrailFactor, type ExitChart, type ExitInput } from '../src/executor/sell-manager';

const now = 5_000_000;
const R = DEFAULT_CONFIG.exit;
const chart = (o: Partial<ExitChart> = {}): ExitChart => ({ strength: 0.5, buyVolShare60: 0.6, netFlowSol60: 1, change60Pct: 0, lastSwingLow: null, largestSellSol60: 0, trades60: 20, ...o });
const base = (o: Partial<ExitInput> = {}): ExitInput => ({
  entryPriceSol: 1, peakPriceSol: 1.35, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now, staleMinutes: 30, priceSol: 1.2,
  migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0, top10PctEntry: 15, top10PctNow: 15, nowMs: now, copyWalletSold: false,
  risk: 0, riskWhy: '', openedAtMs: now - 60_000, maxHoldMinutes: 45, resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1, proceedsSol: 0, volatilityPct: null, txFeeSol: 0,
  ...o,
});

describe('price-action exits (owner big update, ported)', () => {
  it('structure stop: after a 1.35x peak, a close 3%+ under the last swing low sells the rest', () => {
    const d = decideExit(base({ priceSol: 1.1, chart: chart({ lastSwingLow: 1.15 }) }), R);
    expect(d.sells[0]).toMatchObject({ pct: 100, reason: 'TRAILING_STOP' });
    expect(d.sells[0]!.detail).toContain('structure break');
    // above the swing low → no structure sale
    expect(decideExit(base({ priceSol: 1.14, chart: chart({ lastSwingLow: 1.15 }) }), R).sells.some((s) => s.detail.includes('structure'))).toBe(false);
    // no chart → the rule can't fire
    expect(decideExit(base({ priceSol: 1.1 }), R).sells.some((s) => s.detail.includes('structure'))).toBe(false);
  });
  it('momentum fade banks half once when sellers own the last minute', () => {
    const inp = base({ peakPriceSol: 1.5, priceSol: 1.3, chart: chart({ buyVolShare60: 0.3, netFlowSol60: -2 }) });
    const d = decideExit(inp, R);
    const fade = d.sells.find((s) => s.detail.includes('momentum fade'));
    expect(fade?.reason).toBe('TAKE_PROFIT');
    expect(d.state.tpTiersHit).toContain(FADE_MARKER);
    expect(decideExit({ ...inp, tpTiersHit: d.state.tpTiersHit }, R).sells.some((s) => s.detail.includes('momentum fade'))).toBe(false);
    // buyers still in control → no fade
    expect(decideExit(base({ peakPriceSol: 1.5, priceSol: 1.3, chart: chart() }), R).sells.some((s) => s.detail.includes('momentum fade'))).toBe(false);
  });
  it('whale exit: one sell ≥15% of liquidity while 10% off the peak = rug exit', () => {
    const d = decideExit(base({ priceSol: 1.05, liquiditySol: 20, chart: chart({ largestSellSol60: 4 }) }), R);
    expect(d.sells[0]?.reason).toBe('RUG_DETECTED');
    expect(decideExit(base({ priceSol: 1.05, liquiditySol: 20, chart: chart({ largestSellSol60: 2 }) }), R).sells[0]?.reason).not.toBe('RUG_DETECTED');
  });
  it('a dev with a real bag: any 2%+ sell is a rug exit', () => {
    expect(decideExit(base({ devHoldingPctEntry: 5, devHoldingPctNow: 4.85 }), R).sells[0]?.reason).toBe('RUG_DETECTED');
    expect(decideExit(base({ devHoldingPctEntry: 1, devHoldingPctNow: 0.97 }), R).sells[0]?.reason).not.toBe('RUG_DETECTED');
  });
  it('trail width follows chart strength', () => {
    expect(strengthTrailFactor(chart({ strength: 0 }), R)).toBeCloseTo(0.85);
    expect(strengthTrailFactor(chart({ strength: 1 }), R)).toBeCloseTo(1.15);
    expect(strengthTrailFactor(null, R)).toBe(1);
  });
});
