import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP,
  SelfLoop,
  acceptVerdict,
  keyAllowed,
  proposeFromHealth,
  relaxStep,
  settingForSkip,
  strategyOfKey,
  validateChange,
  watchVerdict,
  type LoopDeps,
  type ReplaySummary,
} from '../src/learner/self-loop';
import { EDITABLE } from '../src/config/editable';
import { DEFAULT_CONFIG } from '../src/config/default';
import type { ReplayReport } from '../src/learner/replay';

const C = DEFAULT_LOOP;
const sum = (trades: number, totalSol: number, avgPct: number, profitFactor: number | null): ReplaySummary => ({ trades, totalSol, avgPct, profitFactor, winRatePct: 50 });

describe('which keys the loop may change', () => {
  it('replayable entry / exit keys yes; switches, usage, sizes up and RPC-only guards no', () => {
    expect(keyAllowed('momentumGate.minOffHighPct', C).ok).toBe(true);
    expect(keyAllowed('focus.migrated.scoreThresholdDelta', C).ok).toBe(true);
    expect(keyAllowed('sniper.enabled', C).ok).toBe(false);
    expect(keyAllowed('trading.enabledStrategies.SOON', C).ok).toBe(false);
    expect(keyAllowed('usage.helius.dailyBudget', C).ok).toBe(false);
    expect(keyAllowed('entry.maxBundlePct', C).ok).toBe(false); // RPC holders — the replay can't prove it
    expect(keyAllowed('loop.minEdgeSol', C).ok).toBe(false);
    expect(keyAllowed('no.such.key', C).ok).toBe(false);
  });

  it('allowedKeys, when set, is the whole list', () => {
    expect(keyAllowed('momentumGate.minOffHighPct', { allowedKeys: ['sniper.minScoreMargin'] }).ok).toBe(false);
    expect(keyAllowed('sniper.minScoreMargin', { allowedKeys: ['sniper.minScoreMargin'] }).ok).toBe(true);
  });

  it('validates limits, step size, no-op, size-down-only and the max step', () => {
    expect(validateChange({ key: 'sniper.minScoreMargin', value: 999 }, 8, C).ok).toBe(false);
    expect(validateChange({ key: 'sniper.minScoreMargin', value: 8 }, 8, C).ok).toBe(false);
    const ok = validateChange({ key: 'sniper.minScoreMargin', value: 5.4 }, 8, C);
    expect(ok.ok && ok.value).toBe(5);
    // range 0–30 → 30% = 9 points max
    expect(validateChange({ key: 'sniper.minScoreMargin', value: 0 }, 10, C).ok).toBe(false);
    expect(validateChange({ key: 'sniper.minScoreMargin', value: 1 }, 10, C).ok).toBe(true);
    // sizes may only go down
    expect(validateChange({ key: 'focus.migrated.sizeMultiplier', value: 1.2 }, 1, C).ok).toBe(false);
    expect(validateChange({ key: 'focus.migrated.sizeMultiplier', value: 0.8 }, 1, C).ok).toBe(true);
  });
});

describe('the proof on the tape', () => {
  it('needs enough trades, profit, a better result and no big PF drop', () => {
    expect(acceptVerdict(sum(20, 0.5, 2, 1.4), sum(25, 0.9, 2.5, 1.5), C).accept).toBe(true);
    expect(acceptVerdict(sum(20, 0.5, 2, 1.4), sum(25, 0.55, 2.1, 1.4), C).accept).toBe(false); // not clearly better
    expect(acceptVerdict(sum(20, 0.5, 2, 1.4), sum(5, 0.9, 9, 3), C).accept).toBe(false); // too few trades
    expect(acceptVerdict(sum(20, -0.5, -2, 0.8), sum(25, -0.1, -0.5, 0.95), C).accept).toBe(false); // still loses
    expect(acceptVerdict(sum(20, 0.5, 2, 2.0), sum(30, 0.7, 1.5, 1.5), C).accept).toBe(false); // PF drops 0.5
    expect(acceptVerdict(sum(20, 0.5, 2, 1.4), sum(20, 0.5, 4.5, 1.6), C).accept).toBe(true); // +2.5 pts per trade, same SOL
  });

  it('the not-trading-at-all case: baseline 0 trades → accept a profitable, active change', () => {
    expect(acceptVerdict(sum(0, 0, 0, null), sum(12, 0.4, 3, 1.3), C).accept).toBe(true);
    expect(acceptVerdict(sum(0, 0, 0, null), sum(12, -0.4, -3, 0.7), C).accept).toBe(false);
    expect(acceptVerdict(sum(0, 0, 0, null), sum(3, 0.4, 3, 2), C).accept).toBe(false);
  });
});

