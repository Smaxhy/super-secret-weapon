import { describe, expect, it } from 'vitest';
import {
  buildPipeline,
  encodeRow,
  FittedWinModel,
  pipelineDim,
  refitPipelineStats,
  stratifiedAuc,
  timeSplit,
  trainWinModel,
  weightedAuc,
  WinModel,
  type LearnRow,
} from '../src/learner/win-model';

/** Deterministic random numbers (LCG) so the tests never flake. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

const T0 = 1_760_000_000_000;
const STRATS = ['CURVE_SNIPE', 'MIGRATION_MOMENTUM', 'RUNNER'];

/** n rows; `signal(i, x)` = the true log-odds shift from feature crowd.buyRatio2m (x). */
function makeRows(n: number, seed: number, signal: (i: number, x: number) => number): LearnRow[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const x = gauss(r);
    const flat: Record<string, number> = {
      'crowd.buyRatio2m': 1.5 + x * 0.4,
      'entry.score': 70 + gauss(r) * 6, // the existing score: pure noise here
      'shape.run3m': gauss(r) * 20,
      'entry.hourUtc': Math.floor(r() * 24),
    };
    if (r() < 0.6) flat['market.marketCapUsd'] = 20_000 + r() * 50_000; // often missing
    const p = 1 / (1 + Math.exp(-(-0.5 + signal(i, x))));
    const win = r() < p;
    return {
      flat,
      strategy: STRATS[i % 3]!,
      atMs: T0 + i * 60_000,
      pnlPct: win ? 10 + r() * 80 : -(5 + r() * 15),
      peakX: win ? 1.4 : 1.02,
      weight: r() < 0.3 ? 0.5 : 1,
      source: r() < 0.3 ? 'shadow' : 'real',
    } satisfies LearnRow;
  });
}

