import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { dipOnlyApplies, dipOnlyHigh, hotVolume } from '../src/executor/dip-watcher';
import { dailyCalendar, tradesOnDay, type ClosedTrade } from '../src/api/performance-calc';
import { pullbackZone } from '../src/learner/entry-style';

const base = { enabled: true, minMcUsd: 15_000, dipEntry: false, swing: false };

describe('dip-only entries above $15k MC (v10.24)', () => {
  it('is on by default at $15k', () => {
    expect(DEFAULT_CONFIG.chart.dip.dipOnly.enabled).toBe(true);
    expect(DEFAULT_CONFIG.chart.dip.noWaitBelowMcUsd).toBe(15_000);
  });
  it('waits for a dip at/above $15k, buys straight away under it', () => {
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000 })).toBe(true);
    expect(dipOnlyApplies({ ...base, mcUsd: 15_000 })).toBe(true);
    expect(dipOnlyApplies({ ...base, mcUsd: 9_000 })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: null })).toBe(false);
  });
  it('dip re-checks, swing re-entries and the off switch buy normally', () => {
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, dipEntry: true })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, swing: true })).toBe(false);
    expect(dipOnlyApplies({ ...base, mcUsd: 40_000, enabled: false })).toBe(false);
  });
  it('measures the pullback from the recent high, never below the price', () => {
    expect(dipOnlyHigh(1, 1.25, null)).toBe(1.25);
    expect(dipOnlyHigh(1, null, 20)).toBeCloseTo(1.25);
    expect(dipOnlyHigh(1, null, null)).toBe(1);
    expect(dipOnlyHigh(1, 0.8, null)).toBe(1);
    const z = pullbackZone(1, 15);
    expect(z.hi).toBeCloseTo(0.85);
    expect(z.lo).toBeCloseTo(0.65);
  });
});

describe('huge real volume skips the dip wait', () => {
  const c = DEFAULT_CONFIG.chart.dip.dipOnly.hotVolume;
  const flow = { buyers: 55, buySol: 31, sellSol: 9, buySharePct: 78, organicPct: 82, run3mPct: 12, priceSol: 1e-6 };
  it('buys straight away when every bar clears', () => {
    expect(hotVolume(flow, c)).toMatch(/55 buyers/);
  });
  it('waits for a dip on normal volume, bot volume or no data', () => {
    expect(hotVolume({ ...flow, buyers: 20 }, c)).toBeNull();
    expect(hotVolume({ ...flow, buySol: 8 }, c)).toBeNull();
    expect(hotVolume({ ...flow, buySharePct: 52 }, c)).toBeNull();
    expect(hotVolume({ ...flow, organicPct: 40 }, c)).toBeNull();
    expect(hotVolume(null, c)).toBeNull();
    expect(hotVolume(flow, { ...c, enabled: false })).toBeNull();
  });
});

describe('daily P&L calendar', () => {
  const t = (closed: string, pnl: number, strategy = 'SOON'): ClosedTrade => ({ id: closed + pnl, mint: 'm', symbol: 'X', strategy, sizeSol: 0.5, pnlSol: pnl, openedAt: new Date(closed), closedAt: new Date(closed), exitReason: null });
  it('starts every day at 0 and groups by the close day', () => {
    const days = dailyCalendar([t('2026-10-14T10:00:00Z', 0.2), t('2026-10-14T20:00:00Z', -0.05, 'MIGRATION_MOMENTUM'), t('2026-10-15T01:00:00Z', -0.1)]);
    expect(days.map((d) => d.day)).toEqual(['2026-10-14', '2026-10-15']);
    expect(days[0]!.pnlSol).toBeCloseTo(0.15);
    expect(days[0]!.trades).toBe(2);
    expect(days[0]!.wins).toBe(1);
    expect(days[0]!.avgPct).toBeCloseTo(15);
    expect(days[0]!.byStrategy[0]!.strategy).toBe('SOON');
    expect(days[1]!.pnlSol).toBeCloseTo(-0.1);
  });
  it("uses the viewer's time zone", () => {
    // 01:00 UTC on the 15th = 21:00 on the 14th in New York (offset +240 min).
    expect(dailyCalendar([t('2026-10-15T01:00:00Z', 0.1)], 240)[0]!.day).toBe('2026-10-14');
    // 22:00 UTC on the 14th = 00:00 on the 15th in Amsterdam summer time (offset −120).
    expect(dailyCalendar([t('2026-10-14T22:00:00Z', 0.1)], -120)[0]!.day).toBe('2026-10-15');
  });
  it('picks one day for the chart (tap a day)', () => {
    const all = [t('2026-10-14T10:00:00Z', 0.2), t('2026-10-15T01:00:00Z', -0.1), t('2026-10-15T09:00:00Z', 0.3)];
    expect(tradesOnDay(all, '2026-10-15').map((x) => x.pnlSol)).toEqual([-0.1, 0.3]);
    expect(tradesOnDay(all, '2026-10-14', 240).map((x) => x.pnlSol)).toEqual([0.2, -0.1]);
  });
});
