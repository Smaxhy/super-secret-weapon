/** v27.66 (owner: "scan Kojiro's calls, see which one hits and take it; a tight trailing SL in moments of need"). */
import { describe, expect, it } from 'vitest';
import { KSTUDY, buildCard, callsFrom, kojiroGate, simCall, type HistPost, type KCall } from '../src/forex/kojiro-study';
import { newAccount, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { PROFIT_LOCK } from '../src/forex/profit-lock';
import type { Bar } from '../src/forex/types';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;
const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 20, 14, 0, 0); // 10:00 New York

/** 15-minute candles from closes (each candle spans the previous close → this one, ± a wick). */
function candles(t0: number, closes: number[], wick = 5): Bar[] {
  let prev = closes[0]!;
  return closes.map((c, i) => {
    const b = { t: t0 + i * M15, o: prev, h: Math.max(prev, c) + wick, l: Math.min(prev, c) - wick, c };
    prev = c;
    return b;
  });
}

describe('his posts → calls', () => {
  it('pairs each call with his exit, his plan and his levels of the day', () => {
    const posts: HistPost[] = [
      { id: '1000001', at: T0 - 3_600_000, text: 'Bias: bullish\nDOL: 29,500' },
      { id: '1000002', at: T0 - 3_000_000, text: 'Levels 29,100 29,050 28,990' },
      { id: '1000003', at: T0, text: 'SIGNAL · NQ — LONG @ 29,100' },
      { id: '1000004', at: T0 + 1_800_000, text: 'SIGNAL · NQ — SHORT @ 29,300' },
      { id: '1000005', at: T0 + 3_600_000, text: 'SELL @ 29,250' }, // closes the long
    ];
    const calls = callsFrom(posts);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ side: 1, price: 29_100, bias: 1, atLevel: true, exitPx: 29_250, exitAt: T0 + 3_600_000 });
    expect(calls[1]).toMatchObject({ side: -1, bias: -1, atLevel: false, exitAt: null });
  });
});

describe('replaying a call on the candles', () => {
  const call = (o: Partial<KCall> = {}): KCall => ({ id: 'c', at: T0 + 60_000, pair: 'NDXUSD', side: 1, price: 29_000, stopNamed: null, exitAt: null, exitPx: null, session: 2, bias: 0, atLevel: false, ...o });

  it('his exit closes it at his price', () => {
    const bars = candles(T0, [29_000, 29_040, 29_080, 29_120]);
    const s = simCall(call({ exitAt: T0 + 2 * M15 + 60_000, exitPx: 29_100 }), bars, M15, 'none');
    expect(s).toMatchObject({ how: 'his' });
    expect((s as { r: number }).r).toBeCloseTo(100 / 145, 2); // 0.5% safety stop = 145 points
  });

  it('the safety stop when it falls; the wide trail keeps more of a big run than the tight one gives back', () => {
    const down = candles(T0, [29_000, 28_950, 28_880, 28_800]);
    expect(simCall(call(), down, M15, 'copy')).toMatchObject({ how: 'stop' });
    // runs +200, then gives back 120: the tight trail (arms at +0.3R, trails 0.3R) is out earlier than the wide one
    const run = candles(T0, [29_000, 29_060, 29_120, 29_200, 29_150, 29_080, 29_000, 28_950], 2);
    const tight = simCall(call(), run, M15, 'tight') as { r: number; how: string };
    const wide = simCall(call(), run, M15, 'copy') as { r: number; how: string };
    expect(tight.how).toBe('trail');
    expect(tight.r).toBeGreaterThan(0);
    expect(wide.how).toBe('trail');
  });

  it('a price that is nowhere near the candle = another contract → not graded', () => {
    expect(simCall(call({ price: 28_000 }), candles(T0, [29_000, 29_010, 29_020]), M15, 'none')).toBe('mismatch');
  });
});

