import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/learner/observation-logger';
import { DEFAULT_CURVE_PARAMS } from '../src/lib/pumpfun';
import { deriveMetrics, type LiveTokenView } from '../src/scanner/live-state';

const view: LiveTokenView = {
  mint: 'M',
  creator: 'DEV',
  createdAtMs: 1_000_000,
  buys: 6,
  sells: 2,
  buyVolumeSol: 3,
  sellVolumeSol: 1,
  virtualSolReserves: 32_000_000_000n,
  virtualTokenReserves: 1_005_937_500_000_000n,
  complete: false,
  lastTradeAtMs: 1_050_000,
  curve: DEFAULT_CURVE_PARAMS,
  balances: new Map([
    ['DEV', 50_000_000_000_000n], // 5%
    ['A', 10_000_000_000_000n], // 1%
    ['B', 7_000_000_000_000n],
  ]),
  uniqueWallets: 5,
};

describe('deriveMetrics / buildSnapshot', () => {
  it('computes holder stats from the ledger', () => {
    const m = deriveMetrics(view);
    expect(m.holderCount).toBe(3);
    expect(m.devHoldingPct).toBeCloseTo(5);
    expect(m.top10HolderPct).toBeCloseTo(6.7);
    expect(m.buySellRatio).toBe(3);
    expect(m.volumeSol).toBe(4);
    expect(m.liquiditySol).toBeCloseTo(2);
    expect(m.bondingCurvePct).toBeGreaterThan(8);
  });
  it('builds a snapshot with age relative to creation', () => {
    const s = buildSnapshot(view, 'M1', 1_060_000);
    expect(s.ageSeconds).toBe(60);
    expect(s.interval).toBe('M1');
    expect(s.holderCount).toBe(3);
  });
});
