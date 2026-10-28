/** v27.51 (owner: "he also sends Levels … it can trust his trades, take it and trail it tight SL"). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { POSTED_LEVELS, handleSignal, levelSets, loadLevels, parseBias, parseLevels, type CopyBook } from '../src/forex/discord';
import { postedLevelSignal } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { Practice, newAccount, type PracticeAccount, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';
import type { Bar } from '../src/forex/types';

VENUE_FEES.on = false;
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);

class FakeRedis {
  m = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) { return ks.map((k) => this.m.get(k) ?? null); }
  async lrange(k: string) { return this.lists.get(k) ?? []; }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      lpush: (k: string, v: string) => (ops.push(() => this.lists.set(k, [v, ...(this.lists.get(k) ?? [])])), chain),
      ltrim: () => chain,
      exec: async () => (ops.forEach((f) => f()), []),
    };
    return chain;
  }
}
afterEach(() => vi.useRealTimers());

const POST = 'Levels\n\n29,220.00\n(29,182.25)\n(29,160.00)\n(29,070.50)\n\n1.';
const PLAN = 'Forwarded\n📅  26/10/2026\n\n🔍 Bias: bullish \n\n💧 DOL: Around 29,385.25\n\n🧠 Narrative: I want to see a manipulation to the downside, and then try to long off my levels';

describe('his Levels posts', () => {
  it('reads the prices (brackets, commas, list number ignored); no market named = Nasdaq 100', () => {
    expect(parseLevels(POST)).toEqual({ pair: 'NDXUSD', levels: [29_220, 29_182.25, 29_160, 29_070.5] });
    expect(parseLevels('GC levels 4,012.5 / 3,995 / 3,980')).toEqual({ pair: 'XAUUSD', levels: [4012.5, 3995, 3980] });
    expect(parseLevels('nice levels today')).toBeNull();
    expect(parseLevels('SIGNAL · NQ — LONG @ 29,026.25')).toBeNull();
  });

  it('reads his daily plan: bias + DOL (the date is not a level)', () => {
    expect(parseBias(PLAN)).toEqual({ pair: 'NDXUSD', bias: 1, dol: 29_385.25 });
    expect(parseBias('Bias: bearish')).toMatchObject({ bias: -1, dol: null });
    expect(parseLevels(PLAN)).toBeNull();
  });

  it('plan + levels merge into one record for the day', async () => {
    const r = new FakeRedis();
    const book = { copyOpen: vi.fn(), copyClose: vi.fn(), copyBreakeven: vi.fn() } as unknown as CopyBook;
    const a = await handleSignal(r as unknown as Redis, book, { id: '1400000000000000010', text: PLAN, at: NOW }, NOW);
    expect(a).toMatchObject({ kind: 'levels', ok: true });
    expect(a.what).toMatch(/bullish .*target \(DOL\) 29,385.25/);
    await handleSignal(r as unknown as Redis, book, { id: '1400000000000000011', text: POST, at: NOW + 60_000 }, NOW + 60_000);
    const x = (await loadLevels(r as unknown as Redis, NOW + H)).NDXUSD!;
    expect(x).toMatchObject({ bias: 1, dol: 29_385.25, levels: [29_220, 29_182.25, 29_160, 29_070.5] });
    expect(book.copyOpen).not.toHaveBeenCalled();
  });

  it('a post is saved for the day and logged, never traded by itself', async () => {
    const r = new FakeRedis();
    const book = { copyOpen: vi.fn(), copyClose: vi.fn(), copyBreakeven: vi.fn() } as unknown as CopyBook;
    const row = await handleSignal(r as unknown as Redis, book, { id: '1400000000000000001', text: POST, at: NOW }, NOW);
    expect(row).toMatchObject({ kind: 'levels', pair: 'NDXUSD', ok: true });
    expect(book.copyOpen).not.toHaveBeenCalled();
    expect((await loadLevels(r as unknown as Redis, NOW + H)).NDXUSD?.levels).toEqual([29_220, 29_182.25, 29_160, 29_070.5]);
    expect(await loadLevels(r as unknown as Redis, NOW + POSTED_LEVELS.validMs + 1)).toEqual({});
  });
});

/** hourly bars; the last candle dips to 98.95 and closes back at 100 (absorption at the 99 level) */
function scenario(): Bar[] {
  const t0 = Date.parse('2026-10-13T00:00:00Z');
  const bars: Bar[] = [];
  for (let k = 0; k < 70; k++) {
    const t = t0 + k * H;
    const c = 100.25 + 0.5 * Math.sin(k * 0.5);
    const o = k ? bars[k - 1]!.c : c;
    bars.push({ t, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c });
  }
  bars.push({ t: t0 + 70 * H, o: 100.2, h: 100.25, l: 98.95, c: 100.0 });
  return bars;
}

