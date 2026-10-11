import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../src/config/default';
import { adaptiveTrailingPct, decideExit, type ExitChart, type ExitInput } from '../src/executor/sell-manager';
import { convictionSize } from '../src/executor/trader';
import { BASE_PATTERN, combinePrior, type Belief } from '../src/learner/bayesian-updater';
import { adjustWeights, type OutcomeSample } from '../src/learner/daily-adjuster';
import { resolveOutcome } from '../src/learner/missed-opportunity';
import { classifyRegime, type RegimeStats } from '../src/learner/regime-detector';
import { decodeTape, encodeTape, mergeTapes } from '../src/learner/tape-archiver';

const rules = DEFAULT_CONFIG.exit;
const now = 10_000_000;
const base: ExitInput = {
  entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: now,
  staleMinutes: 30, priceSol: 1, complete: false, devHoldingPctEntry: 1, devHoldingPctNow: 1, top10PctEntry: 15, top10PctNow: 15, nowMs: now,
};
const calm: ExitChart = { strength: 0.5, buyVolShare60: 0.6, netFlowSol60: 2, change60Pct: 2, trendSlopePctPerMin: 2, recentSlopePctPerMin: 2, lastSwingLow: null, largestSellSol60: 0.5, trades60: 20, higherLows: 2 };
const reasons = (i: Partial<ExitInput>) => decideExit({ ...base, ...i }, rules).sells.map((s) => s.reason);

describe('exit rules — chart-aware', () => {
  it('break-even stop: after 1.5x, a fall back to entry + costs closes the trade', () => {
    expect(reasons({ peakPriceSol: 1.6, priceSol: 1.05 })).toEqual(['STOP_LOSS']);
    expect(reasons({ peakPriceSol: 1.4, priceSol: 1.05 })).toEqual([]);
  });
  it('structure break: a close below the last swing low after a 1.3x+ peak', () => {
    const chart = { ...calm, lastSwingLow: 1.25 };
    expect(reasons({ peakPriceSol: 1.45, priceSol: 1.2, chart })).toEqual(['STRUCTURE_BREAK']);
    expect(reasons({ peakPriceSol: 1.45, priceSol: 1.24, chart })).toEqual([]);
  });
  it('momentum fade sells half once, then not again', () => {
    const chart = { ...calm, buyVolShare60: 0.3, netFlowSol60: -3 };
    const d = decideExit({ ...base, peakPriceSol: 1.5, priceSol: 1.3, chart }, rules);
    expect(d.sells.map((s) => [s.reason, s.pct])).toEqual([['MOMENTUM_FADE', 50]]);
    expect(d.state.flags.fadeSold).toBe(true);
    expect(reasons({ peakPriceSol: 1.5, priceSol: 1.3, chart, flags: d.state.flags, remainingPct: 50 })).toEqual([]);
  });
  it('time stop cuts a dead trade but spares one that is recovering', () => {
    const late = { openedAtMs: now - 9 * 60_000, timeStopMinutes: 8, priceSol: 0.95 };
    expect(reasons({ ...late, chart: { ...calm, trendSlopePctPerMin: 0, buyVolShare60: 0.45 } })).toEqual(['TIME_STOP']);
    expect(reasons({ ...late, chart: { ...calm, trendSlopePctPerMin: 2, buyVolShare60: 0.7 } })).toEqual([]);
  });
  it('rug: sell avalanche and single whale sell', () => {
    expect(reasons({ priceSol: 0.8, chart: { ...calm, buyVolShare60: 0.2, change60Pct: -30 } })).toEqual(['RUG_DETECTED']);
    expect(reasons({ priceSol: 0.85, peakPriceSol: 1, liquiditySol: 20, chart: { ...calm, largestSellSol60: 4 } })).toEqual(['RUG_DETECTED']);
  });
  it('rug: a dev holding > 2% selling even a little is a rug signal', () => {
    expect(reasons({ devHoldingPctEntry: 4, devHoldingPctNow: 3.8 })).toEqual(['RUG_DETECTED']);
    expect(reasons({ devHoldingPctEntry: 1, devHoldingPctNow: 0.95 })).toEqual([]);
  });
  it('trailing distance widens with chart strength', () => {
    expect(adaptiveTrailingPct({ ...calm, strength: 0 }, rules)).toBe(rules.trailingStopPctWeak);
    expect(adaptiveTrailingPct({ ...calm, strength: 1 }, rules)).toBe(rules.trailingStopPctStrong);
    expect(adaptiveTrailingPct(null, rules)).toBe(rules.trailingStopPct);
  });
});

