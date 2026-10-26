/** v27.52 (owner: "what happened to not having delayed candles"; "copy his trades immediately, or 1–2 minutes later"). */
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { extendWithLive } from '../src/forex/basis';
import { hlCandles } from '../src/forex/hyperliquid';
import { LevelWatch, shiftedMinutes } from '../src/forex/level-watch';
import type { Practice } from '../src/forex/practice';
import type { Bar } from '../src/forex/types';

const M = 60_000;
const H = 60 * M;
const T0 = Date.UTC(2026, 9, 27, 13, 0); // Tuesday 09:00 New York

describe('Yahoo candles topped up with the live feed', () => {
  const yahoo: Bar[] = Array.from({ length: 20 }, (_, k) => ({ t: T0 + k * H, o: 100 + k, h: 101 + k, l: 99 + k, c: 100.5 + k, v: 1000 }));
  const live: Bar[] = Array.from({ length: 23 }, (_, k) => ({ t: T0 + k * H, o: 98 + k, h: 99 + k, l: 97 + k, c: 98.5 + k, v: 10 }));
  it('adds the finished candles newer than Yahoo’s, moved by the gap, volume scaled', () => {
    const now = T0 + 22 * H + 5 * M; // the 22:00 candle is still forming
    const x = extendWithLive(yahoo, live, H, now);
    expect(x.basis).toBe(2);
    expect(x.added).toBe(2);
    expect(x.bars.slice(-2)).toEqual([
      { t: T0 + 20 * H, o: 120, h: 121, l: 119, c: 120.5, v: 1000 },
      { t: T0 + 21 * H, o: 121, h: 122, l: 120, c: 121.5, v: 1000 },
    ]);
  });
  it('too few shared candles → Yahoo only; the CME halt hour and closed hours are left out', () => {
    expect(extendWithLive(yahoo.slice(-3), live, H, T0 + 23 * H).added).toBe(0);
    // Yahoo up to 20:00 UTC; live to 00:00 → 21:00 UTC (= 17:00 New York, the daily halt) and the "closed" 23:00 are skipped, 22:00 and 00:00 added
    const y2 = Array.from({ length: 20 }, (_, k) => ({ t: T0 - 12 * H + k * H, o: 100, h: 101, l: 99, c: 100 }));
    const l2 = Array.from({ length: 24 }, (_, k) => ({ t: T0 - 12 * H + k * H, o: 98, h: 99, l: 97, c: 98 }));
    const x = extendWithLive(y2, l2, H, T0 + 12 * H, (t) => t === T0 + 10 * H);
    expect(x.bars.slice(20).map((b) => (b.t - T0) / H)).toEqual([9, 11]);
  });
  it('reads Hyperliquid candles', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ t: 2, o: '1', h: '2', l: '0.5', c: '1.5', v: '0' }, { t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '7' }] }));
    expect(await hlCandles('xyz:XYZ100', '1m', 0, 10, fetcher)).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }, { t: 2, o: 1, h: 2, l: 0.5, c: 1.5 }]);
  });
});

describe('his levels on live 1-minute candles', () => {
  it('only finished minutes, moved by the gap', () => {
    expect(shiftedMinutes([{ t: 0, o: 1, h: 2, l: 0, c: 1 }, { t: M, o: 1, h: 2, l: 0, c: 1 }], 10, M + 30_000)).toEqual([{ t: 0, o: 11, h: 12, l: 10, c: 11 }]);
  });

  it('a dip into his level that gets absorbed opens a trade within the minute, once', async () => {
    const now = T0 + 200 * M + 10_000;
    // 199 finished minutes swinging around 29,250, the last one sweeps to 29,178 (his 29,182.25) and closes back at 29,230
    const live: Bar[] = Array.from({ length: 200 }, (_, k) => {
      const c = 29_250 + 15 * Math.sin(k * 0.4);
      return { t: T0 + k * M, o: c - 2, h: c + 6, l: c - 6, c, v: 100 };
    });
    live[199] = { t: T0 + 199 * M, o: 29_235, h: 29_238, l: 29_178, c: 29_230, v: 400 };
    const redis = new Map<string, string>();
    const r = {
      get: async (k: string) => redis.get(k) ?? null,
      set: async (k: string, v: string, ...a: unknown[]) => (a.includes('NX') && redis.has(k) ? null : (redis.set(k, v), 'OK')),
    } as unknown as Redis;
    redis.set('fx:discord:levels', JSON.stringify({ NDXUSD: { pair: 'NDXUSD', levels: [29_385.25, 29_182.25], t: T0, msgId: '1', source: 'kojiro', bias: 1, dol: 29_385.25, biasT: T0 } }));
    redis.set('fx:hl:futures', JSON.stringify({ NDXUSD: 'xyz:XYZ100' }));
    const copyOpen = vi.fn(async () => ({ ok: true, entry: 29_231, stop: 29_150, riskUsd: 20 }));
    const practice = { hlGap: () => 0, heldRefs: async () => [], copyOpen } as unknown as Practice;
    const lines: string[] = [];
    const w = new LevelWatch(r, practice, (_p, l) => lines.push(...l), async () => live);
    await w.tick(now);
    expect(copyOpen).toHaveBeenCalledTimes(1);
    const [req] = copyOpen.mock.calls[0] as unknown as [{ pair: string; side: number; stop: number; target: number; strategy: string; profitLock: boolean }];
    expect(req).toMatchObject({ pair: 'NDXUSD', side: 1, target: 29_385.25, strategy: 'discord_kojiro_levels', profitLock: true });
    expect(29_230 - req.stop).toBeGreaterThanOrEqual((29_230 * 0.08) / 100 - 1e-9);
    expect(lines[0]).toMatch(/Kojiro level: bought NDXUSD/);
    await w.tick(now + 5_000); // the same minute again → no second trade
    expect(copyOpen).toHaveBeenCalledTimes(1);
  });
});
