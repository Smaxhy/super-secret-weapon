import { describe, it, expect } from 'vitest';
import { edgeGateVerdict, DEFAULT_EDGE_GATE, type StrategyStats, type EdgeGateConfig } from '../src/evaluator/edge-gate';

const cfg = DEFAULT_EDGE_GATE; // enabled, minEdge 2%, cost 7%, minTrades 30

describe('edgeGateVerdict', () => {
  it('passes when disabled', () => {
    const v = edgeGateVerdict(null, 0, { ...cfg, enabled: false });
    expect(v.pass).toBe(true);
  });

  it('passes when no stats (not enough data)', () => {
    const v = edgeGateVerdict(null, 0, cfg);
    expect(v.pass).toBe(true);
    expect(v.reason).toContain('not enough data');
  });

  it('passes when stats have too few trades', () => {
    const v = edgeGateVerdict({ winRate: 0.5, avgWinPct: 20, avgLossPct: 10, n: 10 }, 0, cfg);
    expect(v.pass).toBe(true);
    expect(v.reason).toContain('not enough data');
  });

  it('blocks a losing strategy (low WR, small wins, big losses)', () => {
    // WR 24%, avg win +15%, avg loss -12%, costs 7%
    // EV = 0.24*15 - 0.76*12 - 7 = 3.6 - 9.12 - 7 = -12.52
    const stats: StrategyStats = { winRate: 0.24, avgWinPct: 15, avgLossPct: 12, n: 50 };
    const v = edgeGateVerdict(stats, 0, cfg);
    expect(v.pass).toBe(false);
    expect(v.expectedEdgePct).toBeLessThan(0);
  });

  it('passes a profitable strategy', () => {
    // WR 55%, avg win +30%, avg loss -10%, costs 7%
    // EV = 0.55*30 - 0.45*10 - 7 = 16.5 - 4.5 - 7 = 5.0
    const stats: StrategyStats = { winRate: 0.55, avgWinPct: 30, avgLossPct: 10, n: 50 };
    const v = edgeGateVerdict(stats, 0, cfg);
    expect(v.pass).toBe(true);
    expect(v.expectedEdgePct).toBeGreaterThanOrEqual(2);
  });

  it('score margin above bar boosts win rate and can flip a borderline strategy', () => {
    // WR 30%, avg win +25%, avg loss -10%, costs 7%
    // Base EV = 0.30*25 - 0.70*10 - 7 = 7.5 - 7 - 7 = -6.5 (blocked)
    const stats: StrategyStats = { winRate: 0.30, avgWinPct: 25, avgLossPct: 10, n: 50 };
    const blocked = edgeGateVerdict(stats, 0, cfg);
    expect(blocked.pass).toBe(false);

    // +40 score margin → +20% to WR (capped 0.95) → WR ~0.50
    // EV = 0.50*25 - 0.50*10 - 7 = 12.5 - 5 - 7 = 0.5 — still blocked (< 2%)
    const boosted = edgeGateVerdict(stats, 40, cfg);
    // With +40: WR = 0.30 + (40/10)*0.05 = 0.50
    // EV = 0.50*25 - 0.50*10 - 7 = 0.5 — still below 2
    expect(boosted.pass).toBe(false);

    // +60 score margin → WR = 0.30 + 0.30 = 0.60
    // EV = 0.60*25 - 0.40*10 - 7 = 15 - 4 - 7 = 4.0 → passes
    const strong = edgeGateVerdict(stats, 60, cfg);
    expect(strong.pass).toBe(true);
  });

  it('win rate capped at 0.95 even with extreme score margin', () => {
    const stats: StrategyStats = { winRate: 0.90, avgWinPct: 20, avgLossPct: 10, n: 50 };
    // +200 margin → WR = 0.90 + 1.0 → capped 0.95
    const v = edgeGateVerdict(stats, 200, cfg);
    // EV = 0.95*20 - 0.05*10 - 7 = 19 - 0.5 - 7 = 11.5
    expect(v.expectedEdgePct).toBeCloseTo(11.5, 0);
  });

  it('negative score margin lowers win rate', () => {
    // WR 40%, avg win +25%, avg loss -10%, costs 7%
    // Base EV = 0.40*25 - 0.60*10 - 7 = 10 - 6 - 7 = -3 (blocked)
    const stats: StrategyStats = { winRate: 0.40, avgWinPct: 25, avgLossPct: 10, n: 50 };
    // -20 margin → WR = 0.40 - 0.10 = 0.30
    // EV = 0.30*25 - 0.70*10 - 7 = 7.5 - 7 - 7 = -6.5
    const v = edgeGateVerdict(stats, -20, cfg);
    expect(v.pass).toBe(false);
    expect(v.expectedEdgePct).toBeLessThan(-3);
  });

  it('respects custom minEdgePct and costPct', () => {
    const stats: StrategyStats = { winRate: 0.50, avgWinPct: 20, avgLossPct: 8, n: 50 };
    // costPct 3, minEdge 0 → EV = 0.50*20 - 0.50*8 - 3 = 10 - 4 - 3 = 3
    const custom: EdgeGateConfig = { enabled: true, minEdgePct: 0, costPct: 3, minTrades: 30 };
    const v = edgeGateVerdict(stats, 0, custom);
    expect(v.pass).toBe(true);
    expect(v.expectedEdgePct).toBeCloseTo(3, 0);
  });
});
