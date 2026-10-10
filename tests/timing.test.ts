import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { buildProfile, timingVerdict, type DayCounts } from '../src/learner/timing';

const C = DEFAULT_CONFIG.timing;
// 5 days (Mon 2026-10-05 … Fri 2026-10-09): 14–16 UTC busy (600 trades/min), 03–05 UTC quiet (100), rest 300.
const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date) => {
  const counts: DayCounts = {};
  for (let h = 0; h < 24; h++) {
    const tpm = h >= 14 && h < 17 ? 600 : h >= 3 && h < 6 ? 100 : 300;
    counts[h] = { m: 60, t: tpm * 60, a: tpm * 10, l: 60 * 8, c: 2 };
  }
  return { date, counts };
});
const at = (date: string, h: number) => Date.parse(`${date}T${String(h).padStart(2, '0')}:20:00Z`);
// Trades: 15:00 UTC wins (+12%), 04:00 UTC loses (−14%), others around −2%.
const trades = [
  ...Array.from({ length: 20 }, (_, i) => ({ openedAtMs: at(days[i % 5]!.date, 15), pnlPct: 12 })),
  ...Array.from({ length: 20 }, (_, i) => ({ openedAtMs: at(days[i % 5]!.date, 4), pnlPct: -14 })),
  ...Array.from({ length: 40 }, (_, i) => ({ openedAtMs: at(days[i % 5]!.date, 9 + (i % 4)), pnlPct: -2 })),
];

describe('timing: best hours and days to trade', () => {
  const p = buildProfile(days, trades, C, Date.parse('2026-10-10T00:00:00Z'));
  it('finds the busiest and the best / worst hours', () => {
    expect(p.busiestHours.slice(0, 3).sort()).toEqual([14, 15, 16]);
    expect(p.hours[15]!.activity!).toBeGreaterThan(1.5);
    expect(p.hours[4]!.activity!).toBeLessThan(0.5);
    expect(p.bestHours[0]).toBe(15);
    expect(p.worstHours[0]).toBe(4);
    expect(p.hours[15]!.winRatePct).toBe(100);
  });
  it('trades bigger with an easier bar at good busy hours, smaller and stricter at bad quiet ones', () => {
    const good = timingVerdict(p, at('2026-10-12', 15), C);
    const bad = timingVerdict(p, at('2026-10-12', 4), C);
    expect(good.sizeFactor).toBeGreaterThan(1.1);
    expect(good.barDelta).toBeLessThan(0);
    expect(bad.sizeFactor).toBeLessThan(0.9);
    expect(bad.barDelta).toBeGreaterThan(0);
    expect(bad.sizeFactor).toBeGreaterThanOrEqual(C.sizeMin);
    expect(good.why).toMatch(/busy time/);
  });
  it('stays neutral without data and never moves more than the limits', () => {
    const empty = buildProfile([], [], C);
    expect(timingVerdict(empty, Date.now(), C)).toMatchObject({ sizeFactor: 1, barDelta: 0 });
    expect(timingVerdict(null, Date.now(), C).sizeFactor).toBe(1);
    // A few lucky trades don't count as an edge.
    const few = buildProfile(days, [{ openedAtMs: at('2026-10-05', 9), pnlPct: 80 }], C);
    expect(few.hours[9]!.edgePct).toBe(0);
  });
});
