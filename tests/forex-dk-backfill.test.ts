import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DK, DK_META, DK_TAIL, dkKey, loadDk, refreshDkTail, refreshDukascopy, type DkMeta } from '../src/forex/dukascopy';
import { clearSpreadProfiles } from '../src/forex/spreads';
import { feeds } from '../src/forex/feeds';

const H = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 14, 5); // a Wednesday afternoon, market open

class MiniRedis {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
}
const asRedis = (r: MiniRedis) => r as unknown as Redis;

interface Call {
  id: string;
  side: 'bid' | 'ask';
  from: number;
  to: number;
}

/**
 * Fake Dukascopy: hourly bid / ask candles WITH a real range and volume (midBars drops flat / zero-volume rows), only
 * for `ids`, only from `dataFrom` on; `fail(call)` → that request throws; `empty(call)` → it silently returns nothing
 * (what dukascopy-node does on HTTP errors / throttling with `failAfterRetryCount: false`).
 */
function fakeDk(opts: { ids: string[]; dataFrom?: number; fail?: (c: Call) => boolean; empty?: (c: Call) => boolean }) {
  const calls: Call[] = [];
  const fetcher = async (id: string, side: 'bid' | 'ask', from: Date, to: Date): Promise<number[][]> => {
    const c = { id, side, from: from.getTime(), to: to.getTime() };
    calls.push(c);
    if (opts.fail?.(c)) throw new Error('dukascopy down');
    if (opts.empty?.(c)) return [];
    if (!opts.ids.includes(id)) return [];
    const rows: number[][] = [];
    const pip = id.includes('JPY') ? 0.01 : 0.0001;
    const base = id.includes('JPY') ? 150 : 1.1;
    for (let t = Math.ceil(Math.max(c.from, opts.dataFrom ?? 0) / H) * H; t < c.to; t += H) {
      const p = base + Math.sin(t / (9 * H)) * 50 * pip + (side === 'ask' ? 0.5 * pip : -0.5 * pip);
      rows.push([t, p, p + 3 * pip, p - 3 * pip, p + pip, 7]);
    }
    return rows;
  };
  return { calls, fetcher };
}

const histFrom = (now: number) => now - DK.historyDays * DAY;
const metaOf = (r: MiniRedis) => JSON.parse(r.m.get(DK_META)!) as DkMeta;
const maxGap = (ts: number[]) => ts.slice(1).reduce((g, t, i) => Math.max(g, t - ts[i]!), 0);

// note: refreshDkTail throttles per market (module state) — every test below uses its own markets
const pause = DK.pauseMs;
const budget = DK_TAIL.budgetMs;
beforeEach(() => {
  feeds.ok('dk-history'); // Dukascopy's breaker closed
});
afterEach(() => {
  DK.pauseMs = pause;
  DK_TAIL.budgetMs = budget;
  vi.useRealTimers();
  clearSpreadProfiles();
});

