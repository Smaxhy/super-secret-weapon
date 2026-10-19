import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { newAccount, Practice, view, type LiveSource, type PracticePosition } from '../src/forex/practice';
import { LIVE_PUSH_MS, pushPayload, startLivePush } from '../src/forex/live-push';
import { bus, type BusEvent } from '../src/lib/bus';
import type { LiveTick } from '../src/forex/pyth';

const now0 = Date.UTC(2026, 9, 20, 10, 0, 30);
const yahooBody = (price: number, prev: number) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: Math.floor(now0 / 1000) - 30, chartPreviousClose: prev }, timestamp: [Math.floor(now0 / 1000) - 60], indicators: { quote: [{ open: [price], high: [price], low: [price], close: [price] }] } }] },
});
const fakeLive = (px: Record<string, number>): LiveSource => ({
  get: (id) => (px[id] ? { px: px[id]!, t: now0 - 800, bars: [[now0 - 30_000, px[id]! + 0.0005, px[id]! - 0.0005, px[id]!, px[id]!]] } : null),
  flowing: () => true,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('v17.9 practice prices: live Pyth first for currency pairs', () => {
  it('a live price is used (synthetic spread, its candles, its time); the day change comes from Yahoo in the background', async () => {
    vi.useFakeTimers({ now: now0, toFake: ['Date'] });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => yahooBody(1.0999, 1.09) }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new Practice({} as Redis);
    p.live = fakeLive({ EURUSD: 1.1 });
    const q = (await p.quote('EURUSD'))!;
    expect(q.source).toBe('pyth');
    expect(q.mid).toBe(1.1);
    expect(q.bid).toBeLessThan(1.1);
    expect(q.ask).toBeGreaterThan(1.1);
    expect(q.priceT).toBe(now0 - 800);
    expect(q.bars).toHaveLength(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setImmediate(r));
    const q2 = (await p.quote('EURUSD'))!;
    expect(q2.dayChangePct).toBeCloseTo((1.1 / 1.09 - 1) * 100, 2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second background read inside 30 min
  });

  it('metals never take the live price; no live price → the Yahoo path as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => yahooBody(2650.5, 2640) })));
    const p = new Practice({} as Redis);
    p.live = fakeLive({ XAUUSD: 2600 });
    const g = (await p.quote('XAUUSD'))!;
    expect(g.source).toBe('yahoo');
    expect(g.mid).toBe(2650.5);
    expect(g.prevClose).toBe(2640);
    p.live = fakeLive({});
    const e = (await p.quote('GBPUSD'))!;
    expect(e.source).toBe('yahoo');
  });

  it('checks stops every second while live prices flow (v17.10), every 15 s otherwise, never two at once', async () => {
    vi.useFakeTimers();
    const p = new Practice({} as Redis);
    let flowing = true;
    p.live = { get: () => null, flowing: () => flowing };
    const check = vi.fn(async () => undefined);
    (p as unknown as { checkOpen: () => Promise<void> }).checkOpen = check;
    p.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(check).toHaveBeenCalledTimes(20);
    flowing = false;
    check.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    // a slow check: the next ones wait for it
    flowing = true;
    check.mockClear();
    check.mockImplementation(() => new Promise((r) => setTimeout(r, 12_000)));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(check).toHaveBeenCalledTimes(1);
    p.stop();
  });
});

describe('v17.9 live P&L sensitivity', () => {
  const pos = (pair: string, side: 1 | -1, units: number, entry: number): PracticePosition => ({ id: pair, pair, side, units, entry, marginUsd: 100, leverage: 30, stop: null, target: null, openedAt: 0, checkedT: 0 });
  it('pnlPerPx = USD per 1.0 move of the exit price (USD-quoted exact, JPY-quoted the local slope)', () => {
    const a = newAccount(1000);
    a.open = [pos('EURUSD', 1, 10_000, 1.1), pos('USDJPY', -1, 10_000, 150)];
    const v = view(a, { EURUSD: 1.11, USDJPY: 151 }, { EURUSD: 0, USDJPY: 0 });
    const eu = v.positions.find((x) => x.pair === 'EURUSD')!;
    expect(eu.pnlPerPx).toBeCloseTo(10_000, 3);
    const uj = v.positions.find((x) => x.pair === 'USDJPY')!;
    // short USD/JPY: P&L = −units × (px − entry) / px → slope −units × entry / px²
    expect(uj.pnlPerPx!).toBeCloseTo((-10_000 * 150) / (151 * 151), 2);
    // a small move: live estimate ≈ the real P&L
    const est = uj.pnlUsd + (151.05 - uj.px) * uj.pnlPerPx!;
    const real = view(a, { EURUSD: 1.11, USDJPY: 151.05 }, { EURUSD: 0, USDJPY: 0 }).positions.find((x) => x.pair === 'USDJPY')!.pnlUsd;
    expect(Math.abs(est - real)).toBeLessThan(0.05);
  });
});

describe('v17.9 live push', () => {
  it('folds the ticks since the last push per pair into one bus event with bid / ask; quiet moments send nothing', async () => {
    vi.useFakeTimers();
    let emit: ((t: LiveTick[]) => void) | null = null;
    const seen: BusEvent[] = [];
    const listen = (e: BusEvent) => seen.push(e);
    bus.on('event', listen);
    const stop = startLivePush({ onTicks: (fn) => ((emit = fn), () => (emit = null)) });
    emit!([{ id: 'EURUSD', mid: 1.1, conf: 0.0001, t: 1 }, { id: 'FOOBAR', mid: 1, conf: 0, t: 1 }]);
    emit!([{ id: 'EURUSD', mid: 1.1002, conf: 0.0001, t: 2 }]);
    // v17.10: pushed within 200 ms (was once a second)
    await vi.advanceTimersByTimeAsync(LIVE_PUSH_MS);
    expect(seen.filter((e) => e.type === 'fx')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    stop();
    bus.off('event', listen);
    const fx = seen.filter((e) => e.type === 'fx');
    expect(fx).toHaveLength(1);
    const px = (fx[0] as Extract<BusEvent, { type: 'fx' }>).data.px;
    expect(Object.keys(px)).toEqual(['EURUSD']);
    const [mid, bid, ask, t] = px.EURUSD!;
    expect(mid).toBe(1.1002);
    expect(bid).toBeLessThan(mid);
    expect(ask).toBeGreaterThan(mid);
    expect(t).toBe(2);
    expect(emit).toBeNull();
  });

  it('pushPayload drops unknown pairs and bad prices', () => {
    expect(pushPayload([{ id: 'XXXYYY', mid: 1, conf: 0, t: 0 }, { id: 'EURUSD', mid: 0, conf: 0, t: 0 }], 0)).toEqual({});
  });
});
