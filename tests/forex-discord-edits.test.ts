/** v28.4 (owner: "the bot seen these signals? Levels 29,670 / 29,729.50 / … · Monitoring 29,466.25"; "follow all his
 * signal calls"): his edited Levels post, his "Monitoring" levels, a one-off call's lean ends with its session. */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DISCORD_COPY, handleSignal, loadLevels, parseMonitor, savePosted, sessionEnd, type CopyBook } from '../src/forex/discord';

const NOW = Date.UTC(2026, 9, 29, 13, 45, 0);
class FakeRedis {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  multi() {
    const chain = { lpush: () => chain, ltrim: () => chain, exec: async () => [] };
    return chain;
  }
}
const book = () => ({ copyOpen: vi.fn(async () => ({ ok: true })), copyClose: vi.fn(), copyBreakeven: vi.fn() }) as unknown as CopyBook & { copyOpen: ReturnType<typeof vi.fn> };
const FIRST = '**Levels**\n\n29,609.50\n29,670.00\n29,745.00 -29,750.00\n29,830.50-29,835.25';
const EDIT = 'Levels\n\n29,670.00\n29,729.50\n29,745.00 -29,750.00\n29,785.25 - 29,788.00\n29,830.50-29,835.25';

describe('v28.4 edited posts + Monitoring levels + one-off leans', () => {
  it('his calls are copied by default', () => expect(DISCORD_COPY.live).toBe(true));

  it('reads "Monitoring" prices; list numbers and words are not levels', () => {
    expect(parseMonitor('Monitoring 29,466.25')).toEqual({ pair: 'NDXUSD', levels: [29_466.25] });
    expect(parseMonitor('3. Monitoring 29,563.50 (weaker level)')).toEqual({ pair: 'NDXUSD', levels: [29_563.5] });
    expect(parseMonitor('Monitoring \n\n29,635.25')).toEqual({ pair: 'NDXUSD', levels: [29_635.25] });
    expect(parseMonitor('Monitoring for re-entries')).toBeNull();
    expect(parseMonitor('TP 782')).toBeNull();
  });

  it('an edit of his Levels post replaces that list; Monitoring adds to it', async () => {
    const r = new FakeRedis() as unknown as Redis;
    const b = book();
    const at = NOW - 20 * 60_000;
    await handleSignal(r, b, { id: '1564000000000000001', text: FIRST, at, channel: '1495278719647088650' }, at + 1000);
    expect((await loadLevels(r, NOW)).NDXUSD!.levels).toContain(29_609.5);
    const e = await handleSignal(r, b, { id: '1564000000000000001', text: EDIT, at, edited: NOW - 5 * 60_000 }, NOW - 5 * 60_000);
    expect(e).toMatchObject({ kind: 'levels', ok: true });
    expect(e.what).toMatch(/^edited post: /);
    expect((await loadLevels(r, NOW)).NDXUSD!.levels).toEqual([29_835.25, 29_830.5, 29_788, 29_785.25, 29_750, 29_745, 29_729.5, 29_670]);
    // the same edit twice → handled once
    expect(await handleSignal(r, b, { id: '1564000000000000001', text: EDIT, at, edited: NOW - 5 * 60_000 }, NOW)).toMatchObject({ kind: 'duplicate' });
    const m = await handleSignal(r, b, { id: '1564000000000000002', text: 'Monitoring 29,466.25', at: NOW }, NOW);
    expect(m).toMatchObject({ kind: 'levels', pair: 'NDXUSD' });
    const lv = (await loadLevels(r, NOW)).NDXUSD!.levels;
    expect(lv).toContain(29_466.25);
    expect(lv).toContain(29_729.5);
    expect(b.copyOpen).not.toHaveBeenCalled();
  });

  it('an edited trade post never opens a trade', async () => {
    const b = book();
    const row = await handleSignal(new FakeRedis() as unknown as Redis, b, { id: '1564000000000000003', text: 'SIGNAL · NQ — LONG @ 29,500.00', at: NOW, edited: NOW, channel: '1563800424769916968' }, NOW);
    expect(row.kind).toBe('none');
    expect(row.what).toMatch(/only copied from the post as first sent/);
    expect(b.copyOpen).not.toHaveBeenCalled();
  });

  it('a full-conviction call sets his lean only until 17:00 New York; a plan post lasts the day', async () => {
    const fomc = Date.UTC(2026, 9, 28, 17, 53);
    expect(sessionEnd(fomc)).toBe(Date.UTC(2026, 9, 28, 21, 0)); // 17:00 New York (EDT)
    expect(sessionEnd(Date.UTC(2026, 9, 28, 22, 0))).toBe(Date.UTC(2026, 9, 29, 21, 0));
    const r = new FakeRedis() as unknown as Redis;
    await savePosted(r, 'NDXUSD', { bias: -1, dol: null, biasT: fomc, source: 'kojiro', until: sessionEnd(fomc) });
    expect((await loadLevels(r, fomc + 60_000)).NDXUSD!.bias).toBe(-1);
    expect((await loadLevels(r, NOW)).NDXUSD?.bias).toBeUndefined();
    // his plan post the next morning: no session limit
    await savePosted(r, 'NDXUSD', { bias: 1, dol: 29_900, biasT: NOW - 3_600_000, source: 'kojiro' });
    const x = (await loadLevels(r, NOW + 6 * 3_600_000)).NDXUSD!;
    expect(x).toMatchObject({ bias: 1, dol: 29_900 });
    expect(x.biasUntil).toBeUndefined();
  });
});
