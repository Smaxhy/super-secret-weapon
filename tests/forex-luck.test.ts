import { describe, expect, it } from 'vitest';
import { LUCK, luckDowngrade, luckFor, percentile, pickDelta, retime, seeded, splitStats, twinSignals, twinWindow, weeksOfBars } from '../src/forex/luck';
import { signalsFor, simulate, WARMUP } from '../src/forex/engine';
import { applyExit, type ExitKind } from '../src/forex/exits';
import { allowFor, type FilterEnv, type FilterKind } from '../src/forex/filters';
import { statsOf, verdictFor, type Series } from '../src/forex/lab';
import { strategyById, styleOf, type Strategy } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Instrument, type Signal, type Trade } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6);
const MARKETS = INSTRUMENTS.filter((x) => ['EURUSD', 'GBPUSD', 'AUDUSD'].includes(x.id));

/** contiguous hourly random walk (Park–Miller), with optional extra drift per bar */
function walk(n: number, seed: number, start = 1.1, drift?: (i: number) => number): Bar[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let px = start;
  return Array.from({ length: n }, (_, i) => {
    const o = px;
    const c = o * (1 + (rnd() - 0.5) * 0.0012 + (drift ? drift(i) : 0));
    px = c;
    return { t: T0 + i * H, o, h: Math.max(o, c) * (1 + rnd() * 0.0004), l: Math.min(o, c) * (1 - rnd() * 0.0004), c };
  });
}

/** a random walk with planted moves: at irregular "setup" bars price drifts 8 bars one way; the marks say which way */
function planted(n: number, seed: number): { bars: Bar[]; marks: Map<number, 1 | -1> } {
  let s = seed + 99;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const marks = new Map<number, 1 | -1>();
  const driftAt = new Float64Array(n);
  for (let i = 250; i < n - 10; i += 30 + Math.floor(rnd() * 40)) {
    const side: 1 | -1 = rnd() < 0.5 ? 1 : -1;
    marks.set(T0 + i * H, side);
    for (let k = 1; k <= 8; k++) driftAt[i + k] = side * 0.0006;
  }
  return { bars: walk(n, seed, 1.1, (i) => driftAt[i]!), marks };
}

function seriesOf(inst: Instrument, bars: Bar[]): Series {
  const ctx = buildCtx(bars, 60, inst.id);
  const n = bars.length;
  const env: FilterEnv = { tf: '1h', gap: new Float64Array(n).fill(NaN), h4: new Int8Array(n), d1: new Int8Array(n), mood: new Float64Array(n).fill(NaN), riskLong: 0, er: Float64Array.from(ctx.er20) };
  return { inst, tf: '1h', ctx, env };
}

/** the row's trades exactly as evaluateTf builds them */
function rowTrades(s: Strategy, series: readonly Series[], filter: FilterKind, exit: ExitKind): Trade[] {
  const out: Trade[] = [];
  for (const se of series) {
    const sigs = signalsFor(se.ctx, s).map((sg, i) => applyExit(sg, exit, se.ctx, i));
    out.push(...simulate(se.inst, se.tf, se.ctx, s.id, sigs, allowFor(filter, se.env, styleOf(s))));
  }
  return out;
}
const oosOf = (series: readonly Series[]) => {
  const from = Math.min(...series.map((s) => s.ctx.bars[0]!.t));
  const to = Math.max(...series.map((s) => s.ctx.bars[s.ctx.bars.length - 1]!.t));
  return from + 0.7 * (to - from);
};

function plantedStrategy(marks: Map<string, Map<number, 1 | -1>>): Strategy {
  return {
    id: 'planted',
    name: 'Planted edge',
    family: 'trend',
    desc: 'test: knows where the planted moves start',
    signal(c, i) {
      const side = marks.get(c.pair)?.get(c.bars[i]!.t);
      const a = c.atr14[i]!;
      if (!side || !(a > 0)) return null;
      const px = c.close[i]!;
      return { side, stop: px - side * 1.5 * a, target: px + side * 3 * a };
    },
  };
}

