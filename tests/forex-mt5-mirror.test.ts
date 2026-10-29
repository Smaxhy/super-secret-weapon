import { describe, expect, it, vi } from 'vitest';

const store: { value: unknown } = { value: null };
vi.mock('../src/lib/prisma', () => ({
  prisma: {
    botConfig: {
      findUnique: async () => (store.value ? { value: store.value } : null),
      upsert: async ({ update }: { update: { value: unknown } }) => {
        store.value = update.value;
      },
    },
  },
}));

import { lotsFor, matchSymbol, Mt5Mirror, planMirror, scaleOf, type MirrorBotPos, type MirrorRow, type MtFetch, type Mt5Pos } from '../src/forex/mt5-mirror';

const pos = (o: Partial<MirrorBotPos> = {}): MirrorBotPos => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 30_000, entry: 1.1, stop: 1.098, target: 1.104, openedAt: 1_000, closePending: false, ...o });
const row = (o: Partial<MirrorRow> = {}): MirrorRow => ({ posId: 'p1', pair: 'EURUSD', symbol: 'EURUSD.pro', mt5Id: '77', clientId: 'FXabc', side: 1, units0: 30_000, lots0: 3, step: 0.01, minVol: 0.01, entry: 1.1, fill: 1.1003, digits: 5, state: 'open', tries: 1, at: 1_000, modAt: 0, ...o });
const mpos = (o: Partial<Mt5Pos> = {}): Mt5Pos => ({ id: '77', symbol: 'EURUSD.pro', type: 'POSITION_TYPE_BUY', volume: 3, openPrice: 1.1003, stopLoss: 1.0983, takeProfit: 1.1043, ...o });

