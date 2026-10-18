import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import type { MomentumGateConfig } from '../src/evaluator/momentum-gate';
import type { SniperConfig } from '../src/evaluator/sniper';
import type { OrganicFlow } from '../src/scanner/migrated-scanner';
import { DEFAULT_LOOP, SelfLoop, type LoopDeps } from '../src/learner/self-loop';
import type { ReplayReport } from '../src/learner/replay';
import {
  LIVE_ID,
  RANDOM_ID,
  Tournament,
  evictionKey,
  isCandidate,
  judge,
  nestPrefixed,
  offersFor,
  variantEntryFails,
  variantExitRules,
  type TournamentCandidate,
  type TournamentVariant,
} from '../src/learner/tournament';
import type { CrowdTracker } from '../src/scanner/crowd-tracker';
import type { Redis } from 'ioredis';

const SNIPER = DEFAULT_CONFIG.sniper as unknown as SniperConfig;
const MG = DEFAULT_CONFIG.momentumGate as unknown as MomentumGateConfig;
const VARIANTS = DEFAULT_CONFIG.tournament.variants as unknown as TournamentVariant[];
const v = (id: string) => VARIANTS.find((x) => x.id === id)!;

const flow = (buyers: number, buySol: number): OrganicFlow => ({ buyers, buySol, buySharePct: 70, organicPct: 80 } as unknown as OrganicFlow);
const cand = (o: Partial<TournamentCandidate> = {}, sn: Partial<TournamentCandidate['sniper']> = {}): TournamentCandidate => ({
  mint: 'M1',
  symbol: 'TEST',
  strategy: 'MIGRATION_MOMENTUM',
  strategyEnabled: true,
  priceSol: 1e-6,
  onAmm: true,
  hardFail: false,
  ruleFails: [],
  shape: { run1m: 5, run3m: 25, offHigh10m: 4, buyShare2m: 0.7, lastCandlePct: 3 },
  ...o,
  sniper: { flow: flow(22, 14), score: 70, threshold: 60, momentumGateWhy: null, entryQualityVerdict: 'ok', edgeGatePass: null, pressureSellersInControl: false, crowd: null, risky: false, deployerClass: null, ...sn },
});

describe('variant entry checks', () => {
  it('a looser volume bar buys what the live settings refuse; a stricter one refuses', () => {
    const c = cand(); // 22 buyers, live needs 30
    expect(variantEntryFails(c, v(LIVE_ID), SNIPER, MG).some((f) => f.includes('real buyers'))).toBe(true);
    expect(variantEntryFails(c, v('buyers20'), SNIPER, MG)).toEqual([]);
    expect(variantEntryFails(cand({}, { flow: flow(32, 14) }), v('buyers35'), SNIPER, MG).length).toBeGreaterThan(0);
  });

  it('the score margin variant changes the verdict', () => {
    const c = cand({}, { flow: flow(40, 20), score: 63 }); // 3 over the bar: live needs 8
    expect(variantEntryFails(c, v(LIVE_ID), SNIPER, MG).some((f) => f.startsWith('score'))).toBe(true);
    expect(variantEntryFails(c, v('margin0'), SNIPER, MG)).toEqual([]);
  });

  it('a momentum override re-runs the gate on the shape', () => {
    const c = cand({ ruleFails: ['momentum gate: chasing: +35% in 3 min (max 30%)'], shape: { run1m: 5, run3m: 35, offHigh10m: 4, buyShare2m: 0.7, lastCandlePct: 3 } }, { flow: flow(40, 20), momentumGateWhy: 'chasing: +35% in 3 min (max 30%)' });
    expect(isCandidate(c)).toBe(true);
    expect(variantEntryFails(c, v(LIVE_ID), SNIPER, MG).some((f) => f.startsWith('momentum'))).toBe(true);
    expect(variantEntryFails(c, v('run3m45'), SNIPER, MG)).toEqual([]);
  });

  it('only momentum-gate rule fails keep a coin a candidate; hard fails never', () => {
    expect(isCandidate(cand({ ruleFails: ['bundlers hold 30% > 18%'] }))).toBe(false);
    expect(isCandidate(cand({ hardFail: true }))).toBe(false);
  });

  it('exit overrides rebuild the sniper overlay and layer exit.* keys', () => {
    const live = DEFAULT_CONFIG.exit as never;
    const r = variantExitRules(live, v('stop16'), SNIPER.exits) as unknown as { stopLoss: { maxPct: number } };
    expect(r.stopLoss.maxPct).toBe(16);
    const g = variantExitRules(live, v('noGrowth'), SNIPER.exits) as unknown as { holderGrowth: { enabled: boolean } };
    expect(g.holderGrowth.enabled).toBe(false);
    const tp = variantExitRules(live, v('tpFast'), SNIPER.exits) as unknown as { takeProfitTiers: Array<{ multiple: number }> };
    expect(tp.takeProfitTiers.map((t) => t.multiple)).toEqual([1.3, 2, 4]);
    expect(nestPrefixed({ 'exit.a.b': 1, 'sniper.x': 2 }, 'exit.')).toEqual({ a: { b: 1 } });
  });
});

