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
    expect(Math.max(...MIGRATIONS.map((x) => x.version))).toBe(55);
  });

  it('the trusted wallet is a valid Solana address', () => {
    expect(isValidPubkey(OWNER_TRUSTED_COPY)).toBe(true);
  });
});
