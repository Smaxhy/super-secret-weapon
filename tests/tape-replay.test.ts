import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { overrideConfig } from '../src/config/runtime-config';
import { retentionCutoff, shouldFlush, withinMinuteCap } from '../src/learner/tape-recorder';
import { policyByName, Replay, type TapeRow, type TapeToken } from '../src/learner/replay';
import { buildArgs } from '../src/learner/replay-runner';
import { parseArgs, parseSets } from '../src/learner/replay-cli';

describe('tape recorder (pure parts)', () => {
  it('flushes on a full batch or when the interval passed with rows waiting', () => {
    const c = { flushSec: 2, maxBatch: 100 };
    expect(shouldFlush(0, 0, 10_000, c)).toBe(false);
    expect(shouldFlush(5, 9_000, 10_000, c)).toBe(false);
    expect(shouldFlush(5, 7_000, 10_000, c)).toBe(true);
    expect(shouldFlush(100, 9_900, 10_000, c)).toBe(true);
  });
  it('retention cutoff and the per-minute disk guard', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(retentionCutoff(now, 5).toISOString()).toBe('2026-10-12T12:00:00.000Z');
    expect(retentionCutoff(now, 0).toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(withinMinuteCap(1, 10)).toBe(true);
    expect(withinMinuteCap(10, 10)).toBe(true);
    expect(withinMinuteCap(11, 10)).toBe(false);
    expect(withinMinuteCap(1_000_000, 0)).toBe(true);
  });
  it('tape config is on by default with a bounded footprint', () => {
    expect(DEFAULT_CONFIG.tape).toMatchObject({ enabled: true, retentionDays: 5, flushSec: 2, maxBatch: 5000 });
  });
});

describe('replay CLI args', () => {
  it('--set key=value becomes a nested config patch (numbers / booleans / JSON parsed)', () => {
    expect(parseSets(['exit.stopLoss.maxPct=10', 'trading.quietHours.enabled=false', 'exit.takeProfitTiers=[{"multiple":2,"sellPct":50}]', 'x=text'])).toEqual({
      exit: { stopLoss: { maxPct: 10 }, takeProfitTiers: [{ multiple: 2, sellPct: 50 }] },
      trading: { quietHours: { enabled: false } },
      x: 'text',
    });
  });
  it('defaults to the last 24 h with the live policy', () => {
    const now = Date.parse('2026-10-18T00:00:00Z');
    const a = parseArgs([], now);
    expect(a.to).toBe(now);
    expect(a.from).toBe(now - 86_400_000);
    expect(a.policy).toBe('live');
    const b = parseArgs(['--from', '2026-10-17', '--to', '2026-10-17T12:00:00Z', '--policy', 'sniper', '--set', 'a.b=1', '--sol-usd', '120'], now);
    expect(b.from).toBe(Date.parse('2026-10-17'));
    expect(b.to).toBe(Date.parse('2026-10-17T12:00:00Z'));
    expect(b.policy).toBe('sniper');
    expect(b.set).toEqual({ a: { b: 1 } });
    expect(b.solUsd).toBe(120);
  });
  it('the API builds safe child-process args', () => {
    const args = buildArgs({ from: '2026-10-17T00:00:00Z', policy: 'nope', set: { 'exit.stopLoss.maxPct': 10, 'bad key': 1 } }, 'id1');
    expect(args).toEqual(['--id', 'id1', '--from', '2026-10-17T00:00:00Z', '--policy', 'live', '--set', 'exit.stopLoss.maxPct=10']);
  });
});

/** A synthetic tape: one coin that runs 1.0 → 2.0 with organic buyers, one that bleeds out. */
function synthTape(): { rows: TapeRow[]; tokens: Map<string, TapeToken>; from: number; to: number } {
  const t0 = Date.parse('2026-10-17T10:00:00Z');
  const rows: TapeRow[] = [];
  const tokens = new Map<string, TapeToken>();
  const mk = (mint: string, symbol: string, createdAt: number) => tokens.set(mint, { mint, symbol, name: symbol, creator: 'dev' + symbol, createdAtMs: createdAt, completedAtMs: createdAt - 3_600_000 });
  const wallet = (i: number) => `w${i.toString(36).padStart(4, '0')}`;
  // RUN: migrated coin, ~12 SOL MC at $150 → MC ≈ price × 1e9 × 150; start price 3e-7 SOL (MC ≈ $45k).
  mk('RUN', 'RUN', t0 - 2 * 3_600_000);
  let p = 3e-7;
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 2400; i++) {
    const t = t0 + i * 500;
    const buy = rnd() < 0.68;
    const sol = 0.05 + rnd() * 0.9;
    p *= buy ? 1 + 0.0007 + rnd() * 0.0006 : 1 - 0.0004 - rnd() * 0.0005;
    rows.push({ mint: 'RUN', t, w: wallet(Math.floor(rnd() * 400)), buy, sol, tok: sol / p, px: p, pp: p, amm: true });
  }
  // BLEED: same start, more sellers than buyers, price drifts down 60%.
  mk('BLEED', 'BLEED', t0 - 2 * 3_600_000);
  let q = 3e-7;
  for (let i = 0; i < 2400; i++) {
    const t = t0 + i * 500 + 250;
    const buy = rnd() < 0.42;
    const sol = 0.05 + rnd() * 0.6;
    q *= buy ? 1 + 0.0002 + rnd() * 0.0003 : 1 - 0.0006 - rnd() * 0.0006;
    rows.push({ mint: 'BLEED', t, w: wallet(1000 + Math.floor(rnd() * 300)), buy, sol, tok: sol / q, px: q, pp: q, amm: true });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, tokens, from: t0, to: t0 + 2400 * 500 + 60_000 };
}

