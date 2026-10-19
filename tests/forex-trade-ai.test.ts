/** v17.14: the AI read of open trades (display only) — prompt, parsing, when it runs, caps, the minute scheduler. */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { aiDue, buildTradePrompt, FX_AI, parseTradeAi, toQuarter, TradeAi, type TradeAiClient, type TradeAiContext } from '../src/forex/trade-ai';
import { readContext, TradeWatch } from '../src/forex/trade-watch';
import { liveRead } from '../src/forex/trade-read';
import type { AccountView, Quote } from '../src/forex/practice';
import type { MarketNow } from '../src/forex/lab';

class MiniRedis {
  kv = new Map<string, string>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string) { this.kv.set(k, v); return 'OK'; }
  async mget(...ks: string[]) { return ks.map((k) => this.kv.get(k) ?? null); }
  async incr(k: string) { const n = Number(this.kv.get(k) ?? 0) + 1; this.kv.set(k, String(n)); return n; }
  async incrbyfloat(k: string, by: number) { const n = Number(this.kv.get(k) ?? 0) + by; this.kv.set(k, String(n)); return String(n); }
  async expire() { return 1; }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['set', 'incr', 'incrbyfloat', 'expire'] as const) {
      chain[m] = (...a: unknown[]) => { ops.push(() => (this[m] as (...x: unknown[]) => Promise<unknown>)(...a)); return chain; };
    }
    chain.exec = async () => { const out = []; for (const op of ops) out.push([null, await op()]); return out; };
    return chain;
  }
}

const T = Date.UTC(2026, 9, 14, 14, 0, 0); // Wednesday, forex open
const MIN = 60_000;
const GOOD = { verdict: 'on_track', headline: 'Grinding up toward 1.1030 with higher lows', read: 'Price rose steadily since the entry. It holds above 1.1006.', watch: ['1.1018 resistance', 'US CPI at 12:30', 'x', 'y'], confidence: 4 };

