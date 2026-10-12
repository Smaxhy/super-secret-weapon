import { describe, expect, it } from 'vitest';
import { chooseFeatures, FittedTreeModel, trainTreeModel, treeValue } from '../src/learner/tree-model';
import { trainWinModel, type LearnRow } from '../src/learner/win-model';

function rand(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Wins when exactly one of (a high, b high) holds — an interaction no straight line can draw. */
function rows(n: number, seed = 1): LearnRow[] {
  const r = rand(seed);
  return Array.from({ length: n }, (_, i) => {
    const a = r();
    const b = r();
    const noise = r() < 0.1;
    const win = ((a > 0.5) !== (b > 0.5)) !== noise;
    const strategy = i % 3 === 0 ? 'SOON' : 'RUNNER';
    return { flat: { 'x.a': a, 'x.b': b, 'x.noise': r(), 'entry.score': 60 + r() * 20, ...(r() < 0.2 ? {} : { 'x.sometimes': r() }) }, strategy, atMs: 1_000_000 + i * 60_000, pnlPct: win ? 25 : -12, peakX: win ? 1.4 : 1, weight: 1, source: 'real' as const };
  });
}

describe('tree model (gradient-boosted trees)', () => {
  it('learns an interaction the logistic model cannot, passes the exam and beats the score', async () => {
    const data = rows(1200);
    const tree = await trainTreeModel(data, 0);
    expect(tree.json.report.active).toBe(true);
    expect(tree.json.report.valAuc).toBeGreaterThan(0.8);
    const lin = await trainWinModel(data, 0);
    expect(tree.json.report.valAuc).toBeGreaterThan(lin.json.report.valAuc + 0.05);
    // a / b carry the signal
    expect(tree.json.importance.slice(0, 2).map((x) => x.feature).sort()).toEqual(['x.a', 'x.b']);
    expect(tree.prob({ 'x.a': 0.9, 'x.b': 0.1 }, 'SOON')).toBeGreaterThan(tree.prob({ 'x.a': 0.9, 'x.b': 0.9 }, 'SOON') + 0.3);
    expect(tree.prob({ 'x.a': 0.1, 'x.b': 0.9 }, 'SOON')).toBeGreaterThan(tree.prob({ 'x.a': 0.1, 'x.b': 0.1 }, 'SOON') + 0.3);
    // JSON round trip predicts the same
    const back = FittedTreeModel.fromJSON(JSON.stringify(tree.json));
    expect(back.prob({ 'x.a': 0.7, 'x.b': 0.2 }, 'RUNNER')).toBeCloseTo(tree.prob({ 'x.a': 0.7, 'x.b': 0.2 }, 'RUNNER'), 12);
  });
  it('stays off on pure noise', async () => {
    const r = rand(9);
    const noise: LearnRow[] = Array.from({ length: 800 }, (_, i) => ({ flat: { 'x.a': r(), 'x.b': r(), 'entry.score': r() * 100 }, strategy: 'SOON', atMs: i * 1000, pnlPct: r() < 0.3 ? 20 : -10, peakX: 1, weight: 1, source: 'real' as const }));
    const m = await trainTreeModel(noise, 0);
    expect(m.json.report.active).toBe(false);
    expect(m.predict({ 'x.a': 0.5 }, 'SOON').points).toBe(0);
  });
  it('handles missing values and strategy flags', () => {
    expect(chooseFeatures(rows(50), { minPresence: 0.2, maxFeatures: 10 })).toContain('strategy=SOON');
    const nodes = [{ f: 0, cut: 1, miss: 1 as const, l: 1, r: 2, v: 0 }, { f: -1, cut: 0, miss: 0 as const, l: -1, r: -1, v: -1 }, { f: -1, cut: 0, miss: 0 as const, l: -1, r: -1, v: 1 }];
    expect(treeValue(nodes, () => 0.5)).toBe(-1);
    expect(treeValue(nodes, () => 2)).toBe(1);
    expect(treeValue(nodes, () => NaN)).toBe(1); // missing → right
  });
});
