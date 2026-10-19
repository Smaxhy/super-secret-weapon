/** v18.7 (owner: "we can't fast trade slow charts"): the bot trades the 1h / 4h charts only, and cools off after a close. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { BOT, Practice, newAccount, reentryWait, type ClosedPractice, type PracticeAccount, type Quote } from '../src/forex/practice';
import { FX_CONFIG } from '../src/forex/lab';
import { buildPlan } from '../src/forex/plan';
import { marketClock } from '../src/forex/calendar';
import { INSTRUMENTS } from '../src/forex/types';

const M = 60_000;
const H = 60 * M;
/** a Wednesday 14:00:30 UTC: forex open, not the rollover */
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;

class NxRedis {
  m = new Map<string, string>();
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
}
const asRedis = (r: NxRedis) => r as unknown as Redis;
const quote = (id: string, mid: number): Quote => ({ id, mid, bid: mid - HALF, ask: mid + HALF, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() });
const closed = (o: Partial<ClosedPractice> = {}): ClosedPractice => ({ id: 'c1', pair: 'EURUSD', side: 1, entry: 1.1, exit: 1.099, stop: null, target: null, marginUsd: 10, leverage: 30, openedAt: WED - 3 * H, closedAt: WED - 30 * M, pnlUsd: -5, reason: 'signal', ref: `x:1h:EURUSD:${WED - 4 * H}`, strategy: 'x', tf: '1h', ...o } as ClosedPractice);

afterEach(() => vi.useRealTimers());

describe('v18.7 the bot trades the hourly and 4-hour charts only', () => {
  it('is the default', () => {
    expect(FX_CONFIG.botFastCharts).toBe(false);
    expect(BOT.reentryCooldownBars).toBe(3);
  });

  it('the plan says a chosen 1-minute signal is lab only', () => {
    const base = {
      now: WED, clock: marketClock(WED), oanda: false, markets: [], mood: null, names: { x: 'X' }, positions: [], resume: [], equityUsd: 1000, lastSync: {}, labOpen: {}, runs: [],
      upcoming: () => [], blockNow: () => null, chosen: ['x:1m', 'x:1h'], fastFiring: { '1m': { tf: '1m', t: WED, at: WED, byPair: { EURUSD: [{ id: 'x', name: 'X', side: 1 as const, allowed: true, why: null, chosen: true }] } } },
    };
    const off = buildPlan(base as unknown as Parameters<typeof buildPlan>[0]);
    const sig = off.markets.find((m) => m.id === 'EURUSD')!.signals.find((s) => s.tf === '1m')!;
    expect(sig.verdict).toMatch(/lab only/);
    expect(sig.tone).toBe('no');
    const on = buildPlan({ ...base, fastCharts: true } as unknown as Parameters<typeof buildPlan>[0]);
    expect(on.markets.find((m) => m.id === 'EURUSD')!.signals.find((s) => s.tf === '1m')!.verdict).not.toMatch(/lab only/);
  });
});

describe('v18.7 cooling off after a close', () => {
  it('counts 3 candles of the chart from the newest close of that strategy on that market', () => {
    expect(reentryWait([closed()], 'x', '1h', 'EURUSD', WED)).toBe(150); // 3 h − 30 min
    expect(reentryWait([closed()], 'x', '1h', 'EURUSD', WED + 150 * M)).toBe(0);
    expect(reentryWait([closed({ tf: '4h', ref: `x:4h:EURUSD:${WED - 8 * H}` })], 'x', '4h', 'EURUSD', WED)).toBe(690); // 12 h − 30 min
    // another strategy, another market or another chart: free
    expect(reentryWait([closed()], 'y', '1h', 'EURUSD', WED)).toBe(0);
    expect(reentryWait([closed()], 'x', '1h', 'GBPUSD', WED)).toBe(0);
    expect(reentryWait([closed()], 'x', '4h', 'EURUSD', WED)).toBe(0);
    // a part taken or a weekend pause is not a finished trade
    expect(reentryWait([closed({ reason: 'partial' }), closed({ reason: 'weekend' })], 'x', '1h', 'EURUSD', WED)).toBe(0);
    // older rows without `tf` read the chart from the ref
    expect(reentryWait([closed({ tf: undefined })], 'x', '1h', 'EURUSD', WED)).toBe(150);
  });

  it('syncBot waits instead of re-opening, then opens once the cooling-off is over', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), closed: [closed()] }));
    const p = new Practice(asRedis(r));
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
    const lab = { ref: `x:1h:EURUSD:${WED - H}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - M, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const ev = await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
    expect(ev.join(' ')).toMatch(/cooling off 150 min/);
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(0);
    vi.setSystemTime(WED + 151 * M);
    await p.syncBot([{ ...lab, entryT: WED + 150 * M }], () => null, {}, { scope: ['1h', '4h'] });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open).toHaveLength(1);
  });
});
