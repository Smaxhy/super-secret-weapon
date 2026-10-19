import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { botStatus, dailyPnl, dayTrades, downsampleCurve, equityCurve, parsePnlQuery, periods, pnlReport, pnlRowOf, type PnlRow } from '../src/forex/pnl';
import { newAccount, Practice, tick, type ClosedPractice, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { localDay } from '../src/api/performance-calc';
import { INSTRUMENTS } from '../src/forex/types';

const H = 3_600_000;
const M = 60_000;
const EUR = INSTRUMENTS[0]!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;
/** a Wednesday 14:00:30 UTC (forex open) */
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);

afterEach(() => vi.useRealTimers());

/** get / set + the list and transaction commands the P&L log uses (MULTI applies all or nothing). */
class ListRedis {
  m = new Map<string, string>();
  lists = new Map<string, string[]>();
  failExec = false;
  execs = 0;
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
  async llen(k: string) {
    return this.lists.get(k)?.length ?? 0;
  }
  private range(n: number, a: number, b: number): [number, number] {
    const s = a < 0 ? Math.max(0, n + a) : a;
    const e = b < 0 ? n + b : Math.min(b, n - 1);
    return [s, e];
  }
  async lrange(k: string, a: number, b: number) {
    const l = this.lists.get(k) ?? [];
    const [s, e] = this.range(l.length, a, b);
    return l.slice(s, e + 1);
  }
  multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      set: (k: string, v: string) => (ops.push(() => (this.m.set(k, v), 'OK')), chain),
      del: (k: string) => (ops.push(() => Number(this.m.delete(k)) + Number(this.lists.delete(k))), chain),
      rpush: (k: string, ...vs: string[]) =>
        (ops.push(() => {
          const l = [...(this.lists.get(k) ?? []), ...vs];
          this.lists.set(k, l);
          return l.length;
        }),
        chain),
      ltrim: (k: string, a: number, b: number) =>
        (ops.push(() => {
          const l = this.lists.get(k) ?? [];
          const [s, e] = this.range(l.length, a, b);
          this.lists.set(k, l.slice(s, e + 1));
          return 'OK';
        }),
        chain),
      exec: async () => {
        this.execs++;
        if (this.failExec) throw new Error('EXECABORT');
        return ops.map((op) => [null, op()] as [null, unknown]);
      },
    };
    return chain;
  }
  log(acct: 'me' | 'bot') {
    return (this.lists.get(`fx:pnl:${acct}`) ?? []).map((x) => JSON.parse(x) as PnlRow);
  }
}
const asRedis = (r: ListRedis) => r as unknown as Redis;