function fakeClient(out: unknown, opts: { refusal?: boolean; fail?: boolean } = {}) {
  const create = vi.fn(async (_p: unknown) => {
    if (opts.fail) throw new Error('overloaded');
    return { stop_reason: opts.refusal ? 'refusal' : 'end_turn', usage: { input_tokens: 2500, output_tokens: 400 }, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
  return { client: { beta: { messages: { create } } } as unknown as TradeAiClient, create };
}

const bars = Array.from({ length: 90 }, (_, k) => {
  const c = 1.1 + (0.0012 * k) / 89;
  return [T - (90 - k) * MIN, c + 0.00002, c - 0.00002, c, c - 0.00001] as [number, number, number, number, number];
});
const pos = (id = 'p1', over: Partial<AccountView['positions'][number]> = {}) =>
  ({ id, pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 110, stop: 1.0985, target: 1.103, openedAt: T - 90 * MIN, checkedT: 0, strategy: 'ema_cross', tf: '1h', px: 1.1012, pnlUsd: 12, pnlPct: 12, ...over }) as AccountView['positions'][number];
const quote: Quote = { id: 'EURUSD', mid: 1.1012, bid: 1.10116, ask: 1.10124, t: T, bars, dayChangePct: 0.1, source: 'yahoo-live' };
const market = {
  id: 'EURUSD', atrPips: 10, mtf: { h1: 1, h4: 1, d1: 0 }, rsi: 61, strength: { base: 'EUR', quote: 'USD', baseScore: 0.4, quoteScore: -0.2, gap: 0.6 },
  bars: Array.from({ length: 30 }, (_, k) => [T - (30 - k) * 3_600_000, 1.099, 1.1005, 1.0985, 1.1]),
  drawings: { lines: [], levels: [{ kind: 'resistance', price: 1.1018, touches: 3 }, { kind: 'support', price: 1.08, touches: 4 }], prevDay: null, asia: null },
} as unknown as MarketNow;

const ctxOf = (id = 'p1', now = T): TradeAiContext => readContext('bot', pos(id), quote, market, [{ t: now + 30 * MIN, ccy: 'USD', title: 'CPI m/m', impact: 'High', forecast: '', previous: '' }], now).ctx;

describe('v17.14 AI trade read: the prompt and the answer', () => {
  it('puts the trade, the live read, the market, candles and news into one compact JSON', () => {
    const p = JSON.parse(buildTradePrompt(ctxOf())) as Record<string, any>;
    expect(p.trade).toMatchObject({ market: 'EUR/USD', side: 'long (bought)', strategy: 'EMA 20/50 cross on the 1h chart', entry: 1.1, priceNow: 1.1012, stop: 1.0985, target: 1.103, openMinutes: 90 });
    expect(p.trade.pipsToTarget).toBeCloseTo(18, 6);
    expect(p.trade.pipsToStop).toBeCloseTo(27, 6);
    expect(p.liveRead.status).toBe('On track');
    expect(p.liveRead.notes.length).toBeGreaterThan(3);
    expect(p.market.trend).toEqual({ '1h': 'up', '4h': 'up', daily: 'none' });
    expect(p.market.currencyStrengthGapItsWay).toBe(0.6);
    expect(p.market.levelsNearby).toEqual(['resistance 1.10180 (3 touches)']); // 1.08 is too far
    expect(p.hourlyCandles).toHaveLength(24);
    expect(p.hourlyCandles[23]).toEqual([60, 1.099, 1.1005, 1.0985, 1.1]);
    expect(p.quarterHourCandles.length).toBeGreaterThanOrEqual(6);
    expect(p.lastMinutesClose).toHaveLength(30);
    expect(p.newsNext6h).toEqual([{ inMinutes: 30, currency: 'USD', title: 'CPI m/m', impact: 'High' }]);
  });

  it('1-minute candles → 15-minute candles', () => {
    const q = toQuarter([[0, 2, 1, 1.5, 1.2], [60_000, 3, 1.4, 2.5], [900_000, 2.6, 2.4, 2.5, 2.5]]);
    expect(q).toEqual([[0, 1.2, 3, 1, 2.5], [900_000, 2.5, 2.6, 2.4, 2.5]]);
  });

  it('parses and clamps the answer; junk → null', () => {
    expect(parseTradeAi(JSON.stringify(GOOD))).toEqual({ verdict: 'on_track', headline: GOOD.headline, read: GOOD.read, watch: GOOD.watch.slice(0, 3), confidence: 4 });
    expect(parseTradeAi(JSON.stringify({ ...GOOD, confidence: 9 }))!.confidence).toBe(5);
    expect(parseTradeAi(JSON.stringify({ ...GOOD, verdict: 'buy more' }))).toBeNull();
    expect(parseTradeAi(JSON.stringify({ ...GOOD, headline: '  ' }))).toBeNull();
    expect(parseTradeAi('{oops')).toBeNull();
  });

  it('when a read is due: new trade, every 15 min, sooner when the live read turns serious, never while closed', () => {
    expect(aiDue(null, 'on_track', true, T)).toBe('new');
    expect(aiDue(null, 'on_track', false, T)).toBeNull();
    const prev = { at: T - 6 * MIN, status: 'on_track' as const };
    expect(aiDue(prev, 'on_track', true, T)).toBeNull();
    expect(aiDue(prev, 'near_stop', true, T)).toBe('change');
    expect(aiDue(prev, 'stalling', true, T)).toBeNull(); // not serious
    expect(aiDue({ ...prev, at: T - 3 * MIN }, 'near_stop', true, T)).toBeNull(); // too soon after the last
    expect(aiDue({ ...prev, at: T - FX_AI.everyMin * MIN }, 'on_track', true, T)).toBe('time');
  });
});

describe('v17.14 AI trade read: calls, caps, history', () => {
  it('asks Haiku with the JSON schema, stores the read with its history, counts the spend', async () => {
    const r = new MiniRedis();
    const { client, create } = fakeClient(GOOD);
    const ai = new TradeAi(r as unknown as Redis, client);
    expect(ai.model).toBe(process.env.AI_TRADE_MODEL?.trim() || 'claude-haiku-5-5');
    const a1 = await ai.ask(ctxOf(), 'new');
    expect(a1).toMatchObject({ verdict: 'on_track', why: 'new', status: 'on_track', px: 1.1012, history: [] });
    const params = create.mock.calls[0]![0] as Record<string, any>;
    expect(params.output_config.format.type).toBe('json_schema');
    if (/haiku/.test(ai.model)) expect(params.fallbacks).toBeUndefined();
    expect(params.messages[0].content).toContain('EUR/USD');
    const day = new Date(T).toISOString().slice(0, 10);
    expect(Number(r.kv.get(`fx:ai:spend:${day}`))).toBeGreaterThan(0);
    expect(r.kv.get(`ai:spend:${day}`)).toBe(r.kv.get(`fx:ai:spend:${day}`));
    // a second read keeps the first in its history
    const a2 = await ai.ask({ ...ctxOf(), now: T + 15 * MIN }, 'time');
    expect(a2!.history).toEqual([{ at: T, verdict: 'on_track', headline: GOOD.headline }]);
    expect((await ai.cached('bot', 'p1'))!.at).toBe(T + 15 * MIN);
  });

  it('refusal / failure → no read (and says why); no key → none at all', async () => {
    const r = new MiniRedis();
    const ref = new TradeAi(r as unknown as Redis, fakeClient(GOOD, { refusal: true }).client);
    expect(await ref.ask(ctxOf(), 'new')).toBeNull();
    expect(ref.lastError).toMatch(/declined/);
    const bad = new TradeAi(r as unknown as Redis, fakeClient(GOOD, { fail: true }).client);
    expect(await bad.ask(ctxOf('p2'), 'new')).toBeNull();
    expect(bad.lastError).toMatch(/overloaded/);
    const none = new TradeAi(r as unknown as Redis, null);
    expect(await none.capped(T)).toMatch(/ANTHROPIC_API_KEY/);
    expect(await none.ask(ctxOf(), 'asked')).toBeNull();
    expect((await none.status(T)).on).toBe(false);
  });

  it('the hourly cap and the daily budget stop scheduled reads, not the owner asking', async () => {
    const r = new MiniRedis();
    const { client, create } = fakeClient(GOOD);
    const ai = new TradeAi(r as unknown as Redis, client, { ...FX_AI, maxPerHour: 1 });
    await ai.ask(ctxOf('a'), 'new');
    expect(await ai.capped(T)).toMatch(/hourly cap/);
    expect(await ai.ask(ctxOf('b'), 'new')).toBeNull();
    expect(await ai.ask(ctxOf('b'), 'asked')).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
    r.kv.set(`fx:ai:spend:${new Date(T).toISOString().slice(0, 10)}`, '5');
    const ai2 = new TradeAi(r as unknown as Redis, client);
    expect(await ai2.capped(T + 3_600_000)).toMatch(/daily budget/);
  });
});

describe('v17.14 trade watch', () => {
  const practice = (positions: AccountView['positions']) => ({ openNow: vi.fn(async (acct: string) => (acct === 'bot' ? { positions, quotes: { EURUSD: quote } } : { positions: [], quotes: {} })) });
  const src = { markets: () => [market], news: () => [] };

  it('once a minute: asks for trades that are due, one at a time; nothing while forex is closed', async () => {
    const r = new MiniRedis();
    const { client, create } = fakeClient(GOOD);
    const w = new TradeWatch(practice([pos('a'), pos('b')]), new TradeAi(r as unknown as Redis, client), src);
    expect(await w.tick(T)).toBe(2);
    expect(await w.tick(T + 5 * MIN)).toBe(0); // read 5 min ago, nothing serious
    expect(await w.tick(T + 16 * MIN)).toBe(2);
    expect(create).toHaveBeenCalledTimes(4);
    const sat = Date.UTC(2026, 9, 17, 14, 0, 0);
    expect(await w.tick(sat)).toBe(0);
  });

  it('reads: every open trade with its live read and newest AI read; asking again within a minute is refused', async () => {
    const r = new MiniRedis();
    const { client } = fakeClient(GOOD);
    const w = new TradeWatch(practice([pos('a')]), new TradeAi(r as unknown as Redis, client), src);
    const before = await w.reads('bot', T);
    expect(before.trades).toHaveLength(1);
    expect(before.trades[0]!.read.status).toBe('on_track');
    expect(before.trades[0]!.ai).toBeNull();
    expect(before.ai.on).toBe(true);
    const asked = await w.askNow('bot', 'a', T);
    expect(asked.ok).toBe(true);
    expect(asked.ai!.why).toBe('asked');
    expect((await w.askNow('bot', 'a', T + 30_000)).error).toMatch(/less than a minute/);
    expect((await w.askNow('bot', 'zzz', T + 120_000)).error).toMatch(/no open trade/);
    expect((await w.reads('bot', T + 1_000)).trades[0]!.ai!.headline).toBe(GOOD.headline);
  });

  it('the context matches the live read on its own', () => {
    const { read } = readContext('bot', pos(), quote, market, [], T);
    const direct = liveRead({ pos: pos(), bars, pip: 0.0001, digits: 5, label: 'EUR/USD', now: T, strategy: { name: 'EMA 20/50 cross', desc: read.why!, style: 'trend' }, market: { atrPips: 10, mtf: market.mtf, rsi: 61, levels: market.drawings.levels, lines: [], prevDay: null } });
    expect(read).toEqual(direct);
  });
});
