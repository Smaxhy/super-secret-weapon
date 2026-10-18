import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { simulate, WARMUP } from '../src/forex/engine';
import { applyExit, OWNER_EXITS } from '../src/forex/exits';
import { preferVariant } from '../src/forex/filters';
import { runsOn, strategyById, type Strategy } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { trimBars } from '../src/forex/data';
import { upcomingFor, type CalEvent } from '../src/forex/calendar';
import { ForexLab, signalIndex, type MarketBook, type MarketNow, type RunNote } from '../src/forex/lab';
import { chosenOf, FastLab, nextOnGrid, type FastSource } from '../src/forex/fast';
import { newAccount, newSyncReport, Practice, tfOfRef, tick, type LabOpenTrade, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { buildPlan, leanOf, nextChecks, tradeLines, type PlanInputs } from '../src/forex/plan';
import { marketClock } from '../src/forex/calendar';
import { buildStrength } from '../src/forex/strength';
import { buildMood } from '../src/forex/mood';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';
import type { RStats } from '../src/forex/engine';

const H = 3_600_000;
const M = 60_000;
const EUR = INSTRUMENTS[0]!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;
/** a Wednesday 14:00:30 UTC: forex open, not the rollover, not the first 2 h of the week */
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);

const flat = (t: number, px: number): Bar => ({ t, o: px, h: px + 0.0001, l: px - 0.0001, c: px });
const once = (at: number, sig: Signal): Strategy => ({ id: 'x', name: 'x', family: 'control', desc: '', signal: (_c, i) => (i === at ? sig : null) });

class MiniRedis {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
}
const asRedis = (r: MiniRedis) => r as unknown as Redis;

afterEach(() => {
  vi.useRealTimers();
});

describe('trailing take-profit in the engine (v15)', () => {
  /** 260 flat hourly bars at 1.1000 (ATR ≈ 2 pips), a long signal at bar 250, then `after` bars from 260 on */
  function market(after: Array<Partial<Bar>>): Bar[] {
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 260 }, (_, i) => flat(t0 + i * H, 1.1));
    after.forEach((b, k) => {
      const px = b.c ?? 1.1;
      bars.push({ t: t0 + (260 + k) * H, o: b.o ?? px, h: b.h ?? px + 0.0001, l: b.l ?? px - 0.0001, c: px });
    });
    return bars;
  }
  const sig = (extra: Partial<Signal> = {}): Signal => ({ side: 1, stop: 1.099, target: 1.101, ...extra });
  const run = (bars: Bar[], s: Signal) => simulate(EUR, '1h', buildCtx(bars, 60, 'EURUSD'), 'x', bars.map((_, i) => (i === 250 ? s : null)));

  // a green candle through the target, a run higher, then a drop
  const runner = market([{ o: 1.1, h: 1.1015, l: 1.0999, c: 1.1014 }, { c: 1.102 }, { c: 1.103 }, { c: 1.104 }, { c: 1.104 }, { o: 1.104, h: 1.104, l: 1.1, c: 1.1 }, { c: 1.1 }]);

  it('does not close at the target: locks the stop behind it, trails, and books more R on a runner', () => {
    const plain = run(runner, sig())[0]!;
    expect(plain.reason).toBe('target');
    const tr = run(runner, sig({ tpTrail: 2, tpFrac: 0 }))[0]!;
    expect(tr.reason).toBe('trail');
    expect(tr.tpHit).toBe(true);
    expect(tr.target).toBeNull();
    expect(tr.target0).toBeCloseTo(1.101, 8);
    expect(tr.tpTrailPx).toBeGreaterThan(0);
    expect(tr.r).toBeGreaterThan(plain.r + 0.5);
  });

  it('a red candle that touches the target can come back to the locked stop in the same hour (pessimistic path)', () => {
    const bars = market([{ o: 1.1008, h: 1.1012, l: 1.1003, c: 1.1004 }, { c: 1.1004 }]);
    const plain = run(bars, sig())[0]!;
    const tr = run(bars, sig({ tpTrail: 2, tpFrac: 0 }))[0]!;
    expect(tr.reason).toBe('trail');
    expect(tr.bars).toBe(plain.bars);
    expect(tr.r).toBeGreaterThan(0);
    expect(tr.r).toBeLessThan(plain.r);
  });

  it('half at the target, the rest trails: R sits between the target and the full runner', () => {
    const plain = run(runner, sig())[0]!;
    const full = run(runner, sig({ tpTrail: 2, tpFrac: 0 }))[0]!;
    const half = run(runner, sig({ tpTrail: 2, tpFrac: 0.5 }))[0]!;
    expect(half.r).toBeGreaterThan(plain.r);
    expect(half.r).toBeLessThan(full.r);
    expect(half.r).toBeCloseTo((plain.r + full.r) / 2, 1);
  });

  it('trailing stop-loss: the stop moves up with the trade from the start and saves a winner that turns around', () => {
    // up 15 pips (1.5R) without reaching the 2R target, then back down through the old stop
    const bars = market([{ c: 1.1005 }, { c: 1.101 }, { c: 1.1015 }, { o: 1.1015, h: 1.1016, l: 1.098, c: 1.098 }, { c: 1.098 }]);
    const s = sig({ target: 1.102 });
    const plain = run(bars, s)[0]!;
    expect(plain.reason).toBe('stop');
    expect(plain.r).toBeLessThan(-0.9);
    const safe = run(bars, { ...s, trailR: 1 })[0]!;
    expect(safe.reason).toBe('trail');
    // best close 1.1015, starting distance ≈ 10.04 pips → stop ≈ 1.10046 ≈ +0.4R
    expect(safe.stop).toBeCloseTo(1.1015 - (1.1 + HALF - 1.099), 6);
    expect(safe.r).toBeGreaterThan(0.3);
    // an open trade carries its trailing distance (the bot's plan shows it)
    const open = run(market([{ c: 1.1005 }, { c: 1.101 }]), { ...s, trailR: 1 })[0]!;
    expect(open.reason).toBe('open');
    expect(open.trailPx).toBeCloseTo(1.1 + HALF - 1.099, 8);
  });

  it('a signal on the last closed bar is an open trade filled at that close (the bot can take it right away)', () => {
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 300 }, (_, i) => flat(t0 + i * H, 1.1));
    const c = buildCtx(bars, 60, 'EURUSD');
    const s = once(299, { side: 1, stop: 1.099, target: 1.102 });
    const sigs = bars.map((_, i) => s.signal(c, i));
    const ts = simulate(EUR, '1h', c, 'x', sigs);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.reason).toBe('open');
    expect(ts[0]!.entryT).toBe(bars[299]!.t + H);
    expect(ts[0]!.entry).toBeCloseTo(1.1 + HALF, 10);
    expect(signalIndex(bars, ts[0]!.entryT, 60)).toBe(299);
    expect(simulate(EUR, '1h', c, 'x', sigs, undefined, { weekendPause: true, sessionSpreads: true, liveEdge: false })).toHaveLength(0);
  });

  it('signalIndex: the bar before the entry, or the last bar for a trade filled at the last close', () => {
    const bars = [flat(0, 1), flat(H, 1), flat(2 * H, 1)];
    expect(signalIndex(bars, H, 60)).toBe(0);
    expect(signalIndex(bars, 3 * H, 60)).toBe(2);
    expect(signalIndex(bars, 9 * H, 60)).toBe(-1);
  });
});