describe('v28.1 MT5 demo mirror (MetaApi)', () => {
  it('finds the broker symbol: exact, suffixed, indices by their usual names, overrides first', () => {
    const syms = ['EURUSD.pro', 'EURUSDm.x', 'XAUUSD', 'NAS100', 'US500', 'GBPUSD'];
    expect(matchSymbol('EURUSD', syms)).toBe('EURUSD.pro');
    expect(matchSymbol('XAUUSD', syms)).toBe('XAUUSD');
    expect(matchSymbol('NDXUSD', syms)).toBe('NAS100');
    expect(matchSymbol('SPXUSD', syms)).toBe('US500');
    expect(matchSymbol('USDJPY', syms)).toBeNull();
    expect(matchSymbol('USDJPY', syms, { USDJPY: 'USDJPY.x' })).toBe('USDJPY.x');
  });

  it('sizes in lots rounded down to the step, capped, null under the minimum; scale = equity ratio', () => {
    const fx = { contractSize: 100_000, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01 };
    expect(lotsFor(30_000, fx, 5)).toBe(0.3);
    expect(lotsFor(123_456, fx, 5)).toBe(1.23);
    expect(lotsFor(9_000_000, fx, 5)).toBe(5);
    expect(lotsFor(500, fx, 5)).toBeNull();
    expect(lotsFor(7, { contractSize: 100, minVolume: 0.01, maxVolume: 50, volumeStep: 0.01 }, 5)).toBe(0.07); // 7 oz gold
    expect(scaleOf('match', 100_000, 1_000)).toBe(100);
    expect(scaleOf(2, null, 1_000)).toBe(2);
    expect(scaleOf('match', null, 1_000)).toBeNull();
  });

  it('opens only trades opened after it was switched on; follows stop moves at the same distance from MT5\'s fill', () => {
    const base = { mt5: [] as Mt5Pos[], now: 100_000 };
    expect(planMirror({ ...base, bot: [pos({ openedAt: 500 })], rows: {}, since: 1_000 })).toEqual([]);
    expect(planMirror({ ...base, bot: [pos()], rows: {}, since: 1_000 })[0]).toMatchObject({ kind: 'open', retry: false });
    // in sync → nothing
    expect(planMirror({ bot: [pos()], rows: { p1: row() }, mt5: [mpos()], since: 0, now: 100_000 })).toEqual([]);
    // the bot locked profit: stop 1.1005 → MT5 stop = fill + 0.0005
    const a = planMirror({ bot: [pos({ stop: 1.1005 })], rows: { p1: row() }, mt5: [mpos()], since: 0, now: 100_000 });
    expect(a).toEqual([{ kind: 'modify', posId: 'p1', mt5Id: '77', sl: 1.1008, tp: 1.1043 }]);
    // too soon after the last change → waits
    expect(planMirror({ bot: [pos({ stop: 1.1005 })], rows: { p1: row({ modAt: 95_000 }) }, mt5: [mpos()], since: 0, now: 100_000 })).toEqual([]);
  });

  it('takes a part off, closes what the bot closed, notes what MT5 closed by itself, drops dead rows', () => {
    expect(planMirror({ bot: [pos({ units: 15_000 })], rows: { p1: row() }, mt5: [mpos()], since: 0, now: 100_000 })).toEqual([{ kind: 'reduce', posId: 'p1', mt5Id: '77', volume: 1.5 }]);
    expect(planMirror({ bot: [], rows: { p1: row() }, mt5: [mpos()], since: 0, now: 100_000 })).toEqual([{ kind: 'close', posId: 'p1', mt5Id: '77', why: 'the bot closed it' }]);
    expect(planMirror({ bot: [pos({ closePending: true })], rows: { p1: row() }, mt5: [mpos()], since: 0, now: 100_000 })[0]).toMatchObject({ kind: 'close' });
    expect(planMirror({ bot: [pos()], rows: { p1: row() }, mt5: [], since: 0, now: 100_000 })).toEqual([{ kind: 'gone', posId: 'p1' }]);
    expect(planMirror({ bot: [], rows: { p1: row({ state: 'gone' }) }, mt5: [], since: 0, now: 100_000 })).toEqual([{ kind: 'drop', posId: 'p1' }]);
    // a failed open is retried after 5 minutes, at most 3 times
    expect(planMirror({ bot: [pos()], rows: { p1: row({ state: 'failed', tries: 1, at: 0 }) }, mt5: [], since: 0, now: 400_000 })[0]).toMatchObject({ kind: 'open', retry: true });
    expect(planMirror({ bot: [pos()], rows: { p1: row({ state: 'failed', tries: 3, at: 0 }) }, mt5: [], since: 0, now: 400_000 })).toEqual([]);
  });

  it('a round against MetaApi: copies the bot trade on a demo account, refuses a real one', async () => {
    const kv = new Map<string, string>();
    const redis = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => (kv.set(k, v), 'OK' as const) };
    const trades: Array<Record<string, unknown>> = [];
    let mode = 'ACCOUNT_TRADE_MODE_DEMO';
    const fetcher: MtFetch = async (url, init) => {
      const ok = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
      expect(init.headers['auth-token']).toBe('t'.repeat(30));
      if (url.endsWith('/users/current/accounts/acc-123')) return ok({ id: 'acc-123', region: 'london', login: 62586512, server: 'OANDA-Demo' });
      if (url.endsWith('/servers/mt-client-api')) return ok({ domain: 'agiliumtrade.ai' });
      expect(url.startsWith('https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/acc-123/')).toBe(true);
      if (url.endsWith('/account-information')) return ok({ balance: 100_000, equity: 100_000, type: mode, currency: 'USD' });
      if (url.endsWith('/positions')) return ok([]);
      if (url.endsWith('/symbols')) return ok(['EURUSD.pro', 'XAUUSD']);
      if (url.endsWith('/specification')) return ok({ symbol: 'EURUSD.pro', contractSize: 100_000, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, digits: 5 });
      if (url.endsWith('/current-price')) return ok({ bid: 1.1001, ask: 1.1002 });
      if (url.endsWith('/trade')) {
        trades.push(JSON.parse(init.body!) as Record<string, unknown>);
        return ok({ stringCode: 'TRADE_RETCODE_DONE', numericCode: 10009, positionId: '901' });
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };
    store.value = { token: 't'.repeat(30), accountId: 'acc-123', on: true, since: 0, scale: 'match', maxLots: 5, symbols: {} };
    const src = { rawAccount: async () => ({ balanceUsd: 1_000, open: [pos()] }) };
    const lines: string[] = [];
    const m = new Mt5Mirror(redis as never, src, (l) => lines.push(...l), fetcher);
    await m.reload();
    await m.tick(100_000);
    expect(trades).toEqual([{ actionType: 'ORDER_TYPE_BUY', symbol: 'EURUSD.pro', volume: 5, stopLoss: 1.1002 - 0.002, takeProfit: 1.1042, clientId: expect.stringMatching(/^FX/), comment: 'fxbot' }]);
    expect(m.status().rows[0]).toMatchObject({ state: 'open', mt5Id: '901', symbol: 'EURUSD.pro' });
    expect(lines.join(' ')).toMatch(/MT5 demo: bought 5 lots EURUSD\.pro/);
    expect(m.status().token).not.toContain('tttttttttt');

    // a real-money account: switched off, nothing sent
    mode = 'ACCOUNT_TRADE_MODE_REAL';
    trades.length = 0;
    await m.reload();
    await m.tick(200_000);
    expect(trades).toEqual([]);
    expect((store.value as { on: boolean }).on).toBe(false);
  });
});