describe('luck meter: retime', () => {
  const c = buildCtx(walk(800, 3), 60, 'EURUSD');
  const i = 300;
  const j = 650;
  it('keeps the ATR distances, the side and every other field', () => {
    for (const side of [1, -1] as const) {
      const sig: Signal = { side, stop: c.close[i]! - side * 1.5 * c.atr14[i]!, target: c.close[i]! + side * 3 * c.atr14[i]!, trailR: 1, tpTrail: 1.5, tpFrac: 0, maxBars: 10, beAtR: 1, exitWhen: 'ema20' };
      const r = retime(sig, c, i, j)!;
      expect(r.side).toBe(side);
      expect(((c.close[j]! - r.stop) * side) / c.atr14[j]!).toBeCloseTo(1.5, 9);
      expect(((r.target! - c.close[j]!) * side) / c.atr14[j]!).toBeCloseTo(3, 9);
      expect({ ...r, stop: 0, target: 0 }).toEqual({ ...sig, stop: 0, target: 0 });
      const same = retime(sig, c, i, i)!;
      expect(same.stop).toBeCloseTo(sig.stop, 12);
      expect(same.target!).toBeCloseTo(sig.target!, 12);
    }
    const noTarget = retime({ side: 1, stop: c.close[i]! - c.atr14[i]!, target: null, trailAtr: 2.5 }, c, i, j)!;
    expect(noTarget.target).toBeNull();
    expect(noTarget.trailAtr).toBe(2.5);
  });
  it('null on a bad ATR or a stop on the wrong side', () => {
    const sig: Signal = { side: 1, stop: c.close[i]! - c.atr14[i]!, target: null };
    for (const bad of [NaN, 0, -1, Infinity]) {
      const atr14 = [...c.atr14];
      atr14[j] = bad;
      expect(retime(sig, { ...c, atr14 }, i, j)).toBeNull();
      const atrI = [...c.atr14];
      atrI[i] = bad;
      expect(retime(sig, { ...c, atr14: atrI }, i, j)).toBeNull();
    }
    expect(retime({ side: 1, stop: c.close[i]! + c.atr14[i]!, target: null }, c, i, j)).toBeNull();
    expect(retime({ side: -1, stop: c.close[i]! - c.atr14[i]!, target: null }, c, i, j)).toBeNull();
  });
});

describe('luck meter: twin signals', () => {
  const bars = walk(1_000, 5);
  const c = buildCtx(bars, 60, 'EURUSD');
  const n = bars.length;
  const { lo, hi, span } = twinWindow(n);
  const mk = (side: 1 | -1, i: number): Signal => ({ side, stop: c.close[i]! - side * c.atr14[i]!, target: null });
  const at = [lo, lo + 5, 400, 700, hi - 3, hi];
  const sigs: Array<Signal | null> = new Array(n).fill(null);
  at.forEach((i, k) => (sigs[i] = mk(k % 2 ? -1 : 1, i)));
  sigs[n - 1] = mk(1, n - 1); // the last bar: never moved, never a twin

  it('keeps the count, moves each by delta with wrap-around, never outside [WARMUP, n − 2]', () => {
    expect(lo).toBe(WARMUP);
    expect(hi).toBe(n - 2);
    for (const delta of [1, 37, 100, span - 1, span + 12, -25]) {
      const tw = twinSignals(sigs, c, delta);
      const idx = tw.map((x, k) => (x ? k : -1)).filter((k) => k >= 0);
      expect(idx).toHaveLength(at.length);
      for (const k of idx) {
        expect(k).toBeGreaterThanOrEqual(WARMUP);
        expect(k).toBeLessThanOrEqual(n - 2);
      }
      const d = ((delta % span) + span) % span;
      at.forEach((i, k) => {
        const j = lo + ((i - lo + d) % span);
        expect(tw[j]?.side).toBe(k % 2 ? -1 : 1);
        expect(((c.close[j]! - tw[j]!.stop) * tw[j]!.side) / c.atr14[j]!).toBeCloseTo(1, 9);
      });
    }
    // delta 0 = the same bars
    expect(twinSignals(sigs, c, 0).map((x, k) => (x ? k : -1)).filter((k) => k >= 0)).toEqual(at);
    // a series too short to shift → nothing
    expect(twinSignals(sigs.slice(0, WARMUP + 1), { ...c, bars: bars.slice(0, WARMUP + 1) }, 5).every((x) => x === null)).toBe(true);
  });

  it('the shift is never a whole number of days, always at least 2 weeks either way', () => {
    for (const barMin of [1, 15, 60, 240]) {
      const perDay = 1440 / barMin;
      const minShift = 2 * 7 * perDay;
      const sp = minShift * 5 + 17;
      for (let seed = 1; seed <= 300; seed++) {
        const d = pickDelta(seeded(seed), sp, barMin, minShift)!;
        expect(d % perDay).not.toBe(0);
        expect(d).toBeGreaterThanOrEqual(minShift);
        expect(d).toBeLessThanOrEqual(sp - minShift);
      }
      expect(pickDelta(seeded(1), 2 * minShift - 1, barMin, minShift)).toBeNull();
    }
    // a draw that keeps landing on whole days → the nearest other bar; a range of whole days only → null
    expect(pickDelta(() => 0, 50, 60, 24)).toBe(25);
    expect(pickDelta(() => 0, 48, 60, 24)).toBeNull();
    // 2 weeks measured from the series' own times (contiguous hourly bars → 336)
    expect(weeksOfBars(c, 2)).toBe(336);
  });

  it('percentile interpolates; split matches the lab', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1, 9);
    expect(percentile([], 90)).toBeNaN();
    const s = strategyById('donchian20')!;
    const se = seriesOf(MARKETS[0]!, bars);
    const ts = rowTrades(s, [se], 'none', 'designed');
    expect(splitStats(ts, oosOf([se]))).toEqual(statsOf(ts, oosOf([se])));
  });
});

