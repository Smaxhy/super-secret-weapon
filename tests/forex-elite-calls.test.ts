/** v28.3 (owner: "always go for elite calls, calls in the elite signal channel get prioritization and follow them correctly"). */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DISCORD_COPY, handleSignal, isEliteChannel, type CopyBook } from '../src/forex/discord';

const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const ELITE = '1563800424769916968';
const OTHER = '1495278719647088650';

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
const book = () =>
  ({
    copyOpen: vi.fn(async () => ({ ok: true, entry: 29_900, stop: 29_750.5, riskUsd: 18 })),
    copyClose: vi.fn(async () => ({ ok: true, closed: ['NDXUSD long'], pending: 0 })),
    copyBreakeven: vi.fn(async () => ({ ok: true, moved: ['NDXUSD'] })),
  }) as unknown as CopyBook & { copyOpen: ReturnType<typeof vi.fn>; copyClose: ReturnType<typeof vi.fn>; copyBreakeven: ReturnType<typeof vi.fn> };

describe('v28.3 elite-channel calls', () => {
  it('knows the elite channel', () => {
    expect(isEliteChannel(ELITE)).toBe(true);
    expect(isEliteChannel(OTHER)).toBe(false);
    expect(isEliteChannel(undefined)).toBe(false);
  });

  it('takes every elite call at once (his other calls stay in the lab), first in line, and follows his exit and SL-to-BE', async () => {
    const live = DISCORD_COPY.live;
    DISCORD_COPY.live = false;
    try {
      const r = new FakeRedis() as unknown as Redis;
      const b = book();
      const row = await handleSignal(r, b, { id: '1', text: 'SIGNAL · NQ — LONG @ 29,900', at: NOW - 60_000, channel: ELITE }, NOW);
      expect(row.ok).toBe(true);
      expect(row.elite).toBe(true);
      expect(row.what).toMatch(/ELITE-channel call: copied LONG NDXUSD/);
      expect(b.copyOpen.mock.calls[0]![0]).toMatchObject({ pair: 'NDXUSD', side: 1, priority: true });
      // the same call in his other channel stays lab only
      const lab = await handleSignal(r, b, { id: '2', text: 'SIGNAL · NQ — LONG @ 29,900', at: NOW - 60_000, channel: OTHER }, NOW);
      expect(lab.ok).toBe(false);
      expect(lab.what).toMatch(/lab only/);
      expect(b.copyOpen).toHaveBeenCalledTimes(1);
      // a copier catch-up 30 min late still takes it
      expect((await handleSignal(r, b, { id: '3', text: 'SIGNAL · NQ — SHORT @ 29,950', at: NOW - 30 * 60_000, channel: ELITE }, NOW)).ok).toBe(true);
      // his follow-ups: SL to BE, then the exit
      expect((await handleSignal(r, b, { id: '4', text: 'SL to BE', at: NOW, channel: ELITE }, NOW)).kind).toBe('breakeven');
      expect(b.copyBreakeven).toHaveBeenCalled();
      const out = await handleSignal(r, b, { id: '5', text: 'SELL @ 29,980', at: NOW, channel: ELITE }, NOW);
      expect(out.kind).toBe('close');
      expect(b.copyClose).toHaveBeenCalled();
    } finally {
      DISCORD_COPY.live = live;
    }
  });

  it('DISCORD_ELITE_LIVE=off puts them back in the lab', async () => {
    const live = DISCORD_COPY.live;
    DISCORD_COPY.live = false;
    DISCORD_COPY.eliteLive = false;
    try {
      const b = book();
      const row = await handleSignal(new FakeRedis() as unknown as Redis, b, { id: '9', text: 'SIGNAL · NQ — LONG @ 29,900', at: NOW - 60_000, channel: ELITE }, NOW);
      expect(row.ok).toBe(false);
      expect(b.copyOpen).not.toHaveBeenCalled();
    } finally {
      DISCORD_COPY.live = live;
      DISCORD_COPY.eliteLive = true;
    }
  });
});
