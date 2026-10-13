import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { exitRulesFor } from '../src/executor/sell-manager';
import { moonReport, moonshotRules, moonshotVerdict, type MoonResult, type MoonSignals } from '../src/learner/moonshot';

const C = DEFAULT_CONFIG.moonshot;
const mega: MoonSignals = { flow: { buyers: 60, buySol: 35, sellSol: 8, buySharePct: 81, organicPct: 80, run3mPct: 20, priceSol: 1e-6 }, mcUsd: 80_000, kolsHolding: 3, trendLists: 1, dexTrending: false };

describe('moonshot test mode', () => {
  it('fires only when everything lines up', () => {
    expect(moonshotVerdict(mega, C)).toBeNull();
    expect(moonshotVerdict({ ...mega, kolsHolding: 1 }, C)).toMatch(/KOLs/);
    expect(moonshotVerdict({ ...mega, trendLists: 0 }, C)).toMatch(/trending/);
    expect(moonshotVerdict({ ...mega, trendLists: 0, dexTrending: true }, C)).toBeNull();
    expect(moonshotVerdict({ ...mega, flow: { ...mega.flow!, buyers: 20 } }, C)).toMatch(/buyers/);
    expect(moonshotVerdict({ ...mega, flow: { ...mega.flow!, organicPct: 40 } }, C)).toMatch(/organic/);
    expect(moonshotVerdict({ ...mega, flow: { ...mega.flow!, run3mPct: 120 } }, C)).toMatch(/already/);
  });
  it('moonshot exits clip smaller pieces and ride a wider trail', () => {
    const live = exitRulesFor('MIGRATION_MOMENTUM', DEFAULT_CONFIG.exit);
    const m = moonshotRules(live, C) as unknown as { takeProfitTiers: Array<{ multiple: number; sellPct: number }>; trail: { ladder: Array<{ pct: number }> }; initials: { atMultiple: number } };
    expect(m.takeProfitTiers[0]).toEqual({ multiple: 1.5, sellPct: 20 });
    expect(m.trail.ladder[0]!.pct).toBe(25);
    expect(m.initials.atMultiple).toBeGreaterThan(100);
  });
  it('reports moonshot vs normal exits', () => {
    const r = (variant: 'M' | 'L', pnlPct: number, peakX: number): MoonResult => ({ mint: 'm', symbol: 'X', variant, openedAtMs: 1, closedAtMs: 2, pnlPct, peakX, holdSec: 60, exitReason: '', why: '' });
    const rep = moonReport([r('M', 120, 4), r('M', -15, 1.1), r('L', 30, 4), r('L', -12, 1.1)]);
    expect(rep.moonshot).toMatchObject({ n: 2, avgPct: 52.5, winRatePct: 50, went2xPct: 50 });
    expect(rep.normal.avgPct).toBe(9);
  });
});