describe('luck meter: luckDowngrade', () => {
  const twins = Array.from({ length: 20 }, (_, k) => (k - 10) / 100); // −0.10 … +0.09
  const luck = { twins, twinsP90: Math.round(percentile(twins, 90) * 1000) / 1000 };
  it('keeps a row above the twins, downgrades one that random timing matches, leaves no-data alone', () => {
    expect(luckDowngrade('edge', 0.2, luck)).toEqual({ verdict: 'edge', why: null });
    const d = luckDowngrade('maybe', 0.06, luck);
    expect(d.verdict).toBe('no');
    expect(d.why).toMatch(/^random timing with the same exits did as well in 4 of 20 tries/);
    expect(luckDowngrade('edge', 0.06, null)).toEqual({ verdict: 'edge', why: null });
    expect(luckDowngrade('no', 0.5, luck)).toEqual({ verdict: 'no', why: null });
    expect(luckDowngrade('edge', NaN, luck).verdict).toBe('edge');
  });
});

describe('luck meter: real edge vs luck', () => {
  it('a strategy with a built-in edge beats its twins; random entries on a random walk do not', async () => {
    const marks = new Map<string, Map<number, 1 | -1>>();
    const edgeSeries = MARKETS.map((inst, k) => {
      const p = planted(3_000, 41 + k * 7);
      marks.set(inst.id, p.marks);
      return seriesOf(inst, p.bars);
    });
    const ps = plantedStrategy(marks);
    const oos = oosOf(edgeSeries);
    const real = statsOf(rowTrades(ps, edgeSeries, 'none', 'designed'), oos);
    const v = verdictFor(real, null);
    expect(v.verdict).toBe('edge');
    const luck = (await luckFor(ps, edgeSeries, { filter: 'none', exit: 'designed', oosFrom: oos, realOutAvgR: real.outSample.avgR, randomAvgR: null, verdict: verdictFor }))!;
    expect(luck.twins).toHaveLength(LUCK.twins);
    expect(luck.pctl).toBe(100);
    expect(real.outSample.avgR).toBeGreaterThan(luck.twinsP90 + 0.5);
    expect(luck.twinPassPct).toBeLessThanOrEqual(10);
    expect(luckDowngrade(v.verdict, real.outSample.avgR, luck)).toEqual({ verdict: 'edge', why: null });

    // random entries on plain random walks: the real row is just one more draw from the twins' world
    const rs = strategyById('random')!;
    let downgraded = 0;
    const pctls: number[] = [];
    for (let w = 0; w < 4; w++) {
      const rw = MARKETS.map((inst, k) => seriesOf(inst, walk(3_000, 1_000 + w * 31 + k * 7)));
      const o2 = oosOf(rw);
      const r2 = statsOf(rowTrades(rs, rw, 'none', 'designed'), o2);
      const l2 = (await luckFor(rs, rw, { filter: 'none', exit: 'designed', oosFrom: o2, realOutAvgR: r2.outSample.avgR, randomAvgR: null, verdict: verdictFor }))!;
      pctls.push(l2.pctl);
      // even had the lab rated it edge, the luck meter takes it back
      if (luckDowngrade('edge', r2.outSample.avgR, l2).verdict === 'no') downgraded++;
    }
    expect(downgraded).toBeGreaterThanOrEqual(3);
    expect(Math.max(...pctls)).toBeLessThan(100);
  }, 60_000);

  it('same seed → same twins; another seed → other twins; filter + exit variants run', async () => {
    const s = strategyById('donchian20')!;
    const se = MARKETS.map((inst, k) => seriesOf(inst, walk(2_000, 77 + k)));
    const o = { filter: 'regime' as FilterKind, exit: 'trail_sl' as ExitKind, oosFrom: oosOf(se), realOutAvgR: 0.1, randomAvgR: 0, verdict: verdictFor };
    const a = await luckFor(s, se, o);
    const b = await luckFor(s, se, o);
    const c = await luckFor(s, se, { ...o, seed: 8 });
    expect(a).toEqual(b);
    expect(c!.deltas).not.toEqual(a!.deltas);
    for (const d of a!.deltas) expect(d % 24).not.toBe(0);
    expect(new Set(a!.deltas).size).toBeGreaterThan(15);
    expect(a!.twinN.some((x) => x > 0)).toBe(true);
    // too short to shift two weeks both ways → no luck data
    const short = MARKETS.map((inst) => seriesOf(inst, walk(WARMUP + 500, 3)));
    expect(await luckFor(s, short, { ...o, oosFrom: oosOf(short) })).toBeNull();
  }, 60_000);

  it('runtime: 1 strategy × 3 markets × 3,000 bars × 20 twins stays modest', async () => {
    const s = strategyById('donchian20')!;
    const se = MARKETS.map((inst, k) => seriesOf(inst, walk(3_000, 500 + k)));
    const t0 = performance.now();
    const l = await luckFor(s, se, { filter: 'regime', exit: 'trail_sl', oosFrom: oosOf(se), realOutAvgR: 0, randomAvgR: null, verdict: verdictFor });
    const ms = performance.now() - t0;
    console.log(`luck meter: 1 strategy × 3 markets × 3,000 bars × ${LUCK.twins} twins = ${Math.round(ms)} ms`);
    expect(l!.twins).toHaveLength(LUCK.twins);
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});
