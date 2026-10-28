// v27.89: coin derivatives data — fetch / merge, causal series, filters, strategies, liquidations.
import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { addLiq, alignRows, change24, derivKey, derivNow, derivSeriesFor, loadDerivs, mergeRows, parseBinanceLiq, parseBybitLiq, perpOf, refreshDerivs, rollingZ, type Row } from '../src/forex/derivs';
import { allowFor, blockReason, type FilterEnv } from '../src/forex/filters';
import { runsOn, strategyById } from '../src/forex/strategies';
import { INSTRUMENTS, type Bar } from '../src/forex/types';

const H = 3_600_000;
class FakeRedis {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
}

describe('v27.89 coin derivatives', () => {
  it('symbols and merging', () => {
    expect(perpOf('BTCUSD')).toBe('BTCUSDT');
    expect(mergeRows([[1, 1], [2, 2]], [[2, 5], [3, 3]])).toEqual([[1, 1], [2, 5], [3, 3]]);
  });

  it('rolling z only uses the rows before', () => {
    const z = rollingZ([1, 2, 1, 2, 1, 2, 10], 6, 4);
    expect(Number.isNaN(z[3]!)).toBe(true);
    expect(z[6]!).toBeGreaterThan(5);
    // changing a later value never changes an earlier z (causal)
    const z2 = rollingZ([1, 2, 1, 2, 1, 2, -10], 6, 4);
    expect(z2[5]).toBe(z[5]);
  });

  it('OI 24h change and alignment read only what was stamped by each bar close', () => {
    const rows: Row[] = Array.from({ length: 30 }, (_, k) => [k * H, 100 + k] as Row);
    const c = change24(rows);
    expect(Number.isNaN(c[23]!)).toBe(true);
    expect(c[24]).toBeCloseTo(((124 / 100) - 1) * 100, 6);
    const bars: Bar[] = [{ t: 23 * H, o: 1, h: 1, l: 1, c: 1 }, { t: 40 * H, o: 1, h: 1, l: 1, c: 1 }];
    const a = alignRows(rows.map((r) => r[0]), rows.map((r) => r[1]), bars, 60, 3 * H);
    expect(a[0]).toBe(124); // close of the 23:00 bar = 24:00 → the 24:00 row
    expect(Number.isNaN(a[1]!)).toBe(true); // newest row 29:00, close 41:00 → too old
  });

  it('refresh pulls forward + back, keeps one source per series, never throws', async () => {
    const r = new FakeRedis();
    const now = 2000 * H;
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      if (url.includes('binance')) throw new Error('HTTP 451');
      const end = Number(new URL(url).searchParams.get('endTime'));
      const start = end - 50 * H;
      if (url.includes('funding')) return { retCode: 0, result: { list: Array.from({ length: 6 }, (_, k) => ({ fundingRateTimestamp: String(Math.floor((end - 1) / (8 * H)) * 8 * H - k * 8 * H), fundingRate: '0.0001' })).filter((x) => Number(x.fundingRateTimestamp) > now - 200 * H) } };
      if (url.includes('open-interest')) return { retCode: 0, result: { list: Array.from({ length: 50 }, (_, k) => ({ timestamp: String(Math.floor((end - 1) / H) * H - k * H), openInterest: '1000' })).filter((x) => Number(x.timestamp) > now - 300 * H && Number(x.timestamp) > start) } };
      return { retCode: 0, result: { list: [{ timestamp: String(Math.floor((end - 1) / H) * H), buyRatio: '0.6', sellRatio: '0.4' }] } };
    };
    const meta = await refreshDerivs(r as unknown as Redis, INSTRUMENTS.filter((i) => i.id === 'BTCUSD'), now, get, 60_000, 0);
    expect(meta.BTCUSD?.fund?.error ?? null).toBeNull();
    expect(meta.BTCUSD?.fund?.src).toBe('bybit');
    expect(meta.BTCUSD?.oi?.error ?? null).toBeNull();
    expect(meta.BTCUSD?.oi).toMatchObject({ full: true });
    const oi = JSON.parse(r.m.get(derivKey('oi', 'BTCUSD'))!) as Row[];
    expect(oi.length).toBeGreaterThan(100);
    expect(oi[0]![0]).toBeLessThan(oi[oi.length - 1]![0]);
    const book = await loadDerivs(r as unknown as Redis, ['BTCUSD']);
    expect(book.BTCUSD!.ls[0]![1]).toBeCloseTo(1.5, 6);
    expect(calls.some((u) => u.includes('fapi.binance.com'))).toBe(true);
  });

  it('series → filters: crowded funding blocks the crowded side only; other markets never blocked', () => {
    const bars: Bar[] = Array.from({ length: 200 }, (_, k) => ({ t: k * 8 * H, o: 1, h: 1, l: 1, c: 1 }));
    const fund: Row[] = bars.map((b, k) => [b.t + 8 * H, k < 199 ? (k % 2 ? 0.01 : 0.012) : 0.2] as Row);
    const s = derivSeriesFor({ fund, oi: [], ls: [], liq: [] }, bars, 480)!;
    expect(s.fundZ[199]!).toBeGreaterThan(2);
    const env = { tf: '4h', gap: new Float64Array(200), h4: new Int8Array(200), d1: new Int8Array(200), mood: new Float64Array(200), riskLong: 1, fund: s.fund, fundZ: s.fundZ } as FilterEnv;
    expect(blockReason('funding', env, 199, 1)).toContain('longs are crowded');
    expect(blockReason('funding', env, 199, -1)).toBeNull();
    const fxEnv = { tf: '4h', gap: new Float64Array(1), h4: new Int8Array(1), d1: new Int8Array(1), mood: new Float64Array(1), riskLong: 0 } as FilterEnv;
    expect(allowFor('funding', fxEnv)).toBeUndefined();
    expect(allowFor('oi', fxEnv, 'trend')).toBeUndefined();
  });

  it('coin-only strategies never run on forex', () => {
    expect(runsOn(strategyById('funding_squeeze')!, '1h', 'EURUSD')).toBe(false);
    expect(runsOn(strategyById('oi_flush')!, '4h', 'BTCUSD')).toBe(true);
  });

  it('liquidations: Binance SELL / Bybit Buy = a long liquidated, summed per hour', () => {
    const ids = new Set(['BTCUSD']);
    const b = parseBinanceLiq(JSON.stringify({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', z: '0.5', ap: '80000', T: 10 * H + 5 } }), ids);
    expect(b).toEqual([{ id: 'BTCUSD', t: 10 * H + 5, side: 1, usd: 40_000 }]);
    const y = parseBybitLiq(JSON.stringify({ topic: 'allLiquidation.BTCUSDT', data: [{ T: 10 * H + 9, s: 'BTCUSDT', S: 'Sell', v: '1', p: '80000' }, { T: 1, s: 'ETHUSDT', S: 'Buy', v: '1', p: '1' }] }), ids);
    expect(y).toEqual([{ id: 'BTCUSD', t: 10 * H + 9, side: -1, usd: 80_000 }]);
    let rows = addLiq([], b[0]!);
    rows = addLiq(rows, y[0]!);
    expect(rows).toEqual([[10 * H, 40_000, 80_000]]);
    const now = derivNow({ fund: [], oi: [], ls: [], liq: rows }, null, 10 * H + 60_000);
    expect(now!.liq1h).toEqual({ long: 40_000, short: 80_000 });
    expect(now!.note).toContain('liquidated');
  });
});
