import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { blockReason, filterCoverage, missingInput, moodCanBlock, RISK_TRADE, type FilterEnv } from '../src/forex/filters';
import { riskOfLong, buildMood } from '../src/forex/mood';
import { buildStrength } from '../src/forex/strength';
import { FX_FAST, FastLab, liveCoverage, testedCoverage, type FastReport, type FastSource } from '../src/forex/fast';
import { ForexLab, type MarketBook } from '../src/forex/lab';
import type { LabOpenTrade, Practice } from '../src/forex/practice';
import { INSTRUMENTS, STRENGTH_PAIRS, type Bar } from '../src/forex/types';

const M = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
/** a Wednesday 14:00:30 UTC: forex open, not the rollover, not the first 2 h of the week */
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);

/** a filter env for `pair` with `n` bars: strength gap known (0.5), mood unknown unless given */
function env(pair: string, n: number, o: { gap?: number; mood?: number } = {}): FilterEnv {
  return { tf: '1m', gap: new Float64Array(n).fill(o.gap ?? 0.5), h4: new Int8Array(n), d1: new Int8Array(n), mood: new Float64Array(n).fill(o.mood ?? NaN), riskLong: riskOfLong(pair) };
}
const FULL = { gap: 1, mood: 1 };
const minuteBars = (n: number, end: number): Bar[] => Array.from({ length: n }, (_, i) => ({ t: end - (n - i) * M, o: 1, h: 1, l: 1, c: 1 }));

afterEach(() => {
  FX_FAST.tfs = ['15m'];
});

describe('missing mood data on pairs the mood check cannot block (v17 review)', () => {
  it('EURGBP / AUDNZD never wait on missing mood (mood or all); risk pairs still do', () => {
    for (const pair of ['EURGBP', 'AUDNZD']) {
      expect(Math.abs(riskOfLong(pair))).toBeLessThanOrEqual(RISK_TRADE);
      expect(missingInput('mood', env(pair, 10), 9, FULL)).toBeNull();
      expect(missingInput('all', env(pair, 10), 9, FULL)).toBeNull();
    }
    for (const pair of ['AUDJPY', 'USDJPY', 'EURUSD']) {
      expect(missingInput('mood', env(pair, 10), 9, FULL)).toMatch(/market mood/);
      expect(missingInput('all', env(pair, 10), 9, FULL)).toMatch(/market mood/);
      // mood known → nothing missing
      expect(missingInput('mood', env(pair, 10, { mood: 0.2 }), 9, FULL)).toBeNull();
    }
  });

  it("'all' still checks its other inputs on a low-exposure pair", () => {
    expect(missingInput('all', env('EURGBP', 10, { gap: NaN }), 9, FULL)).toMatch(/currency strength/);
    expect(missingInput('all', env('AUDNZD', 10, { gap: NaN }), 9, FULL)).toMatch(/currency strength/);
  });

  it('skips mood exactly when the mood check can never block (no drift from passMood)', () => {
    const pairs = [...INSTRUMENTS.map((x) => x.id), ...STRENGTH_PAIRS.map((x) => x.id)];
    const grid = [-2, -1, -0.6, -0.41, -0.4, -0.2, 0, 0.2, 0.4, 0.41, 0.6, 1, 2];
    const envs = [...pairs.map((p) => env(p, 1)), ...grid.map((r) => ({ ...env('EURUSD', 1), riskLong: r }))];
    for (const e of envs) {
      let blocks = false;
      for (const m of [-3, -1, -0.5, 0, 0.5, 1, 3]) for (const side of [1, -1] as const) if (blockReason('mood', { ...e, mood: Float64Array.of(m) }, 0, side) !== null) blocks = true;
      expect(moodCanBlock(e)).toBe(blocks);
      expect(moodCanBlock(e)).toBe(Math.abs(e.riskLong) > RISK_TRADE);
      expect(missingInput('mood', e, 0, FULL) !== null).toBe(blocks);
    }
  });
});

