/** v26.4 (owner: "aren't you supposed to trade WITH news"): the news strategies trade through the news pause. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { newsBlock, type CalEvent } from '../src/forex/calendar';
import { tradesNews } from '../src/forex/strategies';
import { Practice, newAccount, type PracticeAccount, type Quote } from '../src/forex/practice';
import { INSTRUMENTS } from '../src/forex/types';

const M = 60_000;
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);
const EUR = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;

class NxRedis {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, mode?: string) { if (mode === 'NX' && this.m.has(k)) return null; this.m.set(k, v); return 'OK'; }
  async mget(...ks: string[]) { return ks.map((k) => this.m.get(k) ?? null); }
}
const quote = (mid: number): Quote => ({ id: 'EURUSD', mid, bid: mid - HALF, ask: mid + HALF, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() });
afterEach(() => vi.useRealTimers());

describe('v26.4 news strategies trade the news', () => {
  const cpi: CalEvent = { t: WED, ccy: 'USD', title: 'CPI m/m', impact: 'High' } as CalEvent;
  const holiday: CalEvent = { t: WED, ccy: 'EUR', title: 'Bank Holiday', impact: 'Holiday' } as CalEvent;

  it('only the news strategies are news traders', () => {
    expect(tradesNews('news_drift')).toBe(true);
    expect(tradesNews('news_fade')).toBe(true);
    expect(tradesNews('pivot_bounce')).toBe(false);
    expect(tradesNews(undefined)).toBe(false);
  });

  it('a news trader skips the release window but still waits out a bank holiday', () => {
    expect(newsBlock('EURUSD', WED, [cpi])).toMatch(/USD news/);
    expect(newsBlock('EURUSD', WED, [cpi], 30, true)).toBeNull();
    expect(newsBlock('EURUSD', WED, [holiday], 30, true)).toMatch(/holiday/);
  });

  it('syncBot opens a news strategy during a release but holds the others back', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote(1.1) });
    const lab = (strategy: string) => ({ ref: `${strategy}:1h:EURUSD:${WED - 60 * M}`, strategy, tf: '1h', pair: 'EURUSD', side: 1 as const, entryT: WED - M, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null });
    const block = (pair: string, s?: string) => newsBlock(pair, Date.now(), [cpi], 30, tradesNews(s));
    await p.syncBot([lab('pivot_bounce'), lab('news_drift')], block, {}, { scope: ['1h', '4h'] });
    const open = (JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open;
    expect(open.map((x) => x.strategy)).toEqual(['news_drift']);
  });
});