describe('exit variants and the owner preference (v15)', () => {
  const t0 = Date.UTC(2025, 0, 6);
  const c = buildCtx(Array.from({ length: 260 }, (_, i) => flat(t0 + i * H, 1.1)), 60, 'EURUSD');
  const base: Signal = { side: 1, stop: 1.099, target: 1.102 };

  it('bigger target, trailing take-profit and half-and-trail', () => {
    expect(applyExit(base, 'wide', c, 250)!.target).toBeCloseTo(1.1 + 1.6 * 0.002, 8);
    expect(applyExit({ ...base, target: null, trailAtr: 3 }, 'wide', c, 250)!.trailAtr).toBeCloseTo(4.5, 8);
    expect(applyExit({ ...base, target: null, maxBars: 10 }, 'wide', c, 250)!.maxBars).toBe(20);
    expect(applyExit(base, 'trail_tp', c, 250)).toMatchObject({ tpTrail: 1.5, tpFrac: 0, target: 1.102 });
    expect(applyExit(base, 'half_trail', c, 250)).toMatchObject({ tpTrail: 2, tpFrac: 0.5 });
    // no target: nothing to trail from → the very same signal (the lab then reuses the designed trades)
    const noTgt: Signal = { side: 1, stop: 1.099, target: null, trailAtr: 3 };
    expect(applyExit(noTgt, 'trail_tp', c, 250)).toBe(noTgt);
    expect(applyExit(noTgt, 'half_trail', c, 250)).toBe(noTgt);
    expect(OWNER_EXITS).toEqual(['trail_sl', 'trail_tp', 'half_trail']);
    // trailing stop-loss: the stop follows at its starting distance, and at the target it keeps trailing
    expect(applyExit(base, 'trail_sl', c, 250)).toMatchObject({ trailR: 1, tpTrail: 1.5, tpFrac: 0, target: 1.102 });
    expect(applyExit(noTgt, 'trail_sl', c, 250)).toMatchObject({ trailR: 1, trailAtr: 3, target: null });
  });

  const st = (n: number, avgR: number): RStats => ({ n, winPct: 50, avgR, medianR: 0, pf: 1.2, totalR: n * avgR, maxDdR: 1 });
  it('prefers a trailing take-profit when it tests as well (first 70% only), not when it is clearly worse', () => {
    const v = (tp: number) => [
      { key: 'designed', inSample: st(400, 0.1) },
      { key: 'wide', inSample: st(400, 0.2) },
      { key: 'trail_tp', inSample: st(400, tp) },
    ];
    expect(preferVariant(v(0.195), 'wide', ['trail_tp'], 'designed')).toBe('trail_tp');
    expect(preferVariant(v(0.12), 'wide', ['trail_tp'], 'designed')).toBe('wide');
    // too few trades to count
    expect(preferVariant([{ key: 'designed', inSample: st(400, 0.1) }, { key: 'trail_tp', inSample: st(30, 0.5) }], 'designed', ['trail_tp'], 'designed')).toBe('designed');
    // the owner's order: the trailing stop-loss first when it also tests as well, even if a trailing take-profit is a bit better
    const both = [...v(0.2), { key: 'trail_sl', inSample: st(400, 0.192) }];
    expect(preferVariant(both, 'wide', ['trail_sl', 'trail_tp'], 'designed')).toBe('trail_sl');
    expect(preferVariant([...v(0.2), { key: 'trail_sl', inSample: st(400, 0.15) }], 'wide', ['trail_sl', 'trail_tp'], 'designed')).toBe('trail_tp');
    // the yardstick is the best variant, not a weaker pick
    expect(preferVariant([...v(0.1), { key: 'runner', inSample: st(400, 0.3) }], 'wide', ['trail_tp'], 'designed')).toBe('wide');
  });

  it('which strategies run on which chart', () => {
    expect(runsOn(strategyById('london_breakout')!, '15m')).toBe(false);
    expect(runsOn(strategyById('london_breakout')!, '1h')).toBe(true);
    expect(runsOn(strategyById('ccy_momentum')!, '4h')).toBe(true);
    expect(runsOn(strategyById('ccy_momentum')!, '1m')).toBe(false);
    expect(runsOn(strategyById('ema_cross')!, '1m')).toBe(true);
  });
});

