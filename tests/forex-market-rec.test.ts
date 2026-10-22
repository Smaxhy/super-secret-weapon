import { describe, expect, it } from 'vitest';
import { marketRecOf } from '../src/forex/lab';
import type { MarketCell } from '../src/forex/montecarlo';

const cell = (pair: string, n: number, avgR: number, pf: number | null, inN = 20, inAvgR = 0.1, mcP: number | null = 0.5): MarketCell => ({
  pair, inN, inAvgR, n, avgR, pf, winPct: 50, mcP, mcP5: null, sess: [],
});

describe('v27.21 losing record on a market', () => {
  it('holds back the coin mss_sweep shorts that lost (VPS Oct 22)', () => {
    // BTC: 14 trades PF 0.29 here, unseen 11 at −0.43R
    expect(marketRecOf({ n: 14, pf: 0.29, totalR: -6 }, cell('BTCUSD', 11, -0.43, 0.24, 3, -0.14, 0.02)).ok).toBe(false);
    // ETH: 6 trades PF 0.19 (clearly losing even though thin)
    expect(marketRecOf({ n: 6, pf: 0.19, totalR: -4 }, cell('ETHUSD', 4, -0.75, 0.06, 2, 0, 0.1)).ok).toBe(false);
    // DOGE: 19 trades PF 0.96 overall, but its unseen 7 lose on average
    expect(marketRecOf({ n: 19, pf: 0.96, totalR: -0.5 }, cell('DOGEUSD', 7, -0.12, 0.62, 12, 0.05, 0.42)).ok).toBe(false);
  });
  it('lets proven and thin-but-fine records trade', () => {
    // SOL pivot_bounce 4h: strict cell (188 unseen, +0.16R, PF 2.19)
    expect(marketRecOf({ n: 406, pf: 1.9, totalR: 60 }, cell('SOLUSD', 188, 0.16, 2.19, 200, 0.12, 1)).ok).toBe(true);
    // nothing tested here yet → passes
    expect(marketRecOf(undefined, null).ok).toBe(true);
    // 3 unseen losers is too thin to judge
    expect(marketRecOf({ n: 8, pf: 1.1, totalR: 0.5 }, cell('ETHUSD', 3, -0.5, 0.4)).ok).toBe(true);
    // the owner's one-market trial overrides
    expect(marketRecOf({ n: 172, pf: 0.89, totalR: -8.9 }, null, true).ok).toBe(true);
  });
  it('keeps the old 12-trade rule', () => {
    expect(marketRecOf({ n: 46, pf: 0.68, totalR: -9 }, null).ok).toBe(false);
    expect(marketRecOf({ n: 46, pf: 0.95, totalR: -1 }, null).ok).toBe(true);
  });
});
