/** v18.11: thin-coin learning probes — only size / age rules may be ignored, a few an hour. */
import { describe, expect, it } from 'vitest';
import { HourWindow, thinOnly, thinRule } from '../src/evaluator/thin-probe';
import { DEFAULT_CONFIG } from '../src/config/default';

describe('thin-coin probes', () => {
  it('knows which rules only say "early or small"', () => {
    expect(thinRule('holders 9 < 15')).toBe(true);
    expect(thinRule('only 7 active wallets in 5m (< 25)')).toBe(true);
    expect(thinRule('liquidity 3.20 SOL < 5')).toBe(true);
    expect(thinRule('volume $4,100 < $12,000')).toBe(true);
    expect(thinRule('fees 0.80 SOL < 1')).toBe(true);
    for (const f of ['bundlers hold 31% > 18%', 'safety 40 < 55', 'top 10 hold 61% > 50%', 'dump crew inside', 'deployer: serial launcher (6 launches, 0 graduated, 80% died fast)', 'sellers in control', 'chart breaking down (x)', 'momentum: +40% in 1 min', 'owner filter: MC $9k < $12k', 'holders still hold 80% of their bags']) expect(thinRule(f)).toBe(false);
  });

  it('a probe needs every failed rule to be a thin one, and at least one', () => {
    expect(thinOnly([])).toBe(false);
    expect(thinOnly(['holders 9 < 15', 'liquidity 3.20 SOL < 5'])).toBe(true);
    expect(thinOnly(['holders 9 < 15', 'bundlers hold 31% > 18%'])).toBe(false);
  });

  it('at most N an hour, sliding', () => {
    const w = new HourWindow(2);
    const t0 = Date.UTC(2026, 9, 19, 12);
    expect(w.take(t0)).toBe(true);
    expect(w.take(t0 + 60_000)).toBe(true);
    expect(w.take(t0 + 120_000)).toBe(false);
    expect(w.count(t0 + 120_000)).toBe(2);
    expect(w.take(t0 + 3_600_001)).toBe(true); // the first one aged out
    expect(DEFAULT_CONFIG.explore.thinCoin).toEqual({ enabled: true, maxPerHour: 8 });
  });
});
