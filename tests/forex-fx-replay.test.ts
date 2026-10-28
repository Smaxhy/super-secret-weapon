import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, signalsFor, simulate } from '../src/forex/engine';
import { buildReplay, replayPicks, replaySeries, replayTrades, windowBars } from '../src/forex/fx-replay';
import type { MarketBook, Row } from '../src/forex/lab';
import { buildMood } from '../src/forex/mood';
import { STRATEGIES } from '../src/forex/strategies';
import { buildStrength } from '../src/forex/strength';
import { INSTRUMENTS, type Bar } from '../src/forex/types';

const HOUR = 3_600_000;
/** a wavy hourly series with trends + pullbacks, weekdays only (no weekend gaps to keep it simple) */
function synth(n: number, start = Date.UTC(2025, 0, 6)): Bar[] {
  const out: Bar[] = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 90) * 0.0004 + Math.sin(i / 13) * 0.0006;
    const o = p;
    const c = o + drift + Math.sin(i * 1.7) * 0.0003;
    const h = Math.max(o, c) + 0.0004 + Math.abs(Math.sin(i * 0.9)) * 0.0004;
    const l = Math.min(o, c) - 0.0004 - Math.abs(Math.cos(i * 1.1)) * 0.0004;
    out.push({ t: start + i * HOUR, o, h, l, c });
    p = c;
  }
  return out;
}
const eur = INSTRUMENTS.find((i) => i.id === 'EURUSD')!;
const h1 = synth(3_000);
const book: MarketBook = { at: 1, strength: buildStrength({}), mood: buildMood({}), ranks: {}, zOil: null, zYield: null, zStocks: null, zDollar: null, spxMtd: null, h1: new Map([['EURUSD', h1]]) };
const row = (id: string, tf: '1h' | '4h', verdict: Row['verdict'], outAvgR = 0.1) => ({ id, name: id, tf, filter: 'none', exit: 'designed', entry: 'market', verdict, outSample: { n: 50, avgR: outAvgR } }) as unknown as Row;

describe('v28 replay (FX Replay idea, built in)', () => {
  it('the bot\'s live rows come first, then Edge / Maybe / no by unseen record; random never', () => {
    const rows = [row('ema_cross', '1h', 'no', 0.3), row('macd_cross', '1h', 'maybe'), row('random', '1h', 'edge'), row('donchian20', '1h', 'edge', 0.05), row('rsi_dip', '4h', 'edge')];
    const p = replayPicks(rows, '1h', new Set(['ema_cross:1h']));
    expect(p.map((x) => x.id)).toEqual(['ema_cross', 'donchian20', 'macd_cross']);
    expect(p[0]!.live).toBe(true);
  });

  it('trades are the lab\'s own simulation of that strategy, cut to the window', () => {
    const se = replaySeries(eur, '1h', h1, book)!;
    expect(se.ctx.bars.length).toBe(h1.length);
    const s = STRATEGIES.find((x) => x.id === 'ema_cross') ?? STRATEGIES.find((x) => x.id !== 'random')!;
    const all = simulate(eur, '1h', se.ctx, s.id, signalsFor(se.ctx, s), undefined, DEFAULT_SIM);
    const from = h1[1_500]!.t;
    const to = h1[2_999]!.t;
    const got = replayTrades(se, replayPicks([row(s.id, '1h', 'maybe')], '1h', new Set()), from, to, null);
    const want = all.filter((t) => t.entryT >= from && t.entryT <= to);
    expect(want.length).toBeGreaterThan(3);
    expect(got.length).toBe(want.length);
    expect(got.map((t) => [t.entryT, t.side, t.r])).toEqual(want.map((t) => [t.entryT, t.side, Math.round(t.r * 1000) / 1000]));
  });

  it('a window of candles is cut to the newest maxBars; a replay with too few candles says so', () => {
    const w = windowBars(h1, h1[100]!.t, h1[400]!.t, 50);
    expect(w.length).toBe(50);
    expect(w[w.length - 1]![0]).toBe(h1[400]!.t);
    const r = buildReplay({ inst: eur, tf: '1h', h1: h1.slice(0, 100), book, rows: [], live: new Set(), pick: null, from: 0, to: Date.now(), oosFrom: null });
    expect(r.bars).toEqual([]);
    expect(r.note).toMatch(/not enough/);
  });

  it('4-hour replays build from the hourly bars; picks marked on', () => {
    const r = buildReplay({ inst: eur, tf: '4h', h1, book, rows: [row('donchian20', '4h', 'edge')], live: new Set(), pick: null, from: h1[0]!.t, to: h1[2_999]!.t, oosFrom: null });
    expect(r.bars.length).toBeGreaterThan(400);
    expect(r.bars[1]![0]! - r.bars[0]![0]!).toBe(4 * HOUR);
    expect(r.picks[0]!.on).toBe(true);
  });
});