describe('replay engine on a synthetic tape', () => {
  // Test runs have no DB: a tape score with neutral safety features only clears the bar when the market gates are
  // loose, so the entry rules that need RPC / socials are relaxed to what the tape can show.
  overrideConfig({
    trading: { enabledStrategies: { MIGRATION_MOMENTUM: true, CURVE_SNIPE: false, SOON: false }, maxPositionSol: 0.2 },
    entry: { minCombinedScore: 25, pressure: { enabled: false }, feesByMarketCap: { enabled: false } },
    focus: { migrated: { minTotalFeesSol: 0, minMarketCapUsd: 10_000, minActiveWallets5m: 5, noEntryFirstSec: 0, scoreThresholdDelta: 0, scan: { minOrganicBuyers5m: 5, minOrganicBuySol5m: 1, minBuySharePct: 50, minOrganicPct: 30, maxRun3mPct: 60 } } },
    ownerFilters: { migrated: { minMarketCapUsd: 10_000, minHolders: 5, minLiquidityUsd: 0, minTotalFeesSol: 0 } },
    momentumGate: { enabled: false },
    entryQuality: { enabled: false },
    exit: { priceAction: { enabled: false } },
  });
  const tape = synthTape();

  it('buys the runner at a checkpoint and the exits bank a profit; the bleeder is skipped or cut', () => {
    const engine = new Replay({ policy: policyByName('live'), tokens: tape.tokens, solUsd: 150, from: tape.from, to: tape.to });
    for (let i = 0; i < tape.rows.length; i += 1000) engine.feed(tape.rows.slice(i, i + 1000));
    const r = engine.finish('test');
    expect(r.rows).toBe(tape.rows.length);
    expect(r.coins).toBe(2);
    expect(r.evaluated).toBeGreaterThan(10);
    expect(r.trades).toBeGreaterThanOrEqual(1);
    const run = r.byStrategy.find((s) => s.strategy === 'MIGRATION_MOMENTUM');
    expect(run).toBeDefined();
    const best = r.best[0]!;
    expect(best.symbol).toBe('RUN');
    expect(best.pnlPct).toBeGreaterThan(5);
    expect(r.totalSol).toBeGreaterThan(0);
    for (const t of r.worst) if (t.symbol === 'BLEED') expect(t.pnlPct).toBeLessThan(0);
    expect(r.skips.length).toBeGreaterThan(0);
    expect(r.note).toContain('Not replayed');
    expect(r.policy).toBe('live');
    expect(typeof r.winRatePct).toBe('number');
  });

  it('a --set override changes the rules and the result (an impossible bar → no trades)', () => {
    overrideConfig({ entry: { minCombinedScore: 150 } });
    const engine = new Replay({ policy: policyByName('live'), tokens: tape.tokens, solUsd: 150, from: tape.from, to: tape.to });
    engine.feed(tape.rows);
    const r = engine.finish('test2');
    expect(r.trades).toBe(0);
    expect(r.skips.some((s) => s.reason.includes('score under the bar'))).toBe(true);
    overrideConfig({ entry: { minCombinedScore: 25 } });
  });

  it('the sniper placeholder policy layers its exits and size over every strategy', () => {
    const p = policyByName('sniper');
    expect(p.name).toBe('sniper');
    const o = p.overrides as { trading: { maxPositionSol: number }; exit: { takeProfitTiers: Array<{ multiple: number }>; byStrategy: Record<string, { stopLoss: { maxPct: number } }> } };
    expect(o.trading.maxPositionSol).toBeGreaterThan(0);
    expect(o.exit.takeProfitTiers.map((x) => x.multiple)).toEqual([1.5, 2.5, 5]);
    expect(o.exit.byStrategy.SOON.stopLoss.maxPct).toBe(12);
    expect(p.entry?.({ score: 60, threshold: 65 } as never)).toContain('sniper');
    expect(p.entry?.({ score: 80, threshold: 65 } as never)).toBeNull();
  });
});
