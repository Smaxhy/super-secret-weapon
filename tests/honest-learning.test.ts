import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, type FeatureName } from '../src/config/default';
import { holdoutCheck, type TuningSample } from '../src/learner/weight-tuning';
import { judgeLossExits, lossExitKind, type LossExitAfter } from '../src/learner/exit-tuner';
import { scoreInversions, strategyCards, type ClosedTrade } from '../src/learner/loss-autopsy';

const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
const s = (holders: number, win: boolean, extra: Partial<TuningSample> = {}): TuningSample => ({ features: { holders } as Partial<Record<FeatureName, number>>, win, ...extra });
const strict = { rejectWhenSkipped: true, minAucGain: 0.005, strategyMinPerClass: 8, maxStrategyDrop: 0.02, minTradeSamples: 20 };

describe('weight learner: keep the current weights unless the new ones are measurably better', () => {
  it('keeps the current weights on a thin holdout (no blind accept)', () => {
    const v = holdoutCheck({ ...DEFAULT_WEIGHTS }, { ...DEFAULT_WEIGHTS, holders: 0.3 }, many(20, () => s(1, true)), 5, strict);
    expect(v.accepted).toBe(false);
    expect(v.skipped).toMatch(/holdout has 20 winners \/ 0 losers/);
  });
  it('keeps the current weights when the new ones only tie', () => {
    const holdout = [...many(20, () => s(0.9, true)), ...many(20, () => s(0.2, false))];
    const v = holdoutCheck({ ...DEFAULT_WEIGHTS }, { ...DEFAULT_WEIGHTS }, holdout, 5, strict);
    expect(v.accepted).toBe(false);
  });
  it('accepts a real improvement and rejects one that makes a strategy worse', () => {
    // SOON: holders predicts the win; RUNNER: holders predicts the LOSS. Old weights ignore holders.
    const old = { ...DEFAULT_WEIGHTS, holders: 0.0001 };
    const up = { ...DEFAULT_WEIGHTS, holders: 0.6 };
    const soon = [...many(30, (i) => s(0.9, true, { strategy: 'SOON', features: { holders: 0.9, snipers: (i % 5) / 5 } })), ...many(30, (i) => s(0.1, false, { strategy: 'SOON', features: { holders: 0.1, snipers: (i % 5) / 5 } }))];
    expect(holdoutCheck(old, up, soon, 5, strict).accepted).toBe(true);
    const runner = [...many(10, (i) => ({ strategy: 'RUNNER', win: true, features: { holders: 0.1, snipers: (i % 5) / 5 } }) as TuningSample), ...many(10, (i) => ({ strategy: 'RUNNER', win: false, features: { holders: 0.9, snipers: (i % 5) / 5 } }) as TuningSample)];
    const v = holdoutCheck(old, up, [...soon, ...runner], 5, strict);
    expect(v.accepted).toBe(false);
    expect(v.why).toMatch(/RUNNER got worse/);
  });
  it('rejects weights whose picks earn less on real trades after costs', () => {
    // Ranks wins better, but the real trades it would pick (high holders) lost money.
    const labels = [...many(30, () => s(0.9, true)), ...many(30, () => s(0.1, false))];
    const trades = [...many(12, () => s(0.1, false, { pnlPct: 15 })), ...many(12, () => s(0.9, true, { pnlPct: -8 }))];
    const v = holdoutCheck({ ...DEFAULT_WEIGHTS, holders: 0.0001 }, { ...DEFAULT_WEIGHTS, holders: 0.6 }, [...labels, ...trades], 5, strict);
    expect(v.accepted).toBe(false);
    expect(v.why).toMatch(/earned less after costs/);
    expect(v.tradePnl?.n).toBe(24);
  });
});

