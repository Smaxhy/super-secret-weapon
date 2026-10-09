import { describe, expect, it, vi } from 'vitest';

// Keep the test offline: the recorder module imports the shared Redis client.
vi.mock('../src/lib/redis', () => ({ redis: { lrange: vi.fn(async () => []), multi: vi.fn() } }));

import { historyKey, parsePoint, pickPoints, PointThrottle, serializePoint } from '../src/executor/position-history';
import type { BusEvent } from '../src/lib/bus';

const upd = (id: string, priceSol: number) => ({ id, priceSol, multiple: 1, peakMultiple: 1, unrealizedPnlSol: 0, risk: 0, holders: 10, ownSupplyPct: 1, exitImpactPct: 1 });
const ev = (...u: ReturnType<typeof upd>[]): BusEvent => ({ type: 'positions', data: { updates: u } });

describe('position history helpers', () => {
  it('serialize / parse round trip', () => {
    const s = serializePoint({ t: 1_700_000_000_123.4, priceSol: 3.1e-8 });
    expect(s).toBe('{"t":1700000000123,"p":3.1e-8}');
    expect(parsePoint(s)).toEqual({ t: 1_700_000_000_123, priceSol: 3.1e-8 });
  });

  it('parse rejects junk', () => {
    expect(parsePoint('not json')).toBeNull();
    expect(parsePoint('{"t":1}')).toBeNull();
    expect(parsePoint('{"t":1,"p":0}')).toBeNull();
    expect(parsePoint('{"t":"x","p":1}')).toBeNull();
  });

  it('key format', () => {
    expect(historyKey('abc')).toBe('pos:hist:abc');
  });

  it('throttle allows one point per position per 5s', () => {
    const th = new PointThrottle(5_000);
    expect(th.allow('a', 0)).toBe(true);
    expect(th.allow('a', 2_000)).toBe(false);
    expect(th.allow('b', 2_000)).toBe(true);
    expect(th.allow('a', 5_000)).toBe(true);
    expect(th.allow('a', 9_999)).toBe(false);
  });

  it('throttle prunes stale positions', () => {
    const th = new PointThrottle(5_000);
    th.allow('a', 0);
    th.allow('b', 500_000);
    th.prune(700_000, 600_000);
    expect(th.size).toBe(1);
  });

  it('pickPoints keeps valid, unthrottled updates only', () => {
    const th = new PointThrottle(5_000);
    expect(pickPoints(ev(upd('a', 1e-8), upd('b', 0), upd('c', NaN)), th, 1_000)).toEqual([{ id: 'a', point: { t: 1_000, priceSol: 1e-8 } }]);
    expect(pickPoints(ev(upd('a', 2e-8)), th, 3_000)).toEqual([]);
    expect(pickPoints(ev(upd('a', 2e-8)), th, 6_000)).toHaveLength(1);
    expect(pickPoints({ type: 'stats', data: {} }, th, 20_000)).toEqual([]);
  });
});