describe('bot account (v15)', () => {
  const quote = (bars: Array<[number, number, number, number]>, mid = bars[bars.length - 1]![3]): Quote => ({ id: 'EURUSD', mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars, dayChangePct: 0, source: 'yahoo', priceT: WED });
  const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.099, target: 1.101, openedAt: WED - 10 * M, checkedT: WED - 10 * M, ...o });

  it('trailing take-profit: part off at the target, stop locked behind it, then the locked stop closes it in profit', () => {
    const a: PracticeAccount = { ...newAccount(1000), open: [pos({ tpTrailPx: 0.0004, tpFrac: 0.5, tpHit: false })] };
    const ev = tick(a, { EURUSD: quote([[WED - 5 * M, 1.1012, 1.1001, 1.1011]]) }, WED);
    expect(ev.join(' ')).toMatch(/reached its target/);
    const p = a.open[0]!;
    expect(p.tpHit).toBe(true);
    expect(p.target).toBeNull();
    expect(p.stop).toBeCloseTo(1.1006, 8);
    expect(p.units).toBeCloseTo(5_000, 6);
    expect(a.closed[0]!.reason).toBe('partial');
    expect(a.closed[0]!.pnlUsd).toBeCloseTo(5, 6);
    tick(a, { EURUSD: quote([[WED - 5 * M, 1.1012, 1.1001, 1.1011], [WED - 4 * M, 1.1011, 1.1004, 1.1005]]) }, WED);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('stop');
    expect(a.closed[0]!.pnlUsd).toBeGreaterThan(0);
  });

  function botWith(open: PracticePosition[]): { practice: Practice; redis: MiniRedis } {
    const redis = new MiniRedis();
    redis.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open }));
    const practice = new Practice(asRedis(redis));
    const mids: Record<string, number> = { EURUSD: 1.1, GBPUSD: 1.27, USDJPY: 150, AUDUSD: 0.66, USDCAD: 1.37, USDCHF: 0.8, NZDUSD: 0.6, EURJPY: 165, GBPJPY: 190, EURGBP: 0.866, XAUUSD: 2500, XAGUSD: 30 };
    (practice as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () =>
      Object.fromEntries(
        INSTRUMENTS.map((i) => {
          const mid = mids[i.id]!;
          const half = (i.spreadPips * i.pip) / 2;
          return [i.id, { id: i.id, mid, bid: mid - half, ask: mid + half, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() } as Quote];
        }),
      );
    return { practice, redis };
  }
  const lab = (o: Partial<LabOpenTrade>): LabOpenTrade => ({ ref: `x:1m:EURUSD:${WED}`, strategy: 'x', tf: '1m', pair: 'EURUSD', side: 1, entryT: WED - 30_000, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null, ...o });
  const load = async (r: MiniRedis) => JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;

  it("one chart's check never closes another chart's trades", async () => {
    vi.useFakeTimers({ now: WED });
    const { practice, redis } = botWith([pos({ id: 'm1', ref: `ema_cross:1m:EURUSD:${WED - 5 * M}`, strategy: 'ema_cross', tf: '1m', stop: 1.098, target: 1.104 })]);
    await practice.syncBot([], () => null, {}, { scope: ['1h', '4h'] });
    expect((await load(redis)).open).toHaveLength(1);
    await practice.syncBot([], () => null, {}, { scope: ['1m'] });
    const a = await load(redis);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]!.reason).toBe('signal');
  });

  it('1-minute signals go stale in 2 minutes; at most 2 one-minute trades at once', async () => {
    vi.useFakeTimers({ now: WED });
    const { practice, redis } = botWith([]);
    const rep = newSyncReport();
    await practice.syncBot(
      [
        lab({ ref: `a:1m:EURUSD:${WED}`, strategy: 'a', pair: 'EURUSD', entryT: WED - 3 * M }),
        lab({ ref: `b:1m:GBPUSD:${WED}`, strategy: 'b', pair: 'GBPUSD', stop: 1.265, target: 1.28 }),
        lab({ ref: `c:1m:AUDUSD:${WED}`, strategy: 'c', pair: 'AUDUSD', stop: 0.655, target: 0.67 }),
        lab({ ref: `d:1m:NZDUSD:${WED}`, strategy: 'd', pair: 'NZDUSD', stop: 0.595, target: 0.61 }),
      ],
      () => null,
      {},
      { scope: ['1m'], report: rep },
    );
    const a = await load(redis);
    expect(a.open.map((p) => p.pair).sort()).toEqual(['AUDUSD', 'GBPUSD']);
    expect(a.open.every((p) => p.tf === '1m')).toBe(true);
    expect(rep.candidates).toBe(3);
    expect(rep.opened).toBe(2);
    expect(rep.skipped.map((s) => s.why).join(' ')).toMatch(/already 2 1m trades open/);
  });

  it('the lab reached the target on its chart → the bot position switches to trailing too', async () => {
    vi.useFakeTimers({ now: WED });
    const ref = `x:15m:EURUSD:${WED - 30 * M}`;
    const { practice, redis } = botWith([pos({ ref, strategy: 'x', tf: '15m', tpTrailPx: 0.0004, tpFrac: 0.5, tpHit: false })]);
    await practice.syncBot([lab({ ref, tf: '15m', stop: 1.1006, target: null, tpHit: true, tpTrailPx: 0.0004, tpFrac: 0.5, trailAtr: 2 })], () => null, {}, { scope: ['15m'] });
    const a = await load(redis);
    const p = a.open[0]!;
    expect(p.tpHit).toBe(true);
    expect(p.target).toBeNull();
    expect(p.trailAtr).toBe(2);
    expect(a.closed[0]!.reason).toBe('partial');
    // the lab's locked stop sits above the price (1.1000): it is not followed until price is past it
    expect(p.stop).toBe(1.099);
  });

  it('results per strategy and chart', async () => {
    const redis = new MiniRedis();
    const closed = [
      { ...pos({ ref: 'a:1h:EURUSD:1', strategy: 'a' }), exit: 1, closedAt: 1, pnlUsd: -5, reason: 'stop' },
      { ...pos({ ref: 'a:1m:EURUSD:2', strategy: 'a', tf: '1m' }), exit: 1, closedAt: 2, pnlUsd: 3, reason: 'target' },
      { ...pos({ ref: 'a:1m:EURUSD:2', strategy: 'a', tf: '1m' }), exit: 1, closedAt: 2, pnlUsd: 1, reason: 'partial' },
    ];
    redis.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), closed }));
    const res = await new Practice(asRedis(redis)).botResults();
    expect(res['a:1h']).toEqual({ n: 1, pnlUsd: -5 });
    expect(res['a:1m']).toEqual({ n: 1, pnlUsd: 4 });
    expect(tfOfRef('a:15m:EURUSD:1')).toBe('15m');
  });
});

