import { describe, expect, it } from 'vitest';
import { DATABENTO, DB_META, backAdjust, dbKey, everyMs, invertBars, loadDb, stitchSpot, parseDbPx, parseDbTime, parseOhlcvCsv, refreshDatabento, stitchFutures, testDatabentoKey, type DbFetch } from '../src/forex/databento';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const D = 86_400_000;

function fakeRedis() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => (m.set(k, v), 'OK' as const) };
}

/** a fake Databento: hourly bars from `startAt` on, cost $0.01 a request (`price` overrides) */
function fakeDb(o: { end: number; startAt: number; price?: number; calls?: string[] }): DbFetch {
  return async (url, init) => {
    o.calls?.push(url.split('/v0/')[1]!.split('?')[0]!);
    const auth = init.headers.authorization ?? '';
    if (auth !== `Basic ${Buffer.from('db-testkey123456789:').toString('base64')}`) return { ok: false, status: 401, text: async () => '{"detail":"bad key"}' };
    if (url.includes('metadata.list_datasets')) return { ok: true, status: 200, text: async () => '["GLBX.MDP3","XNAS.ITCH"]' };
    if (url.includes('metadata.get_dataset_range')) return { ok: true, status: 200, text: async () => JSON.stringify({ start: '2010-06-06T00:00:00Z', end: new Date(o.end).toISOString() }) };
    const p = new URLSearchParams(init.body ?? '');
    if (url.includes('metadata.get_cost')) return { ok: true, status: 200, text: async () => String(o.price ?? 0.01) };
    const a = Math.max(Date.parse(p.get('start')!), o.startAt);
    const b = Date.parse(p.get('end')!);
    const rows = ['ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol'];
    for (let t = Math.ceil(a / H) * H; t < b; t += H) {
      const px = 20000 + ((t / H) % 50);
      rows.push(`${new Date(t).toISOString().replace('.000Z', '.000000000Z')},34,1,42,${px},${px + 5},${px - 5},${px + 1},${100 + ((t / H) % 7)},NQ.v.0`);
    }
    return { ok: true, status: 200, text: async () => rows.join('\n') };
  };
}

