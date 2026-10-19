import { describe, expect, it } from 'vitest';
import { fillFromDk } from '../src/forex/fill';
import { refreshDkTail } from '../src/forex/dukascopy';
import type { Bar } from '../src/forex/types';
import type Redis from 'ioredis';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 14, 5);
const bar = (t: number, c: number): Bar => ({ t, o: c, h: c + 0.0003, l: c - 0.0003, c });
const series = (from: number, to: number, f: (t: number) => number) => {
  const out: Bar[] = [];
  for (let t = from; t <= to; t += H) out.push(bar(t, f(t)));
  return out;
};

describe('v17 Dukascopy gap fill (currency pairs)', () => {
  const px = (t: number) => 1.1 + Math.sin(t / (7 * H)) * 0.002;
  const start = NOW - 4 * 86_400_000 - ((NOW - 4 * 86_400_000) % H);
  const lastClosed = Math.floor(NOW / H) * H - H;
  const dk = series(start, lastClosed, px).map((b) => ({ ...b, s: 0.2 }));

  it('fills the hours Yahoo is missing when the two sources agreed just before', () => {
    const yahoo = series(start, lastClosed - 5 * H, px); // the last 5 hours missing
    const f = fillFromDk('EURUSD', yahoo, dk, NOW);
    expect(f.source).toBe('mixed');
    expect(f.filled).toHaveLength(5);
    expect(f.bars[f.bars.length - 1]!.t).toBe(lastClosed);
  });

  it('refuses when the sources disagree, and never fills metals', () => {
    const yahoo = series(start, lastClosed - 5 * H, (t) => px(t) + 0.001); // 10 pips apart
    const f = fillFromDk('EURUSD', yahoo, dk, NOW);
    expect(f.filled).toHaveLength(0);
    expect(f.reason).toMatch(/disagree by 10/);
    expect(fillFromDk('XAUUSD', yahoo, dk, NOW).reason).toMatch(/metals/);
  });

  it('with almost no Yahoo history the Dukascopy series is used on its own; the forming hour is never used', () => {
    const long = series(Math.floor(NOW / H) * H - 40 * 86_400_000, Math.floor(NOW / H) * H, px).map((b) => ({ ...b, s: 0.2 }));
    const f = fillFromDk('EURUSD', series(lastClosed - 10 * H, lastClosed, px), long, NOW);
    expect(f.source).toBe('dukascopy');
    expect(f.bars[f.bars.length - 1]!.t).toBe(lastClosed); // the bar still forming at NOW is left out
  });

  it('the tail refresh merges the newest hours and respects its throttle', async () => {
    const m = new Map<string, string>();
    const redis = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => (m.set(k, v), 'OK') } as unknown as Redis;
    let calls = 0;
    const fetcher = async (_id: string, side: 'bid' | 'ask', from: Date, to: Date) => {
      calls++;
      const rows: number[][] = [];
      for (let t = Math.ceil(from.getTime() / H) * H; t < to.getTime(); t += H) {
        const p = px(t) + (side === 'ask' ? 0.00005 : -0.00005);
        rows.push([t, p, p + 0.0003, p - 0.0003, p, 5]);
      }
      return rows;
    };
    const r = await refreshDkTail(redis, ['EURUSD'], NOW, fetcher);
    expect(r.EURUSD!.added).toBeGreaterThan(40);
    expect(r.EURUSD!.lastT).toBe(lastClosed);
    const again = await refreshDkTail(redis, ['EURUSD'], NOW + 60_000, fetcher);
    expect(again.EURUSD).toBeUndefined(); // within 10 minutes: skipped
    expect(calls).toBe(2);
  });
});
