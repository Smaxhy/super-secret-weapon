/** v27.4: Monte Carlo, per-market cells, NY sessions, market-only edges. */
import { describe, expect, it } from 'vitest';
import { MARKET_EDGE, bySession, cellPass, ddPctAt, marketCells, monteCarlo, sessionOf, type MarketCell } from '../src/forex/montecarlo';
import { FX_CONFIG, planChosen, profitFloor } from '../src/forex/lab';
import type { Trade } from '../src/forex/types';

// v27.19 default is 'prefer'; these tests pin the v27.3 focus-only mode
FX_CONFIG.focus.mode = 'only';

const H = 3_600_000;
const NY0 = Date.UTC(2026, 9, 14, 4); // Wed 00:00 New York (EDT)
const tr = (pair: string, entryT: number, r: number): Trade => ({ pair, entryT, exitT: entryT + H, r, reason: r > 0 ? 'target' : 'stop', strategy: 's', tf: '1h', side: 1, entry: 1, exit: 1, stop: 0.9, stop0: 0.9, target: 1.2 }) as unknown as Trade;

describe('v27.4 Monte Carlo', () => {
  it('a steady winner almost always stays profitable; a coin flip does not; deterministic', () => {
    const good = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1.5 : -1));
    const flip = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1));
    const g = monteCarlo(good, 7)!;
    expect(g.pProfit).toBeGreaterThan(0.95);
    expect(g.p5AvgR).toBeGreaterThan(0);
    expect(g.ddR95).toBeGreaterThan(0);
    expect(g.streak95).toBeGreaterThanOrEqual(3);
    const f = monteCarlo(flip, 7)!;
    expect(f.pProfit).toBeGreaterThan(0.2);
    expect(f.pProfit).toBeLessThan(0.8);
    expect(monteCarlo(good, 7)).toEqual(g);
    expect(monteCarlo([1, 2], 7)).toBeNull();
    expect(ddPctAt(10, 1)).toBeCloseTo(9.6, 1);
  });

  it('New York sessions', () => {
    expect(sessionOf(NY0 + 2 * H)).toBe(0); // 02:00 NY Asia
    expect(sessionOf(NY0 + 4 * H)).toBe(1); // 04:00 London
    expect(sessionOf(NY0 + 9.5 * H)).toBe(2); // 09:30 NY open
    expect(sessionOf(NY0 + 14 * H)).toBe(3); // 14:00 NY afternoon
    expect(sessionOf(NY0 + 19 * H)).toBe(0); // 19:00 Asia
    expect(bySession([tr('X', NY0 + 9.5 * H, 2), tr('X', NY0 + 10 * H, -1)])[2]).toEqual([2, 0.5]);
  });

  it('splits a row by market with its own first-70% / unseen record', () => {
    const oos = NY0 + 1000 * H;
    const ts: Trade[] = [];
    for (let i = 0; i < 60; i++) ts.push(tr('NDXUSD', NY0 + i * 10 * H, i % 3 === 0 ? -1 : 1)); // in-sample, winner
    for (let i = 0; i < 60; i++) ts.push(tr('NDXUSD', oos + i * 10 * H, i % 3 === 0 ? -1 : 1)); // unseen, winner
    for (let i = 0; i < 60; i++) ts.push(tr('EURUSD', oos + i * 10 * H, i % 3 === 0 ? 1 : -1)); // unseen, loser
    const cells = marketCells(ts, oos, 'k');
    const ndx = cells.find((c) => c.pair === 'NDXUSD')!;
    const eur = cells.find((c) => c.pair === 'EURUSD')!;
    expect(ndx.inN).toBe(60);
    expect(ndx.n).toBe(60);
    expect(cellPass(ndx)).toBe(true);
    expect(cellPass(eur)).toBe(false);
    expect(ndx.sess.reduce((a, s) => a + s[0], 0)).toBe(120);
  });

  it('a market-only edge trades on that market (focus permitting); the row floor needs Monte Carlo 90%', () => {
    const cell: MarketCell = { pair: 'USDJPY', inN: 40, inAvgR: 0.2, n: 50, avgR: 0.3, pf: 1.8, winPct: 55, mcP: 0.99, mcP5: 0.1, sess: [] };
    expect(MARKET_EDGE.minMcP).toBe(0.95);
    expect(planChosen('pin_bar', 'USDJPY', false, undefined, false, cell)).toBe(true);
    expect(planChosen('pin_bar', 'USDJPY', false, undefined, true, cell)).toBe(false); // the learner dropped it
    expect(planChosen('pin_bar', 'USDJPY', false, undefined, false, { ...cell, mcP: 0.8 })).toBe(false); // v27.9: 0.85–0.95 on a focus market = a half-size trial
    expect(planChosen('pin_bar', 'GBPUSD', false, undefined, false, { ...cell, pair: 'GBPUSD' })).toBe(true); // v27.10: proven there → past the focus list
    expect(planChosen('pin_bar', 'GBPUSD', true, undefined, false, null)).toBe(false); // unproven: not a focus market
    const st = (n: number, avgR: number, pf: number) => ({ n, winPct: 50, avgR, medianR: 0, pf, totalR: n * avgR, maxDdR: 0 });
    const row = { inSample: st(100, 0.1, 1.3), outSample: st(60, 0.1, 1.3) };
    expect(profitFloor({ ...row, mc: { n: 60, pProfit: 0.85, p5AvgR: -0.1, p50AvgR: 0.1, ddR95: 10, streak95: 6 } }).why).toMatch(/Monte Carlo/);
    expect(profitFloor({ ...row, mc: { n: 60, pProfit: 0.93, p5AvgR: 0, p50AvgR: 0.1, ddR95: 10, streak95: 6 } }).ok).toBe(true);
    expect(FX_CONFIG.profitFloor.minMcP).toBe(0.9);
  });
});
