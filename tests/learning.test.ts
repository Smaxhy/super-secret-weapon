import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, type FeatureName } from '../src/config/default';
import { patternsOf } from '../src/learner/bayesian-updater';
import { adjustWeights } from '../src/learner/daily-adjuster';
import { classify } from '../src/learner/regime-detector';

describe('daily weight adjustment', () => {
  const sample = (holders: number, snipers: number, win: boolean) => ({ features: { holders, snipers } as Partial<Record<FeatureName, number>>, win });
  // Winners have many holders; snipers don't matter.
  const samples = [
    ...Array.from({ length: 30 }, () => sample(0.9, 0.5, true)),
    ...Array.from({ length: 120 }, () => sample(0.3, 0.5, false)),
  ];

  it('raises the weight of a feature that separates winners from losers', () => {
    const r = adjustWeights({ ...DEFAULT_WEIGHTS }, samples)!;
    expect(r.weights.holders).toBeGreaterThan(DEFAULT_WEIGHTS.holders);
    expect(r.changes[0]?.feature).toBe('holders');
  });
  it('keeps weights summing to 1 and moves at most ~5% per run', () => {
    const r = adjustWeights({ ...DEFAULT_WEIGHTS }, samples)!;
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    for (const f of Object.keys(DEFAULT_WEIGHTS) as FeatureName[]) expect(Math.abs(r.weights[f] / DEFAULT_WEIGHTS[f] - 1)).toBeLessThan(0.11);
  });
  it('refuses to learn from too little data', () => {
    expect(adjustWeights({ ...DEFAULT_WEIGHTS }, samples.slice(0, 50))).toBeNull();
  });
});

describe('regime', () => {
  const base = { launchesPerHour: 1000, launchesPerHour7d: 1000, migrationRatePct: 0.8, hitRatePct: 8, rugRatePct: 30, labeled: 100 };
  it('normal by default', () => expect(classify(base)).toBe('NORMAL'));
  it('hot when many winners', () => expect(classify({ ...base, hitRatePct: 20 })).toBe('HOT'));
  it('cold when quiet', () => expect(classify({ ...base, launchesPerHour: 400 })).toBe('COLD'));
  it('rug-heavy wins over everything', () => expect(classify({ ...base, hitRatePct: 20, rugRatePct: 70 })).toBe('RUG_HEAVY'));
  it('ignores hit/rug rates with too few labels', () => expect(classify({ ...base, labeled: 5, hitRatePct: 50, rugRatePct: 90 })).toBe('NORMAL'));
});

describe('bayesian patterns', () => {
  it('matches patterns from stored features', () => {
    const p = patternsOf({ market: { earlyBuyerPct: 12, holders: 60, complete: false }, socials: { twitter: 'https://x.com/a' } }, 'SMART_MONEY_COPY');
    expect(p).toEqual(expect.arrayContaining(['Bundlers hold >10%', '50+ holders', 'Has X link', 'Copy trade (tracked wallet bought)']));
    expect(p).not.toContain('Already migrated');
  });
});

import { explainBuy, explainSell } from '../src/learner/explain';
describe('explanations', () => {
  it('buy recap names the strongest signals and key numbers', () => {
    const t = explainBuy({
      symbol: 'FROG', strategy: 'CURVE_SNIPE', score: 78, threshold: 70, contributions: { holders: 9, buyPressure: 8 }, features: { holders: 0.9, buyPressure: 0.95, snipers: 0.2 },
      market: { holders: 80, volumeUsd: 15000, volumeSol: 100, marketCapUsd: 14000, marketCapSol: 90, buySellRatio: 3.2, complete: false, bondingCurvePct: 60, devHoldingPct: 2, earlyBuyerPct: 12, top10HolderPct: 30, totalFeesSol: 1.4 } as never,
      sizeSol: 0.1, regime: 'HOT', risky: 'bundlers hold 22% > 18%',
    });
    expect(t).toContain('Bought 0.100 SOL of FROG');
    expect(t).toContain('holder count');
    expect(t).toContain('few bundlers/snipers'); // weak spot
    expect(t).toContain('reduced size');
  });
  it('sell recap explains the reason and result', () => {
    const t = explainSell({ symbol: 'FROG', reason: 'TAKE_PROFIT', detail: 'resistance at 1.30x', multiple: 1.25, peakMultiple: 1.3, pct: 70, closing: true, heldMinutes: 6, pnlSol: 0.02 });
    expect(t).toContain('Took profit: resistance at 1.30x.');
    expect(t).toContain('+0.0200 SOL');
  });
});