describe('win model: self-validating win probability', () => {
  it('weighted AUC basics', () => {
    expect(weightedAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(weightedAuc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(weightedAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    expect(weightedAuc([1, 2, 3], [1, 1, 1])).toBe(0.5); // no losers → undefined → 0.5
  });

  it('learns a feature that truly predicts wins, beats the score, and gives good rows more points', async () => {
    const rows = makeRows(1200, 7, (_i, x) => 1.4 * x);
    const t = Date.now();
    const m = await trainWinModel(rows, T0);
    const r = m.json.report;
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.active).toBe(true);
    expect(r.reason).toBe('passed the exam');
    expect(r.valAuc).toBeGreaterThan(0.65);
    expect(r.valAuc).toBeGreaterThan(r.baselineAuc + 0.02);
    expect(r.valLogLoss).toBeLessThan(r.valBaseLogLoss);
    expect(r.calibration.length).toBe(5);
    const top = m.explain()[0]!;
    expect(top.feature).toBe('crowd.buyRatio2m');
    expect(top.effect).toBeGreaterThan(0);
    expect(top.text).toBe('higher crowd.buyRatio2m → more wins');

    const good = m.predict({ 'crowd.buyRatio2m': 2.3, 'entry.score': 70 }, 'CURVE_SNIPE');
    const bad = m.predict({ 'crowd.buyRatio2m': 0.8, 'entry.score': 70 }, 'CURVE_SNIPE');
    expect(good.p).toBeGreaterThan(bad.p);
    expect(good.points).toBeGreaterThan(0);
    expect(bad.points).toBeLessThan(0);
    expect(good.points).toBeLessThanOrEqual(10);
    expect(bad.points).toBeGreaterThanOrEqual(-10);
  });

  it('pure noise never becomes active (0 points)', async () => {
    for (const seed of [1, 2, 3]) {
      const m = await trainWinModel(makeRows(800, seed, () => 0), T0);
      expect(m.json.report.active).toBe(false);
      expect(m.predict({ 'crowd.buyRatio2m': 3 }, 'RUNNER').points).toBe(0);
    }
  });

  it('too little data is never active', async () => {
    const m = await trainWinModel(makeRows(60, 9, (_i, x) => 2 * x), T0);
    expect(m.active).toBe(false);
    expect(m.json.report.reason).toMatch(/effective rows .*60 rows/);
  });

  it('a relationship that flips over time fails the time-ordered exam', async () => {
    // Old 75%: high buy ratio wins. Newest 25%: it loses. A shuffled split would mix both and could pass.
    const n = 1000;
    const m = await trainWinModel(makeRows(n, 11, (i, x) => (i < n * 0.75 ? 1.5 * x : -1.5 * x)), T0);
    expect(m.json.report.active).toBe(false);
    expect(m.json.report.valAuc).toBeLessThan(0.5);
  });

  it('time order: the split is by time, not by input order', () => {
    const rows = makeRows(100, 3, () => 0).reverse();
    const { train, val } = timeSplit(rows, 0.75);
    expect(train.length).toBe(75);
    const lastTrain = Math.max(...train.map((r) => r.atMs));
    expect(Math.min(...val.map((r) => r.atMs))).toBeGreaterThan(lastTrain);
  });

  it('leakage guard: scaling stats come from the training split only', () => {
    const rows = makeRows(400, 5, () => 0);
    // The newest quarter has a wildly different market cap level.
    rows.forEach((r, i) => {
      r.flat['market.marketCapUsd'] = i < 300 ? 10_000 + (i % 10) * 1000 : 5_000_000;
    });
    const { train } = timeSplit(rows, 0.75);
    const p = buildPipeline(train);
    const mc = p.features.find((f) => f.name === 'market.marketCapUsd')!;
    expect(mc.median).toBeLessThan(20_000);
    const all = buildPipeline(rows).features.find((f) => f.name === 'market.marketCapUsd')!;
    expect(all.median).toBeGreaterThan(mc.median); // proves the split matters
  });

  it('pipeline: presence threshold, missing flags, strategy intercepts', () => {
    const rows = makeRows(300, 4, (_i, x) => x);
    rows.forEach((r, i) => {
      if (i % 10 === 0) r.flat['rare.feature'] = 1 + (i % 7); // 10% presence → dropped
    });
    const p = buildPipeline(rows);
    expect(p.features.some((f) => f.name === 'rare.feature')).toBe(false);
    expect(p.missingFlags).toContain('market.marketCapUsd');
    expect(p.missingFlags).not.toContain('crowd.buyRatio2m'); // never missing → no flag
    expect(p.strategies).toEqual([...STRATS].sort());
  });

  it('JSON round trip predicts the same, and predict() is fast', async () => {
    const m = await trainWinModel(makeRows(900, 21, (_i, x) => 1.3 * x), T0);
    const back = FittedWinModel.fromJSON(JSON.stringify(m.toJSON()));
    const flat = { 'crowd.buyRatio2m': 2, 'shape.run3m': 5, 'entry.score': 72 };
    expect(back.predict(flat, 'RUNNER')).toEqual(m.predict(flat, 'RUNNER'));
    expect(back.active).toBe(m.active);
    const t = performance.now();
    for (let i = 0; i < 20_000; i++) m.predict(flat, 'RUNNER');
    expect((performance.now() - t) / 20_000).toBeLessThan(0.05);
    expect(() => FittedWinModel.fromJSON({ ...m.toJSON(), beta: [1] })).toThrow();
  });

  it('5,000 rows train in < 2 s', async () => {
    const rows = makeRows(5000, 31, (_i, x) => x);
    // Add a lot of features to approach the 60-feature cap.
    const r = rng(99);
    for (const row of rows) for (let k = 0; k < 70; k++) row.flat[`f.x${k}`] = gauss(r);
    const t = Date.now();
    const m = await trainWinModel(rows, T0);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(m.json.pipeline.features.length).toBe(60);
  });

  it('WinModel class: trains, stores in Redis, restores', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return 'OK' as const;
      },
    };
    const rows = makeRows(900, 41, (_i, x) => 1.4 * x);
    const wm = new WinModel(redis as never, async () => rows);
    expect(wm.predict({}, 'RUNNER').points).toBe(0);
    const st = await wm.train(T0);
    expect(st?.active).toBe(true);
    expect(store.has('model:win')).toBe(true);
    const wm2 = new WinModel(redis as never, async () => []);
    await wm2.restore();
    const flat = { 'crowd.buyRatio2m': 2.4 };
    expect(wm2.predict(flat, 'RUNNER')).toEqual(wm.predict(flat, 'RUNNER'));
    expect(wm2.snapshot()?.explain.length).toBeGreaterThan(0);
  });

  // ---- regression tests for the review fixes ----

  it('weighted AUC never hangs on NaN / Infinity scores (non-finite rows are ignored)', () => {
    expect(weightedAuc([NaN, 0.1, NaN, 0.9], [1, 0, 0, 1])).toBe(1);
    expect(weightedAuc([NaN, NaN, NaN], [0, 1, 0])).toBe(0.5);
    expect(weightedAuc([Infinity, 0.2, -Infinity, 0.8], [1, 0, 0, 1])).toBe(1);
    expect(weightedAuc([0.2, 0.8], [0, 1], [NaN, 1])).toBe(0.5); // a bad weight drops the row
  });

  it('stratified AUC ignores ranking across strategies', () => {
    // Within each strategy the score is pure noise (AUC 0.5) but strategy B both scores and wins higher.
    const scores = [0.1, 0.1, 0.9, 0.9];
    const labels = [0, 1, 0, 1];
    const w = [1, 1, 1, 1];
    expect(stratifiedAuc(scores, labels, w, ['A', 'A', 'B', 'B']).auc).toBe(0.5);
    const scores2 = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const labels2 = [0, 0, 0, 1, 1, 1];
    // A: [0,0] (one class, skipped), B: [0,1] perfect, C: [1,1] skipped.
    const r = stratifiedAuc(scores2, labels2, [1, 1, 1, 1, 1, 1], ['A', 'A', 'B', 'B', 'C', 'C']);
    expect(r).toEqual({ auc: 1, groups: 1 });
    // Weighted by each strategy's exam weight: X perfect (weight 3), Y inverted (weight 1) → 0.75.
    const r3 = stratifiedAuc([1, 2, 2, 1], [0, 1, 0, 1], [1.5, 1.5, 0.5, 0.5], ['X', 'X', 'Y', 'Y']);
    expect(r3.auc).toBeCloseTo(0.75, 9);
  });

  it('strategy base rates alone (pooled AUC high) never pass the exam', async () => {
    const r = rng(77);
    const base: Record<string, number> = { CURVE_SNIPE: 0.1, MIGRATION_MOMENTUM: 0.5, RUNNER: 0.9 };
    const rows: LearnRow[] = Array.from({ length: 1500 }, (_, i) => {
      const strategy = STRATS[i % 3]!;
      const win = r() < base[strategy]!;
      return {
        flat: { 'crowd.buyRatio2m': 1.5 + gauss(r) * 0.4, 'entry.score': 70 + gauss(r) * 6, 'shape.run3m': gauss(r) * 20 },
        strategy,
        atMs: T0 + i * 60_000,
        pnlPct: win ? 20 : -10,
        peakX: 1,
        weight: 1,
        source: 'real',
      };
    });
    const m = await trainWinModel(rows, T0);
    const rep = m.json.report;
    expect(rep.valAucPooled).toBeGreaterThan(0.7); // the old pooled exam would have passed
    expect(rep.valAuc).toBeLessThan(0.58);
    expect(rep.valStrata).toBe(3);
    expect(rep.active).toBe(false);
  });

  it('λ is chosen without looking at the exam (exam labels cannot change it)', async () => {
    const a = makeRows(800, 51, (_i, x) => 1.2 * x);
    const b = a.map((r, i) => (i >= 600 ? { ...r, pnlPct: -r.pnlPct } : r)); // flip every exam label
    const ma = await trainWinModel(a, T0, { l2Grid: [0.001, 1, 1000] });
    const mb = await trainWinModel(b, T0, { l2Grid: [0.001, 1, 1000] });
    expect(ma.json.report.l2).toBe(mb.json.report.l2);
    expect(ma.json.report.nTrain).toBe(600);
  });

  it('the live refit reuses the validated features (a feature only seen in the exam period is never added)', async () => {
    const rows = makeRows(1200, 7, (_i, x) => 1.4 * x);
    // Present only in the newest 30%: < 25% of the training rows, but 30% of all rows.
    rows.forEach((r, i) => {
      if (i >= 840) r.flat['late.only'] = (r.pnlPct > 3 ? 1 : -1) + gauss(rng(i)) * 0.1;
    });
    const m = await trainWinModel(rows, T0);
    expect(m.json.report.active).toBe(true);
    expect(buildPipeline(rows).features.some((f) => f.name === 'late.only')).toBe(true); // a fresh selection would take it
    expect(m.json.pipeline.features.some((f) => f.name === 'late.only')).toBe(false);
    const trainPipe = buildPipeline(timeSplit(rows, 0.75).train);
    expect(m.json.pipeline.features.map((f) => f.name)).toEqual(trainPipe.features.map((f) => f.name));
    expect(m.json.pipeline.missingFlags).toEqual(trainPipe.missingFlags);
    expect(m.json.pipeline.strategies).toEqual(trainPipe.strategies);
    // refitPipelineStats keeps the list and recomputes medians on the given rows.
    const re = refitPipelineStats(trainPipe, rows);
    expect(re.features.map((f) => f.name)).toEqual(trainPipe.features.map((f) => f.name));
  });

  it('row minimum and exam winners use effective (weighted) counts', async () => {
    const rows = makeRows(120, 61, (_i, x) => 2 * x).map((r) => ({ ...r, weight: 0.5 }));
    const m = await trainWinModel(rows, T0);
    const rep = m.json.report;
    expect(rep.nEffective).toBe(60);
    expect(rep.active).toBe(false);
    expect(rep.reason).toMatch(/only 60\.0 effective rows/);
    const { val } = timeSplit(rows, 0.75);
    expect(rep.valPositives).toBe(val.filter((r) => r.pnlPct > 3).length * 0.5);
  });

  it('few effective exam winners block activation even with many raw winners', async () => {
    const rows = makeRows(1200, 7, (_i, x) => 1.4 * x);
    rows.forEach((r, i) => {
      if (i >= 900) r.weight = 0.02; // exam rows count almost nothing
    });
    const m = await trainWinModel(rows, T0);
    expect(m.json.report.active).toBe(false);
    expect(m.json.report.reason).toMatch(/effective winners/);
  });

  it('encodeRow maps non-finite scaled values to 0; buildPipeline skips overflowing features', () => {
    const p = {
      features: [
        { name: 'a', median: 1, scale: 0, presence: 1, corr: 0 },
        { name: 'b', median: 0, scale: NaN, presence: 1, corr: 0 },
        { name: 'c', median: 0, scale: 2, presence: 1, corr: 0 },
      ],
      missingFlags: [],
      strategies: ['RUNNER'],
    };
    const out = new Float64Array(pipelineDim(p));
    encodeRow(p, { a: 1, b: 3, c: 4 }, 'RUNNER', out);
    expect(Array.from(out)).toEqual([1, 0, 0, 2, 1]);
    const rows = makeRows(200, 8, () => 0);
    rows.forEach((r, i) => {
      r.flat['huge'] = (i % 2 ? 1 : -1) * 1.5e308; // IQR overflows to Infinity
    });
    const pipe = buildPipeline(rows);
    expect(pipe.features.some((f) => f.name === 'huge')).toBe(false);
    for (const f of pipe.features) {
      expect(Number.isFinite(f.median)).toBe(true);
      expect(f.scale).toBeGreaterThan(0);
      expect(Number.isFinite(f.scale)).toBe(true);
      expect(Number.isFinite(f.corr)).toBe(true);
    }
  });

  it('compact columns give the same stats as a direct computation (many rows, sparse features)', () => {
    const rows = makeRows(500, 12, () => 0);
    rows.forEach((r, i) => {
      if (i % 3 === 0) r.flat['sparse.k'] = i; // present in 1/3 of the rows
      else delete r.flat['sparse.k'];
    });
    const f = buildPipeline(rows).features.find((x) => x.name === 'sparse.k')!;
    const vals = rows.filter((_r, i) => i % 3 === 0).map((_r, k) => k * 3);
    const mid = (vals.length - 1) / 2;
    expect(f.median).toBeCloseTo((vals[Math.floor(mid)]! + vals[Math.ceil(mid)]!) / 2, 9);
    expect(f.presence).toBeCloseTo(vals.length / 500, 9);
  });

  it('training only uses the newest maxTrainRows rows', async () => {
    const rows = makeRows(1000, 13, (_i, x) => x);
    const m = await trainWinModel(rows, T0, { maxTrainRows: 400 });
    expect(m.json.report.n).toBe(400);
    expect(m.json.report.nTrain + m.json.report.nVal).toBe(400);
  });

  it('training never blocks the event loop for long (5,000 rows x 150 features)', async () => {
    const rows = makeRows(5000, 33, (_i, x) => x);
    const r = rng(5);
    for (const row of rows) for (let k = 0; k < 146; k++) row.flat[`f.y${k}`] = gauss(r);
    let last = performance.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 10);
    try {
      last = performance.now();
      await trainWinModel(rows, T0);
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
    } finally {
      clearInterval(ticker);
    }
    expect(maxGap).toBeLessThan(150);
  }, 30_000);

  it('fromJSON rejects corrupt models; restore() then stays inactive', async () => {
    const m = await trainWinModel(makeRows(900, 21, (_i, x) => 1.3 * x), T0);
    const good = m.toJSON();
    const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
    expect(() => FittedWinModel.fromJSON(clone())).not.toThrow();
    const bad: Array<(j: ReturnType<typeof clone>) => void> = [
      (j) => delete (j as Partial<typeof j>).strategyBase,
      (j) => ((j as unknown as { strategyBase: unknown }).strategyBase = { RUNNER: 'x' }),
      (j) => delete (j as Partial<typeof j>).report,
      (j) => (j.pipeline.features[0]!.scale = 0),
      (j) => (j.pipeline.features[0]!.median = null as unknown as number),
      (j) => (j.beta[1] = null as unknown as number), // NaN after JSON
      (j) => ((j as unknown as { pipeline: unknown }).pipeline = null),
      (j) => (j.baseRate = 'x' as unknown as number),
    ];
    for (const f of bad) {
      const j = clone();
      f(j);
      expect(() => FittedWinModel.fromJSON(JSON.stringify(j))).toThrow(/bad win model json/);
    }
    const nanBeta = clone();
    nanBeta.beta[0] = NaN;
    expect(() => FittedWinModel.fromJSON(nanBeta)).toThrow();

    const corrupt = clone();
    corrupt.pipeline.features[0]!.scale = 0;
    const redis = { get: async () => JSON.stringify(corrupt), set: async () => 'OK' as const };
    const wm = new WinModel(redis as never, async () => []);
    await wm.restore();
    expect(wm.snapshot()).toBeNull();
    expect(wm.predict({ 'crowd.buyRatio2m': 3 }, 'RUNNER').points).toBe(0);
  });
});
