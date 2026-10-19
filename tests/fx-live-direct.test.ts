/** v17.10: the page's own Pyth stream (backup when the bot's price push goes quiet) + the store's source tag. */
import { describe, expect, it } from 'vitest';
import { applyHermes, BOT_QUIET_MS, BOT_STEADY_MS, FX_PAIRS, planFeeds, PythDirect, typicalHalf, wantDirect, type DirectEnv, type FeedPrice, type PythMeta } from '../dashboard/src/lib/pythDirect';
import { applyFx, EMPTY_FX } from '../dashboard/src/hooks/useFxLive';
import { planFeeds as serverPlan } from '../src/forex/pyth';
import { INSTRUMENTS } from '../src/forex/types';

const meta = (id: string, symbol: string, extra: Record<string, string> = {}): PythMeta => ({ id, attributes: { symbol, asset_type: 'FX', ...extra } });
const METAS: PythMeta[] = [
  meta('0xAA', 'FX.EUR/USD'),
  meta('bb', 'FX.USD/JPY'),
  meta('cc', 'FX.GBP/USD'),
  meta('dd', 'FX.CHF/USD'),
  meta('ee', 'FX.AUD/USD', { base: 'AUD', quote_currency: 'USD' }),
  { id: 'ff', attributes: { symbol: 'Metal.XAU/USD', asset_type: 'Metal' } },
];
const T = 1_760_000_000;
const msg = (rows: Array<[string, string, number]>) => JSON.stringify({ binary: { encoding: 'hex', data: ['00'] }, parsed: rows.map(([id, price, sec]) => ({ id, price: { price, conf: '5', expo: -5, publish_time: sec } })) });

describe('v17.10 page-side Pyth plan matches the bot', () => {
  it('same pairs, pips and spreads as the bot trades; same feed plan', () => {
    const fx = INSTRUMENTS.filter((i) => i.kind === 'fx');
    expect(Object.keys(FX_PAIRS).sort()).toEqual(fx.map((i) => i.id).sort());
    for (const i of fx) expect(FX_PAIRS[i.id]).toEqual({ pip: i.pip, spreadPips: i.spreadPips });
    expect(planFeeds(METAS)).toEqual(serverPlan(METAS as never));
    expect(typicalHalf('EURUSD')).toBeCloseTo(0.00004, 12);
    expect(typicalHalf('XAUUSD')).toBe(0);
  });

  it('turns one Hermes message into push rows: direct, inverse, crosses; older publish times ignored', () => {
    const plans = planFeeds(METAS);
    const latest = new Map<string, FeedPrice>();
    const half = (p: string) => (p === 'EURUSD' ? 0.00005 : typicalHalf(p));
    const a = applyHermes(msg([['0xaa', '110000', T], ['bb', '15000000', T], ['dd', '112500', T]]), plans, latest, half);
    expect(a.EURUSD).toEqual([1.1, 1.09995, 1.10005, T * 1000]);
    expect(a.USDCHF![0]).toBeCloseTo(1 / 1.125, 7);
    expect(a.EURJPY![0]).toBeCloseTo(165, 6);
    expect(a.GBPUSD).toBeUndefined(); // no GBP price yet
    // only pairs whose legs moved are sent; an older publish time never wins
    const b = applyHermes(msg([['bb', '15010000', T + 1], ['aa', '120000', T - 5]]), plans, latest, half);
    expect(Object.keys(b).sort()).toEqual(['EURJPY', 'USDJPY']);
    expect(b.EURJPY![0]).toBeCloseTo(1.1 * 150.1, 6);
    expect(b.EURJPY![3]).toBe(T * 1000); // the older leg's time
    expect(applyHermes('not json', plans, latest, half)).toEqual({});
    expect(applyHermes(msg([['aa', '-1', T + 9]]), plans, latest, half)).toEqual({});
  });

  it('runs only while someone watches a visible page and the bot is quiet; stops once the bot is steady again', () => {
    const base = { watchers: 1, visible: true, running: false, botLastAt: 0, botSteadySince: 0, now: 100_000 };
    expect(wantDirect(base)).toBe(true); // never heard from the bot (older server / socket down)
    expect(wantDirect({ ...base, watchers: 0 })).toBe(false);
    expect(wantDirect({ ...base, visible: false })).toBe(false);
    expect(wantDirect({ ...base, botLastAt: 99_000, botSteadySince: 90_000 })).toBe(false); // bot pushing, not running
    expect(wantDirect({ ...base, botLastAt: 100_000 - BOT_QUIET_MS - 1, botSteadySince: 50_000 })).toBe(true);
    // running, bot came back: kept until it has been steady a while
    expect(wantDirect({ ...base, running: true, botLastAt: 99_900, botSteadySince: 95_000 })).toBe(true);
    expect(wantDirect({ ...base, running: true, botLastAt: 99_900, botSteadySince: 100_000 - BOT_STEADY_MS })).toBe(false);
  });

  it('the store remembers which source moved it last', () => {
    const s = applyFx(EMPTY_FX, { px: { EURUSD: [1.1, 1.09995, 1.10005, 5] } }, 10, 'direct');
    expect(s.src).toBe('direct');
    expect(applyFx(s, { px: { EURUSD: [1.1001, 1.10005, 1.10015, 6] } }, 11).src).toBe('bot');
  });
});

