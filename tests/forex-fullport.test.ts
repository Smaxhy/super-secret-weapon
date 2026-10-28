/** v27.94 (owner: "Fullport FOMC longs is also a call … make sure it happens at all costs"). */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DISCORD_COPY, catchUpFullCalls, fullCall, handleSignal, loadLevels, parseSignal, type CopyBook } from '../src/forex/discord';

const NOW = Date.UTC(2026, 9, 28, 16, 0, 0); // Wednesday, FOMC day

class FakeRedis {
  m = new Map<string, string>();
  h = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  async del(k: string) { return this.m.delete(k) ? 1 : 0; }
  async hset(k: string, ...kv: string[]) {
    const h = this.h.get(k) ?? new Map<string, string>();
    for (let i = 0; i < kv.length; i += 2) h.set(kv[i]!, kv[i + 1]!);
    this.h.set(k, h);
    return 1;
  }
  async hgetall(k: string) { return Object.fromEntries(this.h.get(k) ?? []); }
  async hlen(k: string) { return this.h.get(k)?.size ?? 0; }
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

const bookOk = () => ({ copyOpen: vi.fn(async () => ({ ok: true, entry: 29_900, stop: 29_750.5, riskUsd: 230 })), copyClose: vi.fn(), copyBreakeven: vi.fn() }) as unknown as CopyBook & { copyOpen: ReturnType<typeof vi.fn> };

describe('v27.94 full-conviction calls', () => {
  it('reads "Fullport FOMC longs" and its cousins; not chatter, exits or recaps', () => {
    expect(parseSignal('Fullport FOMC longs')).toMatchObject({ kind: 'open', pair: 'NDXUSD', side: 1, price: null, conviction: 'full', event: 'FOMC' });
    expect(parseSignal('**FULL PORT shorts NQ**')).toMatchObject({ kind: 'open', pair: 'NDXUSD', side: -1, conviction: 'full', event: null });
    expect(parseSignal('all in longs into CPI 🚀')).toMatchObject({ kind: 'open', side: 1, event: 'CPI' });
    expect(parseSignal('FOMC longs')).toMatchObject({ kind: 'open', side: 1, conviction: 'full' });
    expect(parseSignal('longs into FOMC on ES')).toMatchObject({ kind: 'open', pair: 'SPXUSD', side: 1 });
    expect(parseSignal('Fullport GC longs, SL @ 4,000')).toMatchObject({ kind: 'open', pair: 'XAUUSD', side: 1, stop: 4000 });
    // not calls
    expect(parseSignal('no longs before FOMC')).toEqual({ kind: 'none' });
    expect(parseSignal('closed the fullport longs, +$12k')).toEqual({ kind: 'none' });
    expect(parseSignal('FOMC today, longs worked well last time and the dollar might move a lot')).toEqual({ kind: 'none' });
    expect(parseSignal('fullport day today')).toEqual({ kind: 'none' });
    expect(fullCall('CAREFUL WITH FULLPORT SHORTS')).toBeNull();
    // his priced signals are unchanged
    expect(parseSignal('SIGNAL · NQ — LONG @ 29,026.25')).toEqual({ kind: 'open', pair: 'NDXUSD', symbol: 'NQ', side: 1, price: 29026.25, stop: null, target: null });
  });

  it('is taken at the market while his other calls are lab-only, and saves his lean', async () => {
    const live = DISCORD_COPY.live;
    DISCORD_COPY.live = false;
    try {
      const redis = new FakeRedis();
      const book = bookOk();
      const row = await handleSignal(redis as unknown as Redis, book, { id: '1565000000000000001', text: 'Fullport FOMC longs', at: NOW - 3 * 60_000 }, NOW);
      expect(row.ok).toBe(true);
      expect(row.what).toMatch(/FULL-conviction call \(FOMC\).*copied LONG NDXUSD at 29900/);
      expect(book.copyOpen).toHaveBeenCalledTimes(1);
      expect(book.copyOpen.mock.calls[0]![0]).toMatchObject({ pair: 'NDXUSD', side: 1, hisPx: null, riskPct: DISCORD_COPY.riskPct });
      expect((await loadLevels(redis as unknown as Redis, NOW)).NDXUSD?.bias).toBe(1);
      // a normal priced signal stays in the lab
      const lab = await handleSignal(redis as unknown as Redis, book, { id: '1565000000000000002', text: 'SIGNAL · NQ — LONG @ 29,900', at: NOW - 60_000 }, NOW);
      expect(lab.ok).toBe(false);
      expect(lab.what).toMatch(/lab only/);
      expect(book.copyOpen).toHaveBeenCalledTimes(1);
      // reached us 30 min late (copier catch-up) → still taken; 2 h late → not
      expect((await handleSignal(redis as unknown as Redis, book, { id: '1565000000000000003', text: 'full port shorts', at: NOW - 30 * 60_000 }, NOW)).ok).toBe(true);
      expect((await handleSignal(redis as unknown as Redis, book, { id: '1565000000000000004', text: 'full port shorts', at: NOW - 120 * 60_000 }, NOW)).kind).toBe('old');
    } finally {
      DISCORD_COPY.live = live;
    }
  });

  it('catches up a call the old parser logged as "not a trade message" — once', async () => {
    const redis = new FakeRedis();
    redis.lists.set(DISCORD_COPY.logKey, [
      JSON.stringify({ t: NOW - 40 * 60_000, id: '1565000000000000010', source: 'kojiro', text: 'Fullport FOMC longs', kind: 'none', ok: true, what: 'not a trade message' }),
      JSON.stringify({ t: NOW - 6 * 3_600_000, id: '1565000000000000011', source: 'kojiro', text: 'Fullport longs', kind: 'none', ok: true, what: 'not a trade message' }),
      JSON.stringify({ t: NOW - 30 * 60_000, id: '1565000000000000012', source: 'kojiro', text: 'gm', kind: 'none', ok: true, what: 'not a trade message' }),
    ]);
    const book = bookOk();
    const lines = await catchUpFullCalls(redis as unknown as Redis, book, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/posted 40 min ago, missed then — taken now: LONG NDXUSD/);
    expect(book.copyOpen).toHaveBeenCalledTimes(1);
    expect(await catchUpFullCalls(redis as unknown as Redis, book, NOW + 60_000)).toEqual([]);
    expect(book.copyOpen).toHaveBeenCalledTimes(1);
    // a try that fails before the last one leaves it for the next try
    const r2 = new FakeRedis();
    r2.lists.set(DISCORD_COPY.logKey, [JSON.stringify({ t: NOW - 10 * 60_000, id: '1565000000000000020', source: 'kojiro', text: 'FOMC longs', kind: 'none', ok: true, what: 'x' })]);
    const flaky = { ...bookOk(), copyOpen: vi.fn().mockResolvedValueOnce({ ok: false, error: 'no live price' }).mockResolvedValueOnce({ ok: true, entry: 1, stop: 0.9, riskUsd: 10 }) } as unknown as CopyBook;
    expect(await catchUpFullCalls(r2 as unknown as Redis, flaky, NOW, 4 * 3_600_000, false)).toEqual([]);
    expect(await catchUpFullCalls(r2 as unknown as Redis, flaky, NOW + 60_000, 4 * 3_600_000, false)).toHaveLength(1);
  });
});