describe('the deterministic proposer (Bot health)', () => {
  const base = { checked: 100, rulesOk: 0, signal: 0, dipWait: 0, confirming: 0, notConfirmed: 0, heldBack: 0, toTrader: 0, refused: 0, bought: 0, dipGaveUp: 0 };
  const cur = (key: string) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], DEFAULT_CONFIG);
    return key === 'momentumGate.minOffHighPct' ? 6 : v;
  };

  it('maps skip reasons to settings', () => {
    expect(settingForSkip('MIGRATION_MOMENTUM', 'momentum gate: too close to the top: only # off the # -min high')?.key).toBe('momentumGate.minOffHighPct');
    expect(settingForSkip('MIGRATION_MOMENTUM', '# active wallets # <')?.key).toBe('focus.migrated.minActiveWallets5m');
    expect(settingForSkip('SOON', 'holders # < #')?.key).toBe('focus.soon.minHolders');
    expect(settingForSkip('MIGRATION_MOMENTUM', 'score under the bar')?.key).toBe('focus.migrated.scoreThresholdDelta');
    expect(settingForSkip('MIGRATION_MOMENTUM', 'safety hard fail')).toBeNull();
    expect(settingForSkip('MIGRATION_MOMENTUM', 'bundlers hold # > #')).toBeNull();
  });

  it('relaxes one step: 20% of the gap to the limit, at least one editable step', () => {
    const s = EDITABLE.find((e) => e.key === 'momentumGate.minOffHighPct')!;
    expect(relaxStep(s, 6, 'down')).toBeCloseTo(5, 6);
    const sc = EDITABLE.find((e) => e.key === 'focus.migrated.scoreThresholdDelta')!;
    expect(relaxStep(sc, -15, 'down')).toBe(-20); // gap −25 → −5
  });

  it('a strategy that passes every rule but never signals → its top relaxable skip', () => {
    const p = proposeFromHealth(
      {
        minutesSinceEntry: 30,
        strategies: [
          { ...base, strategy: 'MIGRATION_MOMENTUM', on: true, rulesOk: 32, topSkips: [{ reason: 'safety hard fail', count: 200 }, { reason: 'momentum gate: too close to the top: only # off the # -min high', count: 128 }] },
          { ...base, strategy: 'SOON', on: true, rulesOk: 0, topSkips: [{ reason: 'holders # < #', count: 500 }] },
        ],
      },
      cur,
      C,
    );
    expect(p?.key).toBe('momentumGate.minOffHighPct');
    expect(p?.value).toBe(5);
  });

  it('after 6 h without a buy → the top relaxable skip of any switched-on strategy; none → null', () => {
    const h = { minutesSinceEntry: 400, strategies: [{ ...base, strategy: 'SOON', on: true, topSkips: [{ reason: 'safety hard fail', count: 90 }, { reason: 'holders # < #', count: 75 }] }] };
    expect(proposeFromHealth(h, cur, C)?.key).toBe('focus.soon.minHolders');
    expect(proposeFromHealth({ ...h, minutesSinceEntry: 30 }, cur, C)).toBeNull();
  });
});

describe('watch + revert', () => {
  const W = { n: 12, avgPct: -4, replayAvgPct: 3, preAvgPct: -1, elapsedMs: 3600_000 };
  it('waits until enough trades or time', () => {
    expect(watchVerdict({ ...W, n: 5 }, C).action).toBe('wait');
    expect(watchVerdict({ ...W, n: 5, elapsedMs: 49 * 3600_000 }, C).action).toBe('revert');
  });
  it('reverts only when worse than the replay AND worse than before', () => {
    expect(watchVerdict(W, C).action).toBe('revert');
    expect(watchVerdict({ ...W, preAvgPct: -6 }, C).action).toBe('keep'); // still better than before
    expect(watchVerdict({ ...W, avgPct: 1 }, C).action).toBe('keep'); // within 3 pts of the replay
    expect(watchVerdict({ ...W, n: 0, avgPct: null, elapsedMs: 49 * 3600_000 }, C).action).toBe('keep');
  });
  it('judges a key by its own strategy', () => {
    expect(strategyOfKey('focus.migrated.minActiveWallets5m')).toBe('MIGRATION_MOMENTUM');
    expect(strategyOfKey('trading.maxOpenByStrategy.SOON')).toBe('SOON');
    expect(strategyOfKey('momentumGate.minOffHighPct')).toBeNull();
  });
});