function fakeEnv(metas: unknown = METAS) {
  let t = 1_000_000;
  const store = new Map<string, string>();
  const opened: Array<{ url: string; on: { message(d: string): void; failed(): void }; closed: boolean }> = [];
  let fetches = 0;
  let fetchFails = false;
  const env: DirectEnv = {
    fetchJson: async () => {
      fetches++;
      if (fetchFails) throw new Error('HTTP 503');
      return metas;
    },
    openStream: (url, on) => {
      const s = { url, on, closed: false };
      opened.push(s);
      return { close: () => (s.closed = true) };
    },
    now: () => t,
    load: (k) => store.get(k) ?? null,
    save: (k, v) => void store.set(k, v),
  };
  return {
    env,
    opened,
    store,
    get fetches() {
      return fetches;
    },
    failFetch: (v: boolean) => (fetchFails = v),
    advance: (ms: number) => (t += ms),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('v17.10 PythDirect', () => {
  it('looks the feeds up once (cached a day), opens one stream with every leg, passes moved pairs on, closes when told', async () => {
    const f = fakeEnv();
    const got: Array<Record<string, unknown>> = [];
    const d = new PythDirect(f.env, (px) => got.push(px));
    d.sync(true);
    d.sync(true); // already starting: no second stream
    await settle();
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]!.url).toContain('/v2/updates/price/stream?');
    for (const id of ['aa', 'bb', 'cc', 'dd', 'ee']) expect(f.opened[0]!.url).toContain(`ids[]=${id}`);
    expect(f.opened[0]!.url).not.toContain('ids[]=ff');
    f.opened[0]!.on.message(msg([['aa', '110000', T]]));
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!)).toEqual(['EURUSD']);
    expect(d.updates).toBe(1);
    d.sync(false);
    expect(f.opened[0]!.closed).toBe(true);
    expect(d.running).toBe(false);
    // a second page load inside the day uses the stored plan
    const d2 = new PythDirect(f.env, () => undefined);
    d2.sync(true);
    await settle();
    expect(f.fetches).toBe(1);
    expect(f.opened).toHaveLength(2);
  });

  it('a refused stream or a failed feed list backs off before trying again; switched off while loading → no stream', async () => {
    const f = fakeEnv();
    f.failFetch(true);
    const d = new PythDirect(f.env, () => undefined);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(0);
    d.sync(true); // inside the back-off
    await settle();
    expect(f.fetches).toBe(1);
    f.failFetch(false);
    f.advance(2_001);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(1);
    f.opened[0]!.on.failed();
    expect(d.running).toBe(false);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(1); // waiting out the back-off (longer: no price came in between)
    f.advance(2_001);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(1);
    f.advance(3_000);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(2);
    // switched off before the feed list arrived
    const g = fakeEnv();
    const e = new PythDirect(g.env, () => undefined);
    e.sync(true);
    e.sync(false);
    await settle();
    expect(g.opened).toHaveLength(0);
  });

  it('an empty / broken feed list never opens a stream', async () => {
    const f = fakeEnv({ error: 'nope' });
    const d = new PythDirect(f.env, () => undefined);
    d.sync(true);
    await settle();
    expect(f.opened).toHaveLength(0);
    expect(f.store.size).toBe(0);
  });
});
