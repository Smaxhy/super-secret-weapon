import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { cleanDk, liveHour, midBars, type DkBar } from '../src/forex/dukascopy';
import { paperSince, statsOf } from '../src/forex/lab';
import { doneBefore } from '../src/forex/judge';
import { gradeSniper, type SniperRow } from '../src/forex/sniper';
import { gradeConviction, type ConvRow } from '../src/forex/conviction';
import { newAccount, Practice, quoteAge, tick, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { INSTRUMENTS, type Trade } from '../src/forex/types';

const H = 3_600_000;
const M = 60_000;
const EUR = INSTRUMENTS[0]!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;
/** a Wednesday 14:00:30 UTC: forex open, not the rollover */
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);

class NxRedis {
  m = new Map<string, string>();
  failGet = false;
  sets = 0;
  async get(k: string) {
    if (this.failGet) throw new Error('redis down');
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string, mode?: string) {
    this.sets++;
    if (mode === 'NX' && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
}
const asRedis = (r: NxRedis) => r as unknown as Redis;

afterEach(() => {
  vi.useRealTimers();
});

describe('v17 Dukascopy candles: no weekend / flat / forming bars', () => {
  const sat = Date.UTC(2026, 9, 17, 12); // Saturday noon UTC
  const wedH = Date.UTC(2026, 9, 14, 14);
  const row = (t: number, o: number, h: number, l: number, c: number, v = 10) => [t, o, h, l, c, v];
  it('drops weekend hours, bars flat on both sides, zero-volume bars and the bar still forming', () => {
    expect(liveHour(sat, null)).toBe(false);
    expect(liveHour(wedH, null)).toBe(true);
    expect(liveHour(wedH, wedH + 30 * M)).toBe(false); // still forming
    const bid = [row(wedH - H, 1.1, 1.1005, 1.0995, 1.1001), row(wedH, 1.1, 1.1, 1.1, 1.1), row(wedH + H, 1.1, 1.1004, 1.0998, 1.1002, 0), row(sat, 1.1, 1.1003, 1.0999, 1.1001), row(wedH + 2 * H, 1.1, 1.1006, 1.0996, 1.1003)];
    const ask = bid.map((r) => [r[0]!, r[1]! + 0.0001, r[2]! + 0.0001, r[3]! + 0.0001, r[4]! + 0.0001, r[5]!]);
    // flat on both sides (a filler candle that reports volume) must go too
    ask[1] = [wedH, 1.1001, 1.1001, 1.1001, 1.1001, 10];
    const out = midBars('EURUSD', bid, ask, wedH + 2 * H + 10 * M);
    expect(out.map((b) => b.t)).toEqual([wedH - H]);
    expect(out[0]!.s).toBeCloseTo(1, 6);
  });
  it('cleans rows saved by older versions', () => {
    const bars: DkBar[] = [
      { t: wedH, o: 1.1, h: 1.1002, l: 1.0999, c: 1.1001, s: 1 },
      { t: wedH + H, o: 1.1, h: 1.1, l: 1.1, c: 1.1, s: 1 },
      { t: sat, o: 1.1, h: 1.1002, l: 1.0999, c: 1.1001, s: 1 },
    ];
    expect(cleanDk(bars).map((b) => b.t)).toEqual([wedH]);
  });
});

describe('v17 purge at the 70/30 boundary', () => {
  const trade = (entryT: number, exitT: number, r: number): Trade => ({ strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1, entryT, exitT, entry: 1.1, exit: 1.1, stop: 1.09, stop0: 1.09, target: 1.12, r, reason: 'target', bars: 1, stopPct: 1 }) as unknown as Trade;
  it('a trade opened before the boundary and closed after it counts in neither half', () => {
    const s = statsOf([trade(10, 20, 1), trade(40, 60, 5), trade(60, 70, -1)], 50);
    expect(s.inSample.n).toBe(1);
    expect(s.outSample.n).toBe(1);
    expect(s.all.n).toBe(3);
    expect(doneBefore({ t: 40, exitT: 60 }, 50)).toBe(false);
    expect(doneBefore({ t: 40 }, 50)).toBe(true);
  });
  it('the sniper and the conviction tiers pick only on trades finished before the boundary', () => {
    // 30 straddling winners with many votes: before v17 they made K look great on the first 70%
    const rows: SniperRow[] = [];
    for (let k = 0; k < 30; k++) rows.push({ t: 900 + k, exitT: 1100, r: 2, votes: 9 });
    for (let k = 0; k < 40; k++) rows.push({ t: k, exitT: k + 1, r: -0.1, votes: 9 });
    const g = gradeSniper(rows, 1000);
    expect(g.all.inN).toBe(40);
    expect(g.k).toBeNull();
    const conv: ConvRow[] = rows.map((r) => ({ t: r.t, exitT: r.exitT, r: r.r, conf: 4 }));
    expect(gradeConviction(conv, 1000, 'hourly', true, { pHi: null, pTop: null }).active).toBe(false);
  });
});

describe('v17 paper clock', () => {
  it('a Redis error never restarts the forward test; a missing value is set once', async () => {
    const r = new NxRedis();
    expect(await paperSince(asRedis(r), 'k', 111)).toBe(111);
    expect(await paperSince(asRedis(r), 'k', 222)).toBe(111);
    r.failGet = true;
    await expect(paperSince(asRedis(r), 'k', 333)).rejects.toThrow(/redis down/);
    r.failGet = false;
    expect(r.m.get('k')).toBe('111');
  });
});

describe('v17 bot account safety', () => {
  const quote = (id: string, mid: number, o: Partial<Quote> = {}): Quote => ({ id, mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED, ...o });
  const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.09, target: 1.12, openedAt: WED - 10 * M, checkedT: WED - 10 * M, ...o });

  it('a Redis error is not a fresh account: nothing is saved over the real one', async () => {
    const r = new NxRedis();
    r.m.set('fx:practice', JSON.stringify({ ...newAccount(5000), open: [] }));
    const p = new Practice(asRedis(r));
    r.failGet = true;
    const sets = r.sets;
    await expect(p.edit('x', null, null)).rejects.toThrow();
    expect(r.sets).toBe(sets);
    r.failGet = false;
    expect((JSON.parse(r.m.get('fx:practice')!) as PracticeAccount).startUsd).toBe(5000);
  });

  it('a close asked for with no price waits for the first real price (never the entry price)', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice', JSON.stringify({ ...newAccount(1000), open: [pos()] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({});
    const res = await p.close('p1');
    expect(res.ok).toBe(true);
    const a = JSON.parse(r.m.get('fx:practice')!) as PracticeAccount;
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.closePending?.reason).toBe('manual');
    // the next tick with a price closes it there
    const ev = tick(a, { EURUSD: quote('EURUSD', 1.105) }, WED + M);
    expect(ev.join(' ')).toMatch(/first price/);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.exit).toBeCloseTo(1.105 - HALF, 8);
    expect(a.closed[0]!.reason).toBe('manual');
  });

  it('no margin call while a market has no price', () => {
    const a: PracticeAccount = { ...newAccount(10), open: [pos({ marginUsd: 100 }), pos({ id: 'p2', pair: 'GBPUSD', entry: 1.27, stop: null, target: null })] };
    // EUR/USD crashed but GBP/USD has no quote: before v17 GBP was valued at its entry price and both were closed
    const ev = tick(a, { EURUSD: quote('EURUSD', 1.0, { bars: [] }) }, WED);
    expect(ev.join(' ')).not.toMatch(/margin call/);
    expect(a.open).toHaveLength(2);
  });

  it('a held bot trade on a market the lab had no fresh candles for is kept, not closed', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [pos({ ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h' })] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
    const ev = await p.syncBot([], () => null, {}, { scope: ['1h', '4h'], pairsSeen: new Set(['GBPUSD']) });
    expect(ev.join(' ')).toMatch(/kept EURUSD/);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
    await p.syncBot([], () => null, {}, { scope: ['1h', '4h'], pairsSeen: new Set(['EURUSD']) });
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('signal');
  });

  it('a 1-minute trade is not opened on an old price; quote age uses the market time', async () => {
    vi.useFakeTimers({ now: WED });
    expect(quoteAge({ priceT: WED - 5 * M, bars: [], t: WED }, WED)).toBe(5 * M);
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1, { priceT: WED - 5 * M, bars: [[WED - 5 * M, 1.1, 1.1, 1.1]] }) });
    const lab = { ref: `x:1m:EURUSD:${WED}`, strategy: 'x', tf: '1m', pair: 'EURUSD', side: 1 as const, entryT: WED - 30_000, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const ev = await p.syncBot([lab], () => null, {}, { scope: ['1m'] });
    expect(ev.join(' ')).toMatch(/min old/);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    // the same price is fine for an hourly trade
    await p.syncBot([{ ...lab, ref: `x:1h:EURUSD:${WED}`, tf: '1h' }], () => null, {}, { scope: ['1h', '4h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
  });
});
