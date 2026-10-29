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

import { expandPrice, parseSignal } from '../src/forex/discord';
import { postedLevelSignal, reclaimSignal } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import type { Bar } from '../src/forex/types';

describe('v28.5 copying him right: targets, flips, sweep-and-reclaim at his level', () => {
  it('reads his "TP 782" / "TP1 806" posts and expands short prices around the trade', () => {
    expect(parseSignal('TP 782')).toEqual({ kind: 'target', pair: null, symbol: null, price: 782 });
    expect(parseSignal('TP1 806 if you want to be sure')).toMatchObject({ kind: 'target', price: 806 });
    expect(parseSignal('Fullport FOMC shorts')).toMatchObject({ kind: 'open', side: -1 });
    expect(expandPrice(782, 29_887)).toBe(29_782);
    expect(expandPrice(806, 29_887)).toBe(29_806);
    expect(expandPrice(12.5, 29_995)).toBe(30_012.5);
    expect(expandPrice(29_806, 29_887)).toBe(29_806);
  });

  it('a call the other way closes his earlier copy first; a TP post sets the open copy\'s target', async () => {
    const calls: string[] = [];
    const b = {
      copyOpen: vi.fn(async () => (calls.push('open'), { ok: true, entry: 29_887, stop: 30_036, riskUsd: 20 })),
      copyClose: vi.fn(async (m: { side: number }) => (calls.push(`close ${m.side}`), { ok: true, closed: ['long NDXUSD +$3.00'], pending: 0 })),
      copyBreakeven: vi.fn(),
      copyTarget: vi.fn(async (m: { price: number }) => ({ ok: true, moved: [`short NDXUSD → ${expandPrice(m.price, 29_887)}`] })),
    } as unknown as CopyBook;
    const r = new FakeRedis() as unknown as Redis;
    const row = await handleSignal(r, b, { id: '1564000000000000010', text: 'SIGNAL · NQ — SHORT @ 29,887', at: NOW }, NOW);
    expect(calls).toEqual(['close 1', 'open']);
    expect(row.what).toMatch(/closed his earlier long NDXUSD/);
    const t = await handleSignal(r, b, { id: '1564000000000000011', text: 'TP 782', at: NOW }, NOW);
    expect(t).toMatchObject({ kind: 'target', ok: true });
    expect(t.what).toMatch(/29782/);
  });

  it('NQ swept his 29,466.25 to ~29,405 and closed back over it → long, stop under the sweep, his next level the target', () => {
    const M = 60_000;
    const t0 = Date.UTC(2026, 9, 29, 12, 0);
    const bars: Bar[] = [];
    let px = 29_700;
    // 2 h of quiet drift down from 29,700 to ~29,560 (1-point candles)
    for (let k = 0; k < 120; k++) {
      const o = px;
      px -= 1.2;
      bars.push({ t: t0 + k * M, o, h: Math.max(o, px) + 3, l: Math.min(o, px) - 3, c: px });
    }
    // fast drop through the level to 29,405, three candles under it, then the close back over it
    const run: Array<[number, number, number, number]> = [[29_560, 29_562, 29_500, 29_505], [29_505, 29_508, 29_470, 29_472], [29_472, 29_474, 29_440, 29_445], [29_445, 29_450, 29_405, 29_420], [29_420, 29_458, 29_415, 29_450], [29_450, 29_482, 29_446, 29_478]];
    for (const [o, h, l, c] of run) bars.push({ t: t0 + bars.length * M, o, h, l, c });
    const c = buildCtx(bars, 1, 'NDXUSD');
    const i = bars.length - 1;
    const levels = [29_609.5, 29_563.5, 29_466.25];
    const s = reclaimSignal(c, i, levels, t0)!;
    expect(s).toMatchObject({ side: 1, note: 'swept his level and closed back over it' });
    expect(s.stop!).toBeLessThan(29_405);
    expect([29_563.5, 29_609.5]).toContain(s.target);
    // one candle earlier (still under the level) → nothing yet; his lean the other way → nothing
    expect(reclaimSignal(c, i - 1, levels, t0)).toBeNull();
    expect(reclaimSignal(c, i, levels, t0, -1)).toBeNull();
    // the level watcher's rule chain finds it
    expect(postedLevelSignal(c, i, levels, t0)).toMatchObject({ side: 1 });
  });
});

