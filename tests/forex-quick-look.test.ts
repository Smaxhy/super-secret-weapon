/** v28.2 the quick look at the candle close: the bot used to open 1h / 4h trades 9–12 min after the close (the full run's
 * time) while the lab's copy entered AT the close. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { QUICK, quickLookTrades, type MarketBook, type Row } from '../src/forex/lab';
import { buildMood } from '../src/forex/mood';
import { Practice, newAccount, type PracticeAccount, type Quote } from '../src/forex/practice';
import { STRATEGIES } from '../src/forex/strategies';
import { buildStrength } from '../src/forex/strength';
import { INSTRUMENTS, type Bar } from '../src/forex/types';

const M = 60_000;
const H = 60 * M;
function synth(n: number, start = Date.UTC(2025, 0, 6)): Bar[] {
  const out: Bar[] = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 90) * 0.0004 + Math.sin(i / 13) * 0.0006;
    const o = p;
    const c = o + drift + Math.sin(i * 1.7) * 0.0003;
    out.push({ t: start + i * H, o, h: Math.max(o, c) + 0.0004 + Math.abs(Math.sin(i * 0.9)) * 0.0004, l: Math.min(o, c) - 0.0004 - Math.abs(Math.cos(i * 1.1)) * 0.0004, c });
    p = c;
  }
  return out;
}
const eur = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const all = synth(3_200);
const book: MarketBook = { at: 1, strength: buildStrength({}), mood: buildMood({}), ranks: {}, zOil: null, zYield: null, zStocks: null, zDollar: null, spxMtd: null, h1: new Map() };
const ids = STRATEGIES.filter((s) => s.id !== 'random' && !QUICK.skip.has(s.id)).map((s) => s.id);
const row = (id: string, filter: Row['filter'] = 'none') => ({ id, name: id, tf: '1h', filter, exit: 'designed', entry: 'market', verdict: 'maybe', pairs: [], markets: [], all: { avgR: 0.1 } }) as unknown as Row;
const rec = { dropped: [] as string[], proven: new Set<string>(), down: {} };
const paperOk = (keys: string[]) => new Map(keys.map((k) => [k, { n: 20, avgR: 0.2, pf: 2 } as never]));

/** the newest candle index where at least one strategy signalled (searched from the end) */
function findSignal() {
  for (let i = all.length - 1; i > 2_800; i--) {
    const h1 = all.slice(0, i + 1);
    const now = all[i]!.t + H + 30_000;
    const got = quickLookTrades({ inst: eur, tf: '1h', h1, book, rows: ids.map((id) => row(id)), chosen: new Set(ids.map((id) => `${id}:1h`)), rec, paper: paperOk(ids.map((id) => `${id}:1h`)), now });
    if (got.length) return { i, h1, now, got };
  }
  throw new Error('no signal in the synthetic series');
}

describe('v28.2 quick look at the candle close', () => {
  const f = findSignal();
  const id = f.got[0]!.strategy;

  it('hands the bot the trade that signalled on the candle that just closed', () => {
    for (const t of f.got) {
      expect(t.ref.endsWith(String(all[f.i]!.t + H))).toBe(true);
      expect(t.entryT).toBe(all[f.i]!.t + H);
      expect(t.chosen).toBe(true);
    }
  });

  it('waits for the full run when it cannot apply a check: a market-read filter, a cross-market strategy, a dropped or forward-failing row, an old or forming candle', () => {
    const one = (o: Partial<Parameters<typeof quickLookTrades>[0]>) => quickLookTrades({ inst: eur, tf: '1h', h1: f.h1, book, rows: [row(id)], chosen: new Set([`${id}:1h`]), rec, paper: paperOk([`${id}:1h`]), now: f.now, ...o });
    expect(one({}).length).toBeGreaterThan(0);
    expect(one({ rows: [row(id, 'strength')] })).toEqual([]);
    expect(one({ chosen: new Set() })).toEqual([]);
    expect(one({ rec: { ...rec, dropped: [`${id}:1h`] } })).toEqual([]);
    expect(one({ paper: new Map() })).toEqual([]);
    expect(one({ now: f.now - 2 * M })).toEqual([]); // the candle hasn't closed yet
    expect(one({ now: f.now + 30 * M })).toEqual([]); // too old for the quick look (the full run has it)
  });
});

class NxRedis {
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
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);
const HALF = (eur.spreadPips * eur.pip) / 2;
const quote = (mid: number): Quote => ({ id: 'EURUSD', mid, bid: mid - HALF, ask: mid + HALF, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() });
afterEach(() => vi.useRealTimers());

describe('v28.2 syncBot openOnly', () => {
  it('opens new trades but never closes or manages a held one', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new NxRedis();
    r.m.set('fx:practice:bot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: quote(1.1) });
    const lab = (ref: string, side: 1 | -1) => ({ ref, strategy: ref.split(':')[0]!, tf: '1h', pair: 'EURUSD', side, entryT: WED - M, stop: side === 1 ? 1.098 : 1.102, target: side === 1 ? 1.104 : 1.096, chosen: true, sizeF: 1, prio: 0.2, judge: null });
    await p.syncBot([lab(`a:1h:EURUSD:${WED - H}`, 1)], () => null, {}, { scope: ['1h', '4h'] });
    const acct = () => JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    expect(acct().open).toHaveLength(1);
    // the quick look hands only a new sell: the held buy is NOT in its list, and must stay open
    await p.syncBot([lab(`b:1h:EURUSD:${WED - H}`, -1)], () => null, {}, { scope: ['1h', '4h'], openOnly: true });
    expect(acct().open.map((x) => x.ref).sort()).toEqual([`a:1h:EURUSD:${WED - H}`, `b:1h:EURUSD:${WED - H}`]);
  });
});