const row = (o: Partial<PnlRow> & { t: number; usd: number }): PnlRow => ({ id: `r${o.t}`, pair: 'EURUSD', side: 1, strategy: 'ema_cross', tf: '1h', reason: 'target', entry: 1.1, exit: 1.101, openedAt: o.t - H, ...o });
const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 30, stop: 1.09, target: 1.12, openedAt: WED - 10 * M, checkedT: WED - 10 * M, ...o });
const quote = (mid: number, bars: Quote['bars'] = [[WED - M, mid, mid, mid]]): Quote => ({ id: 'EURUSD', mid, bid: mid - HALF, ask: mid + HALF, t: WED, bars, dayChangePct: 0, source: 'yahoo', priceT: WED });
const stubQuotes = (p: Practice, q: () => Record<string, Quote>) => {
  (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => q();
};
const closed = (o: Partial<ClosedPractice> & { id: string; closedAt: number; pnlUsd: number }): ClosedPractice => ({ ...pos({ id: o.id }), exit: 1.1, reason: 'manual', ...o });

describe('v17.8 P&L days in the viewer clock', () => {
  it('buckets closes across midnight in UTC+2 (tz −120) and UTC−5 (tz +300) like the crypto calendar', () => {
    const late14 = Date.UTC(2026, 9, 14, 21, 30); // 23:30 in UTC+2
    const after = Date.UTC(2026, 9, 14, 23, 30); // 01:30 on the 15th in UTC+2
    const rows = [row({ t: late14, usd: 10 }), row({ t: after, usd: -4 })];
    expect(dailyPnl(rows, -120).map((d) => [d.day, d.pnlUsd])).toEqual([['2026-10-14', 10], ['2026-10-15', -4]]);
    // in UTC both are on the 14th
    expect(dailyPnl(rows, 0).map((d) => [d.day, d.pnlUsd, d.trades])).toEqual([['2026-10-14', 6, 2]]);
    const ny1 = Date.UTC(2026, 9, 15, 3, 0); // 22:00 on the 14th in UTC−5
    const ny2 = Date.UTC(2026, 9, 15, 5, 30); // 00:30 on the 15th
    const ny = dailyPnl([row({ t: ny1, usd: 3 }), row({ t: ny2, usd: 2 })], 300);
    expect(ny.map((d) => d.day)).toEqual(['2026-10-14', '2026-10-15']);
    for (const t of [late14, after, ny1, ny2]) for (const tz of [-120, 300]) expect(dailyPnl([row({ t, usd: 1 })], tz)[0]!.day).toBe(localDay(new Date(t), tz));
  });

  it('a week starts on Monday; month and today in the viewer clock', () => {
    const sun = Date.UTC(2026, 9, 18, 12); // Sunday Oct 18
    const rows = [
      row({ t: Date.UTC(2026, 9, 11, 12), usd: 100 }), // Sunday before: last week
      row({ t: Date.UTC(2026, 9, 12, 9), usd: 5 }), // Monday: this week
      row({ t: Date.UTC(2026, 9, 18, 8), usd: -2 }), // today
      row({ t: Date.UTC(2026, 8, 30, 12), usd: 50 }), // September
    ];
    const p = periods(rows, sun, 0);
    expect(p.today).toEqual({ pnlUsd: -2, trades: 1, wins: 0 });
    expect(p.week).toEqual({ pnlUsd: 3, trades: 2, wins: 1 });
    expect(p.month).toEqual({ pnlUsd: 103, trades: 3, wins: 2 });
    expect(p.all).toEqual({ pnlUsd: 153, trades: 4, wins: 3 });
    // 00:30 Monday Oct 19 in UTC+2 (still Sunday in UTC): a new week has started for that viewer
    const monLocal = Date.UTC(2026, 9, 18, 22, 30);
    const q = periods(rows, monLocal, -120);
    expect(q.week).toEqual({ pnlUsd: 0, trades: 0, wins: 0 });
    expect(q.today.trades).toBe(0);
  });

  it('parts taken count as money, not as trades; a trade wins on its close + its parts', () => {
    const t0 = Date.UTC(2026, 9, 14, 10);
    const rows = [
      row({ id: 'a-part', t: t0, usd: 25, reason: 'partial' }),
      row({ id: 'a', t: t0 + H, usd: -2, reason: 'stop' }),
      row({ id: 'b', t: t0 + 2 * H, usd: -10, reason: 'stop', strategy: 'tsmom', tf: '4h' }),
      row({ id: 'c', t: t0 + 3 * H, usd: 4, reason: 'weekend', strategy: null, tf: null }),
    ];
    const [d] = dailyPnl(rows, 0, { ema_cross: 'EMA 20/50 cross' });
    expect(d!.pnlUsd).toBe(17);
    expect(d!.trades).toBe(3);
    expect(d!.wins).toBe(2); // a (+25 − 2) and the weekend leg c
    expect(d!.bestUsd).toBe(23);
    expect(d!.worstUsd).toBe(-10);
    expect(d!.byStrategy).toEqual([
      { strategy: 'ema_cross', name: 'EMA 20/50 cross', tf: '1h', trades: 1, pnlUsd: 23 },
      { strategy: 'manual', name: 'By hand', tf: null, trades: 1, pnlUsd: 4 },
      { strategy: 'tsmom', name: 'tsmom', tf: '4h', trades: 1, pnlUsd: -10 },
    ]);
    // a day with only a part taken: money, no trade, no best / worst
    const only = dailyPnl([row({ id: 'z-part', t: t0, usd: 7, reason: 'partial' })], 0)[0]!;
    expect([only.pnlUsd, only.trades, only.bestUsd, only.worstUsd]).toEqual([7, 0, null, null]);
    const dt = dayTrades(rows, '2026-10-14', 0, { ema_cross: 'EMA 20/50 cross' });
    expect(dt.map((x) => x.id)).toEqual(['c', 'b', 'a', 'a-part']);
    expect(dt[3]!.partial).toBe(true);
    expect(dt[0]!.name).toBeNull();
    expect(dt[2]!.name).toBe('EMA 20/50 cross');
  });

  it('the curve keeps every bucket high / low and the last point, ≤ 600 points', () => {
    let s = 7;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5);
    const rows = Array.from({ length: 5000 }, (_, i) => row({ id: `x${i}`, t: WED + i * M, usd: Math.round(rnd() * 2000) / 100 }));
    rows[3210]!.usd = -900; // a deep dip
    rows[3211]!.usd = 905;
    const full = (() => {
      let eq = 1000;
      return [[WED - 1, 1000] as [number, number], ...rows.map((r) => [r.t, Math.round((eq += r.usd) * 100) / 100] as [number, number])];
    })();
    const c = equityCurve(rows, 1000, 600);
    expect(c.length).toBeLessThanOrEqual(600);
    expect(c[0]).toEqual([WED - 1, 1000]);
    expect(c[c.length - 1]).toEqual(full[full.length - 1]);
    const ys = full.map((p) => p[1]);
    expect(Math.min(...c.map((p) => p[1]))).toBe(Math.min(...ys));
    expect(Math.max(...c.map((p) => p[1]))).toBe(Math.max(...ys));
    for (let i = 1; i < c.length; i++) expect(c[i]![0]).toBeGreaterThan(c[i - 1]![0]);
    // short curves are untouched
    expect(downsampleCurve([[1, 1], [2, 2]], 600)).toEqual([[1, 1], [2, 2]]);
    expect(equityCurve([], 1000)).toEqual([]);
  });

  it('report: empty shapes without an account; the curve ends at the real balance when older closes are missing', () => {
    const empty = pnlReport('bot', [], null, WED, 0);
    expect(empty).toMatchObject({ acct: 'bot', startUsd: 0, equityUsd: 0, openPnlUsd: 0, since: null, days: [], curve: [] });
    const rows = [row({ t: WED - 2 * H, usd: 30 }), row({ t: WED - H, usd: 20 })];
    const acct = { startUsd: 1000, balanceUsd: 1100, equityUsd: 1105.5, createdAt: WED - 30 * 86_400_000, positions: [{ pnlUsd: 5.5 }] };
    const r = pnlReport('bot', rows, acct, WED, 0);
    expect(r.openPnlUsd).toBe(5.5);
    expect(r.since).toBe(acct.createdAt);
    expect(r.curve[0]![1]).toBe(1050);
    expect(r.curve[r.curve.length - 1]![1]).toBe(1100);
    expect(pnlReport('bot', rows, { ...acct, balanceUsd: 1050 }, WED, 0).curve[0]).toEqual([WED - 2 * H - 1, 1000]);
  });

  it('bot status: open trades newest first with names and charts', () => {
    const st = botStatus({ startUsd: 1000, equityUsd: 1012, positions: [{ ...pos({ id: 'a', strategy: 'ema_cross', ref: `ema_cross:15m:EURUSD:${WED}`, openedAt: WED - H }), px: 1.1, pnlUsd: 7.25, pnlPct: 7 }, { ...pos({ id: 'b', openedAt: WED }), px: 1.1, pnlUsd: 4.5, pnlPct: 4 }] }, { ema_cross: 'EMA 20/50 cross' });
    expect(st.open).toBe(2);
    expect(st.openPnlUsd).toBe(11.75);
    expect(st.trades.map((t) => [t.id, t.name, t.tf])).toEqual([['b', null, null], ['a', 'EMA 20/50 cross', '15m']]);
    expect(botStatus(null)).toEqual({ open: 0, openPnlUsd: 0, equityUsd: 0, startUsd: 0, trades: [] });
  });

  it('query: acct bot | me, tz clamped ±14 h, day YYYY-MM-DD', () => {
    expect(parsePnlQuery({})).toEqual({ ok: true, acct: 'bot', tz: 0, day: null });
    expect(parsePnlQuery({ acct: 'me', tz: '-120' })).toEqual({ ok: true, acct: 'me', tz: -120, day: null });
    expect(parsePnlQuery({ tz: '2000' })).toMatchObject({ ok: true, tz: 840 });
    expect(parsePnlQuery({ acct: 'admin' }).ok).toBe(false);
    expect(parsePnlQuery({ tz: 'abc' }).ok).toBe(false);
    expect(parsePnlQuery({ day: '2026-10-14' }, true)).toMatchObject({ ok: true, day: '2026-10-14' });
    for (const day of ['2026-10-1', '2026-13-01', '2026-02-30', 'x', undefined]) expect(parsePnlQuery({ day }, true).ok).toBe(false);
  });
});

