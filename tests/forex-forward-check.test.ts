import { describe, expect, it } from 'vitest';
import { FX_CONFIG, forwardOk } from '../src/forex/lab';

describe('v27.87 forward check', () => {
  it('needs enough forward paper trades that made money', () => {
    expect(FX_CONFIG.forwardCheck.on).toBe(true);
    expect(forwardOk(undefined).ok).toBe(false);
    expect(forwardOk({ n: 7, avgR: 0.4, pf: 3 }).why).toContain('only 7 forward');
    // the coin rows that looked fine on unseen data but lost forward (VPS read Oct 28)
    expect(forwardOk({ n: 12, avgR: -0.58, pf: 0.19 }).ok).toBe(false);
    expect(forwardOk({ n: 95, avgR: -0.02, pf: 0.93 }).ok).toBe(false);
    // round_break:4h coins forward: 24 trades, +0.25R, PF 6.74 → trades
    expect(forwardOk({ n: 24, avgR: 0.25, pf: 6.74 }).ok).toBe(true);
    expect(forwardOk({ n: 12, avgR: 0.3, pf: null }).ok).toBe(true);
  });
  it('off = everything passes', () => {
    FX_CONFIG.forwardCheck.on = false;
    try {
      expect(forwardOk(undefined).ok).toBe(true);
    } finally {
      FX_CONFIG.forwardCheck.on = true;
    }
  });
});
