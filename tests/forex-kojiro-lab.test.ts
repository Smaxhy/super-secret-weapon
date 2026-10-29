/** v27.77 (owner: "keep all Kojiro calls in labs for now — they work for him, apparently not for us"). */
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { DISCORD_COPY, POSTED_LEVELS, handleSignal, type CopyBook } from '../src/forex/discord';
import { gradeLevelLab, levelLabSummary, type LabLevelTrade } from '../src/forex/level-watch';
import { VENUE_FEES } from '../src/forex/venue-fees';
import type { Bar } from '../src/forex/types';

const M = 60_000;
const T = Date.UTC(2026, 9, 28, 2, 32, 0);

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

describe('Kojiro calls: copied by default (v28.4), levels lab only', () => {
  it('his calls are copied by default; level trades stay lab only', () => {
    expect(DISCORD_COPY.live).toBe(true);
    expect(POSTED_LEVELS.trade).toBe(false);
  });
  it('with DISCORD_COPY_LIVE=off his SIGNAL post is logged and graded, never opened', async () => {
    DISCORD_COPY.live = false;
    const opened: unknown[] = [];
    const book = { copyOpen: async (r: unknown) => (opened.push(r), { ok: true }), copyClose: async () => ({ ok: true, closed: [], pending: 0 }), copyBreakeven: async () => ({ ok: true, moved: [] }) } as unknown as CopyBook;
    const row = await handleSignal(new FakeRedis() as unknown as Redis, book, { id: '1400000000000000001', text: 'SIGNAL · NQ — SHORT @ 29,879', at: T - 10_000 }, T);
    expect(opened).toHaveLength(0);
    expect(row).toMatchObject({ kind: 'open', ok: false });
    expect(row.what).toMatch(/lab only — not traded/);
    DISCORD_COPY.live = true;
  });
});

describe('the level lab', () => {
  const bar = (k: number, o: number, h: number, l: number, c: number): Bar => ({ t: T + k * M, o, h, l, c });
  const row = (): LabLevelTrade => ({ ref: 'discord_kojiro_levels:lab:NDXUSD:1', pair: 'NDXUSD', side: -1, entry: 29856.25, stop: 29881.14, target: 29804, t: T, why: 'sold high toward his level' });

  it('grades a recorded setup on the minutes after it: target → R after the fee', () => {
    VENUE_FEES.on = true;
    const rows = [row()];
    expect(gradeLevelLab(rows, 'NDXUSD', [bar(0, 29856, 29860, 29840, 29842), bar(1, 29842, 29845, 29800, 29806)], T + 3 * M)).toBe(true);
    expect(rows[0]!.done).toMatchObject({ reason: 'target', exit: 29804 });
    expect(rows[0]!.done!.r).toBeGreaterThan(1.5);
    expect(rows[0]!.done!.r).toBeLessThan(2.1); // the fee comes off
  });

  it('a stop touched first is a loss; nothing hit stays open; the summary adds it up', () => {
    const lost = row();
    gradeLevelLab([lost], 'NDXUSD', [bar(0, 29856, 29885, 29850, 29870)], T + 2 * M);
    expect(lost.done).toMatchObject({ reason: 'stop' });
    expect(lost.done!.r).toBeLessThan(-1);
    const open = { ...row(), ref: 'x2' };
    expect(gradeLevelLab([open], 'NDXUSD', [bar(0, 29856, 29860, 29850, 29855)], T + 2 * M)).toBe(false);
    expect(open.done).toBeUndefined();
    const s = levelLabSummary([lost, open]);
    expect(s).toMatchObject({ n: 2, done: 1, wins: 0, open: 1 });
    expect(s.byWhy['sold high toward his level']!.n).toBe(1);
  });
});
