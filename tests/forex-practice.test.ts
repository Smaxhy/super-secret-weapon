import { describe, expect, it } from 'vitest';
import { newAccount, pnlUsd, tick, unitsFor, usdPer, view, type Quote } from '../src/forex/practice';
import { instrument } from '../src/forex/types';

const mids = { EURUSD: 1.1, USDJPY: 150, GBPUSD: 1.25, XAUUSD: 2500 };
const q = (id: string, mid: number, bars: Array<[number, number, number, number]> = []): Quote => ({ id, mid, bid: mid - 0.00004, ask: mid + 0.00004, t: 0, bars, dayChangePct: null, source: 'yahoo' });

describe('forex practice account', () => {
  it('converts currencies and sizes positions', () => {
    expect(usdPer('JPY', mids)).toBeCloseTo(1 / 150);
    expect(usdPer('EUR', mids)).toBe(1.1);
    expect(unitsFor(instrument('EURUSD')!, 11_000, mids)).toBeCloseTo(10_000);
    expect(unitsFor(instrument('USDJPY')!, 10_000, mids)).toBeCloseTo(10_000);
    expect(unitsFor(instrument('XAUUSD')!, 25_000, mids)).toBeCloseTo(10);
    // long 10k EUR from 1.1000 to 1.1100 = +$100
    expect(pnlUsd({ pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1 }, 1.11, mids)).toBeCloseTo(100);
    // short $10k USDJPY 150 → 149 = +10,000 JPY ≈ +$67
    expect(pnlUsd({ pair: 'USDJPY', side: -1, units: 10_000, entry: 150 }, 149, mids)).toBeCloseTo(67.1, 0);
    expect(pnlUsd({ pair: 'XAUUSD', side: 1, units: 10, entry: 2500 }, 2510, mids)).toBeCloseTo(100);
  });

  it('stop, target and margin call', () => {
    const T = Date.UTC(2026, 9, 19, 10);
    const a = newAccount(1000);
    a.open.push({ id: 'a', pair: 'EURUSD', side: 1, units: 100_000, entry: 1.1, marginUsd: 110, leverage: 1000, stop: 1.098, target: 1.105, openedAt: T, checkedT: T });
    // bar hits the target first
    tick(a, { EURUSD: q('EURUSD', 1.104, [[T + 60_000, 1.106, 1.1, 1.104]]) }, T + 70_000);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('target');
    expect(a.balanceUsd).toBeCloseTo(1500);
    // big leveraged loss → stop-out closes everything
    const b = newAccount(1000);
    b.open.push({ id: 'b', pair: 'EURUSD', side: 1, units: 500_000, entry: 1.1, marginUsd: 550, leverage: 1000, stop: null, target: null, openedAt: T, checkedT: T });
    expect(view(b, { EURUSD: 1.1 }).marginLevelPct).toBeCloseTo(178.2, 0); // spread already counted
    tick(b, { EURUSD: q('EURUSD', 1.0985, [[T + 60_000, 1.1, 1.098, 1.0985]]) }, T + 70_000);
    expect(b.open).toHaveLength(0);
    expect(b.closed[0]!.reason).toBe('stop-out');
    expect(b.balanceUsd).toBeLessThan(300);
  });
});
