import { describe, expect, it } from 'vitest';
import { reviewLoss, reviewLosses, lossSummary } from '../src/forex/loss-review';
import type { ClosedPractice } from '../src/forex/practice';
import type { Trade } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 23, 3);
const closed = (o: Partial<ClosedPractice>): ClosedPractice => ({ id: 'c1', pair: 'LINKUSD', side: 1, units: 100, entry: 12.2, marginUsd: 50, leverage: 20, stop: 12.0, target: 12.6, openedAt: T0, checkedT: 0, lock: null, exit: 12.0, closedAt: T0 + H, pnlUsd: -20, reason: 'stop', strategy: 'news_drift', tf: '1h', ref: 'news_drift:1h:LINKUSD:1', riskUsd0: 33, ...o } as ClosedPractice);
const lab = (r: number, reason = 'stop'): Trade => ({ strategy: 'news_drift', tf: '1h', pair: 'LINKUSD', side: 1, entryT: 1, exitT: T0 + 2 * H, entry: 12.2, exit: 12.1, r, stopPct: 1, reason, bars: 2, stop: 12.1, stop0: 12.1, target: 12.6 } as Trade);
const ctx = (labR: number | null, extra: Partial<Parameters<typeof reviewLoss>[1]> = {}) => ({ closed: [] as ClosedPractice[], open: [], labDone: new Map(labR === null ? [] : [['news_drift:1h:LINKUSD:1', lab(labR)]]), labOpen: new Set<string>(), maxLossUsd: 20, now: T0 + 3 * H, ...extra });

describe('v27.23 loss review', () => {
  it('normal: the tested trade lost too; the cap saving is measured', () => {
    const r = reviewLoss(closed({}), ctx(-1.08));
    expect(r.verdict).toBe('normal');
    expect(r.causes).toContain('tested_loss');
    expect(r.capDelta).toBeCloseTo(-20 + 1.08 * 33, 1); // the cap saved ≈ $15.64
  });
  it('avoidable: the cap stopped it while the tested trade won', () => {
    const r = reviewLoss(closed({}), ctx(1.5, ));
    expect(r.verdict).toBe('avoidable');
    expect(r.causes).toContain('loss_cap');
    expect(r.capDelta! < 0).toBe(true);
  });
  it('avoidable: a doubled bet on the same market and direction', () => {
    const other = closed({ id: 'c2', strategy: 'momentum_bar', ref: 'momentum_bar:1h:LINKUSD:1' });
    const r = reviewLoss(closed({}), ctx(-1.08, { closed: [closed({}), other] }));
    expect(r.verdict).toBe('avoidable');
    expect(r.causes).toContain('doubled');
    expect(r.why).toContain('momentum_bar');
  });
  it('pending while the tested trade runs, unknown after 3 days without one', () => {
    expect(reviewLoss(closed({}), ctx(null, { labOpen: new Set(['news_drift:1h:LINKUSD:1']) })).verdict).toBe('pending');
    expect(reviewLoss(closed({}), ctx(null, { now: T0 + 5 * 86_400_000 })).verdict).toBe('unknown');
  });
  it('reviewLosses skips wins and manual closes, keeps finished reviews, summarises', () => {
    const rows = [closed({}), closed({ id: 'w', pair: 'BTCUSD', pnlUsd: 5 }), closed({ id: 'm', pair: 'ETHUSD', reason: 'manual', pnlUsd: -9 })];
    const { reviews, finished } = reviewLosses([], ctx(-1.08, { closed: rows }));
    expect(reviews.map((x) => x.id)).toEqual(['c1']);
    expect(finished).toHaveLength(1);
    const s = lossSummary(reviews);
    expect(s.by.normal.n).toBe(1);
    expect(s.capStops).toBe(1);
    expect(s.capSavedUsd > 0).toBe(true);
  });
});