describe('v27.91 Databento CME history', () => {
  it('reads timestamps and prices in every form Databento sends', () => {
    expect(parseDbTime('2025-01-02T14:00:00.000000000Z')).toBe(Date.UTC(2025, 0, 2, 14));
    expect(parseDbTime('1735826400000000000')).toBe(Date.UTC(2025, 0, 2, 14));
    expect(parseDbPx('21034.25')).toBe(21034.25);
    expect(parseDbPx('21034250000000')).toBeCloseTo(21034.25, 6);
    const bars = parseOhlcvCsv('ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol\n2025-01-02T14:00:00.000000000Z,34,1,42,100,101,99,100.5,250,NQ.v.0\n2025-01-02T15:00:00.000000000Z,34,1,42,100.5,102,100,101.5,0,NQ.v.0\n');
    expect(bars).toEqual([
      { t: Date.UTC(2025, 0, 2, 14), o: 100, h: 101, l: 99, c: 100.5, v: 250, iid: 42 },
      { t: Date.UTC(2025, 0, 2, 15), o: 100.5, h: 102, l: 100, c: 101.5, iid: 42 },
    ]);
  });

  it('tests a key on the dataset list and refuses a wrong one', async () => {
    const f = fakeDb({ end: Date.UTC(2026, 9, 27), startAt: 0 });
    expect(await testDatabentoKey('db-testkey123456789', f)).toEqual({ ok: true, datasets: 2 });
    const bad = await testDatabentoKey('db-wrongkey123456789', f);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/401/);
  });

  it('downloads newest first, back-fills to where Databento starts, prices every request', async () => {
    const r = fakeRedis();
    const now = Date.UTC(2026, 9, 28);
    const end = now - D;
    const calls: string[] = [];
    const meta = await refreshDatabento(r as never, 'db-testkey123456789', now, fakeDb({ end, startAt: end - 400 * D, calls }), ['NDXUSD']);
    expect(meta.error).toBeNull();
    const bars = await loadDb(r as never, 'NDXUSD');
    expect(bars[0]!.t).toBe(end - 400 * D);
    expect(bars[bars.length - 1]!.t).toBe(end - H);
    expect(bars[0]!.v).toBeGreaterThan(0);
    expect(meta.ids.NDXUSD!.full).toBe(true);
    // every download was priced first
    expect(calls.filter((c) => c === 'timeseries.get_range').length).toBe(calls.filter((c) => c === 'metadata.get_cost').length);
    expect(meta.spentUsd).toBeCloseTo(0.01 * calls.filter((c) => c === 'timeseries.get_range').length, 6);
    // the next run only catches up the new hours
    const calls2: string[] = [];
    await refreshDatabento(r as never, 'db-testkey123456789', now + 2 * H, fakeDb({ end: end + 2 * H, startAt: end - 400 * D, calls: calls2 }), ['NDXUSD']);
    expect(calls2.filter((c) => c === 'timeseries.get_range').length).toBe(1);
    expect((await loadDb(r as never, 'NDXUSD')).at(-1)!.t).toBe(end + H);
  });

  it('stops at the spend cap and never downloads an over-priced piece', async () => {
    const r = fakeRedis();
    const now = Date.UTC(2026, 9, 28);
    await r.set(DB_META, JSON.stringify({ at: 0, spentUsd: DATABENTO.maxUsd - 0.005, availEnd: null, ids: {}, error: null }));
    const meta = await refreshDatabento(r as never, 'db-testkey123456789', now, fakeDb({ end: now, startAt: now - 100 * D }), ['NDXUSD']);
    expect(meta.error).toMatch(/spend cap/);
    expect(r.m.has(dbKey('NDXUSD'))).toBe(false);
    const r2 = fakeRedis();
    const m2 = await refreshDatabento(r2 as never, 'db-testkey123456789', now, fakeDb({ end: now, startAt: now - 100 * D, price: 50 }), ['NDXUSD']);
    expect(m2.ids.NDXUSD!.error).toMatch(/would cost \$50/);
    expect(m2.spentUsd).toBe(0);
  });

  it('puts older bars in front of Yahoo only when the seam lines up', () => {
    const now = Date.UTC(2026, 9, 28);
    const y: Bar[] = [{ t: now - 10 * D, o: 100, h: 101, l: 99, c: 100 }];
    const db: Bar[] = [{ t: now - 10 * D - H, o: 99.9, h: 100.2, l: 99.8, c: 100.05, v: 5 }, { t: now - 10 * D, o: 1, h: 1, l: 1, c: 1 }];
    expect(stitchFutures(y, db, now)).toEqual([db[0], y[0]]);
    const rolled: Bar[] = [{ t: now - 10 * D - H, o: 103, h: 103, l: 103, c: 103 }];
    expect(stitchFutures(y, rolled, now)).toEqual(y);
  });

  it('v28.14: a slow market no longer starves the rest — every market is caught up, the emptiest back-filled first', async () => {
    const r = fakeRedis();
    const now = Date.UTC(2026, 9, 28);
    const end = now - D;
    // NDX already holds a little history, gold none
    await r.set(dbKey('NDXUSD'), JSON.stringify([[end - 30 * D, 1, 1, 1, 1, 0]]));
    const saved = DATABENTO.budgetMs;
    DATABENTO.budgetMs = 0; // budget gone after the first download
    try {
      await refreshDatabento(r as never, 'db-testkey123456789', now, fakeDb({ end, startAt: end - 400 * D }), ['NDXUSD', 'XAUUSD']);
    } finally {
      DATABENTO.budgetMs = saved;
    }
    // with no time left nothing downloads, but the order puts gold (empty) ahead of NDX for the back-fill
    const meta = JSON.parse(r.m.get(DB_META)!);
    expect(Object.keys(meta.ids)).toEqual(['NDXUSD', 'XAUUSD']);
    DATABENTO.budgetMs = 60_000;
    try {
      await refreshDatabento(r as never, 'db-testkey123456789', now, fakeDb({ end, startAt: end - 400 * D }), ['NDXUSD', 'XAUUSD']);
    } finally {
      DATABENTO.budgetMs = saved;
    }
    expect((await loadDb(r as never, 'XAUUSD')).length).toBeGreaterThan(1000);
    expect((await loadDb(r as never, 'NDXUSD')).length).toBeGreaterThan(1000);
  });

  it('v28.14: currency futures are back-adjusted at rolls, inverted for USD/JPY and scaled onto spot', () => {
    // contract 1 at 0.0070, roll to contract 2 one step higher (forward points), then Yahoo spot ~0.6% off
    const fut = [
      { t: 0, o: 0.007, h: 0.00701, l: 0.00699, c: 0.007, iid: 1 },
      { t: H, o: 0.007, h: 0.00701, l: 0.00699, c: 0.007, iid: 1 },
      { t: 2 * H, o: 0.00705, h: 0.00706, l: 0.00704, c: 0.00705, iid: 2 },
      { t: 3 * H, o: 0.00705, h: 0.00706, l: 0.00704, c: 0.00705, iid: 2 },
    ];
    const adj = backAdjust(fut);
    // no step left at the roll: the old contract was scaled up to the new one
    expect(adj[1]!.c).toBeCloseTo(adj[2]!.o, 9);
    expect(adj[3]!.c).toBe(0.00705);
    const inv = invertBars(adj);
    expect(inv[3]!.c).toBeCloseTo(1 / 0.00705, 6);
    expect(inv[3]!.h).toBeCloseTo(1 / 0.00704, 6); // high ↔ low
    const spot0 = (1 / 0.00705) * 1.006;
    const yahoo: Bar[] = [{ t: 4 * H, o: spot0, h: spot0 + 0.1, l: spot0 - 0.1, c: spot0 }];
    const out = stitchSpot('USDJPY', yahoo, fut, 5 * H, 10);
    expect(out.length).toBe(5);
    expect(out[3]!.c).toBeCloseTo(spot0, 6); // seam lines up with spot
    expect(out[0]!.v).toBeUndefined();
    // a seam too far from spot (wrong market) → Yahoo only
    expect(stitchSpot('USDJPY', [{ ...yahoo[0]!, o: spot0 * 1.1 }], fut, 5 * H, 10).length).toBe(1);
    // EUR/USD is not inverted
    const e = stitchSpot('EURUSD', [{ t: 4 * H, o: 0.00705, h: 0.00706, l: 0.00704, c: 0.00705 }], fut, 5 * H, 10);
    expect(e[0]!.c).toBeCloseTo(0.00705, 9);
  });

  it('v28.15: hourly runs while any market is still filling, 6-hourly once all are full', () => {
    const ids = Object.fromEntries(Object.keys(DATABENTO.symbols).map((id) => [id, { first: 1, last: 2, n: 2, full: true, error: null }]));
    const full = { at: 0, spentUsd: 0, availEnd: null, ids, error: null };
    expect(everyMs(full)).toBe(DATABENTO.everyHours * H);
    expect(everyMs({ ...full, ids: { ...ids, XAUUSD: { ...ids.XAUUSD!, full: false } } })).toBe(DATABENTO.catchUpHours * H);
    expect(everyMs(null)).toBe(DATABENTO.catchUpHours * H);
  });
});
