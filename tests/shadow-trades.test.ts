import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { runAutopsy, type ClosedTrade } from '../src/learner/loss-autopsy';
import { shadowAsClosed, shadowReport, whyKey, wouldHaveTaken, ShadowTrades, type ShadowResult } from '../src/learner/shadow-trades';
import { buildProfile } from '../src/learner/timing';

const res = (o: Partial<ShadowResult>): ShadowResult => ({
  mint: 'm', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', kind: 'skipped', why: 'top 10 hold 55% (> 50%)', score: 70, bar: 72,
  mcUsd: 40_000, ageMin: 90, curvePct: 'migrated', kols: 0, run3m: 5, offHigh10m: 8, flat: {},
  openedAtMs: 1_760_000_000_000, closedAtMs: 1_760_000_600_000, pnlPct: 0, peakX: 1, holdSec: 600, exitReason: 'STOP_LOSS', ...o,
});

describe('shadow trades: pretend trades on coins it did not buy', () => {
  it('groups the same filter regardless of its numbers', () => {
    expect(whyKey('top 10 hold 55% (> 50%)')).toBe(whyKey('top 10 hold 61.5% (> 50%)'));
    expect(whyKey('fake volume 62%')).not.toBe(whyKey('top 10 hold 55%'));
  });

  it('reports what each filter costs and the winners it missed', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => res({ symbol: `T${i}`, why: `top 10 hold ${51 + i}% (> 50%)`, pnlPct: 30, peakX: i === 0 ? 4.2 : 1.8 })),
      ...Array.from({ length: 12 }, () => res({ why: 'fake volume 70% (> 50%)', pnlPct: -14, peakX: 1.01 })),
      ...Array.from({ length: 10 }, () => res({ kind: 'refused', why: 'max 6 MIGRATION_MOMENTUM positions open', pnlPct: 12, peakX: 1.5 })),
    ];
    const r = shadowReport(rows, 3);
    const top10 = r.byRule.find((g) => g.key === whyKey('top 10 hold 51% (> 50%)'))!;
    expect(top10.n).toBe(12);
    expect(top10.avgPct).toBe(30);
    expect(r.findings.join(' ')).toMatch(/top 10 hold.*costing money/);
    expect(r.findings.join(' ')).toMatch(/fake volume.*saving money/);
    expect(r.findings.join(' ')).toMatch(/no room for/);
    expect(r.missed[0]!.peakX).toBe(4.2);
    expect(r.byKind.refused.n).toBe(10);
  });

  it('only refused + near ones count as trades it would have taken (half weight in SOL)', () => {
    expect(wouldHaveTaken({ kind: 'refused' })).toBe(true);
    expect(wouldHaveTaken({ kind: 'near' })).toBe(true);
    expect(wouldHaveTaken({ kind: 'skipped' })).toBe(false);
    const c = shadowAsClosed(res({ kind: 'near', pnlPct: -20 }), 0.5, 0.1);
    expect(c.pnlSol).toBeCloseTo(-0.01);
    expect(c.shadow).toBe(true);
  });

  it('the autopsy finds a losing kind of trade sooner with shadow trades, headline numbers stay real', () => {
    const C = DEFAULT_CONFIG.autopsy;
    const real: ClosedTrade[] = Array.from({ length: 8 }, () => ({ strategy: 'CURVE_SNIPE', mcUsd: 7_000, ageMin: 2, curvePct: 40, score: 75, hourUtc: 13, pnlSol: -0.03, pnlPct: -15, sizeSol: 0.2, exitReason: 'STOP_LOSS', peakMultiple: 1, heldMin: 3, explore: false }));
    const good: ClosedTrade[] = Array.from({ length: 8 }, () => ({ ...real[0]!, mcUsd: 30_000, pnlSol: 0.05, pnlPct: 25, exitReason: 'TAKE_PROFIT', peakMultiple: 1.4 }));
    const sh = Array.from({ length: 30 }, () => shadowAsClosed(res({ kind: 'refused', strategy: 'CURVE_SNIPE', mcUsd: 7_500, ageMin: 2, curvePct: 40, pnlPct: -16 }), 0.5, 0.2));
    const without = runAutopsy([...real, ...good], C);
    const withShadow = runAutopsy([...real, ...good], C, Date.now(), sh);
    expect(without.blocked.length).toBe(0);
    expect(withShadow.blocked.some((b) => b.band === 'MC $5–10k')).toBe(true);
    expect(withShadow.trades).toBe(16);
    expect(withShadow.overall.n).toBe(16);
  });

  it('best-times results weigh shadow trades less', () => {
    const at = Date.parse('2026-10-06T15:10:00Z');
    const p = buildProfile([], [...Array.from({ length: 10 }, () => ({ openedAtMs: at, pnlPct: 10 })), ...Array.from({ length: 10 }, () => ({ openedAtMs: at, pnlPct: -10, w: 0.5 }))], DEFAULT_CONFIG.timing);
    expect(p.hours[15]!.avgPct).toBeCloseTo(3.3, 1);
  });

  it('opens a pretend trade once per coin + strategy per cooldown; far-off skips are ignored', () => {
    const crowd = { trades: vi.fn(() => []), candles: vi.fn(() => []) } as never;
    const st = new ShadowTrades({ multi: () => ({ lpush: () => ({ ltrim: () => ({ exec: async () => [] }) }) }) } as never, crowd);
    const sig = { mint: 'A', symbol: 'A', strategy: 'RUNNER' as const, kind: 'refused' as const, why: 'max 4 RUNNER positions open', score: 80, bar: 75, priceSol: 1e-7, onAmm: false, mcUsd: 9_000, ageMin: 4, curvePct: 50, kols: 0, run3m: 3, offHigh10m: 4, flat: {} };
    expect(st.onSignal(sig, 1_000)).toBe(true);
    expect(st.onSignal(sig, 2_000)).toBe(false);
    expect(st.onSignal({ ...sig, mint: 'B', kind: 'skipped', score: 40 }, 3_000)).toBe(false);
    expect(st.onSignal({ ...sig, mint: 'C', kind: 'skipped', score: 70 }, 3_000)).toBe(true);
    expect(st.openCount).toBe(2);
  });
});
