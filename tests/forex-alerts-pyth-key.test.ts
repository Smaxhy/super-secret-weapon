/** v17.12: phone alerts when a forex trade does well, and the Pyth API key pasted on the dashboard. */
import { afterEach, describe, expect, it } from 'vitest';
import { newAccount, takeNotices, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { DEFAULT_PUSH_SETTINGS, fxMessageFor } from '../src/lib/push';
import { PYTH, pythConf, pythKey, setPythConf, testPythKey } from '../src/forex/pyth';
import { VENUE_FEES } from '../src/forex/venue-fees';
// v26: these tests pin exact R / USD numbers of other features — the venue fee is tested on its own (forex-venue-fees)
VENUE_FEES.on = false;

const T = Date.UTC(2026, 9, 14, 14, 0, 0);
const q = (mid: number, bars: Array<[number, number, number, number, number]>): Quote => ({ id: 'EURUSD', mid, bid: mid - 0.00004, ask: mid + 0.00004, t: T, bars, dayChangePct: null, source: 'yahoo-live' });
const long = (): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 110, stop: 1.097, target: 1.103, openedAt: T, checkedT: 0, strategy: 'tsmom' });

describe('v17.12 trade alerts from the account checks', () => {
  it('profit locked → one alert; two thirds of the way → one alert; the close → its total', () => {
    const a = newAccount(1000);
    a.open = [long()];
    const m1 = T + 60_000;
    tick(a, { EURUSD: q(1.1011, [[m1, 1.1012, 1.1004, 1.1011, 1.1004]]) }, m1 + 30_000);
    const n1 = takeNotices(a);
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ kind: 'lock', pair: 'EURUSD', side: 1, strategy: 'tsmom' });
    expect(n1[0]!.pnlUsd).toBeCloseTo((1.1011 - 0.00004 - 1.1) * 10_000, 1);
    expect(n1[0]!.stopPnlUsd!).toBeGreaterThan(0);
    // the same minute again: nothing new
    tick(a, { EURUSD: q(1.1011, [[m1, 1.1012, 1.1004, 1.1011, 1.1004]]) }, m1 + 40_000);
    expect(takeNotices(a)).toHaveLength(0);
    // +21 pips at the bid (more than ⅔ of 30): "doing really well", once
    const mv = { moved: false };
    tick(a, { EURUSD: q(1.1021, [[m1 + 60_000, 1.1022, 1.1011, 1.1021, 1.1011]]) }, m1 + 125_000, mv);
    const n2 = takeNotices(a);
    expect(n2.map((n) => n.kind)).toEqual(['run']);
    expect(mv.moved).toBe(true);
    tick(a, { EURUSD: q(1.1022, [[m1 + 120_000, 1.1023, 1.102, 1.1022, 1.1021]]) }, m1 + 185_000);
    expect(takeNotices(a)).toHaveLength(0);
    // falls back to the trailing stop: closed in profit
    tick(a, { EURUSD: q(1.1005, [[m1 + 180_000, 1.1022, 1.1005, 1.1006, 1.1022]]) }, m1 + 245_000);
    const n3 = takeNotices(a);
    expect(n3).toHaveLength(1);
    expect(n3[0]).toMatchObject({ kind: 'close', reason: 'stop' });
    expect(n3[0]!.pnlUsd).toBeGreaterThan(10);
  });

  it('push messages follow the settings', () => {
    const lock = { acct: 'bot' as const, kind: 'lock' as const, pair: 'EURUSD', side: 1 as const, pnlUsd: 10.4, stopPnlUsd: 3.2 };
    const m = fxMessageFor(lock, DEFAULT_PUSH_SETTINGS)!;
    expect(m.title).toMatch(/EUR\/USD \+\$10\.40 — profit locked/);
    expect(m.body).toMatch(/Bot \(long\).*\+\$3\.20/);
    expect(m.url).toBe('/forex');
    expect(fxMessageFor(lock, { ...DEFAULT_PUSH_SETTINGS, fxGood: false })).toBeNull();
    expect(fxMessageFor({ ...lock, acct: 'me', kind: 'run', pnlUsd: 21 }, DEFAULT_PUSH_SETTINGS)!.title).toMatch(/two thirds/);
    const win = { ...lock, kind: 'close' as const, pnlUsd: 25, reason: 'target' };
    expect(fxMessageFor(win, DEFAULT_PUSH_SETTINGS)!.title).toMatch(/closed \+\$25\.00/);
    expect(fxMessageFor(win, { ...DEFAULT_PUSH_SETTINGS, fxClose: false })).toBeNull();
    const loss = { ...win, pnlUsd: -8, reason: 'stop' };
    expect(fxMessageFor(loss, DEFAULT_PUSH_SETTINGS)).toBeNull(); // losses off by default
    expect(fxMessageFor(loss, { ...DEFAULT_PUSH_SETTINGS, lossClose: true })!.title).toMatch(/closed −\$8\.00/);
  });
});

describe('v17.12 Pyth key from the dashboard', () => {
  afterEach(() => setPythConf(null));
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
  const FX = [{ id: '0xaa', attributes: { symbol: 'FX.EUR/USD', asset_type: 'FX' } }];

  it('tries the upgraded Hermes first, then the old one; sends the key as a bearer token', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    const t = await testPythKey('k'.repeat(20), async (url, init) => {
      seen.push({ url, auth: init.headers.authorization! });
      return url.startsWith(PYTH.bases[0]!) ? reply(401, {}) : reply(200, FX);
    });
    expect(t).toEqual({ ok: true, base: PYTH.bases[1]!, pairs: 1 });
    expect(seen[0]!.url).toContain('/v2/price_feeds?asset_type=fx');
    expect(seen[0]!.auth).toBe(`Bearer ${'k'.repeat(20)}`);
    expect(PYTH.bases[0]).toBe('https://pyth.dourolabs.app/hermes');
  });

  it('a refused key or an answer without currency pairs is an error that says why', async () => {
    const bad = await testPythKey('x'.repeat(20), async () => reply(403, {}));
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/403/);
    const empty = await testPythKey('x'.repeat(20), async () => reply(200, []));
    expect((empty as { error: string }).error).toMatch(/no currency pairs/);
  });

  it('a saved key is used (and where it worked); removing it goes back to the .env key, if any', () => {
    setPythConf({ key: 'abc'.repeat(8), base: 'https://pyth.dourolabs.app/hermes/' });
    expect(pythKey()).toBe('abc'.repeat(8));
    expect(pythConf()).toMatchObject({ base: 'https://pyth.dourolabs.app/hermes', source: 'dashboard' });
    setPythConf(null);
    expect(pythConf().source).toBe(process.env.PYTH_API_KEY ? 'env' : null);
  });
});
