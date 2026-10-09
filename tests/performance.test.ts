import { describe, expect, it } from 'vitest';
import { summarise, type ClosedTrade } from '../src/api/performance-calc';

const t = (pnl: number, day: number, strategy = 'CURVE_SNIPE'): ClosedTrade => ({
  id: String(Math.random()), mint: 'm', symbol: 'S', strategy, sizeSol: 0.2, pnlSol: pnl,
  openedAt: new Date(Date.UTC(2026, 9, day, 10)), closedAt: new Date(Date.UTC(2026, 9, day, 11)), exitReason: pnl > 0 ? 'TAKE_PROFIT' : 'STOP_LOSS',
});

describe('summarise', () => {
  it('computes totals, win rate, drawdown and daily buckets', () => {
    const s = summarise([t(0.3, 1), t(-0.1, 1), t(-0.2, 2), t(0.5, 3)], 10);
    expect(s.totalPnlSol).toBeCloseTo(0.5);
    expect(s.winRate).toBe(50);
    expect(s.maxDrawdownSol).toBeCloseTo(0.3);
    expect(s.daily.map((d) => d.pnl)).toEqual([0.2, -0.2, 0.5]);
    expect(s.best?.pnlSol).toBe(0.5);
    expect(s.worst?.pnlSol).toBe(-0.2);
    expect(s.consistency).not.toBeNull();
  });
  it('handles no trades', () => {
    const s = summarise([], 10);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBeNull();
  });
});