describe('15-minute and 1-minute lab (v15)', () => {
  it('pure helpers: run grid, picks, history window, upcoming news', () => {
    expect(nextOnGrid(Date.UTC(2026, 0, 1, 10, 7), 15 * M, 40_000)).toBe(Date.UTC(2026, 0, 1, 10, 15, 40));
    expect(nextOnGrid(Date.UTC(2026, 0, 1, 10, 15, 30), 15 * M, 40_000)).toBe(Date.UTC(2026, 0, 1, 10, 15, 40));
    expect(chosenOf([{ id: 'a', tf: '1m', verdict: 'edge' }, { id: 'b', tf: '1m', verdict: 'no' }, { id: 'random', tf: '1m', verdict: 'maybe' }, { id: 'c', tf: '15m', verdict: 'maybe' }], ['c:15m'])).toEqual(['a:1m']);
    const bars = Array.from({ length: 100 }, (_, i) => flat(i * M, 1));
    expect(trimBars(bars, 100 * M, 50 * M, 1000)).toHaveLength(50);
    expect(trimBars(bars, 100 * M, 500 * M, 30)[0]!.t).toBe(70 * M);
    const ev = (o: Partial<CalEvent>): CalEvent => ({ t: WED + H, ccy: 'USD', title: 'CPI', impact: 'High', forecast: '', previous: '', ...o });
    const got = upcomingFor('EURUSD', WED, [ev({}), ev({ ccy: 'JPY' }), ev({ impact: 'Low' }), ev({ t: WED + 9 * H }), ev({ impact: 'Medium', title: 'Fed Chair Speaks' })]);
    expect(got.map((e) => e.title)).toEqual(['CPI', 'Fed Chair Speaks']);
  });

  /** a lab with a minimal hourly market read (no strength / mood data) */
  function labWithBook(redis: MiniRedis): ForexLab {
    const lab = new ForexLab(asRedis(redis));
    const h1 = new Map<string, Bar[]>();
    for (const inst of INSTRUMENTS.slice(0, 2)) h1.set(inst.id, Array.from({ length: 600 }, (_, i) => flat(WED - (600 - i) * H, inst.id === 'EURUSD' ? 1.1 : 1.27)));
    const book: MarketBook = { at: 1, strength: buildStrength({}), mood: buildMood({}), ranks: {}, zOil: null, zYield: null, zStocks: null, zDollar: null, spxMtd: null, h1 };
    lab.book = book;
    return lab;
  }
  function walk(n: number, end: number, barMs: number, start: number, seed: number): Bar[] {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    let px = start;
    return Array.from({ length: n }, (_, i) => {
      const o = px;
      const c = o * (1 + (rnd() - 0.5) * 0.0012 + Math.sin(i / 120) * 0.0002);
      px = c;
      return { t: end - (n - i) * barMs, o, h: Math.max(o, c) * (1 + rnd() * 0.0004), l: Math.min(o, c) * (1 - rnd() * 0.0004), c };
    });
  }

  it('collects candles, tests every short-chart strategy on its own history and checks the newest close live', async () => {
    const redis = new MiniRedis();
    const lab = labWithBook(redis);
    const sync = vi.fn(async () => [] as string[]);
    lab.practice = { syncBot: sync, botResults: async () => ({}) } as unknown as Practice;
    const data: Record<string, Bar[]> = {};
    for (const [k, inst] of INSTRUMENTS.slice(0, 2).entries()) {
      data[`15m:${inst.id}`] = walk(1_700, WED - 30_000, 15 * M, inst.id === 'EURUSD' ? 1.1 : 1.27, 11 + k);
      data[`1m:${inst.id}`] = walk(1_700, WED - 30_000, M, inst.id === 'EURUSD' ? 1.1 : 1.27, 21 + k);
    }
    const asked: number[] = [];
    const src: FastSource = {
      oanda: async () => false,
      bars: async (inst, tf, fromT) => {
        asked.push(fromT);
        return { bars: (data[`${tf}:${inst.id}`] ?? []).filter((b) => b.t >= fromT), source: 'yahoo' };
      },
    };
    const fast = new FastLab(asRedis(redis), lab, src);
    await fast.refresh('15m', WED);
    await fast.refresh('1m', WED);
    expect(fast.series('15m', 'EURUSD')).toHaveLength(1_700);
    expect(fast.series('1m', 'GBPUSD')).toHaveLength(1_700);
    // a market with too little history gets one full backfill request (keepDays back)
    expect(Math.min(...asked)).toBeLessThan(WED - 20 * 86_400_000);
    const rep = await fast.evaluate(WED);
    expect(rep).not.toBeNull();
    const tfs = new Set(rep!.rows.map((r) => r.tf));
    expect(tfs).toEqual(new Set(['15m', '1m']));
    expect(rep!.rows.some((r) => r.id === 'london_breakout' || r.id === 'ccy_momentum')).toBe(false);
    expect(rep!.spans['15m'].markets).toBe(2);
    expect(rep!.spans['1m'].oosFrom).toBeGreaterThan(rep!.spans['1m'].from!);
    expect(redis.m.has('fx:fast:report')).toBe(true);
    await fast.decide('15m', WED);
    expect(fast.firing['15m']).toBeDefined();
    expect(sync).toHaveBeenCalledTimes(1);
    const call = sync.mock.calls[0] as unknown as [LabOpenTrade[], unknown, unknown, { scope: string[] }];
    expect(call[3].scope).toEqual(['15m']);
    expect(call[0].every((t) => t.tf === '15m' && t.chosen)).toBe(true);
    expect(lab.runs[0]!.tf).toBe('15m');
    // weekends: nothing to check
    await fast.decide('1m', Date.UTC(2026, 9, 17, 12));
    expect(sync).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe("the bot's plan (v15)", () => {
  const market = (o: Partial<MarketNow> = {}): MarketNow =>
    ({ id: 'EURUSD', label: 'EUR/USD', price: 1.1, t: WED - H, change24hPct: 0, closes: [], trend: 'up', rsi: 50, atrPips: 10, firing: [], openPaper: 0, bars: [], drawings: { lines: [], levels: [], ranges: [] }, mtf: { h1: 1, h4: 1, d1: 1 }, strength: { base: 'EUR', quote: 'USD', baseScore: 0.5, quoteScore: -0.3, gap: 0.8 }, risk: 0, ...o }) as MarketNow;
  const base = (o: Partial<PlanInputs> = {}): PlanInputs => ({
    now: WED,
    clock: marketClock(WED),
    oanda: false,
    markets: [market()],
    mood: null,
    fastFiring: {},
    chosen: ['ema_cross:15m', 'tsmom:1h'],
    names: { ema_cross: 'EMA 20/50 cross', tsmom: 'Time-series momentum' },
    positions: [],
    resume: [],
    equityUsd: 1000,
    lastSync: {},
    labOpen: {},
    runs: [],
    upcoming: () => [],
    blockNow: () => null,
    pnlAt: (p, x) => p.side * p.units * (x - p.entry),
    ...o,
  });

  it('leans with the stronger currency and the bigger charts', () => {
    expect(leanOf(market(), null)).toMatchObject({ side: 1 });
    expect(leanOf(market(), null).why).toMatch(/EUR stronger than USD/);
    expect(leanOf(market({ mtf: { h1: 0, h4: -1, d1: 1 }, strength: { base: 'EUR', quote: 'USD', baseScore: 0, quoteScore: 0, gap: 0.05 } }), null).side).toBe(0);
  });

  it('spells out every exit of a trade, including the trailing take-profit and the time limit', () => {
    const p: PracticePosition & { px: number } = { id: 'p', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.099, target: 1.102, openedAt: WED - H, checkedT: WED, ref: `ema_cross:15m:EURUSD:${WED - H}`, tf: '15m', tpTrailPx: 0.0005, tpFrac: 0.5, beAt: 1.101, maxBars: 8, px: 1.1005 };
    const lines = tradeLines(p, WED, (q, x) => q.side * q.units * (x - q.entry));
    const text = lines.map((l) => l.text).join(' | ');
    expect(text).toMatch(/Stop 1\.09900 \(10 pips/);
    expect(text).toMatch(/takes 50% off, locks the stop 5 pips behind/);
    expect(text).toMatch(/break-even|entry price/);
    expect(text).toMatch(/Time limit: closed after 8 15-minute candles/);
    const hit = tradeLines({ ...p, tpHit: true, target: null, stop: 1.1015, trailAtr: 2 }, WED, (q, x) => q.side * q.units * (x - q.entry));
    expect(hit.find((l) => l.k === 'target')!.done).toBe(true);
    expect(hit.map((l) => l.text).join(' ')).toMatch(/Stop locked at 1\.10150/);
    const sl = tradeLines({ ...p, trailPx: 0.001 }, WED, (q, x) => q.side * q.units * (x - q.entry));
    expect(sl.map((l) => l.text).join(' ')).toMatch(/Trailing stop-loss: the stop follows the price 10 pips behind/);
  });

  it('per market: in a trade, waiting on news, already in a trade, or just watching', () => {
    const position = { id: 'p', pair: 'GBPUSD', side: 1 as const, units: 1000, entry: 1.27, marginUsd: 50, leverage: 30, stop: 1.26, target: 1.29, openedAt: WED - H, checkedT: WED, strategy: 'tsmom', ref: `tsmom:1h:GBPUSD:${WED - H}`, tf: '1h', px: 1.271, pnlUsd: 1 };
    const sync = newSyncReport();
    sync.waits.push({ pair: 'USDJPY', strategy: 'ema_cross', tf: '15m', side: -1, why: 'USD news: CPI' });
    const plan = buildPlan(
      base({
        markets: [market(), market({ id: 'GBPUSD', label: 'GBP/USD' }), market({ id: 'USDJPY', label: 'USD/JPY' })],
        positions: [position],
        fastFiring: { '15m': { tf: '15m', t: WED - 15 * M, at: WED, byPair: { USDJPY: [{ id: 'ema_cross', name: 'EMA 20/50 cross', side: -1, allowed: true, why: null, chosen: true }], EURUSD: [{ id: 'ema_cross', name: 'EMA 20/50 cross', side: 1, allowed: true, why: null, chosen: true }] } } },
        lastSync: { '15m': sync },
        labOpen: { 'ema_cross:15m:EURUSD': WED - 6 * H },
        runs: [{ t: WED - M, tf: '15m', signals: 2, chosen: 2, opened: 0, skipped: 0, waits: 1, holding: 1, note: 'x' } as RunNote],
      }),
    );
    const by = (id: string) => plan.markets.find((m) => m.id === id)!;
    expect(by('GBPUSD').status).toBe('trading');
    expect(by('GBPUSD').headline).toMatch(/Time-series momentum/);
    expect(by('USDJPY').status).toBe('waiting');
    expect(by('USDJPY').headline).toMatch(/USD news: CPI/);
    expect(by('EURUSD').signals[0]!.verdict).toMatch(/already in a trade/);
    expect(by('AUDUSD').status).toBe('watching');
    expect(plan.markets[0]!.id).toBe('GBPUSD');
    expect(plan.trades).toHaveLength(1);
    expect(plan.trading).toEqual({ '15m': 1, '1h': 1 });
    expect(plan.summary).toMatch(/In 1 trade/);
    expect(plan.timeline).toHaveLength(1);
  });

  it('weekends and news blocks', () => {
    const sat = Date.UTC(2026, 9, 17, 12);
    expect(buildPlan(base({ now: sat, clock: marketClock(sat) })).summary).toMatch(/Market closed/);
    const p = buildPlan(base({ upcoming: (pair) => (pair === 'EURUSD' ? [{ t: WED + 20 * M, ccy: 'USD', title: 'CPI', impact: 'High' }] : []), blockNow: (pair) => (pair === 'EURUSD' ? 'USD news: CPI' : null) }));
    const eur = p.markets.find((m) => m.id === 'EURUSD')!;
    expect(eur.status).toBe('blocked');
    expect(eur.blocks.join(' ')).toMatch(/USD CPI in 20 min/);
  });

  it('next checks follow each chart', () => {
    const n = Object.fromEntries(nextChecks(Date.UTC(2026, 0, 1, 10, 7, 0), true).map((x) => [x.tf, x.at]));
    expect(n['1m']).toBe(Date.UTC(2026, 0, 1, 10, 7, 20));
    expect(n['15m']).toBe(Date.UTC(2026, 0, 1, 10, 15, 40));
    expect(n['1h']).toBe(Date.UTC(2026, 0, 1, 11, 1, 30));
    expect(n['4h']).toBe(Date.UTC(2026, 0, 1, 12, 1, 30));
    expect(Object.fromEntries(nextChecks(Date.UTC(2026, 0, 1, 10, 7, 0), false).map((x) => [x.tf, x.at]))['1m']).toBe(Date.UTC(2026, 0, 1, 10, 8, 20));
  });
});

// keep WARMUP referenced: the engine's warm-up must stay below the 260-bar test markets above
it('test markets are longer than the warm-up', () => expect(WARMUP).toBeLessThan(250));

describe('bigger size when more sure (v15.2)', () => {
  it('counts the market checks that back a side', async () => {
    const { agreeCount, confirmations, judgeCuts, maxConfirmations, tierOf } = await import('../src/forex/conviction');
    const env = (o: Partial<import('../src/forex/filters').FilterEnv> = {}) => ({ tf: '1h' as const, gap: new Float64Array([0.5]), h4: Int8Array.from([1]), d1: Int8Array.from([1]), mood: new Float64Array([0.8]), riskLong: 1, ...o });
    expect(agreeCount(env(), 0, 1)).toBe(4);
    expect(agreeCount(env(), 0, -1)).toBe(0);
    // mood only counts when it is clear AND the trade carries real risk-on / safe-haven exposure
    expect(agreeCount(env({ riskLong: 0 }), 0, 1)).toBe(3);
    expect(agreeCount(env({ mood: new Float64Array([0.2]) }), 0, 1)).toBe(3);
    // 4-hour charts have no next-bigger chart
    expect(agreeCount(env({ tf: '4h' }), 0, 1)).toBe(3);
    expect(maxConfirmations('4h', true)).toBe(5);
    expect(maxConfirmations('15m', false)).toBe(4);
    const cuts = judgeCuts(Array.from({ length: 100 }, (_, i) => i / 100));
    expect(cuts.pHi).toBeCloseTo(0.7, 8);
    expect(cuts.pTop).toBeCloseTo(0.9, 8);
    expect(confirmations(3, 0.95, cuts)).toBe(5);
    expect(confirmations(3, 0.75, cuts)).toBe(4);
    expect(confirmations(3, null, cuts)).toBe(3);
    expect(tierOf(5, true)).toBe('verySure');
    expect(tierOf(4, true)).toBe('sure');
    expect(tierOf(4, false)).toBe('verySure');
    expect(tierOf(2, false)).toBe('normal');
  });

  it('only trades bigger once the sure trades made clearly more on unseen data', async () => {
    const { boostFor, gradeConviction } = await import('../src/forex/conviction');
    const rows = (sureR: number, veryR: number, n = 80) => [
      ...Array.from({ length: n }, (_, k) => ({ t: k, r: 0, conf: 1 })),
      ...Array.from({ length: n }, (_, k) => ({ t: 1000 + k, r: 0, conf: 1 })),
      ...Array.from({ length: n }, (_, k) => ({ t: 1000 + k, r: sureR, conf: 3 })),
      ...Array.from({ length: n }, (_, k) => ({ t: 1000 + k, r: veryR, conf: 5 })),
      ...Array.from({ length: n }, (_, k) => ({ t: k, r: sureR, conf: 3 })),
    ];
    const cuts = { pHi: 0.6, pTop: 0.8 };
    const good = gradeConviction(rows(0.3, 0.6), 1000, 'hourly', true, cuts);
    expect(good.active).toBe(true);
    expect(good.tiers.map((t) => t.active)).toEqual([true, true]);
    expect(boostFor('verySure', good)).toEqual({ tier: 'verySure', mult: 2, lev: 100 });
    expect(boostFor('sure', good)).toEqual({ tier: 'sure', mult: 1.5, lev: 50 });
    expect(boostFor('normal', good)).toEqual({ tier: 'normal', mult: 1, lev: null });
    // 'very sure' no better than 'sure' → it only gets the 'sure' size
    const flatTop = gradeConviction(rows(0.3, 0.3), 1000, 'hourly', true, cuts);
    expect(flatTop.tiers.map((t) => t.active)).toEqual([true, false]);
    expect(boostFor('verySure', flatTop)).toEqual({ tier: 'sure', mult: 1.5, lev: 50 });
    // sure trades no better on unseen data → normal size for everything
    const none = gradeConviction(rows(0.02, 0.02), 1000, 'hourly', true, cuts);
    expect(none.active).toBe(false);
    expect(none.why).toMatch(/not clearly better/);
    expect(boostFor('verySure', none).mult).toBe(1);
    // too few
    expect(gradeConviction(rows(0.5, 0.8, 20), 1000, 'hourly', true, cuts).active).toBe(false);
  });

  it('the bot account risks more at higher leverage on a proven sure entry (never above 2%)', async () => {
    vi.useFakeTimers({ now: WED });
    const redis = new MiniRedis();
    redis.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const practice = new Practice(asRedis(redis));
    (practice as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({
      EURUSD: { id: 'EURUSD', mid: 1.1, bid: 1.1 - HALF, ask: 1.1 + HALF, t: WED, bars: [[WED - M, 1.1, 1.1, 1.1]], dayChangePct: 0, source: 'yahoo', priceT: WED },
      GBPUSD: { id: 'GBPUSD', mid: 1.27, bid: 1.27 - 0.00006, ask: 1.27 + 0.00006, t: WED, bars: [[WED - M, 1.27, 1.27, 1.27]], dayChangePct: 0, source: 'yahoo', priceT: WED },
    });
    const base = { strategy: 'x', tf: '1h', side: 1 as const, entryT: WED - 60_000, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    await practice.syncBot(
      [
        { ...base, ref: `x:1h:EURUSD:${WED}`, pair: 'EURUSD', stop: 1.098, target: 1.104, conviction: { tier: 'verySure', conf: 5, of: 6, mult: 2, lev: 100 } },
        // a short: the long EUR/USD already carries 2% against the dollar, a second dollar-short would pass the 2.2% cap
        { ...base, ref: `y:1h:GBPUSD:${WED}`, strategy: 'y', pair: 'GBPUSD', side: -1, stop: 1.272, target: 1.266, conviction: { tier: 'normal', conf: 2, of: 6, mult: 1, lev: null } },
      ],
      () => null,
      {},
      { scope: ['1h', '4h'] },
    );
    const a = JSON.parse(redis.m.get('fx:practice:bot')!) as PracticeAccount;
    const eur = a.open.find((p) => p.pair === 'EURUSD')!;
    const gbp = a.open.find((p) => p.pair === 'GBPUSD')!;
    expect(eur.leverage).toBe(100);
    expect(eur.riskPct).toBeCloseTo(2, 1);
    expect(eur.conviction?.tier).toBe('verySure');
    expect(gbp.leverage).toBe(30);
    expect(gbp.riskPct).toBeCloseTo(1, 1);
    const lines = tradeLines({ ...eur, px: 1.1 }, WED, (q, x) => q.side * q.units * (x - q.entry)).map((l) => l.text).join(' ');
    expect(lines).toMatch(/Bigger size: very sure — 5 of 6 checks agreed/);
  });
});