describe('v17 Dukascopy back-fill after a tail fetch on an empty store', () => {
  it('a 3-day tail does not block the full history: the next refresh downloads the older range and records full', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    const dk = fakeDk({ ids: ['EURUSD'] });
    const tail = await refreshDkTail(asRedis(redis), ['EURUSD'], NOW, dk.fetcher);
    expect(tail.EURUSD!.error).toBeNull();
    const afterTail = await loadDk(asRedis(redis), 'EURUSD');
    expect(afterTail[0]!.t).toBeGreaterThan(NOW - 4 * DAY); // only the newest days

    dk.calls.length = 0;
    const meta = await refreshDukascopy(asRedis(redis), NOW + H, dk.fetcher);
    const eurCalls = dk.calls.filter((c) => c.id === 'EURUSD');
    // the old range is requested, all the way back to now − historyDays
    expect(Math.min(...eurCalls.map((c) => c.from))).toBe(histFrom(NOW + H));
    // newest piece first: the first back-fill request ends at the oldest stored bar
    const back = eurCalls.filter((c) => c.to <= afterTail[0]!.t);
    expect(back[0]!.to).toBe(afterTail[0]!.t);
    expect(back.map((c) => c.to)).toEqual([...back.map((c) => c.to)].sort((a, b) => b - a));
    const eur = await loadDk(asRedis(redis), 'EURUSD');
    expect(eur[0]!.t).toBeLessThanOrEqual(histFrom(NOW + H) + DK.slackDays * DAY);
    expect(eur.length).toBeGreaterThan(15_000);
    expect(maxGap(eur.map((b) => b.t))).toBeLessThan(3 * DAY); // weekends only, no hole at the seam
    expect(meta.ids.EURUSD!.error).toBeNull();
    expect(meta.ids.EURUSD!.full).toBe(true);
  }, 60_000);

  it('a second refresh does not re-request the old range once it reaches back', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    const dk = fakeDk({ ids: ['USDJPY'] });
    const tail = await refreshDkTail(asRedis(redis), ['USDJPY'], NOW, dk.fetcher);
    expect(tail.USDJPY!.added).toBeGreaterThan(40);
    const m1 = await refreshDukascopy(asRedis(redis), NOW + H, dk.fetcher);
    expect(m1.ids.USDJPY!.full).toBe(true);
    expect(m1.ids.USDJPY!.error).toBeNull();

    dk.calls.length = 0;
    const later = NOW + H + DK.refreshHours * H + H;
    const m2 = await refreshDukascopy(asRedis(redis), later, dk.fetcher);
    // only the newest days: one forward piece, starting a day before the newest stored bar
    const mine = dk.calls.filter((c) => c.id === 'USDJPY');
    expect(mine).toHaveLength(2);
    expect(Math.min(...mine.map((c) => c.from))).toBeGreaterThanOrEqual(later - 3 * DAY);
    expect(m2.ids.USDJPY!.full).toBe(true);
    expect(m2.ids.USDJPY!.firstT!).toBeLessThanOrEqual(histFrom(later) + DK.slackDays * DAY);
    expect(metaOf(redis).ids.USDJPY!.full).toBe(true);
  }, 60_000);

  it('a market with truly no older data: trusted only after `backfillTries` empty back-fills in a row, then left alone', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    const young = NOW - 200 * DAY; // GBPUSD: nothing older than 200 days at Dukascopy
    const gbp = fakeDk({ ids: ['GBPUSD'], dataFrom: young });
    await refreshDkTail(asRedis(redis), ['GBPUSD'], NOW, gbp.fetcher);
    let t = NOW + H;
    const m1 = await refreshDukascopy(asRedis(redis), t, gbp.fetcher);
    // the back-fill got everything there is, then stopped at the first piece that brought nothing older
    expect(m1.ids.GBPUSD!.firstT!).toBeLessThan(young + 4 * DAY);
    expect(Math.min(...gbp.calls.filter((c) => c.id === 'GBPUSD').map((c) => c.from))).toBeGreaterThan(histFrom(t));
    expect(m1.ids.GBPUSD!.full).toBe(false); // "no error" is not proof that nothing older exists
    expect(m1.ids.GBPUSD!.error).toMatch(/older history: only back to/);
    const firstT = m1.ids.GBPUSD!.firstT!;

    for (let k = 1; k <= DK.backfillTries; k++) {
      gbp.calls.length = 0;
      t += DK.refreshHours * H + H;
      const m = await refreshDukascopy(asRedis(redis), t, gbp.fetcher);
      const back = gbp.calls.filter((c) => c.id === 'GBPUSD' && c.to <= firstT);
      expect(back).toHaveLength(2); // one piece (bid + ask) that came back empty
      expect(back[0]!.to).toBe(firstT);
      expect(m.ids.GBPUSD!.firstT).toBe(firstT);
      if (k < DK.backfillTries) {
        expect(m.ids.GBPUSD!.full).toBe(false);
        expect(m.ids.GBPUSD!.tries).toBe(k);
        expect(m.ids.GBPUSD!.error).toMatch(/older history: nothing returned before/);
      } else {
        expect(m.ids.GBPUSD!.full).toBe(true);
        expect(m.ids.GBPUSD!.error).toBeNull();
        expect(m.ids.GBPUSD!.note).toMatch(/taken as where the data starts/);
      }
    }

    // from now on only the newest days
    gbp.calls.length = 0;
    t += DK.refreshHours * H + H;
    const m = await refreshDukascopy(asRedis(redis), t, gbp.fetcher);
    const mine = gbp.calls.filter((c) => c.id === 'GBPUSD');
    expect(mine).toHaveLength(2);
    expect(Math.min(...mine.map((c) => c.from))).toBeGreaterThanOrEqual(t - 3 * DAY);
    expect(m.ids.GBPUSD!.full).toBe(true);
    expect(m.ids.GBPUSD!.error).toBeNull();
  }, 60_000);

  it('a back-fill Dukascopy answers with nothing (silent HTTP error / throttling) is not marked full and is retried', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    let silent = true;
    const dk = fakeDk({ ids: ['GBPJPY'], empty: (c) => silent && c.id === 'GBPJPY' && c.to < NOW - 2 * DAY });
    await refreshDkTail(asRedis(redis), ['GBPJPY'], NOW, dk.fetcher);
    const t1 = NOW + H;
    const m1 = await refreshDukascopy(asRedis(redis), t1, dk.fetcher);
    expect(m1.ids.GBPJPY!.error).toMatch(/older history: nothing returned before/);
    expect(m1.ids.GBPJPY!.full).toBe(false);
    expect(m1.ids.GBPJPY!.tries).toBe(1);
    const short = await loadDk(asRedis(redis), 'GBPJPY');
    expect(short[0]!.t).toBeGreaterThan(NOW - 4 * DAY);

    // Dukascopy answers again: the next refresh asks for the old range again and the history reaches back
    silent = false;
    dk.calls.length = 0;
    const t2 = t1 + DK.refreshHours * H + H;
    const m2 = await refreshDukascopy(asRedis(redis), t2, dk.fetcher);
    const back = dk.calls.filter((c) => c.id === 'GBPJPY' && c.to <= short[0]!.t);
    expect(back[0]!.to).toBe(short[0]!.t);
    expect(Math.min(...back.map((c) => c.from))).toBe(histFrom(t2));
    expect(m2.ids.GBPJPY!.error).toBeNull();
    expect(m2.ids.GBPJPY!.full).toBe(true);
    expect(m2.ids.GBPJPY!.tries).toBeUndefined();
    const all = await loadDk(asRedis(redis), 'GBPJPY');
    expect(all[0]!.t).toBeLessThanOrEqual(histFrom(t2) + DK.slackDays * DAY);
    expect(maxGap(all.map((b) => b.t))).toBeLessThan(3 * DAY);
  }, 60_000);

  it('a first download whose oldest pieces came back empty is not full: the next refresh back-fills it', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    let silent = true;
    const dk = fakeDk({ ids: ['EURAUD'], empty: (c) => silent && c.from < NOW - 300 * DAY });
    const m1 = await refreshDukascopy(asRedis(redis), NOW, dk.fetcher);
    expect(m1.ids.EURAUD!.full).toBe(false);
    expect(m1.ids.EURAUD!.error).toMatch(/older history: only back to/);
    expect(m1.ids.EURAUD!.firstT!).toBeGreaterThan(NOW - 300 * DAY);
    silent = false;
    const t2 = NOW + DK.refreshHours * H + H;
    const m2 = await refreshDukascopy(asRedis(redis), t2, dk.fetcher);
    expect(m2.ids.EURAUD!.full).toBe(true);
    expect(m2.ids.EURAUD!.error).toBeNull();
    expect(m2.ids.EURAUD!.firstT!).toBeLessThanOrEqual(histFrom(t2) + DK.slackDays * DAY);
    expect(maxGap((await loadDk(asRedis(redis), 'EURAUD')).map((b) => b.t))).toBeLessThan(3 * DAY);
  }, 60_000);

  it('a back-fill that throws is not marked full and is retried — from the oldest bar it got, no hole', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    const t1 = NOW + H;
    let down = true;
    // the oldest part fails on the first refresh (pieces older than 600 days)
    const dk = fakeDk({ ids: ['AUDUSD'], fail: (c) => down && c.id === 'AUDUSD' && c.from < t1 - 600 * DAY });
    await refreshDkTail(asRedis(redis), ['AUDUSD'], NOW, dk.fetcher);
    const m1 = await refreshDukascopy(asRedis(redis), t1, dk.fetcher);
    expect(m1.ids.AUDUSD!.error).toMatch(/older history: dukascopy down/);
    expect(m1.ids.AUDUSD!.full).toBe(false);
    const partial = await loadDk(asRedis(redis), 'AUDUSD');
    expect(partial[0]!.t).toBeGreaterThan(histFrom(t1) + DK.slackDays * DAY); // didn't reach back…
    expect(partial[0]!.t).toBeLessThan(t1 - 500 * DAY); // …but kept what it got
    expect(maxGap(partial.map((b) => b.t))).toBeLessThan(3 * DAY); // contiguous (newest piece first)

    // within the refresh window nothing happens; after it, the back-fill is retried and goes on from the oldest bar
    down = false;
    dk.calls.length = 0;
    await refreshDukascopy(asRedis(redis), t1 + H, dk.fetcher);
    expect(dk.calls).toHaveLength(0);
    const t2 = t1 + DK.refreshHours * H + H;
    const m2 = await refreshDukascopy(asRedis(redis), t2, dk.fetcher);
    const back = dk.calls.filter((c) => c.id === 'AUDUSD' && c.to <= partial[0]!.t);
    expect(back.length).toBeGreaterThan(0);
    expect(back[0]!.to).toBe(partial[0]!.t); // the middle isn't downloaded again
    expect(Math.min(...back.map((c) => c.from))).toBe(histFrom(t2));
    expect(m2.ids.AUDUSD!.error).toBeNull();
    expect(m2.ids.AUDUSD!.full).toBe(true);
    const eur = await loadDk(asRedis(redis), 'AUDUSD');
    expect(eur[0]!.t).toBeLessThanOrEqual(histFrom(t2) + DK.slackDays * DAY);
    expect(maxGap(eur.map((b) => b.t))).toBeLessThan(3 * DAY);
  }, 60_000);

  it('a store from before the fix that reaches back needs no back-fill and is marked full', async () => {
    DK.pauseMs = 0;
    const redis = new MiniRedis();
    const dk = fakeDk({ ids: ['EURUSD'] });
    await refreshDukascopy(asRedis(redis), NOW, dk.fetcher);
    // an old meta without `full`
    const old = metaOf(redis);
    for (const v of Object.values(old.ids)) delete v.full;
    redis.m.set(DK_META, JSON.stringify(old));
    dk.calls.length = 0;
    const later = NOW + DK.refreshHours * H + H;
    const m = await refreshDukascopy(asRedis(redis), later, dk.fetcher);
    expect(dk.calls.filter((c) => c.id === 'EURUSD')).toHaveLength(2);
    expect(m.ids.EURUSD!.full).toBe(true);
    expect(redis.m.has(dkKey('EURUSD'))).toBe(true);
  }, 60_000);
});

