import { beforeEach, describe, expect, it } from 'vitest';
import { blockerSnapshot, exploreMargin, noteEntry, noteRefusal, noteSignal, noteSkip, normaliseReason, resetBlockers, setLastEntryAt } from '../src/lib/entry-blockers';

const T = 1_760_000_000_000;

describe('entry blockers ("why isn\'t it trading")', () => {
  beforeEach(() => resetBlockers(T));

  it('groups reasons that only differ in numbers', () => {
    expect(normaliseReason('top 10 hold 54% (max 50%)')).toBe(normaliseReason('top 10 hold 61.5% (max 50%)'));
    expect(normaliseReason('MC $8.2k below $12k')).toBe('MC # below #');
  });

  it('counts skips and refusals over the last hour and explains the drought', () => {
    noteSkip('CURVE_SNIPE', 'top 10 hold 54%', T);
    noteSkip('CURVE_SNIPE', 'top 10 hold 70%', T + 1000);
    noteSkip('SWING', 'score under the bar', T + 2000);
    let s = blockerSnapshot(T + 5000);
    expect(s.lastHour.evaluated).toBe(3);
    expect(s.topSkips[0]).toEqual({ reason: 'CURVE_SNIPE: top # hold #', count: 2 });
    expect(s.summary).toMatch(/none good enough/);

    noteSignal(T + 6000);
    noteRefusal('CURVE_SNIPE', 'daily loss circuit breaker', T + 6000);
    s = blockerSnapshot(T + 7000);
    expect(s.summary).toMatch(/refused — mostly "CURVE_SNIPE: daily loss circuit breaker"/);

    noteEntry(T + 8000);
    expect(blockerSnapshot(T + 9000).summary).toBe('1 buy in the last hour');
    // An hour later the old counts are gone.
    const later = blockerSnapshot(T + 62 * 60_000);
    expect(later.lastHour.evaluated).toBe(0);
    expect(later.summary).toMatch(/trade stream is probably down/);
  });

  it('widens the learning-trade margin after a drought only', () => {
    const ex = { scoreMargin: 5, droughtMinutes: 45, droughtScoreMargin: 10 };
    setLastEntryAt(T, T);
    expect(exploreMargin(ex, T + 30 * 60_000)).toBe(5);
    expect(exploreMargin(ex, T + 50 * 60_000)).toBe(10);
    noteEntry(T + 50 * 60_000);
    expect(exploreMargin(ex, T + 51 * 60_000)).toBe(5);
    expect(exploreMargin({ scoreMargin: 5 }, T + 999 * 60_000)).toBe(5);
  });
});