describe('fast charts: missing-data guard uses the tested history (v17 review)', () => {
  it('stored coverage = the bars before the chart oosFrom only', () => {
    const bars = minuteBars(100, WED);
    const e = env('EURUSD', 100, { mood: 0.1 });
    for (let i = 0; i < 10; i++) e.gap[i] = NaN; // strength warming up at the start
    for (let i = 70; i < 100; i++) e.mood[i] = NaN; // mood feed down in the unseen 30%
    const se = { ctx: { bars }, env: e } as unknown as Parameters<typeof testedCoverage>[0];
    const oosFrom = bars[70]!.t;
    const c = testedCoverage(se, oosFrom);
    expect(c.mood).toBe(1);
    expect(c.gap).toBeCloseTo(60 / 70, 10);
    // the whole history would have said 70% (under the bar)
    expect(filterCoverage(e, 100).mood).toBeCloseTo(0.7, 10);
    // oosFrom past the history → all of it (as the hourly lab)
    expect(testedCoverage(se, WED + DAY).mood).toBeCloseTo(0.7, 10);
  });

  it('a live window with hours of missing mood does NOT switch the guard off when coverage is stored', () => {
    // 2,000 live 1-minute bars, mood missing for the last 17 h → the live window's first 70% is only ~70% covered
    const n = 2_000;
    const bars = minuteBars(n, WED);
    const e = env('EURUSD', n, { mood: 0.1 });
    for (let i = n - 17 * 60; i < n; i++) e.mood[i] = NaN;
    const se = { ctx: { bars }, env: e } as unknown as Parameters<typeof liveCoverage>[3];
    // old behaviour: the live window's own first 70% → under 80% → the guard switched itself off
    const old = liveCoverage(null, '1m', 'EURUSD', se);
    expect(old.mood!).toBeLessThan(0.8);
    expect(missingInput('mood', e, n - 1, old)).toBeNull();
    // stored with the hourly test (mood was there on the tested first 70%) → the untested trade waits
    const rep: Pick<FastReport, 'coverage'> = { coverage: { '1m': { EURUSD: { gap: 1, mood: 1 } } } };
    const cov = liveCoverage(rep, '1m', 'EURUSD', se);
    expect(cov).toEqual({ gap: 1, mood: 1 });
    expect(missingInput('mood', e, n - 1, cov)).toMatch(/market mood/);
    expect(missingInput('all', e, n - 1, cov)).toMatch(/market mood/);
  });

  it('no stored coverage (old report, another chart or market) → the live-window behaviour as before', () => {
    const n = 1_000;
    const bars = minuteBars(n, WED);
    const e = env('EURUSD', n, { mood: 0.1 });
    for (let i = 900; i < n; i++) e.mood[i] = NaN;
    const se = { ctx: { bars }, env: e } as unknown as Parameters<typeof liveCoverage>[3];
    const before = filterCoverage(e, Math.floor(n * 0.7));
    expect(liveCoverage(undefined, '1m', 'EURUSD', se)).toEqual(before);
    expect(liveCoverage({}, '1m', 'EURUSD', se)).toEqual(before);
    expect(liveCoverage({ coverage: { '15m': { EURUSD: { mood: 0 } } } }, '1m', 'EURUSD', se)).toEqual(before);
    expect(liveCoverage({ coverage: { '1m': { GBPUSD: { mood: 0 } } } }, '1m', 'EURUSD', se)).toEqual(before);
    // the live window's first 70% had mood → the guard still works the old way
    expect(missingInput('mood', e, n - 1, liveCoverage(undefined, '1m', 'EURUSD', se))).toMatch(/market mood/);
  });

  class MiniRedis {
    m = new Map<string, string>();
    async get(k: string) {
      return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
      this.m.set(k, v);
      return 'OK';
    }
    async mget(...ks: string[]) {
      return ks.map((k) => this.m.get(k) ?? null);
    }
  }
  function walk(n: number, end: number, barMs: number, start: number, seed: number): Bar[] {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    let px = start;
    return Array.from({ length: n }, (_, i) => {
      const o = px;
      const c = o * (1 + (rnd() - 0.5) * 0.0012 + Math.sin(i / 120) * 0.0002);
      px = c;
      return { t: end - (n - i) * barMs, o, h: Math.max(o, c) * (1 + rnd() * 0.0004), l: Math.min(o, c) * (1 - rnd() * 0.0004), c };
    });
  }

  it('end to end: the hourly fast test stores it, the live check reads it (and falls back without it)', async () => {
    FX_FAST.tfs = ['15m', '1m']; // v18.8: the 1-minute chart is off by default — this test exercises it on purpose
    const redis = new MiniRedis();
    const lab = new ForexLab(redis as unknown as Redis);
    const pairs = INSTRUMENTS.slice(0, 2); // EURUSD, GBPUSD: both clear risk trades, so mood matters
    const h1 = new Map<string, Bar[]>();
    for (const inst of pairs) h1.set(inst.id, walk(600, WED - 30_000, H, inst.id === 'EURUSD' ? 1.1 : 1.27, 5));
    // S&P hourly up to ~4 days + 17 h before now: mood stays valid 4 days after its last reading → missing for the
    // newest ~17 h (the feed has been down), known before that
    const spxEnd = WED - 4 * DAY - 18 * H;
    const spx: Bar[] = Array.from({ length: 240 }, (_, i) => ({ t: spxEnd - (239 - i) * H, o: 5000, h: 5000, l: 5000, c: 5000 + (i % 7) }));
    const book: MarketBook = { at: WED - 10 * M, strength: buildStrength({}), mood: buildMood({ SPX: spx }), ranks: {}, zOil: null, zYield: null, zStocks: null, zDollar: null, spxMtd: null, h1 };
    lab.book = book;
    const sync = vi.fn(async () => [] as string[]);
    lab.practice = { syncBot: sync, botResults: async () => ({}), heldRefs: async () => [] } as unknown as Practice;
    // 4,000 one-minute candles (≈ 67 h): the tested first 70% ends ≈ 20 h ago, mood went missing ≈ 17 h ago
    const data: Record<string, Bar[]> = {};
    for (const [k, inst] of pairs.entries()) data[inst.id] = walk(4_000, WED - 30_000, M, inst.id === 'EURUSD' ? 1.1 : 1.27, 31 + k);
    const src: FastSource = { oanda: async () => false, bars: async (inst, tf, fromT) => ({ bars: tf === '1m' ? (data[inst.id] ?? []).filter((b) => b.t >= fromT) : [], source: 'yahoo' }) };
    const fast = new FastLab(redis as unknown as Redis, lab, src);
    await fast.refresh('1m', WED);
    const rep = await fast.evaluate(WED);
    expect(rep).not.toBeNull();
    const cov = rep!.coverage?.['1m'];
    expect(cov && Object.keys(cov).sort()).toEqual(['EURUSD', 'GBPUSD']);
    // computed on the bars before this chart's oosFrom: mood was there for all of them, although the whole tested
    // history (and the live window) misses the newest ~17 h
    expect(cov!.EURUSD!.mood).toBeGreaterThan(0.99);
    expect(rep!.coverage?.['15m']).toBeUndefined();
    // persisted with the report
    expect((JSON.parse(redis.m.get('fx:fast:report')!) as FastReport).coverage?.['1m']?.EURUSD?.mood).toBe(cov!.EURUSD!.mood);

    // every 1m strategy traded WITH the mood filter (as if picked on the first 70%)
    fast.report = { ...rep!, rows: rep!.rows.filter((r) => r.tf === '1m' && r.id !== 'random').map((r) => ({ ...r, filter: 'mood' as const, verdict: 'edge' as const })) };
    const labOpen = (k: number) => (sync.mock.calls[k] as unknown as [LabOpenTrade[]])[0];
    await fast.decide('1m', WED);
    expect(sync).toHaveBeenCalledTimes(1);
    const waits = labOpen(0).filter((t) => /market mood/.test(t.dataWait ?? ''));
    expect(labOpen(0).length).toBeGreaterThan(0);
    expect(waits.length).toBeGreaterThan(0);

    // an old report without stored coverage → the live window's own first 70% (mood under 80% there) → as before
    fast.report = { ...fast.report, coverage: undefined };
    await fast.decide('1m', WED);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(labOpen(1).length).toBe(labOpen(0).length);
    expect(labOpen(1).some((t) => t.dataWait)).toBe(false);
  }, 120_000);
});
