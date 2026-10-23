import { describe, expect, it } from 'vitest';
import { machineVerdict, plateauOf, poolMachines, prepNotes, scaleSignal, studyRow, timeMachine, weekForecast } from '../src/forex/prep';
import { type FilterEnv } from '../src/forex/filters';
import { type Series } from '../src/forex/lab';
import { type Strategy } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Instrument, type Trade } from '../src/forex/types';

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


const oosOf = (series: readonly Series[]) => {
  const from = Math.min(...series.map((s) => s.ctx.bars[0]!.t));
  const to = Math.max(...series.map((s) => s.ctx.bars[s.ctx.bars.length - 1]!.t));
  return { oos: from + 0.7 * (to - from), to };
};

describe('v27.33 weekend prep', () => {
  it('scales a signal around its close and refuses a stop on the wrong side', () => {
    const s = scaleSignal({ side: 1, stop: 0.99, target: 1.03 }, 1, 1.25, 0.75)!;
    expect(s.stop).toBeCloseTo(0.9875, 6);
    expect(s.target).toBeCloseTo(1.0225, 6);
    expect(scaleSignal({ side: -1, stop: 1.01, target: null }, 1, 0.5, 2)!.target).toBeNull();
    expect(scaleSignal({ side: 1, stop: 0.99, target: 1.03 }, 1, -1, 1)).toBeNull();
    expect(scaleSignal(null, 1, 1, 1)).toBeNull();
  });

  it('plateau: neighbours with enough trades decide; under half positive = fragile', () => {
    const g = (vals: number[]) => [0.75, 1, 1.25].flatMap((ms, a) => [0.75, 1, 1.25].map((mt, b) => ({ ms, mt, n: 40, avgR: vals[a * 3 + b]! })));
    expect(plateauOf(g([0.1, 0.2, 0.1, 0.1, 0.3, 0.2, 0.05, 0.1, -0.1]))).toMatchObject({ share: 0.875, fragile: false, worstAvgR: -0.1 });
    expect(plateauOf(g([-0.1, -0.2, -0.1, -0.1, 0.5, -0.2, -0.05, 0.1, -0.1])).fragile).toBe(true);
    expect(plateauOf(g([0, 0, 0, 0, 0, 0, 0, 0, 0]).map((c) => ({ ...c, n: 3 }))).share).toBeNull();
  });

  it('the skill\'s verdict weighs the target R (break-even 1 / (1 + R))', () => {
    expect(machineVerdict(536, 464, 1)).toMatch(/^Close to a coin flip/);
    expect(machineVerdict(241, 505, 2)).toMatch(/^Close to break-even/);
    expect(machineVerdict(700, 300, 1)).toMatch(/^Strongly toward the target/);
    expect(machineVerdict(400, 600, 1)).toMatch(/^Leans toward the stop/);
    expect(machineVerdict(0, 0, 1)).toMatch(/too few/);
    expect(machineVerdict(10, 5, 1)).toMatch(/too few/);
    expect(machineVerdict(60, 40, 1, 400)).toMatch(/75% of replays hit neither/);
  });

  it('time machine on a random walk: a 1R stop / target is a coin flip and replays ≈ 0R; a planted edge shows as timing', () => {
    const bars = walk(3000, 7);
    const trades: Trade[] = [];
    for (let i = 2000; i < 2900; i += 15) {
      const e = bars[i]!.o;
      trades.push({ strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1, entryT: bars[i]!.t, exitT: bars[i + 5]!.t, entry: e, exit: e, r: 0.5, stopPct: 0.3, reason: 'target', bars: 40, stop: e * 0.997, stop0: e * 0.997, target: e * 1.003 });
    }
    const m = timeMachine(bars, trades, 60, bars[1000]!.t, bars[2999]!.t)!;
    expect(m.trades).toBe(trades.length);
    expect(m.replays).toBe(trades.length * 10);
    expect(Math.abs(m.replayAvgR)).toBeLessThan(0.3);
    expect(m.targetR).toBeCloseTo(1, 6);
    expect(m.edgeR).toBeGreaterThan(0.2);
    expect(m.verdict).toMatch(/target first/);
    // the same trades as shorts on the same draws: target and stop swap exactly (the replays keep the period's drift)
    const sh = timeMachine(bars, trades.map((t) => ({ ...t, side: -1 as const, stop0: t.entry * 1.003, target: t.entry * 0.997 })), 60, bars[1000]!.t, bars[2999]!.t)!;
    expect(sh.targetFirst).toBe(m.stopFirst);
    expect(sh.stopFirst).toBe(m.targetFirst);
    expect(sh.replayAvgR).toBeCloseTo(-m.replayAvgR, 2);
    // same seed → same numbers
    expect(timeMachine(bars, trades, 60, bars[1000]!.t, bars[2999]!.t)).toEqual(m);
    // nothing in the pool → null
    expect(timeMachine(bars, trades, 60, bars[2999]!.t + 1, bars[2999]!.t + 2)).toBeNull();
    expect(poolMachines([m, m])).toMatchObject({ trades: m.trades * 2, edgeR: m.edgeR });
  });

  it('next-week forecast: deterministic, more trades → wider; a losing set has few green weeks', () => {
    const win = { perWeek: 3, rs: [1.5, -1, 2, -1, 1] };
    const f = weekForecast([win], 20)!;
    expect(f).toEqual(weekForecast([win], 20));
    expect(f.tradesPerWeek).toBe(3);
    expect(f.pGreen).toBeGreaterThan(0.55);
    expect(f.p5Pct).toBeLessThan(0);
    expect(f.medianPct).toBeCloseTo(f.medianR * 20, 0);
    expect(weekForecast([{ perWeek: 3, rs: [-1, -1, 0.5] }], 1)!.pGreen).toBeLessThan(0.3);
    expect(weekForecast([], 1)).toBeNull();
  });

  it('studyRow: a planted edge holds up on its plateau and its timing beats random paths; notes say so', async () => {
    const marks = new Map<string, Map<number, 1 | -1>>();
    const series = MARKETS.map((inst, k) => {
      const p = planted(2600, 11 + k);
      marks.set(inst.id, p.marks);
      return seriesOf(inst, p.bars);
    });
    const s = plantedStrategy(marks);
    const { oos, to } = oosOf(series);
    const row = await studyRow({ s, key: 'planted:1h', name: 'Planted 1h', tf: '1h', filter: 'none', exit: 'designed', kind: 'live', pairs: [] }, series, oos, to);
    expect(row.plateau.cells).toHaveLength(9);
    expect(row.unseenN).toBeGreaterThan(10);
    expect(row.plateau.share).not.toBeNull();
    expect(row.plateau.fragile).toBe(false);
    expect(row.machine!.edgeR).toBeGreaterThan(0);
    expect(row.unseenRs).toHaveLength(row.unseenN);
    const notes = prepNotes([row], weekForecast([{ perWeek: row.perWeek, rs: row.unseenRs! }], 20));
    expect(notes.join(' ')).toMatch(/Planted 1h holds up/);
    expect(notes.join(' ')).toMatch(/timing adds \+/);
    expect(notes.join(' ')).toMatch(/Next week, if it trades like the unseen data/);
  });
});
