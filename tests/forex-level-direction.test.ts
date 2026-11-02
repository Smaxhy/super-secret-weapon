/** v28.18 (owner: "just take his levels properly"): his level trades go one way only, at most 3 losers a session. */
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type Redis from 'ioredis';
import { LevelWatch, directionSkip, levelLabSummary, levelLossesToday, trendSide, LEVEL_RULES, LEVEL_LAB, type LabLevelTrade } from '../src/forex/level-watch';
import type { Practice } from '../src/forex/practice';
import type { Bar } from '../src/forex/types';
import { parseLevels, parseMonitor } from '../src/forex/discord';

describe('his level trades, one way only', () => {
  it('reads the market direction from the 2-hour average and its slope', () => {
    const down = Array.from({ length: 400 }, (_, k) => 28_800 - k);
    const up = Array.from({ length: 400 }, (_, k) => 28_400 + k);
    const flat = Array.from({ length: 400 }, (_, k) => 28_500 + (k % 2 ? 3 : -3));
    expect(trendSide(down, 399, 1)).toBe(-1);
    expect(trendSide(up, 399, 1)).toBe(1);
    expect(trendSide(flat, 399, 1)).toBe(0);
    expect(trendSide(down, 50, 1)).toBe(0); // not enough history
    // a bounce inside a fall: the close pops over the average but the average still falls → no long
    const bounce = [...down.slice(0, 390), ...Array.from({ length: 10 }, (_, k) => 28_410 + k * 30)];
    expect(trendSide(bounce, 399, 1)).not.toBe(1);
    // 15-minute candles: same 2 hours = 8 candles
    const down15 = Array.from({ length: 80 }, (_, k) => 28_800 - k * 10);
    expect(trendSide(down15, 79, 15)).toBe(-1);
  });

  it('his plan wins; without one only the market direction trades', () => {
    expect(directionSkip(-1, 0, -1)).toBeNull();
    expect(directionSkip(1, 0, -1)).toMatch(/against the market/);
    expect(directionSkip(1, 0, 0)).toMatch(/no clear market direction/);
    expect(directionSkip(1, 1, -1)).toBeNull(); // his bullish plan beats a falling market
    expect(directionSkip(-1, 1, -1)).toMatch(/against his long plan/);
  });

  it('counts losing level trades of this session only (17:00 New York)', () => {
    const now = Date.UTC(2026, 10, 2, 20, 0); // 15:00 New York → session started 22:00 UTC Nov 1
    const row = (closedAt: number, pnlUsd: number, extra: Partial<{ strategy: string; pair: string; reason: string }> = {}) => ({ strategy: 'discord_kojiro_levels', pair: 'NDXUSD', closedAt, pnlUsd, reason: 'stop', ...extra });
    const rows = [
      row(Date.UTC(2026, 10, 2, 19, 0), -20),
      row(Date.UTC(2026, 10, 2, 18, 0), -18),
      row(Date.UTC(2026, 10, 2, 17, 0), 30),
      row(Date.UTC(2026, 10, 1, 21, 0), -20), // yesterday's session
      row(Date.UTC(2026, 10, 2, 18, 30), -5, { reason: 'partial' }),
      row(Date.UTC(2026, 10, 2, 18, 30), -5, { pair: 'XAUUSD' }),
      row(Date.UTC(2026, 10, 2, 18, 30), -5, { strategy: 'discord_kojiro' }),
    ];
    expect(levelLossesToday(rows, 'discord_kojiro_levels', 'NDXUSD', now)).toBe(2);
    expect(LEVEL_RULES.maxLossesPerDay).toBe(3);
  });

  it('the lab keeps the rule\'s own record (taken vs skipped)', () => {
    const r = (skip: string | null | undefined, rr: number): LabLevelTrade => ({ ref: String(Math.random()), pair: 'NDXUSD', side: -1, entry: 1, stop: 2, target: null, t: 0, why: 'x', ...(skip !== undefined ? { skip } : {}), done: { at: 1, exit: 1, reason: 'stop', locked: false, pts: 0, r: rr } });
    const s = levelLabSummary([r(null, 1.5), r(null, -1), r('against the market', -1.2), r(undefined, 3)]);
    expect(s.rule).toEqual({ taken: { n: 2, totalR: 0.5 }, skipped: { n: 1, totalR: -1.2 } });
    expect(s.totalR).toBe(2.3);
  });

  it('reads "28,678,25" (a comma for the decimal point) as 28,678.25', () => {
    const lv = parseLevels('NQ Levels\n\n28,789.25 - 28,791.75\n28,713.50 - 28,714.50\n28,666.00 - 28,678,25\n28,477.50 - 28,482.25')!;
    expect(lv.levels).toContain(28_678.25);
    expect(lv.levels).toHaveLength(8);
    expect(parseMonitor('Monitoring 28,418,50')!.levels).toEqual([28_418.5]);
    expect(parseLevels('Levels 29,220.00 (29,182.25) (29,160.00)')!.levels).toEqual([29_220, 29_182.25, 29_160]);
  });
});

describe('the 1-minute watcher', () => {
  const M = 60_000;
  const T0 = Date.UTC(2026, 9, 27, 13, 0); // Tuesday 09:00 New York
  const run = async (bias: 1 | null) => {
    const now = T0 + 200 * M + 10_000;
    // a steady fall from 29,400 to ~29,200, the last minute sweeps his 29,182.25 and closes back over it (a long setup)
    const live: Bar[] = Array.from({ length: 200 }, (_, k) => {
      const c = 29_400 - k + 4 * Math.sin(k * 0.7);
      return { t: T0 + k * M, o: c + 1, h: c + 5, l: c - 5, c, v: 100 };
    });
    live[199] = { t: T0 + 199 * M, o: 29_205, h: 29_208, l: 29_178, c: 29_204, v: 400 };
    const store = new Map<string, string>();
    const r = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ...a: unknown[]) => (a.includes('NX') && store.has(k) ? null : (store.set(k, v), 'OK')),
    } as unknown as Redis;
    store.set('fx:discord:levels', JSON.stringify({ NDXUSD: { pair: 'NDXUSD', levels: [29_385.25, 29_182.25], t: T0, msgId: '1', source: 'kojiro', ...(bias ? { bias, biasT: T0 } : {}) } }));
    store.set('fx:hl:futures', JSON.stringify({ NDXUSD: 'xyz:XYZ100' }));
    const copyOpen = vi.fn(async () => ({ ok: true, entry: 29_204, stop: 29_150, riskUsd: 20 }));
    const practice = { hlGap: () => 0, heldRefs: async () => [], rawAccount: async () => ({ closed: [] }), copyOpen } as unknown as Practice;
    await new LevelWatch(r, practice, () => undefined, async () => live).tick(now);
    return { copyOpen, lab: JSON.parse(store.get(LEVEL_LAB.key) ?? '[]') as LabLevelTrade[] };
  };

  it('no bias from him + a falling market → the long is recorded in the lab, not traded', async () => {
    const { copyOpen, lab } = await run(null);
    expect(copyOpen).not.toHaveBeenCalled();
    expect(lab).toHaveLength(1);
    expect(lab[0]!.side).toBe(1);
    expect(lab[0]!.skip).toMatch(/against the market's direction/);
  });

  it('his bullish plan → the same long is taken', async () => {
    const { copyOpen, lab } = await run(1);
    expect(copyOpen).toHaveBeenCalledTimes(1);
    expect(lab[0]!.skip).toBeNull();
  });
});
