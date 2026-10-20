/** v20.1 strict mode (owner: "I want to win, make it trade only what will work with proper research, revert all
 * current active trades"). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { Practice, newAccount, undoOpen, type ClosedPractice, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { FX_CONFIG, qualityPass } from '../src/forex/lab';
import { buildDesks, desksSummary, type DeskInput } from '../src/forex/desks';
import { classify, whyNoTrades } from '../src/forex/why';
import { INSTRUMENTS } from '../src/forex/types';
import { buildPlan, checksOf } from '../src/forex/plan';
import { marketClock } from '../src/forex/calendar';

const M = 60_000;
const H = 60 * M;
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;

class NxRedis {
  m = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string, mode?: string) {
    if (mode === 'NX' && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
  async lrange(k: string) {
    return this.lists.get(k) ?? [];
  }
  async llen(k: string) {
    return (this.lists.get(k) ?? []).length;
  }
  multi() {
    const ops: Array<() => void> = [];
    const self = this;
    const m = {
      del(k: string) {
        ops.push(() => self.lists.delete(k));
        return m;
      },
      rpush(k: string, ...v: string[]) {
        ops.push(() => self.lists.set(k, [...(self.lists.get(k) ?? []), ...v]));
        return m;
      },
      lpush(k: string, ...v: string[]) {
        ops.push(() => self.lists.set(k, [...v.reverse(), ...(self.lists.get(k) ?? [])]));
        return m;
      },
      set(k: string, v: string) {
        ops.push(() => self.m.set(k, v));
        return m;
      },
      ltrim() {
        return m;
      },
      async exec() {
        for (const o of ops) o();
        return [];
      },
    };
    return m;
  }
}
const asRedis = (r: NxRedis) => r as unknown as Redis;
const quote = (id: string, mid: number): Quote => ({ id, mid, bid: mid - HALF, ask: mid + HALF, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() });
const pos = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, entry: 1.1, units: 3000, marginUsd: 100, leverage: 30, stop: 1.095, target: 1.11, openedAt: WED - 3 * H, ref: `x:1h:EURUSD:${WED - 4 * H}`, strategy: 'x', tf: '1h', ...o } as PracticePosition);
const closed = (o: Partial<ClosedPractice> = {}): ClosedPractice => ({ id: 'c1', pair: 'EURUSD', side: 1, entry: 1.1, exit: 1.099, stop: null, target: null, marginUsd: 10, leverage: 30, openedAt: WED - 3 * H, closedAt: WED - 30 * M, pnlUsd: -5, reason: 'signal', ref: `x:1h:EURUSD:${WED - 4 * H}`, strategy: 'x', tf: '1h', ...o } as ClosedPractice);

afterEach(() => vi.useRealTimers());

describe('v20.1 strict mode is the default', () => {
  it('edge only, 2 market checks, no desk trades, market entries only', () => {
    expect(FX_CONFIG.strict).toEqual({ mode: 'quality', minAgree: 2, deskTrades: false, market: { minN: 12, minPf: 1.1 } });
    expect(FX_CONFIG.liveEntries).toBe(false);
  });
});

describe('v20.1 revert the open trades', () => {
  it('strikes positions, their parts and rolls, orders and weekend pauses; closed trades stay', () => {
    const a: PracticeAccount = {
      ...newAccount(1000),
      balanceUsd: 1000 + 12 - 5 + 3.5,
      peakUsd: 1015.5,
      open: [pos({ id: 'p1', bankedUsd: 12 }), pos({ id: 'p2', pair: 'GBPUSD', bankedUsd: 3.5, ref: `y:4h:GBPUSD:${WED - 8 * H}`, strategy: 'y', tf: '4h' })],
      closed: [closed({ id: 'p1-part', reason: 'partial', pnlUsd: 12 }), closed({ id: 'c1', pnlUsd: -5 }), closed({ id: 'p2-part', reason: 'partial', pnlUsd: 2 }), closed({ id: 'p2-part2', reason: 'partial', pnlUsd: 1.5 })],
      orders: [{ id: 'o1', pair: 'USDJPY', side: -1, limit: 150, expiresAt: WED + H, stop: 151, target: 148, marginUsd: 50, leverage: 30, placedAt: WED - M, ref: `z:1h:USDJPY:${WED - H}`, strategy: 'z', tf: '1h' } as unknown as NonNullable<PracticeAccount['orders']>[number]],
      resume: [{ ref: `w:1h:AUDUSD:${WED - 30 * H}`, pair: 'AUDUSD', side: 1, scaled: false, tpHit: false, lev: 30, bankedUsd: 0, at: WED - 20 * H }],
    };
    const r = undoOpen(a);
    expect(r).toMatchObject({ open: 2, parts: 3, usd: 15.5, orders: 1, paused: 1 });
    expect(r.ids).toEqual(['p1', 'p2']);
    expect(a.open).toHaveLength(0);
    expect(a.orders).toHaveLength(0);
    expect(a.resume).toHaveLength(0);
    expect(a.closed.map((c) => c.id)).toEqual(['c1']);
    expect(a.balanceUsd).toBeCloseTo(995, 2); // 1000 − 5 (the finished losing trade stays), the parts' $15.50 taken back
    expect(a.peakUsd).toBeCloseTo(1000, 2);
  });

  it('Practice.undoOpen rewrites the durable P&L log too', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), balanceUsd: 1007, open: [pos({ id: 'p1', bankedUsd: 7 })], closed: [closed({ id: 'p1-part', reason: 'partial', pnlUsd: 7 }), closed({ id: 'old', pnlUsd: -3, closedAt: WED - 5 * H })] }));
    r.lists.set('fx:pnl:bot', [JSON.stringify({ id: 'p1-part', t: WED - H, usd: 7, pair: 'EURUSD', side: 1, strategy: 'x', tf: '1h', reason: 'partial', entry: 1.1, exit: 1.102 }), JSON.stringify({ id: 'old', t: WED - 5 * H, usd: -3, pair: 'EURUSD', side: 1, strategy: 'x', tf: '1h', reason: 'signal', entry: 1.1, exit: 1.099 })]);
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
    const line = await p.undoOpen('bot');
    expect(line).toMatch(/1 position, 1 part \(−\$7\.00 taken back out\)/);
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(a.open).toHaveLength(0);
    expect(a.balanceUsd).toBe(1000);
    expect((r.lists.get('fx:pnl:bot') ?? []).map((x) => (JSON.parse(x) as { id: string }).id)).toEqual(['old']);
  });
});

describe('v20.1 a trade needs 2 market checks on its side', () => {
  it('syncBot waits with 1 of 4 and opens with 2 of 4', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
    const lab = { ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - M, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null, agree: { n: 1, of: 4, need: 2 } };
    const ev = await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    expect(ev.join(' ')).toMatch(/only 1 of 4 market checks agree \(needs 2/);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    expect(classify('only 1 of 4 market checks agree (needs 2: strength, bigger charts, mood)')).toBe('agree');
    await p.syncBot([{ ...lab, agree: { n: 2, of: 4, need: 2 } }], () => null, {}, { scope: ['1h', '4h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
  });

  it('the Why readout names it', () => {
    const w = whyNoTrades({
      now: WED, clock: { open: true, noNewTrades: false, rollover: false },
      runs: [{ t: WED - 30 * M, tf: '1h', checks: 14, signals: 3, chosen: 3, opened: 0, skipped: 0, waits: 3 } as unknown as Parameters<typeof whyNoTrades>[0]['runs'][number]],
      log: [{ t: WED - 30 * M, e: 'waiting on EUR/USD (ema_cross): only 1 of 4 market checks agree (needs 2: strength, bigger charts, mood)' }],
      lastSync: {}, chosen: ['ema_cross:1h'], lastOpenedAt: WED - 6 * H, openNow: 0, ordersNow: 0, dataAge: {}, labError: null,
    });
    expect(w.reasons[0]?.kind).toBe('agree');
  });
});

describe('v20.1 the desks study only', () => {
  it('quota 0: no pick, status waiting, says study only', () => {
    const x: DeskInput = {
      now: WED, markets: ['EURUSD'], quota: 0,
      rows: [{ id: 'ema_cross', tf: '1h', pairs: [{ pair: 'EURUSD', n: 40, pf: 1.3, totalR: 6 }] }],
      ledger: [], positions: [], closed: [],
      open: [{ ref: `ema_cross:1h:EURUSD:${WED - H}`, pair: 'EURUSD', strategy: 'ema_cross', tf: '1h', chosen: false, entryT: WED - M }],
      chosen: new Set(),
    };
    const { desks, picks } = buildDesks(x);
    expect(picks.size).toBe(0);
    expect(desks[0]!.status).toBe('waiting');
    expect(desks[0]!.quota).toBe(0);
    expect(desks[0]!.says).toMatch(/study only · best here: ema_cross 1h \(not proven — not traded\)/);
    expect(desksSummary(desks)).toMatch(/0 of 1 markets traded today · 1 waiting for a proven setup · desks study only/);
  });
});

describe('v20.2 the plan says the state in one word and what it is waiting for', () => {
  const inputs = (chosen: string[]) => ({
    now: WED, clock: marketClock(WED), oanda: false, markets: [], mood: null, fastFiring: {}, chosen, names: { x: 'X rule' },
    positions: [], resume: [], equityUsd: 1000, lastSync: {}, labOpen: {}, runs: [], upcoming: () => [], blockNow: () => null, pnlAt: () => 0,
    strict: { mode: 'quality' as const, minAgree: 2 },
  });
  it('nothing proven → "Nothing qualifies yet"; a proven setup → "Waiting for a setup" + what the next look does', () => {
    const none = buildPlan(inputs([]));
    expect(none.mode.kind).toBe('nothing_proven');
    expect(none.mode.word).toBe('Nothing qualifies yet');
    expect(none.mode.line).toMatch(/strict mode/);
    expect(none.markets[0]!.plan).toMatch(/no strategy clears the quality bar/);
    const one = buildPlan(inputs(['x:1h']));
    expect(one.mode.kind).toBe('scanning');
    expect(one.mode.word).toBe('Waiting for a setup');
    expect(one.mode.line).toMatch(/2\+ market checks/);
    expect(one.nextLook.does).toMatch(/proven 1h setup/);
    expect(one.nextLook.does).toMatch(/2\+ checks agree/);
    expect(one.markets[0]!.plan).toMatch(/Waiting for one of its 1 proven setup to fire/);
    expect(one.markets[0]!.checks).toEqual([]);
  });
  it('checksOf reads the four checks one by one', () => {
    const c = checksOf({ id: 'EURUSD', mtf: { h1: 1, h4: 1, d1: -1 }, strength: { base: 'EUR', quote: 'USD', gap: 0.42 }, risk: 0 } as unknown as Parameters<typeof checksOf>[0], null);
    expect(c.map((k) => `${k.name}${k.side}`)).toEqual(['strength1', '4h1', 'daily-1', 'mood0']);
    expect(c[0]!.text).toMatch(/EUR stronger/);
  });
});

describe('v20.4 quality mode: the bar the bot trades on, and a winning record on the market', () => {
  const st = (n: number, avgR: number, pf: number | null) => ({ n, avgR, pf, winPct: 50, totalR: Math.round(n * avgR * 100) / 100, medianR: 0, maxDdR: 0, expectancy: avgR } as unknown as import('../src/forex/lab').Row['all']);
  const row = (o: Partial<Parameters<typeof qualityPass>[0]>) => ({ id: 'round_fade', inSample: st(240, 0.03, 1.07), outSample: st(102, 0.13, 1.45), all: st(342, 0.06, 1.15), ...o });
  it('admits a row that is positive in both halves, 0.05R+ and PF 1.2+ unseen, beats random and its luck twins', () => {
    expect(qualityPass(row({}), 0.0).ok).toBe(true);
    expect(qualityPass(row({ luck: { pctl: 95, twinsP90: 0.08, twinPassPct: 10 } }), -0.02).ok).toBe(true);
  });
  it('rejects thin, luck-beaten, first-part-losing and worse-than-random rows, and the yardstick', () => {
    expect(qualityPass(row({ outSample: st(102, 0.02, 1.06) }), 0).why).toMatch(/needs 0.05R\+/);
    expect(qualityPass(row({ outSample: st(102, 0.06, 1.1) }), 0).why).toMatch(/needs 1.2\+/);
    expect(qualityPass(row({ inSample: st(240, -0.01, 0.97) }), 0).why).toMatch(/lost in the first part/);
    expect(qualityPass(row({}), 0.1).why).toMatch(/random timing did better/);
    expect(qualityPass(row({ luck: { pctl: 40, twinsP90: 0.2, twinPassPct: 60 } }), 0).why).toMatch(/luck twins did as well/);
    expect(qualityPass(row({ outSample: st(20, 0.3, 2) }), 0).why).toMatch(/only 20 unseen trades/);
    expect(qualityPass(row({ id: 'random' }), 0).ok).toBe(false);
  });
  it('syncBot waits while the strategy has no winning record on that market, and opens once it has one', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
    const lab = { ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - M, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null, agree: { n: 3, of: 4, need: 2 }, marketRec: { n: 9, pf: 0.8, totalR: -2.1, ok: false } };
    const ev = await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    expect(ev.join(' ')).toMatch(/no winning record on this market \(9 tested trades here, profit factor 0.8, -2.1R\)/);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    expect(classify('no winning record on this market (9 tested trades here, profit factor 0.8, -2.1R)')).toBe('market_rec');
    expect(classify('no tested record on this market yet')).toBe('market_rec');
    await p.syncBot([{ ...lab, marketRec: { n: 20, pf: 1.4, totalR: 3.2, ok: true } }], () => null, {}, { scope: ['1h', '4h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
  });
  it('the plan names the quality bar', () => {
    const none = buildPlan({ now: WED, clock: marketClock(WED), oanda: false, markets: [], mood: null, fastFiring: {}, chosen: [], names: {}, positions: [], resume: [], equityUsd: 1000, lastSync: {}, labOpen: {}, runs: [], upcoming: () => [], blockNow: () => null, pnlAt: () => 0, strict: { mode: 'quality', minAgree: 2 } });
    expect(none.mode.line).toMatch(/quality bar/);
  });
});
