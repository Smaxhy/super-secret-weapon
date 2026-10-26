/** v27.47 (owner: "make it on time"): OANDA's live prices for the indices / metals, moved onto the futures price. */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';

vi.mock('../src/forex/oanda', async (orig) => {
  const real = await orig<typeof import('../src/forex/oanda')>();
  return {
    ...real,
    loadOanda: async () => ({ token: 't'.repeat(30), accountId: '101-004-1-001' }),
    // OANDA's NAS100 CFD sits 80 points under the NQ future; EURUSD as is
    oandaPrices: async (_s: unknown, ids: readonly string[]) => ids.filter((id) => id === 'NDXUSD' || id === 'EURUSD').map((id) => (id === 'NDXUSD' ? { id, bid: 28_949, ask: 28_951, t: Date.now(), tradeable: true } : { id, bid: 1.1, ask: 1.1002, t: Date.now(), tradeable: true })),
    oandaCandles: async () => [{ t: Date.now() - 60_000, o: 28_940, h: 28_960, l: 28_930, c: 28_950, v: 10, complete: true }],
  };
});

const { toOanda, fromOanda } = await import('../src/forex/oanda');
const { measureBasis, shiftBars } = await import('../src/forex/basis');
const { Practice } = await import('../src/forex/practice');
type Quote = import('../src/forex/practice').Quote;

describe('OANDA names', () => {
  it('indices use OANDA CFD names, coins never go to OANDA', () => {
    expect(toOanda('NDXUSD')).toBe('NAS100_USD');
    expect(toOanda('SPXUSD')).toBe('SPX500_USD');
    expect(toOanda('DJIUSD')).toBe('US30_USD');
    expect(toOanda('RUTUSD')).toBe('US2000_USD');
    expect(toOanda('EURUSD')).toBe('EUR_USD');
    expect(toOanda('XAUUSD')).toBe('XAU_USD');
    expect(toOanda('BTCUSD')).toBeNull();
    expect(fromOanda('NAS100_USD')).toBe('NDXUSD');
    expect(fromOanda('EUR_USD')).toBe('EURUSD');
  });
});

describe('futures gap (basis)', () => {
  const t0 = Date.UTC(2026, 9, 27, 14, 0);
  const rows = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => [t0 + i * 60_000, f(i)] as const);
  it('median of futures − OANDA over the minutes both have', () => {
    const fut = rows(30, (i) => 29_000 + i);
    const cfd = rows(30, (i) => 28_920 + i + (i === 5 ? 40 : 0)); // one odd print doesn't move the median
    expect(measureBasis(fut, cfd)).toEqual({ basis: 80, n: 30 });
  });
  it('too few shared minutes or an impossible gap → none', () => {
    expect(measureBasis(rows(5, () => 29_000), rows(5, () => 28_900))).toBeNull();
    expect(measureBasis(rows(20, () => 29_000), rows(20, () => 20_000))).toBeNull();
  });
  it('shifts bars, keeping a missing open missing', () => {
    expect(shiftBars([[1, 10, 8, 9, 8.5], [2, 11, 9, 10]] as Array<[number, number, number, number, number?]>, 2)).toEqual([[1, 12, 10, 11, 10.5], [2, 13, 11, 12]]);
  });
});

describe('Practice prices with OANDA connected', () => {
  const yahoo = (id: string, mid: number): Quote => ({ id, mid, bid: mid - 1, ask: mid + 1, t: Date.now(), bars: [], dayChangePct: null, source: 'yahoo', delayMs: 600_000 });
  const make = () => {
    const p = new Practice({ get: async () => null } as unknown as Redis);
    (p as unknown as { quote: (id: string) => Promise<Quote> }).quote = async (id) => yahoo(id, id === 'BTCUSD' ? 100_000 : 29_020);
    return p;
  };
  it('the Nasdaq stays on Yahoo until its gap is measured, then goes live at OANDA + gap', async () => {
    const p = make();
    (p as unknown as { measureBasisFor: () => Promise<void> }).measureBasisFor = async () => undefined;
    const before = await p.quotes(['NDXUSD', 'EURUSD', 'BTCUSD']);
    expect(before.NDXUSD!.source).toBe('yahoo');
    expect(before.EURUSD!.source).toBe('oanda');
    expect(before.BTCUSD!.source).toBe('yahoo'); // coins keep their own feed (were missing before v27.47)
    (p as unknown as { basis: Map<string, { basis: number; n: number; at: number }> }).basis.set('oanda:NDXUSD', { basis: 80, n: 30, at: Date.now() });
    const after = await p.quotes(['NDXUSD']);
    expect(after.NDXUSD!.source).toBe('oanda');
    expect(after.NDXUSD!.mid).toBe(29_030);
    expect(after.NDXUSD!.bars[0]![3]).toBe(29_030);
    expect(after.NDXUSD!.delayMs).toBeUndefined();
  });
  it('an hour-old gap is not trusted', async () => {
    const p = make();
    (p as unknown as { measureBasisFor: () => Promise<void> }).measureBasisFor = async () => undefined;
    (p as unknown as { basis: Map<string, { basis: number; n: number; at: number }> }).basis.set('oanda:NDXUSD', { basis: 80, n: 30, at: Date.now() - 2 * 3_600_000 });
    expect((await p.quotes(['NDXUSD'])).NDXUSD!.source).toBe('yahoo');
  });
});