describe('the loop end to end (mocked replay + applyEdit)', () => {
  const report = (trades: number, totalSol: number, avgPct: number, pf: number | null) => ({ trades, totalSol, avgPct, profitFactor: pf, winRatePct: 50 }) as unknown as ReplayReport;
  const setup = (over: Partial<LoopDeps> = {}) => {
    let stored: string | null = null;
    let now = Date.parse('2026-10-18T05:00:00Z');
    const applied: Array<{ key: string; value: unknown; source: string }> = [];
    const values: Record<string, number> = { 'momentumGate.minOffHighPct': 6 };
    const replays: string[][] = [];
    const deps: LoopDeps = {
      cfg: () => C,
      current: (k) => values[k],
      health: () => ({ minutesSinceEntry: 30, strategies: [{ strategy: 'MIGRATION_MOMENTUM', on: true, checked: 800, rulesOk: 32, signal: 0, dipWait: 0, confirming: 0, notConfirmed: 0, heldBack: 0, toTrader: 0, refused: 0, bought: 0, dipGaveUp: 0, topSkips: [{ reason: 'momentum gate: too close to the top: only # off the # -min high', count: 128 }] }] }),
      runReplay: async (set) => {
        replays.push(set);
        return set.length ? report(12, 0.6, 4, 1.6) : report(0, 0, 0, null);
      },
      replayRunning: () => false,
      tapeStartMs: async () => now - 3 * 86_400_000,
      apply: async (key, value, source) => {
        applied.push({ key, value, source });
        values[key] = value as number;
        return { ok: true };
      },
      liveTrades: async () => [],
      load: async () => stored,
      save: async (raw) => void (stored = raw),
      liveMode: () => false,
      now: () => now,
      ...over,
    };
    return { loop: new SelfLoop(deps), applied, replays, values, advance: (ms: number) => (now += ms), setTrades: (f: LoopDeps['liveTrades']) => (deps.liveTrades = f) };
  };

  it('proposes, proves (baseline + candidate), applies — then refuses a second experiment while watching', async () => {
    const t = setup();
    const r = await t.loop.runOnce(false);
    expect(r.ran).toBe(true);
    expect(t.replays).toEqual([[], ['momentumGate.minOffHighPct=5']]);
    expect(t.applied).toEqual([{ key: 'momentumGate.minOffHighPct', value: 5, source: 'loop' }]);
    const s = await t.loop.state();
    expect(s.current?.status).toBe('watching');
    expect((await t.loop.runOnce(true)).why).toMatch(/still watching/);
  });

  it('reverts when live disagrees, then cools down', async () => {
    const t = setup();
    await t.loop.runOnce(false);
    t.setTrades(async (q) => (q.sinceMs ? Array.from({ length: 12 }, () => -5) : []));
    t.advance(3600_000);
    await t.loop.watch();
    expect(t.applied.at(-1)).toEqual({ key: 'momentumGate.minOffHighPct', value: 6, source: 'loop-revert' });
    const s = await t.loop.state();
    expect(s.current).toBeNull();
    expect(s.history[0]?.status).toBe('reverted');
    t.advance(3600_000);
    expect((await t.loop.runOnce(false)).why).toMatch(/cooling down/);
  });

  it('keeps it when live holds up', async () => {
    const t = setup();
    await t.loop.runOnce(false);
    t.setTrades(async (q) => (q.sinceMs ? Array.from({ length: 12 }, () => 5) : []));
    await t.loop.watch();
    expect((await t.loop.state()).history[0]?.status).toBe('kept');
  });

  it('rejects when the replay says no, and never runs without enough tape, during a replay or in live mode', async () => {
    const t = setup({ runReplay: async (set) => (set.length ? report(12, -0.2, -2, 0.8) : report(0, 0, 0, null)) });
    await t.loop.runOnce(false);
    expect((await t.loop.state()).history[0]?.status).toBe('rejected');
    expect(t.applied).toEqual([]);
    expect((await setup({ tapeStartMs: async () => Date.parse('2026-10-18T00:00:00Z') }).loop.runOnce(true)).why).toMatch(/h of recorded market/);
    expect((await setup({ replayRunning: () => true }).loop.runOnce(true)).why).toMatch(/another replay/);
    expect((await setup({ liveMode: () => true }).loop.runOnce(true)).why).toMatch(/live trading/);
  });
});
