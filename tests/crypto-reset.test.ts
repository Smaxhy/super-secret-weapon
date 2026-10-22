import { describe, expect, it } from 'vitest';
import { copyDecision } from '../src/learner/copy-consistent';
import { MIGRATIONS } from '../src/config/migrations';
import { OWNER_TRUSTED_COPY } from '../src/config/kol-wallets';
import { isValidPubkey } from '../src/lib/pumpfun';
import type { WalletReport } from '../src/learner/copy-replay';

const w = (wallet: string, o: Partial<WalletReport> = {}): WalletReport => ({ wallet, kind: 'tracked', label: null, qualifiedAt: null, n: 8, winPct: 60, avgPct: 5, medianPct: 2, totalSol: 1.2, profitFactor: 1.6, medianHoldMin: 12, firstHalfSol: 0.5, secondHalfSol: 0.7, consistent: true, own: null, ...o });

describe('crypto reset (v15.4)', () => {
  it('copies only wallets the latest copy test found consistent', () => {
    expect(copyDecision(null, 'A').ok).toBe(false);
    const rep = { to: '', wallets_: [w('A'), w('B', { consistent: false, firstHalfSol: 0.9, secondHalfSol: -0.4 })] };
    expect(copyDecision(rep, 'A')).toMatchObject({ ok: true });
    expect(copyDecision(rep, 'B').why).toMatch(/not consistent.*\+0\.9 SOL \/ -0\.4 SOL/);
    expect(copyDecision(rep, 'C').why).toMatch(/no copies of it/);
  });

  it('migration v55: SOON + migrated only, copies gated, faster entries, created even if never saved', () => {
    const m = MIGRATIONS.find((x) => x.version === 55)!;
    expect(m.create).toBe(true);
    const get = (sec: string, path: string[]) => m.set.find(([s, p]) => s === sec && p.join('.') === path.join('.'))?.[2];
    expect(get('trading', ['enabledStrategies', 'SOON'])).toBe(true);
    expect(get('trading', ['enabledStrategies', 'MIGRATION_MOMENTUM'])).toBe(true);
    for (const off of ['CURVE_SNIPE', 'SWING', 'RUNNER']) expect(get('trading', ['enabledStrategies', off])).toBe(false);
    expect(get('copy', ['onlyConsistent'])).toBe(true);
    expect(get('entry', ['confirmDelaySec'])).toBe(8);
    expect(Math.max(...MIGRATIONS.map((x) => x.version))).toBeGreaterThanOrEqual(55);
  });

  it('the trusted wallet is a valid Solana address', () => {
    expect(isValidPubkey(OWNER_TRUSTED_COPY)).toBe(true);
  });
});

describe('crypto data collector (v17.15)', () => {
  it('migration v57: every strategy on, lower bars, more learning trades, every learner on; guards untouched', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config/default');
    const m = MIGRATIONS.find((x) => x.version === 57)!;
    expect(m.create).toBe(true);
    const get = (sec: string, path: string[]) => m.set.find(([s, p]) => s === sec && p.join('.') === path.join('.'))?.[2];
    for (const s of ['MIGRATION_MOMENTUM', 'SOON', 'CURVE_SNIPE', 'RUNNER', 'SWING', 'SMART_MONEY_COPY']) {
      expect(get('trading', ['enabledStrategies', s])).toBe(true);
      expect(get('trading', ['allocation', s])).toBeGreaterThan(0);
    }
    const alloc = m.set.filter(([s, p]) => s === 'trading' && p[0] === 'allocation').reduce((a, [, , v]) => a + (v as number), 0);
    expect(alloc).toBeCloseTo(1, 6);
    expect(get('entry', ['minCombinedScore'])).toBeLessThan(DEFAULT_CONFIG.entry.minCombinedScore);
    expect(get('sniper', ['enabled'])).toBe(false);
    for (const [sec, path] of [['ta', ['labEnabled']], ['tournament', ['enabled']], ['aiCoach', ['enabled']], ['meme', ['enabled']], ['live', ['dryRun', 'enabled']], ['brain', ['enabled']]] as Array<[string, string[]]>) expect(get(sec, path)).toBe(true);
    // never loosens the hard guards or the paid-credit budgets
    expect(m.set.some(([s]) => s === 'antiRug' || s === 'ownerFilters' || s === 'usage' || s === 'vamp')).toBe(false);
    // every path it writes exists in the defaults (no typo creates a dead setting)
    for (const [sec, path] of m.set) {
      let node: unknown = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[sec];
      for (const k of path) {
        expect(node, `${sec}.${path.join('.')}`).toBeTypeOf('object');
        node = (node as Record<string, unknown>)[k];
      }
      if (!(sec === 'trading' && path[0] === 'maxOpenByStrategy')) expect(node, `${sec}.${path.join('.')}`).not.toBeUndefined();
    }
    expect(Math.max(...MIGRATIONS.map((x) => x.version))).toBeGreaterThanOrEqual(57);
  });
  it('v59 switches Sniper mode off again and loosens the bundler / liquidity / holder / curve rules; every path exists', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config/default');
    const m = MIGRATIONS.find((x) => x.version === 59)!;
    expect(m.create).toBe(true);
    expect(m.set.find(([s, p]) => s === 'sniper' && p[0] === 'enabled')?.[2]).toBe(false);
    expect(m.set.some(([s]) => s === 'antiRug' || s === 'usage' || s === 'vamp')).toBe(false);
    for (const [sec, path] of m.set) {
      let node: unknown = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[sec];
      for (const k of path) node = (node as Record<string, unknown>)[k];
      expect(node, `${sec}.${path.join('.')}`).not.toBeUndefined();
    }
  });
  it('v58 makes the memecoin bot basic but never touches the hard guards or budgets; every path exists', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config/default');
    const m = MIGRATIONS.find((x) => x.version === 58)!;
    expect(m.create).toBe(true);
    expect(m.set.some(([s]) => s === 'antiRug' || s === 'usage' || s === 'vamp' || s === 'deployers' || s === 'wallets')).toBe(false);
    expect(m.set.some(([s, p]) => s === 'trading' && p[0] === 'maxPositionSol')).toBe(false);
    for (const [sec, path] of m.set) {
      let node: unknown = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[sec];
      for (const k of path) node = (node as Record<string, unknown>)[k];
      expect(node, `${sec}.${path.join('.')}`).not.toBeUndefined();
    }
  });
});
