import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { cleanDk, liveHour, midBars, type DkBar } from '../src/forex/dukascopy';
import { paperSince, statsOf } from '../src/forex/lab';
import { doneBefore } from '../src/forex/judge';
import { gradeSniper, type SniperRow } from '../src/forex/sniper';
import { gradeConviction, type ConvRow } from '../src/forex/conviction';
import { ledgerRows, ledgerSummary, newAccount, Practice, quoteAge, recordTrade, tick, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { INSTRUMENTS, type Trade } from '../src/forex/types';
import { FeedBook, feedHealth } from '../src/forex/feeds';
import { dataAgeOf, lagBars, staleReason } from '../src/forex/freshness';
import { cotScoreAt, cotSeries, refreshMacro, valueAt, type MacroData } from '../src/forex/macro';
import { blindNewsBlock } from '../src/forex/calendar';
import { tradeLines } from '../src/forex/plan';
import { VENUE_FEES } from '../src/forex/venue-fees';
// v26: these tests pin exact R / USD numbers of other features — the venue fee is tested on its own (forex-venue-fees)
VENUE_FEES.on = false;

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

describe('v17.1 bot R ledger', () => {
  const quote = (id: string, mid: number, o: Partial<Quote> = {}): Quote => ({ id, mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED, ...o });

  it('a bot trade opens with 1 R measured on its fill and closes into the ledger in R', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    let mid = 1.1;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', mid) });
    const lab = { ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - 60_000, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    let a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    const pos = a.open[0]!;
    // 1 R = what the stop loses from the ask it filled at (≈ 1% of $1,000 at normal risk)
    expect(pos.riskUsd0).toBeGreaterThan(8);
    expect(pos.riskUsd0).toBeLessThan(12);
    // the lab closes the trade (its exit fired) at a price 1 R up
    mid = pos.entry + (pos.entry - 1.098) + HALF;
    await p.syncBot([], () => null, {}, { scope: ['1h', '4h'] });
    a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    const rows = ledgerRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('x:1h');
    expect(rows[0]!.keyT).toBe(WED - H);
    expect(rows[0]!.r).toBeCloseTo(1, 1);
    expect(ledgerSummary(a)['x:1h']).toMatchObject({ n: 1, wins: 1 });
    expect(await p.botLedger()).toHaveLength(1);
  });

  it('manual trades and unknown risk never count; the ledger keeps the newest 60 per key', () => {
    const a = newAccount(1000);
    recordTrade(a, 'x:1h', WED, 5); // the 4-argument form: stats only
    recordTrade(a, 'x:1h', WED, 5, { ref: 'x:1h:EURUSD:1', why: 'signal' }); // no risk known → r null
    recordTrade(a, 'x:1h', WED, -10, { ref: 'x:1h:EURUSD:2', riskUsd0: 10, why: 'manual' });
    expect(ledgerRows(a)).toHaveLength(2);
    expect(ledgerSummary(a)['x:1h']).toBeUndefined();
    for (let k = 0; k < 70; k++) recordTrade(a, 'x:1h', WED + k, 10, { ref: `x:1h:EURUSD:${k + 3}`, riskUsd0: 10, why: 'target' });
    expect(ledgerRows(a)).toHaveLength(60);
    expect(ledgerSummary(a)['x:1h']).toMatchObject({ n: 60, totalR: 60, avgR: 1, wins: 60 });
  });
});

describe('v17.0 review fixes', () => {
  const quote = (id: string, mid: number, o: Partial<Quote> = {}): Quote => ({ id, mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED, ...o });
  const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.09, target: 1.12, openedAt: WED - 10 * M, checkedT: WED - 10 * M, ...o });

  it("a broken 'me' account never stops the bot account's checks", async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice', '{not json');
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [pos({ stop: 1.099 })] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.098, { bars: [[WED - M, 1.0985, 1.0975, 1.098]] }) });
    await (p as unknown as { checkOpen: () => Promise<void> }).checkOpen();
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('stop');
    expect(r.m.get('fx:practice')).toBe('{not json'); // untouched
  });

  it('a weekend re-open that fails on a price hiccup is kept and retried', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 19, 12) }); // Monday noon UTC
    const now = Date.now();
    const r = new NxRedis();
    const ref = `x:1h:EURUSD:${now - 80 * H}`;
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), resume: [{ ref, strategy: 'x', pair: 'EURUSD', side: 1, riskPct: 1, lev: 30, bankedUsd: 3, riskUsd0: 10, at: now - 60 * H }] }));
    const p = new Practice(asRedis(r));
    let old = true;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1, { t: now, priceT: old ? now - 40 * M : now, bars: [[now - M, 1.1, 1.1, 1.1]] }) });
    const lab = { ref, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: now - 80 * H, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const ev = await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    expect(ev.join(' ')).toMatch(/could not re-open EURUSD yet/);
    let a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.resume).toHaveLength(1);
    old = false;
    await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.resume).toHaveLength(0);
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.riskUsd0).toBe(10); // still the original trade's 1 R
  });

  it('a hand-closed trade waiting for a price is closed as manual at the weekend flatten, never resumed', async () => {
    const fri = Date.UTC(2026, 9, 16, 20, 45); // Friday 16:45 New York: flatten time
    vi.useFakeTimers({ now: fri });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [pos({ ref: `x:1h:EURUSD:${fri - H}`, strategy: 'x', tf: '1h', closePending: { reason: 'manual', at: fri - M } }), pos({ id: 'p2', ref: `y:1h:EURUSD:${fri - H}`, strategy: 'y', tf: '1h' })] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1, { stale: true, t: fri, priceT: fri - 2 * M, bars: [] }) });
    await (p as unknown as { checkOpen: () => Promise<void> }).checkOpen();
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.open).toHaveLength(0);
    expect(a.closed.find((c) => c.id === 'p1')!.reason).toBe('manual');
    expect(a.closed.find((c) => c.id === 'p2')!.reason).toBe('weekend');
    expect(a.resume?.map((x) => x.ref)).toEqual([`y:1h:EURUSD:${fri - H}`]);
  });

  it('kept-without-data is logged once; a stale price never closes a trade; the plan says it is closing', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [pos({ ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h' })] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1, { stale: true }) });
    const seen = new Set(['GBPUSD']);
    expect((await p.syncBot([], () => null, {}, { scope: ['1h'], pairsSeen: seen })).join(' ')).toMatch(/kept EURUSD/);
    expect((await p.syncBot([], () => null, {}, { scope: ['1h'], pairsSeen: seen })).join(' ')).not.toMatch(/kept EURUSD/);
    // the market is seen again, the exit fired, but the only price is stale → pending, not a close
    await p.syncBot([], () => null, {}, { scope: ['1h'], pairsSeen: new Set(['EURUSD']) });
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.open[0]!.closePending?.reason).toBe('signal');
    const lines = tradeLines({ ...a.open[0]!, px: 1.1 }, WED, () => 0);
    expect(lines[0]!.k).toBe('closing');
  });

  it("an hourly trade may use a source's declared delay (Yahoo metals); a 1-minute trade may not", async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1, { priceT: WED - 15 * M, delayMs: 10 * M }) });
    const lab = { ref: `x:1h:EURUSD:${WED}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - 30_000, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
    const ev = await p.syncBot([{ ...lab, ref: `x:1m:EURUSD:${WED}`, tf: '1m' }], () => null, {}, { scope: ['1m'] });
    expect(ev.join(' ')).toMatch(/delayed feed/);
  });

  it('a stored paper start that is unreadable is repaired (a read error still throws)', async () => {
    const r = new NxRedis();
    r.m.set('k', 'garbage');
    expect(await paperSince(asRedis(r), 'k', 555)).toBe(555);
    expect(r.m.get('k')).toBe('555');
  });
});

describe('v17.3 feed health + freshness', () => {
  it('a provider failing 3 times in a row is paused with a growing backoff; one success closes it', () => {
    let now = 1_000_000;
    const b = new FeedBook(() => now);
    b.fail('yahoo-1h', new Error('x'));
    b.fail('yahoo-1h', new Error('x'));
    expect(b.allow('yahoo')).toBe(true);
    b.fail('yahoo-quotes', new Error('x')); // same provider
    expect(b.allow('yahoo')).toBe(false);
    expect(b.pausedUntil('yahoo')).toBe(now + 2 * M);
    now += 2 * M;
    expect(b.allow('yahoo')).toBe(true);
    b.fail('yahoo-1h', new Error('x'));
    expect(b.pausedUntil('yahoo')).toBe(now + 4 * M);
    b.ok('yahoo-1h', { items: 5, asOf: now });
    expect(b.allow('yahoo')).toBe(true);
    expect(b.allow('cftc')).toBe(true);
    const h = feedHealth(b.snapshot(), { now: now + 100 * M, open: true, oanda: false });
    expect(h.find((x) => x.id === 'yahoo-1h')!.status).toBe('stale');
    expect(h.find((x) => x.id === 'oanda')!.status).toBe('off');
    expect(h.find((x) => x.id === 'cftc')!.status).toBe('never');
    expect(feedHealth(b.snapshot(), { now: now + 100 * M, open: false, oanda: false }).find((x) => x.id === 'yahoo-1h')!.status).toBe('closed');
  });

  it('candles behind are counted on the market clock (weekends are not behind)', () => {
    const now = Date.UTC(2026, 9, 14, 14, 5); // Wed 14:05 UTC → newest closed hourly bar opened 13:00
    expect(lagBars('EURUSD', Date.UTC(2026, 9, 14, 13), now, H)).toBe(0);
    expect(lagBars('EURUSD', Date.UTC(2026, 9, 14, 10), now, H)).toBe(3);
    // Monday 00:30 UTC: Friday's last bar (20:00 UTC) is not behind — the market was shut
    const mon = Date.UTC(2026, 9, 19, 0, 30);
    expect(lagBars('EURUSD', Date.UTC(2026, 9, 16, 20), mon, H)).toBeLessThanOrEqual(3);
    const age = dataAgeOf('EURUSD', '1h', [{ t: Date.UTC(2026, 9, 14, 10), o: 1, h: 1, l: 1, c: 1 }], now, H);
    expect(age.status).toBe('stale');
    expect(staleReason(age, now)).toMatch(/EURUSD 1h prices are 4 h old \(3 candles behind/);
    expect(staleReason(dataAgeOf('EURUSD', '1h', [{ t: Date.UTC(2026, 9, 14, 13), o: 1, h: 1, l: 1, c: 1 }], now, H), now)).toBeNull();
  });

  it('positioning and rates stop counting when too old — the same in a backtest and live', () => {
    const DAY = 86_400_000;
    const xs: Array<[number, number]> = Array.from({ length: 40 }, (_, k) => [k * 7 * DAY, k / 40]);
    const lastT = 39 * 7 * DAY;
    expect(cotScoreAt(xs, lastT + 10 * DAY)).toBe(1);
    expect(cotScoreAt(xs, lastT + 18 * DAY)).toBeNaN();
    const m: MacroData = { at: 0, cot: { EUR: xs }, rates: {}, errors: [] };
    const bars = [lastT + 10 * DAY, lastT + 18 * DAY].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1 }));
    const s = cotSeries(m, 'EURUSD', bars, 60);
    expect(s[0]).toBe(1);
    expect(s[1]).toBeNaN();
    expect(valueAt([[0, 4]], 99 * DAY, 100 * DAY)).toBe(4);
    expect(valueAt([[0, 4]], 101 * DAY, 100 * DAY)).toBeNaN();
  });

  it('a dead BIS feed is not hidden by old rates; a failed refresh retries in 2 h, not 12', async () => {
    const r = new NxRedis();
    const now = Date.UTC(2026, 9, 17);
    r.m.set('fx:macro', JSON.stringify({ at: now - 13 * H, cot: {}, rates: { USD: [[0, 4]], EUR: [[0, 2]], JPY: [[0, 0.5]], GBP: [[0, 4]] }, errors: [] }));
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error('HTTP 503');
    };
    const m = await refreshMacro(asRedis(r), now, { json: fail, text: fail });
    expect(m.errors.some((e) => e.startsWith('BIS'))).toBe(true);
    expect(Object.keys(m.rates)).toHaveLength(4); // old rates still there (with their own age limit)
    const n = calls;
    await refreshMacro(asRedis(r), now + H, { json: fail, text: fail });
    expect(calls).toBe(n); // within 2 h: no new attempt
    await refreshMacro(asRedis(r), now + 2 * H + 1, { json: fail, text: fail });
    expect(calls).toBeGreaterThan(n);
  });

  it('with the news calendar gone, dollar pairs wait out the usual US release windows', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 14, h + 4, m); // October: New York = UTC−4
    expect(blindNewsBlock('EURUSD', at(8, 30))).toMatch(/US release/);
    expect(blindNewsBlock('XAUUSD', at(10, 0))).toMatch(/US release/);
    expect(blindNewsBlock('EURUSD', at(11, 0))).toBeNull();
    expect(blindNewsBlock('EURGBP', at(8, 30))).toBeNull();
  });
});

describe('v17 entry guards', () => {
  it('no new bot trade when the price already ran past the target or > 0.3R from the lab fill', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    let mid = 1.1;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: { id: 'EURUSD', mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED } });
    const lab = { ref: `x:1h:EURUSD:${WED}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - 30_000, entry: 1.1, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    mid = 1.1008; // 0.4R above the lab's fill
    expect((await p.syncBot([lab], () => null, {}, { scope: ['1h'], report: undefined })).length).toBeGreaterThanOrEqual(0);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    mid = 1.105; // past the target
    await p.syncBot([lab], () => null, {}, { scope: ['1h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    mid = 1.1003; // 0.15R: fine
    await p.syncBot([lab], () => null, {}, { scope: ['1h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
  });
});

describe('v17 account realism', () => {
  const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.099, target: 1.102, openedAt: WED - 10 * M, checkedT: WED - 10 * M, ...o });
  const q = (bars: Quote['bars']): Quote => ({ id: 'EURUSD', mid: bars[bars.length - 1]![3], bid: bars[bars.length - 1]![3] - HALF, ask: bars[bars.length - 1]![3] + HALF, t: WED, bars, dayChangePct: 0, source: 'yahoo', priceT: WED });
  it('a minute that opens past the stop fills at that open (not the stop); same for a target', () => {
    const a: PracticeAccount = { ...newAccount(1000), open: [pos()] };
    tick(a, { EURUSD: q([[WED - 2 * M, 1.0985, 1.097, 1.0975, 1.0982]]) }, WED);
    expect(a.closed[0]!.reason).toBe('stop');
    expect(a.closed[0]!.exit).toBeCloseTo(1.0982 - HALF, 8);
    const b: PracticeAccount = { ...newAccount(1000), open: [pos()] };
    tick(b, { EURUSD: q([[WED - 2 * M, 1.1035, 1.1025, 1.103, 1.103]]) }, WED);
    expect(b.closed[0]!.reason).toBe('target');
    expect(b.closed[0]!.exit).toBeCloseTo(1.103 - HALF, 8);
    // no open given (older feeds): the level, as before
    const c: PracticeAccount = { ...newAccount(1000), open: [pos()] };
    tick(c, { EURUSD: q([[WED - 2 * M, 1.0985, 1.097, 1.0975]]) }, WED);
    expect(c.closed[0]!.exit).toBe(1.099);
  });
  it('the minute still forming is checked again on the next tick', () => {
    const a: PracticeAccount = { ...newAccount(1000), open: [pos()] };
    tick(a, { EURUSD: q([[WED - 30_000, 1.1001, 1.0999, 1.1, 1.1]]) }, WED);
    expect(a.open).toHaveLength(1);
    expect(a.open[0]!.checkedT).toBe(WED - 10 * M);
    // the same minute later dips through the stop
    tick(a, { EURUSD: q([[WED - 30_000, 1.1001, 1.0985, 1.099, 1.1]]) }, WED + 20_000);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('stop');
  });
});