import { LevelWatch, loadLevelLab } from '../src/forex/level-watch';
import { HL_FUTURES_KEY } from '../src/forex/hyperliquid';
import type { Practice } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

describe('v28.5 his Monitoring prices survive his edit; a past stretch goes through the level lab', () => {
  it('an edit of the same Levels post keeps the Monitoring prices; a new post starts fresh', async () => {
    const r = new FakeRedis() as unknown as Redis;
    const at = NOW - 30 * 60_000;
    await savePosted(r, 'NDXUSD', { levels: [29_670, 29_609.5], t: at, msgId: 'A', source: 'kojiro' });
    await savePosted(r, 'NDXUSD', { levels: [29_466.25], t: at + 60_000, msgId: 'm', source: 'kojiro', add: true });
    await savePosted(r, 'NDXUSD', { levels: [29_729.5, 29_670], t: at, msgId: 'A', source: 'kojiro' });
    expect((await loadLevels(r, NOW)).NDXUSD!.levels).toEqual([29_729.5, 29_670, 29_466.25]);
    await savePosted(r, 'NDXUSD', { levels: [30_000, 29_900], t: NOW, msgId: 'B', source: 'kojiro' });
    expect((await loadLevels(r, NOW)).NDXUSD!.levels).toEqual([30_000, 29_900]);
  });

  it('replayLab records the sweep-and-reclaim long at his Monitoring level and grades it on the minutes after', async () => {
    const fees = VENUE_FEES.on;
    VENUE_FEES.on = false;
    try {
      const M = 60_000;
      const t0 = Date.UTC(2026, 9, 29, 11, 30);
      const bars: Bar[] = [];
      let px = 29_740;
      for (let k = 0; k < 120; k++) {
        const o = px;
        px -= 1.5;
        bars.push({ t: t0 + k * M, o, h: Math.max(o, px) + 3, l: Math.min(o, px) - 3, c: px });
      }
      for (const [o, h, l, c] of [[29_560, 29_562, 29_500, 29_505], [29_505, 29_508, 29_470, 29_472], [29_472, 29_474, 29_440, 29_445], [29_445, 29_450, 29_405, 29_420], [29_420, 29_458, 29_415, 29_450], [29_450, 29_482, 29_446, 29_478]] as const) bars.push({ t: t0 + bars.length * M, o, h, l, c });
      // then it runs up through his 29,563.50
      for (let k = 0; k < 30; k++) {
        const o = bars[bars.length - 1]!.c;
        bars.push({ t: t0 + bars.length * M, o, h: o + 6, l: o - 1, c: o + 5 });
      }
      const now = bars[bars.length - 1]!.t + 2 * M;
      const r = new FakeRedis();
      r.m.set(HL_FUTURES_KEY, JSON.stringify({ NDXUSD: 'xyz:XYZ100' }));
      await savePosted(r as unknown as Redis, 'NDXUSD', { levels: [29_609.5, 29_563.5, 29_466.25], t: t0 + 60 * M, msgId: 'A', source: 'kojiro' });
      const w = new LevelWatch(r as unknown as Redis, { hlGap: () => 0 } as unknown as Practice, () => undefined, async () => bars);
      const lines = await w.replayLab('NDXUSD', t0 + 60 * M, now);
      expect(lines!.join(' ')).toMatch(/would buy at 29478/);
      const row = (await loadLevelLab(r as unknown as Redis)).find((x) => x.entry === 29_478)!;
      expect(row.side).toBe(1);
      expect(row.why).toMatch(/swept his level/);
      expect(row.done!.r).toBeGreaterThan(0);
    } finally {
      VENUE_FEES.on = fees;
    }
  });
});