describe('loss exits: was the stop / rug exit right?', () => {
  it('reads the kind of exit from the sell text', () => {
    expect(lossExitKind('STOP_LOSS', 'price -17.2% held under the −15% stop (after fees) for 2s')).toEqual({ kind: 'stop_soft', stopPct: 15 });
    expect(lossExitKind('STOP_LOSS', 'price -40.0% — past the −35% disaster limit inside the 5-min hold')).toEqual({ kind: 'stop_disaster', stopPct: 35 });
    expect(lossExitKind('RUG_DETECTED', 'one wallet dumped it: −31% in 20s, 1 seller dumped 4.0 SOL vs 0.2 bought')?.kind).toBe('rug_solo');
    expect(lossExitKind('RUG_DETECTED', 'crash: −35% in 90s, 6 sellers dumped 9.1 SOL vs 1.0 bought')?.kind).toBe('rug_crash');
    expect(lossExitKind('RUG_DETECTED', 'top holders dumped 5.1% of the supply since we bought (3 sold half or more)')?.kind).toBe('rug_holders');
    expect(lossExitKind('TRAILING_STOP', 'x')).toBeNull();
  });
  const row = (kind: LossExitAfter['kind'], maxAfterX: number, endX: number, extra: Partial<LossExitAfter> = {}): LossExitAfter => ({ id: Math.random().toString(), strategy: 'SOON', kind, closedAtMs: 0, exitX: 0.75, pnlPct: -27, stopPct: null, maxAfterX, minAfterX: 0.5, endX, trades: 20, ...extra });
  const c = { minExits: 15, falseAlarmPct: 40, maxDiedPct: 30, lateOvershootPts: 5 };
  it('flags a twitchy rug exit (coins came back above our entry)', () => {
    const v = judgeLossExits([...many(10, () => row('rug_solo', 1.5, 1.2)), ...many(6, () => row('rug_solo', 1.0, 0.8))], c)[0]!;
    expect(v.verdict).toBe('false_alarm');
  });
  it('confirms a rug exit that saved money and flags stops that land too far past the stop', () => {
    expect(judgeLossExits(many(16, () => row('rug_crash', 1.0, 0.2)), c)[0]!.verdict).toBe('good');
    const late = judgeLossExits(many(16, () => row('stop_soft', 1.0, 0.9, { stopPct: 15, pnlPct: -24 })), c)[0]!;
    expect(late.verdict).toBe('late');
    expect(late.overshootPts).toBe(9);
  });
});

describe('strategy cards: does each strategy deserve to run?', () => {
  const t = (strategy: string, pnlPct: number, i: number, peak = 1.0, score: number | null = null): ClosedTrade => ({
    strategy, pnlPct, pnlSol: pnlPct / 100, sizeSol: 1, exitReason: 'X', peakMultiple: peak, heldMin: 5, explore: false, mcUsd: null, ageMin: null, curvePct: null, score, hourUtc: 0, closedAtMs: i,
  });
  it('a lucky moonshot does not make a losing strategy profitable', () => {
    const lucky = [...many(37, (i) => t('SOON', -6, i)), t('SOON', 400, 40), t('SOON', 300, 41), t('SOON', 200, 42)];
    const k = strategyCards(lucky)[0]!;
    expect(k.avgPct).toBeGreaterThan(0);
    expect(k.withoutTop3Pct).toBeLessThan(0);
    expect(k.verdict).not.toBe('profitable');
  });
  it('separates a profitable strategy from a losing one', () => {
    const cards = strategyCards([...many(40, (i) => t('RUNNER', i % 4 === 0 ? -10 : 12, i, 1.3)), ...many(40, (i) => t('SOON', i % 4 === 0 ? 10 : -12, i, 1.0))]);
    expect(cards.find((k) => k.strategy === 'RUNNER')!.verdict).toBe('profitable');
    const soon = cards.find((k) => k.strategy === 'SOON')!;
    expect(soon.verdict).toBe('losing');
    expect(soon.why).toMatch(/bad entries/);
  });
  it('notices when a higher score band does worse', () => {
    const ts = [...many(20, (i) => t('SOON', i % 2 ? 8 : 4, i, 1, 75)), ...many(20, (i) => t('SOON', i % 2 ? -10 : -6, i, 1, 85))];
    expect(scoreInversions(ts, 15)[0]).toMatch(/score 80–90 averages -8% vs 6% for score 70–80/);
  });
});

describe('migrated coins have their own safety minimum', () => {
  it('40 for migrated coins, 45 for SOON (v10.31), the general 55 for everything else', async () => {
    const { strategyMinimums } = await import('../src/evaluator/scorer');
    const { DEFAULT_CONFIG } = await import('../src/config/default');
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'MIGRATION_MOMENTUM').minSafetyScore).toBe(40);
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'CURVE_SNIPE').minSafetyScore).toBe(55);
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'SOON').minSafetyScore).toBe(45);
  });
  it('v10.31 holder minimums: new pairs 8, SOON 35, others keep their strategy number', async () => {
    const { checkEntryRules, strategyMinimums } = await import('../src/evaluator/scorer');
    const { DEFAULT_CONFIG } = await import('../src/config/default');
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'CURVE_SNIPE').minHolders).toBe(8);
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'SOON').minHolders).toBe(35);
    expect(strategyMinimums(DEFAULT_CONFIG.entry, DEFAULT_CONFIG.focus, 'MIGRATION_MOMENTUM').minHolders).toBeNull();
    expect(typeof checkEntryRules).toBe('function');
  });
});
