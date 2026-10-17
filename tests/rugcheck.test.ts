import { describe, it, expect } from 'vitest';
import { rugCheckVerdict, type RugCheckResult } from '../src/integrations/rugcheck';

const good: RugCheckResult = {
  mint: 'abc',
  score: 200,
  riskLevel: 'Good',
  risks: [],
  topHolderPct: 5,
  hasMintAuthority: false,
  hasFreezeAuthority: false,
  fetchedAt: Date.now(),
};

const cfg = { enabled: true, maxScore: 500, blockDanger: true };

describe('rugCheckVerdict', () => {
  it('passes a clean token', () => {
    const v = rugCheckVerdict(good, cfg);
    expect(v.pass).toBe(true);
    expect(v.reasons).toHaveLength(0);
  });

  it('disabled = always passes', () => {
    const v = rugCheckVerdict(good, { ...cfg, enabled: false });
    expect(v.pass).toBe(true);
  });

  it('null result = passes (fail-open)', () => {
    const v = rugCheckVerdict(null, cfg);
    expect(v.pass).toBe(true);
  });

  it('blocks high score', () => {
    const v = rugCheckVerdict({ ...good, score: 800 }, cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.some(r => r.includes('800'))).toBe(true);
  });

  it('blocks Danger risk level', () => {
    const v = rugCheckVerdict({ ...good, riskLevel: 'Danger' }, cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.some(r => r.includes('Danger'))).toBe(true);
  });

  it('respects blockDanger = false', () => {
    const v = rugCheckVerdict({ ...good, riskLevel: 'Danger' }, { ...cfg, blockDanger: false });
    expect(v.pass).toBe(true);
  });

  it('blocks mint authority', () => {
    const v = rugCheckVerdict({ ...good, hasMintAuthority: true }, cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.some(r => r.includes('mint authority'))).toBe(true);
  });

  it('blocks freeze authority', () => {
    const v = rugCheckVerdict({ ...good, hasFreezeAuthority: true }, cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.some(r => r.includes('freeze authority'))).toBe(true);
  });

  it('accumulates multiple reasons', () => {
    const v = rugCheckVerdict({ ...good, score: 800, hasMintAuthority: true, riskLevel: 'Danger' }, cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
