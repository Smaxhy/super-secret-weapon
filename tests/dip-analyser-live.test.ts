import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS } from '../src/config/migrations';
import { dipSignalOk } from '../src/executor/dip-watcher';
import { baseTaId, taPoints, withForcedLive } from '../src/learner/ta-lab';
import type { LabStats } from '../src/learner/strategy-lab';

const stat = (id: string, n: number, avg: number, se: number): LabStats => ({ id, name: id, n, avgPnlPct: avg, sePct: se } as unknown as LabStats);
const IDS = ['dip_analyser', 'dip_analyser@5s', 'dip_analyser@1m', 'fib_golden_pocket'];
const C = { forceLive: ['dip_analyser'], forceLiveEdgePct: 10, minTrades: 60 };

describe('v10.36: the dip analyser trades live', () => {
  it('is live on every timeframe before the lab proves it', () => {
    const live = withForcedLive(new Map(), IDS, [], null, C);
    expect([...live.keys()].sort()).toEqual(['dip_analyser', 'dip_analyser@1m', 'dip_analyser@5s']);
    expect(live.get('dip_analyser')).toMatchObject({ forced: true, edgePct: 10 });
    expect(baseTaId('dip_analyser@5s')).toBe('dip_analyser');
  });

  it('switches off on a timeframe the lab has proven LOSES, keeps an earned edge', () => {
    const stats = [stat('dip_analyser', 80, -9, 2), stat('dip_analyser@5s', 30, -9, 2)];
    const earned = new Map([['dip_analyser@1m', { id: 'dip_analyser@1m', n: 90, avgPnlPct: 6, edgePct: 5 }]]);
    const live = withForcedLive(earned, IDS, stats, stat('baseline', 100, -3, 1), C);
    expect(live.has('dip_analyser')).toBe(false); // −9 + 2×2 = −5 < −3 baseline → proven to lose
    expect(live.get('dip_analyser@5s')?.forced).toBe(true); // only 30 tests — not judged yet
    expect(live.get('dip_analyser@1m')).toMatchObject({ edgePct: 5 }); // earned edge kept, not overwritten
  });

  it('gives score points and says it is live by the owner\'s choice', () => {
    const live = withForcedLive(new Map(), IDS, [], null, C);
    const r = taPoints([{ id: 'dip_analyser', strength: 1, why: 'x' }], live, { pointsPerSignal: 3, maxPoints: 8 });
    expect(r.points).toBe(3);
    expect(r.notes[0]).toMatch(/live by your choice/);
  });

  it('a dip signal counts as the dip entry only under the high, above the breakdown, no blow-off', () => {
    const w = { high: 100, zone: { lo: 70, hi: 90 } };
    const c = { breakdownPct: 7, signalMinOffHighPct: 5, blowOff: { enabled: true, dropRunPct: 500 } };
    expect(dipSignalOk(w, 88, 60, c)).toBeNull();
    expect(dipSignalOk(w, 97, 60, c)).toMatch(/under the high/);
    expect(dipSignalOk(w, 60, 50, c)).toMatch(/broke down/);
    expect(dipSignalOk(w, 88, 10, c)).toMatch(/blow-off/);
  });

  it('defaults + migration v27: new pairs at the minimum size, dip analyser live', () => {
    expect(DEFAULT_CONFIG.trading.minSizeStrategies).toEqual(['CURVE_SNIPE']);
    expect(DEFAULT_CONFIG.ta.forceLive).toEqual(['dip_analyser']);
    expect(DEFAULT_CONFIG.ta.dipEntrySignals).toEqual(['dip_analyser']);
    const m = MIGRATIONS.find((x) => x.version === 27)!;
    expect(m.set.map((s) => s[1].join('.'))).toEqual(['minSizeStrategies', 'forceLive', 'forceLiveEdgePct', 'dipEntrySignals']);
  });
});
