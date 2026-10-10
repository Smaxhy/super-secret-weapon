import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { bandOf, blockedBand, runAutopsy, type ClosedTrade } from '../src/learner/loss-autopsy';

const C = DEFAULT_CONFIG.autopsy;
const trade = (o: Partial<ClosedTrade>): ClosedTrade => ({
  strategy: 'CURVE_SNIPE', mcUsd: 8_000, ageMin: 2, curvePct: 40, score: 75, hourUtc: 13,
  pnlSol: 0, pnlPct: 0, sizeSol: 0.2, exitReason: 'STOP_LOSS', peakMultiple: 1, heldMin: 3, explore: false, ...o,
});

describe('loss autopsy (owner: "scan what keeps going wrong and learn")', () => {
  // Low-MC snipes lose again and again (never go up); $20–50k ones win.
  const losers = Array.from({ length: 20 }, (_, i) => trade({ mcUsd: 7_000, pnlPct: -14 + (i % 3), pnlSol: 0.2 * ((-14 + (i % 3)) / 100), peakMultiple: 1.01 }));
  const winners = Array.from({ length: 16 }, (_, i) => trade({ mcUsd: 30_000, ageMin: 2.5, pnlPct: i % 4 === 0 ? -12 : 25, pnlSol: 0.2 * ((i % 4 === 0 ? -12 : 25) / 100), exitReason: i % 4 === 0 ? 'STOP_LOSS' : 'TAKE_PROFIT', peakMultiple: i % 4 === 0 ? 1.02 : 1.4 }));
  const a = runAutopsy([...losers, ...winners], C);

  it('finds the losing band and blocks only it', () => {
    expect(a.blocked.map((b) => b.band)).toContain('MC $5–10k');
    expect(a.blocked.some((b) => b.band === 'MC $20–50k')).toBe(false);
    expect(a.best[0]!.band).toBe('MC $20–50k');
  });
  it('says WHY it loses: entries (never went up) and the break-even win rate', () => {
    expect(a.losers.neverUpPct).toBeGreaterThanOrEqual(90);
    expect(a.findings.join(' ')).toMatch(/ENTRIES are the problem/);
    expect(a.overall.neededWinRatePct).not.toBeNull();
    expect(a.byExit[0]!.reason).toBe('STOP_LOSS');
  });
  it('a new buy in a blocked band is caught; other bands and strategies pass', () => {
    const shape = { strategy: 'CURVE_SNIPE', mcUsd: 6_500, ageMin: 2, curvePct: 40, score: 75, hourUtc: 13 };
    expect(blockedBand(shape, a.blocked)?.band).toBe('MC $5–10k');
    expect(blockedBand({ ...shape, mcUsd: 35_000 }, a.blocked)?.band ?? null).not.toBe('MC $5–10k');
    expect(blockedBand({ ...shape, strategy: 'SWING' }, a.blocked)).toBeNull();
  });
  it('needs enough trades before it blocks anything', () => {
    expect(runAutopsy(losers.slice(0, 10), C).blocked).toEqual([]);
  });
  it('bands', () => {
    expect(bandOf('curve', { strategy: 'S', mcUsd: 1, ageMin: 1, curvePct: 'migrated', score: 1, hourUtc: 0 })).toBe('migrated');
    expect(bandOf('curve', { strategy: 'S', mcUsd: 1, ageMin: 1, curvePct: null, score: 1, hourUtc: 0 })).toBeNull();
    expect(bandOf('mc', { strategy: 'S', mcUsd: 2e6, ageMin: 1, curvePct: 1, score: 1, hourUtc: 0 })).toBe('MC >$1M');
  });
});
