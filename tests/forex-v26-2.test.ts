/** v26.2 (owner: "the last trade was up 10 bucks then sold for 1 dollar"): the open P&L counts the venue fee, and a
 * re-test that makes the lab's trade vanish (without it ending) no longer closes the bot's running trade. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { BOT, Practice, newAccount, view, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { VENUE_FEES, feeUsd } from '../src/forex/venue-fees';
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
const REF = `x:1h:EURUSD:${WED - H}`;
const lab = { ref: REF, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - M, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
const acct = (r: NxRedis) => JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;

afterEach(() => vi.useRealTimers());

async function opened() {
  vi.useFakeTimers({ now: WED });
  const r = new NxRedis();
  r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
  const p = new Practice(asRedis(r));
  (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote('EURUSD', 1.1) });
  await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'] });
  expect(acct(r).open).toHaveLength(1);
  return { r, p };
}

describe('v26.2 the open P&L includes the fee the close will charge', () => {
  it('view takes the round-trip venue fee off the open P&L', () => {
    const pos = { id: 'p1', pair: 'EURUSD', side: 1, entry: 1.1, units: 10_000, marginUsd: 100, leverage: 100, stop: null, target: null, openedAt: WED } as unknown as PracticePosition;
    const a = { ...newAccount(1000), open: [pos] };
    const fee = feeUsd(EUR, 100, 100);
    expect(fee).toBeGreaterThan(0);
    const withFee = view(a, { EURUSD: 1.1 }).positions[0]!.pnlUsd;
    VENUE_FEES.on = false;
    try {
      expect(feeUsd(EUR, 100, 100)).toBe(0);
      const without = view(a, { EURUSD: 1.1 }).positions[0]!.pnlUsd;
      expect(withFee).toBeCloseTo(without - fee, 2);
    } finally {
      VENUE_FEES.on = true;
    }
  });
});

describe('v26.2 a re-test never closes a running trade by itself', () => {
  it('keeps the trade when the lab trade vanished without ending', async () => {
    const { r, p } = await opened();
    vi.setSystemTime(WED + 2 * H);
    const ev = await p.syncBot([], () => null, {}, { scope: ['1h', '4h'], labDone: new Set() });
    expect(ev.join(' ')).toMatch(/re-test changed its strategy's rules/);
    expect(acct(r).open).toHaveLength(1);
  });

  it('closes it when the lab trade really ended', async () => {
    const { r, p } = await opened();
    vi.setSystemTime(WED + 2 * H);
    await p.syncBot([], () => null, {}, { scope: ['1h', '4h'], labDone: new Set([REF]) });
    expect(acct(r).open).toHaveLength(0);
    expect(acct(r).closed[0]!.reason).toBe('signal');
  });

  it('closes an orphan after 30 candles of its chart', async () => {
    const { r, p } = await opened();
    vi.setSystemTime(WED + (BOT.orphanMaxBars + 1) * H);
    await p.syncBot([], () => null, {}, { scope: ['1h', '4h'], labDone: new Set() });
    expect(acct(r).open).toHaveLength(0);
  });

  it('without the list it behaves as before (closes)', async () => {
    const { r, p } = await opened();
    vi.setSystemTime(WED + 2 * H);
    await p.syncBot([], () => null, {}, { scope: ['1h', '4h'] });
    expect(acct(r).open).toHaveLength(0);
  });
});