describe('the card and the gate', () => {
  /** n long calls in the NY open that each lose to the stop, m short calls that each run to his exit */
  function history(nLose: number, mWin: number): { posts: HistPost[]; bars: Bar[] } {
    const closes: number[] = [];
    const posts: HistPost[] = [];
    let id = 2_000_000;
    for (let k = 0; k < nLose + mWin; k++) {
      const t = T0 + k * 86_400_000; // one call a day at 10:00 New York
      const lose = k < nLose;
      posts.push({ id: String(id++), at: t + 60_000, text: lose ? 'SIGNAL · NQ — LONG @ 29,000' : 'SIGNAL · NQ — SHORT @ 29,000' });
      if (!lose) posts.push({ id: String(id++), at: t + 3 * M15 + 60_000, text: 'COVER @ 28,900' });
      // that day's candles: from 29,000 straight down 200 points, then flat until the next day
      const day = [29_000, 28_960, 28_920, 28_880, 28_840, 28_800];
      while (closes.length < k * 96) closes.push(29_000);
      closes.push(...day);
    }
    while (closes.length < (nLose + mWin) * 96 + 96) closes.push(29_000);
    return { posts, bars: candles(T0, closes, 2) };
  }

  it('skips the kind of his calls that kept losing, takes the rest', () => {
    const { posts, bars } = history(10, 10);
    const card = buildCard(posts, { NDXUSD: [{ bars, barMs: M15 }] }, null, T0);
    expect(card.graded).toBe(20);
    const longs = card.slices.find((s) => s.key === 'side:1')!;
    expect(longs.stat.n).toBe(10);
    expect(longs.skip).toBe(true);
    expect(card.slices.find((s) => s.key === 'side:-1')!.skip).toBe(false);
    const g = kojiroGate(card, { side: 1, session: 2, bias: 0, atLevel: false, stopNamed: null });
    expect(g.take).toBe(false);
    expect(g.why).toMatch(/his long calls lost/);
    expect(kojiroGate(card, { side: -1, session: 1, bias: 0, atLevel: false, stopNamed: null }).take).toBe(true);
  });

  it('a losing record across the board skips nothing (that is reported, not picked)', () => {
    const { posts, bars } = history(12, 0);
    const card = buildCard(posts, { NDXUSD: [{ bars, barMs: M15 }] }, null, T0);
    expect(card.plans.copy.avgR).toBeLessThan(0);
    expect(card.slices.some((s) => s.skip)).toBe(false);
  });

  it('too few calls = taken as before; no card = taken', () => {
    const { posts, bars } = history(KSTUDY.gateMinN - 1, 0);
    const card = buildCard(posts, { NDXUSD: [{ bars, barMs: M15 }] }, null, T0);
    expect(kojiroGate(card, { side: 1, session: 2, bias: 0, atLevel: false, stopNamed: null }).take).toBe(true);
    expect(kojiroGate(null, { side: 1, session: 2, bias: 0, atLevel: false, stopNamed: null })).toMatchObject({ take: true });
  });
});

describe('moments of need: news → the tight trailing stop', () => {
  it('a copy switches to the tight lock while big news is near; other trades are left alone', () => {
    const T = Date.UTC(2026, 9, 20, 12, 25, 0);
    const a = newAccount(1000);
    const copy: PracticePosition = { id: 'k1', pair: 'NDXUSD', side: 1, units: 1.4, entry: 29_000, marginUsd: 800, leverage: 50, stop: 28_855, target: null, openedAt: T - 600_000, checkedT: 0, tf: 'signal', ref: 'discord_kojiro:signal:NDXUSD:1', riskUsd0: 1.4 * 145, allIn: true };
    a.open = [copy];
    const q: Quote = { id: 'NDXUSD', mid: 29_010, bid: 29_009, ask: 29_011, t: T, bars: [[T - 60_000, 29_012, 29_000, 29_010, 29_005]], dayChangePct: null, source: 'yahoo-live' };
    const ev = tick(a, { NDXUSD: q }, T, undefined, undefined, (pair) => (pair === 'NDXUSD' ? 'USD news: CPI' : null));
    const p = a.open[0]!;
    expect(p.copyLock).toBe('tight');
    expect(p.tightWhy).toBe('USD news: CPI');
    expect(ev.join(' ')).toMatch(/tight trailing stop now/);
    // the tight lock = the profit lock on D = 2 × the original 145-point stop
    expect(p.lock!.gap).toBeCloseTo(PROFIT_LOCK.gapFrac * 290, 6);
  });
});