describe('conviction sizing', () => {
  const t = DEFAULT_CONFIG.trading;
  it('a bare pass gets the minimum, a top score with a strong chart gets the maximum', () => {
    expect(convictionSize({ score: 75, threshold: 75, strength: 0, regimeMultiplier: 1 }, t).sizeSol).toBeCloseTo(t.minPositionSol);
    expect(convictionSize({ score: 95, threshold: 75, strength: 1, regimeMultiplier: 1 }, t).sizeSol).toBeCloseTo(t.maxPositionSol);
  });
  it('the regime multiplier scales the result', () => {
    expect(convictionSize({ score: 95, threshold: 75, strength: 1, regimeMultiplier: 0.5 }, t).sizeSol).toBeCloseTo(t.maxPositionSol / 2);
  });
});

describe('regime classification', () => {
  const s: RegimeStats = { launches6h: 500, completed6h: 5, completionRate6h: 0.01, baselineCompletionRate: 0.01, recentTrades: 10, recentWinRate: 0.5, recentRugRate: 0.1, recentPnlSol: 0.1 };
  it('NORMAL by default, HOT when completions run hot', () => {
    expect(classifyRegime(s)).toBe('NORMAL');
    expect(classifyRegime({ ...s, completionRate6h: 0.02 })).toBe('HOT');
  });
  it('RUG_HEAVY when half our recent trades end as rugs or stops; COLD when losing', () => {
    expect(classifyRegime({ ...s, recentRugRate: 0.5 })).toBe('RUG_HEAVY');
    expect(classifyRegime({ ...s, recentWinRate: 0.2, recentPnlSol: -0.3 })).toBe('COLD');
    expect(classifyRegime({ ...s, completionRate6h: 0.004 })).toBe('COLD');
  });
});

describe('outcomes, beliefs and weight tuning', () => {
  it('resolves outcomes relative to the market cap at decision time', () => {
    expect(resolveOutcome({ mcAtEval: 50, peakMc: 120, mcNow: 60, complete: false }, 2, 0.4).outcome).toBe('PUMPED');
    expect(resolveOutcome({ mcAtEval: 50, peakMc: 60, mcNow: 15, complete: false }, 2, 0.4).outcome).toBe('DIED');
    expect(resolveOutcome({ mcAtEval: 50, peakMc: 60, mcNow: 45, complete: false }, 2, 0.4).outcome).toBe('FLAT');
    expect(resolveOutcome({ mcAtEval: 50, peakMc: 60, mcNow: 45, complete: true }, 2, 0.4).good).toBe(true);
  });
  it('pattern prior stays neutral until the evidence is there, then follows the lift', () => {
    const beliefs = new Map<string, Belief>([[BASE_PATTERN, { alpha: 20, beta: 80, observations: 100 }]]);
    expect(combinePrior(['all', 'setup:PULLBACK'], beliefs, 15)).toBe(0.5);
    beliefs.set('setup:PULLBACK', { alpha: 40, beta: 60, observations: 100 });
    expect(combinePrior(['all', 'setup:PULLBACK'], beliefs, 15)).toBeGreaterThan(0.8);
    beliefs.set('snipers:>10', { alpha: 2, beta: 98, observations: 100 });
    expect(combinePrior(['all', 'snipers:>10'], beliefs, 15)).toBeLessThan(0.3);
  });
  it('weights move towards features that separate winners from losers, within limits', () => {
    const samples: OutcomeSample[] = Array.from({ length: 60 }, (_, i) => ({ good: i % 2 === 0, features: { trend: i % 2 === 0 ? 0.9 : 0.2, holders: 0.5 } }));
    const limits = { maxWeightStepPct: 10, weightFloor: 0.01, weightCeiling: 0.25, adjusterMinSamples: 40 };
    const r = adjustWeights({ ...DEFAULT_WEIGHTS }, samples, limits)!;
    expect(r.weights.trend).toBeGreaterThan(DEFAULT_WEIGHTS.trend);
    expect(r.weights.trend / DEFAULT_WEIGHTS.trend).toBeLessThan(1.11);
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(adjustWeights({ ...DEFAULT_WEIGHTS }, samples.slice(0, 20), limits)).toBeNull();
  });
});

describe('tape archive encoding', () => {
  const a = [
    { tsMs: 1, isBuy: true, solAmount: 0.5, priceSol: 1e-8, user: 'A' },
    { tsMs: 2, isBuy: false, solAmount: 0.25, priceSol: 9e-9, user: 'B' },
  ];
  it('round-trips through the compact form', () => {
    const { rows, wallets } = encodeTape(a);
    expect(decodeTape(rows, wallets)).toEqual(a);
  });
  it('merging overlapping tapes drops duplicates and keeps time order', () => {
    const b = [a[1]!, { tsMs: 3, isBuy: true, solAmount: 1, priceSol: 1.1e-8, user: 'C' }];
    expect(mergeTapes(b, a).map((t) => t.tsMs)).toEqual([1, 2, 3]);
  });
});