describe('v17.8 durable P&L log', () => {
  it('a booked close is logged once: repeated saves, a restart and a failed save that is retried', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new ListRedis();
    r.m.set('fx:practice', JSON.stringify({ ...newAccount(1000), open: [pos({ id: 'p1' }), pos({ id: 'p2', stop: null, target: null })] }));
    const p = new Practice(asRedis(r));
    // the stop of p1 is hit on the last minute
    stubQuotes(p, () => ({ EURUSD: quote(1.095, [[WED - M, 1.1, 1.0895, 1.095]]) }));
    await p.snapshot('me');
    expect(r.log('me').map((x) => [x.id, x.reason])).toEqual([['p1', 'stop']]);
    expect(r.log('me')[0]!.usd).toBeCloseTo(-100, 1);
    // nothing new: more snapshots never log it again
    await p.snapshot('me');
    await p.snapshot('me');
    expect(r.log('me')).toHaveLength(1);
    // a restart (a new process) and a manual close: only the new close joins
    const p2 = new Practice(asRedis(r));
    stubQuotes(p2, () => ({ EURUSD: quote(1.096) }));
    expect((await p2.close('p2')).ok).toBe(true);
    expect(r.log('me').map((x) => x.id)).toEqual(['p1', 'p2']);
    await p2.snapshot('me');
    expect(r.log('me')).toHaveLength(2);
    expect((await p2.pnlRows('me')).map((x) => x.id)).toEqual(['p1', 'p2']);

    // the same account object saved twice, and a save that fails then succeeds on retry
    const acc = JSON.parse(r.m.get('fx:practice')!) as PracticeAccount;
    acc.open = [pos({ id: 'p3', openedAt: WED, checkedT: WED - 2 * M })];
    tick(acc, { EURUSD: quote(1.08, [[WED - M, 1.1, 1.08, 1.08]]) }, WED);
    const save = (a: PracticeAccount) => (p2 as unknown as { save: (a: PracticeAccount, acct: 'me') => Promise<void> }).save(a, 'me');
    r.failExec = true;
    await expect(save(acc)).rejects.toThrow();
    expect(r.log('me')).toHaveLength(2);
    expect((JSON.parse(r.m.get('fx:practice')!) as PracticeAccount).closed).toHaveLength(2); // the account wasn't written either
    r.failExec = false;
    await save(acc);
    await save(acc);
    expect(r.log('me').map((x) => x.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('parts taken and the close of the rest are both logged; the day counts one trade', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new ListRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [pos({ id: 'b1', strategy: 'ema_cross', tf: '1h', ref: `ema_cross:1h:EURUSD:${WED - H}`, scaleAt: 1.105, scaleFrac: 0.5, scaled: false, target: null })] }));
    const p = new Practice(asRedis(r));
    // +1R: half off at 1.105 (stop → entry), then the rest stopped at the entry
    stubQuotes(p, () => ({ EURUSD: quote(1.099, [[WED - 2 * M, 1.1052 + HALF, 1.1 + HALF, 1.104 + HALF], [WED - M, 1.1, 1.098, 1.099]]) }));
    await p.snapshot('bot');
    const log = r.log('bot');
    expect(log.map((x) => [x.id, x.reason, x.strategy, x.tf])).toEqual([['b1-part', 'partial', 'ema_cross', '1h'], ['b1', 'stop', 'ema_cross', '1h']]);
    expect(log[0]!.usd).toBeCloseTo(25, 6);
    expect(log[1]!.usd).toBeCloseTo(0, 6);
    const [d] = dailyPnl(await p.pnlRows('bot'), 0);
    expect(d).toMatchObject({ day: '2026-10-14', trades: 1, wins: 1, bestUsd: 25 });
    expect(d!.pnlUsd).toBeCloseTo(25, 6);
  });

  it('an older account fills the empty log once from its closed list (oldest first) — on read or on its first save', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new ListRedis();
    const old = [closed({ id: 'c3', closedAt: WED - H, pnlUsd: 3 }), closed({ id: 'c2', closedAt: WED - 2 * H, pnlUsd: -2 }), closed({ id: 'c1', closedAt: WED - 3 * H, pnlUsd: 1 })];
    r.m.set('fx:practice', JSON.stringify({ ...newAccount(1000), balanceUsd: 1002, closed: old, open: [pos({ id: 'p9', stop: null, target: null })] }));
    const p = new Practice(asRedis(r));
    expect((await p.pnlRows('me')).map((x) => x.id)).toEqual(['c1', 'c2', 'c3']);
    expect(r.log('me').map((x) => x.id)).toEqual(['c1', 'c2', 'c3']);
    // a restart never fills it again; a new close joins once
    const p2 = new Practice(asRedis(r));
    expect(await p2.pnlRows('me')).toHaveLength(3);
    stubQuotes(p2, () => ({ EURUSD: quote(1.1) }));
    await p2.close('p9');
    expect(r.log('me').map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'p9']);
    expect((await p2.pnlRows('me')).map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'p9']);

    // first touch is a save with a new close: the fill includes it exactly once
    const r2 = new ListRedis();
    r2.m.set('fx:practice', JSON.stringify({ ...newAccount(1000), closed: old, open: [pos({ id: 'p9', stop: null, target: null })] }));
    const p3 = new Practice(asRedis(r2));
    stubQuotes(p3, () => ({ EURUSD: quote(1.1) }));
    await p3.close('p9');
    expect(r2.log('me').map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'p9']);
  });

  it('a reset clears that account\'s log only', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new ListRedis();
    r.m.set('fx:practice', JSON.stringify({ ...newAccount(1000), closed: [closed({ id: 'm1', closedAt: WED - H, pnlUsd: 5 })] }));
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), closed: [closed({ id: 'b1', closedAt: WED - H, pnlUsd: 7 })] }));
    const p = new Practice(asRedis(r));
    expect(await p.pnlRows('me')).toHaveLength(1);
    expect(await p.pnlRows('bot')).toHaveLength(1);
    await p.reset(2000, 'me');
    expect(r.lists.has('fx:pnl:me')).toBe(false);
    expect(await p.pnlRows('me')).toEqual([]);
    expect(await p.pnlRows('bot')).toHaveLength(1);
    expect((JSON.parse(r.m.get('fx:practice')!) as PracticeAccount).startUsd).toBe(2000);
    // and a new process doesn't bring the old rows back (the reset account has no closes)
    expect(await new Practice(asRedis(r)).pnlRows('me')).toEqual([]);
  });

  it('log rows are compact: strategy chart from the ref, manual trades without one', () => {
    const c = closed({ id: 'x', closedAt: WED, pnlUsd: 1.234567, strategy: 'tsmom', ref: `tsmom:4h:EURUSD:${WED}`, entry: 1.0823450000000001 });
    expect(pnlRowOf(c)).toMatchObject({ id: 'x', t: WED, usd: 1.23, strategy: 'tsmom', tf: '4h', entry: 1.082345 });
    expect(pnlRowOf(closed({ id: 'y', closedAt: WED, pnlUsd: 1 }))).toMatchObject({ strategy: null, tf: null });
  });
});
