import { describe, expect, it } from 'vitest';
import { outcomeOf, OutcomeTracker, type OutcomeSignal } from '../src/learner/outcome-tracker';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const T0 = 1_700_000_000_000;
const sig = (o: Partial<OutcomeSignal> = {}): OutcomeSignal => ({ mint: 'M', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', atMs: T0, onAmm: true, marketCapSol: 300, score: 60, bar: 70, why: 'score under the bar', flat: { 'x.a': 1 }, ...o });
function path(f: (s: number) => number, secs = 2400): CrowdTrade[] {
  const out: CrowdTrade[] = [];
  for (let s = 0; s < secs; s += 3) out.push({ t: T0 + s * 1000, w: `w${s % 30}`, buy: s % 2 === 0, sol: 0.3, tok: 0, px: f(s), pp: f(s) });
  return out;
}

describe('outcome tracker (learn from every coin it checks)', () => {
  it('replays a coin that ran with the bot’s own exits → a winning lesson', () => {
    const o = outcomeOf(sig(), path((s) => 1e-6 * (1 + Math.min(1, s / 600))), 45 * 60_000, 5);
    expect(o.peakX).toBeGreaterThan(1.4);
    expect(o.pnlPct).toBeGreaterThan(0);
  });
  it('a coin that bled out → a losing lesson', () => {
    const o = outcomeOf(sig(), path((s) => 1e-6 * Math.max(0.3, 1 - s / 900)), 45 * 60_000, 5);
    expect(o.pnlPct).toBeLessThan(-10);
  });
  it('a dead coin (no trades after the check) costs the round trip', () => {
    const o = outcomeOf(sig(), [], 45 * 60_000, 5.5);
    expect(o).toMatchObject({ pnlPct: -5.5, peakX: 1 });
  });
  it('records once per coin + strategy per cooldown and caps the queue', () => {
    const t = new OutcomeTracker({} as never, () => [], () => ({ enabled: true, watchMin: 45, cooldownMin: 20, maxPending: 2, maxPerTick: 10, keep: 10, weight: 0.25 }));
    expect(t.record(sig())).toBe(true);
    expect(t.record(sig({ atMs: T0 + 60_000 }))).toBe(false); // cooldown
    expect(t.record(sig({ strategy: 'SOON' }))).toBe(true);
    expect(t.record(sig({ mint: 'N' }))).toBe(false); // queue full
    expect(t.pendingCount).toBe(2);
  });
});
