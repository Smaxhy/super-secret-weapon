/** v27.48 (owner: OANDA's demo login fails): live index / metal prices from Hyperliquid's builder markets + the gap. */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { HyperliquidLive, matchFutures } from '../src/forex/hyperliquid';
import { Practice, type Quote } from '../src/forex/practice';
import type { LiveSocket } from '../src/forex/yahoo-live';

const NOW = Date.UTC(2026, 9, 27, 15, 0); // a Tuesday, CME open

describe('finding the index / metal markets', () => {
  it('matches builder markets only (the main dex "SPX" is a memecoin)', () => {
    expect(matchFutures(['SPX', 'BTC', 'xyz:XYZ100', 'xyz:GOLD', 'xyz:SILVER', 'km:US500', 'abc:NVDA'])).toEqual({ NDXUSD: 'xyz:XYZ100', SPXUSD: 'km:US500', XAUUSD: 'xyz:GOLD', XAGUSD: 'xyz:SILVER' });
    expect(matchFutures(['SPX', 'PAXG'])).toEqual({});
  });

  it('discovers, subscribes and keeps the raw price out of the coin feed', async () => {
    const sent: string[] = [];
    const h: Record<string, (x?: unknown) => void> = {};
    const sock = { on: (ev: string, fn: (x?: unknown) => void) => void (h[ev] = fn), send: (d: string) => void sent.push(d), terminate: () => undefined } as unknown as LiveSocket;
    const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { type: string; dex?: string };
      const json = b.type === 'perpDexs' ? [null, { name: 'xyz' }] : b.type === 'meta' ? { universe: [{ name: 'xyz:XYZ100' }, { name: 'xyz:TSLA' }] } : [{ t: NOW - 60_000, c: '28950' }];
      return { ok: true, status: 200, json: async () => json };
    });
    const live = new HyperliquidLive(() => sock, () => NOW, undefined, fetcher);
    live.start();
    h.open!();
    await live.discover();
    expect(live.futuresFound()).toEqual({ NDXUSD: 'xyz:XYZ100' });
    expect(sent.some((x) => x.includes('xyz:XYZ100'))).toBe(true);
    const ticks: unknown[] = [];
    live.onTicks((t) => ticks.push(...t));
    h.message!(JSON.stringify({ channel: 'l2Book', data: { coin: 'xyz:XYZ100', time: NOW, levels: [[{ px: '28949' }], [{ px: '28951' }]] } }));
    expect(live.book('NDXUSD')).toMatchObject({ bid: 28949, ask: 28951 });
    expect(live.get('NDXUSD')).toBeNull(); // never the raw price
    expect(ticks).toHaveLength(0);
    expect(await live.candles('NDXUSD')).toEqual([[NOW - 60_000, 28950]]);
    live.stop();
  });
});

describe('practice prices from Hyperliquid', () => {
  const make = () => {
    vi.useFakeTimers({ now: NOW });
    const p = new Practice({ get: async () => null } as unknown as Redis);
    p.hl = { book: () => ({ bid: 28_949, ask: 28_951, t: NOW }), candles: async () => [], futBars: () => [[NOW - 60_000, 28_960, 28_940, 28_950, 28_945]] };
    (p as unknown as { measureBasisFor: () => Promise<void> }).measureBasisFor = async () => undefined;
    return p;
  };
  it('the Nasdaq goes live at Hyperliquid + gap once the gap is measured; before, Yahoo as usual', async () => {
    const p = make();
    const before = await p.quote('NDXUSD').catch(() => null);
    expect(before?.source).not.toBe('hyperliquid');
    (p as unknown as { basis: Map<string, { basis: number; n: number; at: number }> }).basis.set('hl:NDXUSD', { basis: 80, n: 30, at: NOW });
    const q = (await p.quote('NDXUSD')) as Quote;
    expect(q).toMatchObject({ source: 'hyperliquid', mid: 29_030, bid: 29_029, ask: 29_031, priceT: NOW });
    expect(q.bars[0]).toEqual([NOW - 60_000, 29_040, 29_020, 29_030, 29_025]);
    expect(p.basisNow().NDXUSD).toMatchObject({ basis: 80, src: 'hl' });
    vi.useRealTimers();
  });
  it('not on a weekend (the CME market is shut, the builder market keeps moving)', async () => {
    const p = make();
    vi.setSystemTime(Date.UTC(2026, 9, 31, 15, 0)); // Saturday
    (p as unknown as { basis: Map<string, { basis: number; n: number; at: number }> }).basis.set('hl:NDXUSD', { basis: 80, n: 30, at: Date.now() });
    const q = await p.quote('NDXUSD').catch(() => null);
    expect(q?.source).not.toBe('hyperliquid');
    vi.useRealTimers();
  });
});

describe('v27.75 Dow / Russell names + the ones it could not match', async () => {
  const { lookalikes } = await import('../src/forex/hyperliquid');
  it('matches more Dow / Russell names and lists unknown index-like markets', () => {
    expect(matchFutures(['xyz:XYZ100', 'km:USA30', 'abc:R2K', 'xyz:GOLD'])).toMatchObject({ DJIUSD: 'km:USA30', RUTUSD: 'abc:R2K' });
    const found = matchFutures(['xyz:XYZ100', 'xyz:GOLD', 'zz:US30X', 'zz:NVDA']);
    expect(lookalikes(['xyz:XYZ100', 'xyz:GOLD', 'zz:US30X', 'zz:NVDA', 'BTC'], found)).toEqual(['zz:US30X']);
  });
});