const fakeRedis = () => {
  const lists = new Map<string, string[]>();
  const kv = new Map<string, string>();
  const r = {
    lrange: async (k: string, a: number, b: number) => (lists.get(k) ?? []).slice(a, b + 1),
    set: async (k: string, val: string) => void kv.set(k, val),
    multi: () => {
      const ops: Array<() => void> = [];
      const m = {
        lpush: (k: string, val: string) => (ops.push(() => lists.set(k, [val, ...(lists.get(k) ?? [])])), m),
        ltrim: (k: string, a: number, b: number) => (ops.push(() => lists.set(k, (lists.get(k) ?? []).slice(a, b + 1))), m),
        exec: async () => ops.forEach((f) => f()),
      };
      return m;
    },
  };
  return { redis: r as unknown as Redis, lists };
};
const crowd = { trades: () => [] } as unknown as CrowdTracker;

describe('the tournament book', () => {
  it('opens once per coin per variant per 30 min and evicts the oldest of the fullest variant', () => {
    const { redis } = fakeRedis();
    const t = new Tournament(redis, crowd, () => 0.99);
    const c = cand({}, { flow: flow(40, 20), score: 75 }); // every non-random variant buys
    const n1 = t.onCandidate(c, 1_000_000);
    expect(n1).toBeGreaterThan(5);
    expect(t.onCandidate(c, 1_000_000 + 10 * 60_000)).toBe(0);
    expect(t.onCandidate(c, 1_000_000 + 31 * 60_000)).toBe(n1);
  });

  it('eviction picks the oldest of the most crowded variant', () => {
    const open = new Map([
      ['a:1', { variant: 'a', openedAt: 5 }],
      ['b:1', { variant: 'b', openedAt: 1 }],
      ['b:2', { variant: 'b', openedAt: 3 }],
    ]);
    expect(evictionKey(open)).toBe('b:1');
  });

  it('the random yardstick buys 1 in randomEvery scored coins regardless of the rules', () => {
    const { redis } = fakeRedis();
    const lowRng = new Tournament(redis, crowd, () => 0);
    expect(lowRng.onCandidate(cand({ ruleFails: ['bundlers hold 30% > 18%'] }), 1)).toBe(1); // only random
    const highRng = new Tournament(redis, crowd, () => 0.5);
    expect(highRng.onCandidate(cand({ ruleFails: ['bundlers hold 30% > 18%'] }), 1)).toBe(0);
  });
});