describe('v17 Dukascopy tail fetch keeps to its time budget', () => {
  it('a request that never answers is cut off at the budget: that market errors, nothing is saved, the run stops', async () => {
    DK_TAIL.budgetMs = 300;
    const redis = new MiniRedis();
    const asked: string[] = [];
    const never = (id: string) => {
      asked.push(id);
      return new Promise<number[][]>(() => undefined);
    };
    const t0 = Date.now();
    const out = await refreshDkTail(asRedis(redis), ['NZDUSD', 'USDCAD', 'EURJPY'], NOW, never);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(1_500);
    expect(out.NZDUSD!.error).toMatch(/timed out/);
    expect(out.USDCAD).toBeUndefined();
    expect(asked).toEqual(['NZDUSD']);
    expect(redis.m.size).toBe(0);
  });

  it('a request the budget timed out ends the run even when the wall clock says time is left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // Date frozen: elapsed reads 0 forever, the (real) timer still fires
    vi.setSystemTime(NOW);
    DK_TAIL.budgetMs = 200;
    const redis = new MiniRedis();
    const asked: string[] = [];
    const never = (id: string) => {
      asked.push(id);
      return new Promise<number[][]>(() => undefined);
    };
    const out = await refreshDkTail(asRedis(redis), ['CADJPY', 'NZDJPY', 'CHFJPY'], NOW, never);
    expect(asked).toEqual(['CADJPY']);
    expect(out.CADJPY!.error).toMatch(/timed out/);
    expect(out.NZDJPY).toBeUndefined();
    expect(redis.m.size).toBe(0);
  });

  it('the budget is checked again before the ask side', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const redis = new MiniRedis();
    const sides: string[] = [];
    const slowBid = async (id: string, side: 'bid' | 'ask') => {
      sides.push(`${id}:${side}`);
      vi.setSystemTime(Date.now() + DK_TAIL.budgetMs + 1_000); // the bid answer came back after the budget
      return [[NOW - 5 * H, 1.1, 1.1003, 1.0997, 1.1001, 7]];
    };
    const out = await refreshDkTail(asRedis(redis), ['USDCHF', 'EURGBP'], NOW, slowBid);
    expect(sides).toEqual(['USDCHF:bid']);
    expect(out.USDCHF!.error).toMatch(/budget/);
    expect(out.EURGBP).toBeUndefined();
    expect(redis.m.size).toBe(0);
  });
});
