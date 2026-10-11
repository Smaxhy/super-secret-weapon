import { describe, expect, it } from 'vitest';
import { candlesFromTrades, timeframeFail, timeframes, tfStats } from '../src/evaluator/timeframes';
import { labIds } from '../src/learner/ta-lab';
import { runStrategiesTf, splitTaId, taName, TA_STRATEGIES } from '../src/evaluator/ta/strategies';

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);
const tr = (sec: number, px: number, buy = true, sol = 0.5) => ({ t: T0 + sec * 1000, w: `w${sec}`, buy, sol, tok: sol / px, px, pp: px });

describe('timeframes', () => {
  it('builds exact candles per timeframe, with gaps filled', () => {
    const trades = [tr(0, 1), tr(2, 1.1), tr(12, 1.2), tr(31, 1.5, false)];
    const c5 = candlesFromTrades(trades, 5_000, T0 + 33_000);
    expect(c5[0]).toMatchObject({ t: T0, o: 1, h: 1.1, c: 1.1, n: 2 });
    expect(c5.map((c) => c.t - T0)).toEqual([0, 5000, 10000, 15000, 20000, 25000, 30000]);
    expect(c5[1]!.n).toBe(0); // quiet 5 s → flat candle
    expect(c5[6]).toMatchObject({ o: 1.2, c: 1.5, sv: 0.5 });
    const c30 = candlesFromTrades(trades, 30_000, T0 + 33_000);
    expect(c30).toHaveLength(2);
    expect(c30[0]).toMatchObject({ o: 1, c: 1.2, n: 3 });
  });
  it('stats: current candle move, 3-candle run, distance from the high', () => {
    const s = tfStats(candlesFromTrades([tr(0, 1), tr(5, 1.2), tr(10, 1.1), tr(15, 1.32)], 5_000, T0 + 16_000))!;
    expect(s.lastPct).toBeCloseTo(20, 0); // 1.1 → 1.32
    expect(s.run3Pct).toBeCloseTo(32, 0); // open of the candle 2 back (1.0) → 1.32
    expect(s.offHighPct).toBe(0);
  });
  it('every timeframe at once, and the owner limits', () => {
    const trades = Array.from({ length: 60 }, (_, i) => tr(i * 10, 1 + i * 0.002));
    trades.push(tr(600, 1.4));
    const tf = timeframes(trades, T0 + 601_000);
    expect(Object.keys(tf).sort()).toEqual(['h1', 'm1', 'm5', 's15', 's30', 's5']);
    const z = { s5: 0, s15: 0, s30: 0, m1: 0, m5: 0, h1: 0 };
    expect(timeframeFail(tf, { maxLastCandlePct: z, maxRun3Pct: z, maxLastDropPct: z })).toBeNull();
    expect(timeframeFail(tf, { maxLastCandlePct: { ...z, s30: 8 }, maxRun3Pct: z, maxLastDropPct: z })).toMatch(/30 s candle \+/);
  });
});

describe('chart strategies on more timeframes', () => {
  it('lab ids cover every strategy per timeframe', () => {
    const ids = labIds({ disabled: [], timeframes: ['15s', '5s', '1m'] });
    expect(ids).toHaveLength(TA_STRATEGIES.length * 3);
    expect(ids.filter((i) => i.endsWith('@1m'))).toHaveLength(TA_STRATEGIES.length);
    expect(labIds({ disabled: [TA_STRATEGIES[0]!.id], timeframes: ['15s'] })).toHaveLength(TA_STRATEGIES.length - 1);
    expect(splitTaId('x@5s')).toEqual({ base: 'x', suffix: '@5s' });
    expect(taName(`${TA_STRATEGIES[0]!.id}@1m`)).toMatch(/\(1 min\)$/);
  });
  it('runs on trade-built candles and keeps the timeframe in the id', () => {
    const trades = Array.from({ length: 400 }, (_, i) => tr(i * 3, 1 + Math.sin(i / 9) * 0.2 + i * 0.001, i % 3 !== 0));
    const now = T0 + 1201_000;
    const ids = TA_STRATEGIES.flatMap((s) => [s.id, `${s.id}@5s`, `${s.id}@1m`]);
    const sigs = runStrategiesTf([], trades, trades[trades.length - 1]!.px, now, 1200, ids);
    expect(sigs.every((s) => ids.includes(s.id))).toBe(true);
  });
});