describe('judging (Benjamini–Hochberg vs the baseline)', () => {
  const noisy = (n: number, mean: number, seed: number) => Array.from({ length: n }, (_, i) => mean + 20 * Math.sin(seed * 7.13 + i * 1.7));
  const vs: TournamentVariant[] = [
    { id: LIVE_ID, name: 'live', entryOverrides: {}, exitOverrides: {} },
    { id: RANDOM_ID, name: 'random', entryOverrides: {}, exitOverrides: {}, random: true },
    { id: 'good', name: 'good', entryOverrides: { 'sniper.volume.minBuyers': 20 }, exitOverrides: {} },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `noise${i}`, name: `noise ${i}`, entryOverrides: { 'sniper.volume.minBuySol': 8 + i }, exitOverrides: {} })),
  ];
  const C = { minResults: 40, q: 0.1, beatLiveByPts: 2 };

  it('finds the true winner and not the noise', () => {
    const rows = new Map<string, number[]>([[LIVE_ID, noisy(120, -3, 1)], [RANDOM_ID, noisy(120, -6, 2)], ['good', noisy(120, 9, 3)]]);
    for (let i = 0; i < 8; i++) rows.set(`noise${i}`, noisy(120, -3, 10 + i));
    const j = judge(vs, rows, C);
    expect(j.baseline).toBe(LIVE_ID);
    expect(j.rows.find((r) => r.id === 'good')!.status).toBe('winner');
    expect(j.rows.filter((r) => r.id.startsWith('noise')).every((r) => r.status !== 'winner')).toBe(true);
  });

  it('too few results never win; when live hardly trades, random is the baseline', () => {
    const rows = new Map<string, number[]>([[LIVE_ID, noisy(3, 0, 1)], [RANDOM_ID, noisy(80, -6, 2)], ['good', noisy(20, 30, 3)]]);
    const j = judge(vs, rows, C);
    expect(j.baseline).toBe(RANDOM_ID);
    expect(j.rows.find((r) => r.id === 'good')!.status).toBe('too few');
  });

  it('offers only single editable keys', () => {
    const variants: TournamentVariant[] = [...vs, { id: 'combo', name: 'combo', entryOverrides: { 'sniper.volume.minBuyers': 20, 'sniper.minScoreMargin': 0 }, exitOverrides: {} }, { id: 'tp', name: 'tp', entryOverrides: {}, exitOverrides: { 'sniper.exits.takeProfitTiers': [] } }];
    const judged = [
      { id: 'good', status: 'winner', keys: ['sniper.volume.minBuyers'], avgPnlPct: 9 },
      { id: 'combo', status: 'winner', keys: ['sniper.volume.minBuyers', 'sniper.minScoreMargin'], avgPnlPct: 10 },
      { id: 'tp', status: 'winner', keys: ['sniper.exits.takeProfitTiers'], avgPnlPct: 8 },
    ] as never;
    const offers = offersFor(variants, judged);
    expect(offers).toContainEqual({ variant: 'good', key: 'sniper.volume.minBuyers', value: 20 });
    expect(offers).toContainEqual({ variant: 'combo', key: 'sniper.volume.minBuyers', value: 20 });
    expect(offers.find((o) => o.variant === 'tp')).toHaveProperty('skip');
  });
});

describe('a winner reaches the self-improving loop as exactly one proposal', () => {
  it('offer → validated, queued, and the next run proves THAT key first', async () => {
    let stored: string | null = null;
    const replays: string[][] = [];
    const now = Date.UTC(2026, 9, 20, 12);
    const values: Record<string, unknown> = { 'sniper.volume.minBuyers': 30 };
    const report = (trades: number, totalSol: number, avgPct: number, pf: number | null) => ({ trades, totalSol, avgPct, profitFactor: pf, winRatePct: 50 }) as unknown as ReplayReport;
    const deps: LoopDeps = {
      cfg: () => DEFAULT_LOOP,
      current: (k) => values[k],
      health: () => ({ minutesSinceEntry: 30, strategies: [] }),
      runReplay: async (set) => (replays.push(set), set.length ? report(12, 0.8, 6, 1.8) : report(4, 0.1, 2, 1.1)),
      replayRunning: () => false,
      tapeStartMs: async () => now - 3 * 86_400_000,
      apply: async (key, value) => ((values[key] = value), { ok: true }),
      liveTrades: async () => [],
      load: async () => stored,
      save: async (raw) => void (stored = raw),
      liveMode: () => false,
      now: () => now,
    };
    const loop = new SelfLoop(deps);
    expect((await loop.offer({ key: 'sniper.enabled', value: false, source: 'tournament', evidence: 'x' })).queued).toBe(false);
    expect((await loop.offer({ key: 'sniper.volume.minBuyers', value: 20, source: 'tournament', evidence: 'won 40 trades' })).queued).toBe(true);
    expect((await loop.state()).offers).toHaveLength(1);
    const r = await loop.runOnce(true);
    expect(r.ran).toBe(true);
    expect(replays).toEqual([[], ['sniper.volume.minBuyers=20']]);
    const s = await loop.state();
    expect(s.current?.source).toBe('tournament');
    expect(s.offers).toHaveLength(0);
  });
});
