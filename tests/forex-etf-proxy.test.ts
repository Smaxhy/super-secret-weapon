/** v28.17 (owner: "fix the 10 min delay no matter what"): the Russell 2000's live price from IWM × the futures ratio. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { aggregate, etfAsFutures, etfLive, measureRatio, parseEtf, type EtfMinutes } from '../src/forex/etf-proxy';
import { extendWithLive } from '../src/forex/basis';
import { Practice, type Quote } from '../src/forex/practice';
import type { Bar } from '../src/forex/types';

const NOW = Date.UTC(2026, 10, 3, 15, 30); // Tuesday 10:30 New York, CME + NYSE open
const MIN = 60_000;
const H = 3_600_000;

function yahooJson(rows: Array<[number, number]>, delayMin = 0, mtSec?: number): unknown {
  return {
    chart: {
      result: [{
        meta: { exchangeDataDelayedBy: delayMin, regularMarketPrice: 200, regularMarketTime: mtSec ?? Math.floor(rows[rows.length - 1]![0] / 1000) },
        timestamp: rows.map(([t]) => t / 1000),
        indicators: { quote: [{ open: rows.map(([, c]) => c), high: rows.map(([, c]) => c + 0.05), low: rows.map(([, c]) => c - 0.05), close: rows.map(([, c]) => c), volume: rows.map(() => 1000) }] },
      }],
    },
  };
}

const etfRows = (from: number, n: number, px = (k: number) => 220 + k * 0.01): Array<[number, number]> => Array.from({ length: n }, (_, k) => [from + k * MIN, px(k)]);

describe('ETF minutes → a live futures-equivalent price', () => {
  it('parses the newest minute (pre-market included) and the declared delay', () => {
    const m = parseEtf('IWM', yahooJson(etfRows(NOW - 30 * MIN, 30)), NOW)!;
    expect(m.bars).toHaveLength(30);
    expect(m.px).toBeCloseTo(220.29, 6);
    expect(etfLive(m, NOW)).toBe(true);
    expect(etfLive(parseEtf('IWM', yahooJson(etfRows(NOW - 30 * MIN, 30), 15), NOW), NOW)).toBe(false); // delayed → not live
    expect(etfLive(m, NOW + 10 * MIN)).toBe(false); // stale → not live
  });

  it('measures futures ÷ ETF on shared minutes and refuses too few / disagreeing ones', () => {
    const etf = etfRows(NOW - 60 * MIN, 60).map(([t, c]) => [t, c] as const);
    const fut = etf.map(([t, c]) => [t, c * 10.9] as const);
    expect(measureRatio(fut, etf)!.ratio).toBeCloseTo(10.9, 6);
    expect(measureRatio(fut.slice(0, 5), etf)).toBeNull();
    const wild = fut.map(([t, c], k) => [t, c * (k % 2 ? 1.02 : 0.98)] as const); // a wrong pairing: minutes 4% apart
    expect(measureRatio(wild, etf)).toBeNull();
  });

  it('aggregates minutes onto the hour, only hours with enough minutes', () => {
    const bars: Bar[] = etfRows(NOW - 90 * MIN, 90).map(([t, c]) => ({ t, o: c, h: c, l: c, c }));
    const hours = aggregate(bars, H);
    // 14:00 has all 60 minutes, 15:00 only its first 30 (below 60%)
    expect(hours.map((b) => b.t)).toEqual([Date.UTC(2026, 10, 3, 14, 0)]);
  });

  it('adds the hour that just closed onto the late futures candles (the lab sees it at once)', () => {
    // futures hourly candles up to 13:00 (14:00 not in yet: Yahoo is late); ETF minutes 08:00–15:00 New York-ish
    const start = Date.UTC(2026, 10, 3, 4, 0);
    const minutes: Array<[number, number]> = etfRows(start, 11 * 60, (k) => 220 + Math.sin(k / 50));
    const m = parseEtf('IWM', yahooJson(minutes), start + 11 * 60 * MIN)!;
    const etfH = aggregate(m.bars, H);
    const fut: Bar[] = etfH.filter((b) => b.t < Date.UTC(2026, 10, 3, 14, 0)).map((b) => ({ ...b, o: b.o * 10.9 + 3, h: b.h * 10.9 + 3, l: b.l * 10.9 + 3, c: b.c * 10.9 + 3 }));
    const live = etfAsFutures(m, fut, H);
    expect(live.length).toBe(etfH.length);
    const x = extendWithLive(fut, live, H, Date.UTC(2026, 10, 3, 15, 0) + 1_000);
    expect(x.added).toBe(1);
    const last = x.bars[x.bars.length - 1]!;
    expect(last.t).toBe(Date.UTC(2026, 10, 3, 14, 0));
    const want = etfH.find((b) => b.t === last.t)!.c * 10.9 + 3;
    expect(Math.abs(last.c - want)).toBeLessThan(0.5);
  });
});

describe('the bot account on the Russell 2000', () => {
  afterEach(() => vi.useRealTimers());
  const make = () => {
    vi.useFakeTimers({ now: NOW });
    const p = new Practice({ get: async () => null, set: async () => 'OK' } as unknown as Redis);
    p.hl = { book: () => null, candles: async () => [], futBars: () => [] };
    return p;
  };

  it('quotes RUTUSD from IWM × the measured ratio (source etf, no delay)', async () => {
    const p = make();
    const rows = etfRows(NOW - 120 * MIN, 120);
    const m: EtfMinutes = parseEtf('IWM', yahooJson(rows), NOW)!;
    p.etfFetch = async () => m;
    p.futMinutes = async () => ({ id: 'RUTUSD', mid: 0, bid: 0, ask: 0, t: NOW, bars: rows.slice(0, 110).map(([t, c]) => [t, c * 10.9, c * 10.9, c * 10.9] as [number, number, number, number]), dayChangePct: null, source: 'yahoo' }) as Quote;
    const q = (await p.quote('RUTUSD')) as Quote;
    expect(q.source).toBe('etf');
    expect(q.mid).toBeCloseTo(m.px * 10.9, 4);
    expect(q.delayMs).toBeUndefined();
    expect(p.etfTick('RUTUSD')).toMatchObject({ id: 'RUTUSD' });
  });

  it('never opens a Russell trade on Yahoo\'s late futures price', async () => {
    const p = make();
    p.etfFetch = async () => null; // no live ETF price (e.g. 22:00 New York)
    const late: Quote = { id: 'RUTUSD', mid: 2400, bid: 2399.5, ask: 2400.5, t: NOW, bars: [[NOW - MIN, 2401, 2399, 2400]], dayChangePct: null, source: 'yahoo', priceT: NOW - 10 * MIN };
    (p as unknown as { cache: Map<string, Quote> }).cache.set('RUTUSD', late);
    const r = await p.open({ pair: 'RUTUSD', side: 1, marginUsd: 50, leverage: 10, stop: 2380, target: 2440, maxQuoteAgeMs: 10 * MIN, feedDelayOk: true }, 'bot');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no live price for RUTUSD/);
  });
});
