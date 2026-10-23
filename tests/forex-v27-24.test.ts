import { describe, expect, it } from 'vitest';
import { howToWin } from '../src/forex/loss-review';
import { lossStreak, BOT, type ClosedPractice } from '../src/forex/practice';
import { confluenceStudy, isTogether, CONFLUENCE, type ConfTrade } from '../src/forex/confluence';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 23, 0);
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: T0 + i * H, o, h, l, c });
// long at 100, tested stop 98 ($20 cap stop tighter at 99), target 104
const pos = { side: 1 as const, entry: 100, stop: 99, target: 104, units: 10, riskUsd0: 20, openedAt: T0 + 1, closedAt: T0 + 2 * H };

describe('v27.24 how it could have won', () => {
  it('up first → bank it', () => {
    expect(howToWin(pos, [bar(0, 100, 101.5, 99.5, 100), bar(1, 100, 100, 98.9, 99)], H)?.kind).toBe('bank_early');
  });
  it('the tested stop would have held, target hit later', () => {
    expect(howToWin(pos, [bar(0, 100, 100.4, 98.9, 99), bar(1, 99, 100, 98.5, 99.5), bar(2, 99.5, 104.5, 99.5, 104)], H)?.kind).toBe('tested_stop');
  });
  it('a bigger drop first → wider stop / later entry; never reached → skip', () => {
    expect(howToWin(pos, [bar(0, 100, 100.4, 98.9, 99), bar(1, 99, 99, 97, 97.5), bar(2, 97.5, 104.5, 97.5, 104)], H)?.kind).toBe('wider_stop');
    expect(howToWin(pos, [bar(0, 100, 100.4, 98.9, 99), bar(1, 99, 99, 95, 96), bar(2, 96, 104.5, 96, 104)], H)?.kind).toBe('later_entry');
    expect(howToWin(pos, [bar(0, 100, 100.4, 98.9, 99), bar(1, 99, 99.5, 97, 98)], H)?.kind).toBe('skip');
  });
});

describe('v27.24 losing streak', () => {
  const c = (pnlUsd: number, closedAt: number, reason: ClosedPractice['reason'] = 'stop') => ({ pnlUsd, closedAt, reason, strategy: 'x' }) as ClosedPractice;
  it('counts the newest losses until a win, skipping manual closes', () => {
    expect(lossStreak([c(-20, 5), c(-9, 4, 'manual'), c(-20, 3), c(-20, 2), c(-20, 1), c(30, 0)])).toEqual({ n: 4, lastAt: 5 });
    expect(lossStreak([c(10, 5), c(-20, 4)]).n).toBe(0);
    expect(BOT.streak.on).toBe(false); // v27.25: owner wants only the per-trade max loss
  });
});

describe('v27.24 doubling-up test', () => {
  const t = (key: string, pair: string, entryT: number, r: number): ConfTrade => ({ key, pair, side: 1, entryT, exitT: entryT + H, r, barMs: H });
  it('finds a second strategy the same way within 2 candles', () => {
    expect(isTogether(t('a:1h', 'EURUSD', 0, 1), [t('b:1h', 'EURUSD', H, 1)])).toBe(true);
    expect(isTogether(t('a:1h', 'EURUSD', 0, 1), [t('a:4h', 'EURUSD', H, 1), t('b:1h', 'EURUSD', 5 * H, 1)])).toBe(false);
  });
  it('switches on only when double signals win more on both parts', () => {
    const pool: ConfTrade[] = [];
    const line = 1000 * H;
    for (let i = 0; i < 200; i++) {
      const base = (i < 100 ? 0 : line + 10 * H) + i * 10 * H;
      pool.push(t('a:1h', 'EURUSD', base, 0.6), t('b:1h', 'EURUSD', base + H, 0.6)); // together, win more
      pool.push(t('a:1h', 'GBPUSD', base, -0.1)); // alone
    }
    const rep = confluenceStudy(pool, line);
    expect(rep.active).toBe(true);
    expect(rep.mult).toBe(CONFLUENCE.mult);
    const flat = confluenceStudy(pool.map((x) => ({ ...x, r: 0 })), line);
    expect(flat.active).toBe(false);
  });
});
