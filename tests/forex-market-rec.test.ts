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

import { undoClosed } from '../src/forex/practice';

describe('v27.21 undoClosed', () => {
  it('strikes chosen losses: balance, record and ledger', () => {
    const c = (id: string, strategy: string, pnlUsd: number, closedAt: number) => ({ id, pair: 'BTCUSD', side: -1, units: 1, entry: 1, exit: 1, marginUsd: 1, leverage: 1, stop: null, target: null, openedAt: closedAt - 1, closedAt, pnlUsd, reason: 'stop', strategy, tf: '15m', ref: `${strategy}:15m:BTCUSD:${closedAt}` });
    const a = {
      balanceUsd: 900, peakUsd: 1000,
      closed: [c('a', 'mss_sweep', -30, 10), c('b', 'donchian20', -20, 11), c('a-part1', 'mss_sweep', 5, 9)],
      stats: { 'mss_sweep:15m': [[10, -25]], 'donchian20:15m': [[11, -20]] },
      ledger: { 'mss_sweep:15m': [[10, -25, -1, 'mss_sweep:15m:BTCUSD:10', 0]] },
    } as never;
    const r = undoClosed(a, (x) => x.strategy === 'mss_sweep' && x.pnlUsd < 0);
    expect(r.ids.sort()).toEqual(['a', 'a-part1']);
    expect(r.usd).toBe(-25);
    const acc = a as unknown as { balanceUsd: number; closed: Array<{ id: string }>; stats: Record<string, unknown[]>; ledger: Record<string, unknown[]> };
    expect(acc.balanceUsd).toBe(925);
    expect(acc.closed.map((x) => x.id)).toEqual(['b']);
    expect(acc.stats['mss_sweep:15m']).toEqual([]);
    expect(acc.ledger['mss_sweep:15m']).toEqual([]);
    expect(acc.stats['donchian20:15m']).toHaveLength(1);
  });
});

import { dailyPnl, type PnlRow } from '../src/forex/pnl';

describe('v27.21 correction rows', () => {
  it('move money between days without counting as trades', () => {
    const r = (id: string, t: number, usd: number, reason: string): PnlRow => ({ id, t, usd, pair: 'BTCUSD', side: -1, strategy: 'mss_sweep', tf: '15m', reason, entry: 0, exit: 0, openedAt: null });
    const d1 = Date.UTC(2026, 9, 21, 13);
    const d2 = Date.UTC(2026, 9, 22, 19);
    const days = dailyPnl([r('a', d1, 10, 'target'), r('adj1', d1 + 1, -79.37, 'adjust'), r('adj2', d2, 79.37, 'adjust')]);
    expect(days.map((d) => [d.day, d.pnlUsd, d.trades, d.wins])).toEqual([['2026-10-21', -69.37, 1, 1], ['2026-10-22', 79.37, 0, 0]]);
  });
});