describe('trading at his levels', () => {
  const bars = scenario();
  const c = buildCtx(bars, 60, 'NDXUSD');
  const i = bars.length - 1;
  const posted = bars[i - 5]!.t;

  it('buys the absorption at his level, stop past the candle, target his next level ≥ 1R up', () => {
    const s = postedLevelSignal(c, i, [102.5, 99], posted)!;
    expect(s.side).toBe(1);
    const a = c.atr14[i]!;
    expect(s.stop).toBeCloseTo(100 - Math.max(100 - (98.95 - 0.15 * a), 0.3 * a), 9);
    expect(s.target).toBe(102.5);
  });

  it('his bias keeps only his direction; his DOL is the target', () => {
    expect(postedLevelSignal(c, i, [102.5, 99], posted, -1)).toBeNull();
    expect(postedLevelSignal(c, i, [102.5, 99], posted, 1, 104)!.target).toBe(104);
    expect(postedLevelSignal(c, i, [102.5, 99], posted, 1, 100.1)!.target).toBe(102.5); // DOL under 1R away → next level
  });

  it('nothing near his levels, or the candle came before his post → no trade', () => {
    expect(postedLevelSignal(c, i, [97, 103], posted)).toBeNull();
    expect(postedLevelSignal(c, i, [102.5, 99], bars[i]!.t + 1)).toBeNull();
  });

  it('the copy opens with that stop + target and the tight trailing stop', async () => {
    vi.useFakeTimers({ now: NOW });
    const r = new FakeRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), maxLossUsd: 20 }));
    const p = new Practice(r as unknown as Redis);
    const mid = 29_100;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ NDXUSD: { id: 'NDXUSD', mid, bid: mid - 1, ask: mid + 1, t: Date.now(), bars: [[Date.now() - 60_000, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() } as Quote });
    const res = await p.copyOpen({ pair: 'NDXUSD', side: 1, stopNamed: null, hisPx: null, strategy: 'discord_kojiro_levels', ref: 'discord_kojiro_levels:signal:NDXUSD:1', riskPct: 2, leverage: 50, profitLock: true, stop: 29_050, target: 29_220 }, 'bot');
    expect(res.ok).toBe(true);
    const pos = (JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open[0]!;
    expect(pos).toMatchObject({ stop: 29_050, target: 29_220, strategy: 'discord_kojiro_levels', tf: 'signal' });
    expect(pos.lock).not.toBeNull();
    expect((pos.entry - pos.stop!) * pos.units).toBeCloseTo(18, 0); // v27.95: $20 cap × 0.9 incl. the fee
    // a price already past the stop is refused
    const past = await p.copyOpen({ pair: 'NDXUSD', side: 1, stopNamed: null, hisPx: null, strategy: 'discord_kojiro_levels', ref: 'discord_kojiro_levels:signal:NDXUSD:2', riskPct: 2, leverage: 50, profitLock: true, stop: 29_200, target: null }, 'bot');
    expect(past.ok).toBe(false);
  });
});

describe('v27.64 short / long level lists', () => {
  const SHORT = '**Short Levels (for today)**\n\n29,713.75\n29,727.75\n29,765.00\n29,783.00\n29,736.25';
  it('a "Short Levels" post is read as shorts only', () => {
    expect(parseLevels(SHORT)).toEqual({ pair: 'NDXUSD', levels: [29_783, 29_765, 29_736.25, 29_727.75, 29_713.75], side: -1 });
    expect(parseLevels('Buy levels 29,100 29,050')).toMatchObject({ side: 1 });
    expect(parseLevels(POST)).not.toHaveProperty('side');
  });

  it('keeps his plain levels + plan, adds the short list; each list trades its own side', async () => {
    const r = new FakeRedis();
    const book = { copyOpen: vi.fn(), copyClose: vi.fn(), copyBreakeven: vi.fn() } as unknown as CopyBook;
    await handleSignal(r as unknown as Redis, book, { id: '1400000000000000020', text: 'Levels 29,562.25 29,431.25 29,305.00', at: NOW - 2 * H }, NOW);
    await handleSignal(r as unknown as Redis, book, { id: '1400000000000000021', text: 'Bias: bullish\nDOL: 29,713.75', at: NOW - H }, NOW);
    const row = await handleSignal(r as unknown as Redis, book, { id: '1400000000000000022', text: SHORT, at: NOW - 0.5 * H }, NOW);
    expect(row.what).toMatch(/SHORT levels \(shorts only\)/);
    const lv = (await loadLevels(r as unknown as Redis, NOW)).NDXUSD!;
    expect(lv.levels).toEqual([29_562.25, 29_431.25, 29_305]);
    expect(lv).toMatchObject({ bias: 1, dol: 29_713.75, shortLevels: [29_783, 29_765, 29_736.25, 29_727.75, 29_713.75] });
    const sets = levelSets(lv);
    expect(sets.map((s) => [s.side, s.dol])).toEqual([[1, 29_713.75], [-1, null]]);
    expect(sets[1]!.all).toContain(29_562.25); // a short targets his long levels below
    // a day later the lists are gone
    expect(await loadLevels(r as unknown as Redis, NOW + 25 * H)).toEqual({});
  });
});
