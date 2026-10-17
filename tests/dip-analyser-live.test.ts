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

  it('defaults + migration v27: new pairs at the minimum size (dip analyser test-only again since v10.39)', () => {
    expect(DEFAULT_CONFIG.trading.minSizeStrategies).toEqual(['CURVE_SNIPE']);
    const m = MIGRATIONS.find((x) => x.version === 27)!;
    expect(DEFAULT_CONFIG.ta.forceLive).toEqual([]); // v10.39: the lab has to prove it first
    expect(m.set.map((s) => s[1].join('.'))).toEqual(['minSizeStrategies', 'forceLive', 'forceLiveEdgePct', 'dipEntrySignals']);
  });
});

describe('v10.37: a switched-on strategy always has a budget', () => {
  it('0 allocation → the minimum share; SWING defaults to 10% (migration v28)', async () => {
    const { allocationShare } = await import('../src/executor/trader');
    expect(allocationShare(0, 0.05)).toBe(0.05);
    expect(allocationShare(0.35, 0.05)).toBe(0.35);
    expect(allocationShare(undefined, undefined)).toBe(0);
    expect(DEFAULT_CONFIG.trading.allocation.SWING).toBe(0.1);
    expect(MIGRATIONS.find((x) => x.version === 28)!.set.map((s) => s[1].join('.'))).toEqual(['allocation.SWING', 'allocation.SMART_MONEY_COPY']);
  });
});

describe('v10.39: back to the tighter rules, fewer nudgers', () => {
  it('pre-v10.35 rules, coach / calibration / timing nudges off, chart buy rules off (migration v29)', () => {
    expect(DEFAULT_CONFIG.entry.minCombinedScore).toBe(65);
    expect(DEFAULT_CONFIG.entry.maxTop10Pct).toBe(50);
    expect(DEFAULT_CONFIG.focus.newPair.minAgeSec).toBe(45);
    expect(DEFAULT_CONFIG.focus.migrated.noEntryFirstSec).toBe(330);
    const v29 = MIGRATIONS.find((x) => x.version === 29)!;
    const aaSet = v29.set.find((s) => s[0] === 'entry' && s[1].join('.') === 'autoAdjust');
    expect(aaSet).toBeDefined();
    expect(aaSet![2]).toEqual({ coach: false, calibration: false });
    const timingSet = v29.set.find((s) => s[0] === 'timing' && s[1].join('.') === 'enabled');
    expect(timingSet).toBeDefined();
    expect(timingSet![2]).toBe(false);
    const keys = MIGRATIONS.find((x) => x.version === 29)!.set.map((s) => `${s[0]}.${s[1].join('.')}`);
    expect(keys).toEqual(expect.arrayContaining(['entry.minCombinedScore', 'entry.autoAdjust', 'entry.priceAction.enabled', 'ta.forceLive', 'timing.enabled', 'focus.migrated.noEntryFirstSec']));
  });
});

describe('v10.40: total fees by market cap (owner)', () => {
  it('≥ $50k → 9 SOL, under → 3 SOL, MC unknown → old minimum; the brain\'s blanket fee tip is found for removal', async () => {
    const { feeMinimum } = await import('../src/evaluator/scorer');
    const { feeRuleTipIds } = await import('../src/learner/ai-coach');
    const c = DEFAULT_CONFIG.entry.feesByMarketCap;
    expect(feeMinimum(c, 60_000)).toBe(9);
    expect(feeMinimum(c, 50_000)).toBe(9);
    expect(feeMinimum(c, 30_000)).toBe(3);
    expect(feeMinimum(c, null)).toBeNull();
    expect(feeMinimum({ ...c, enabled: false }, 30_000)).toBeNull();
    const rule = (o: object) => ({ id: 'r', title: '', why: '', strategy: null, action: 'avoid', conditions: [{ feature: 'market.totalFeesSol', op: 'lt', value: 9 }], createdAt: '', status: 'live', statusWhy: '', backtest: null, forward: null, source: 'owner', tipId: 't1', ...o });
    expect(feeRuleTipIds([rule({}), rule({ tipId: 't2', conditions: [{ feature: 'crowd.buyers', op: 'lt', value: 9 }] }), rule({ tipId: 't3', source: 'ai' })] as never)).toEqual(['t1']);
  });
});
