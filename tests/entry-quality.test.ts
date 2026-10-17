import { describe, it, expect } from 'vitest';
import { entryQuality, DEFAULT_ENTRY_QUALITY, type EntryQualityConfig } from '../src/evaluator/entry-quality';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const cfg = DEFAULT_ENTRY_QUALITY;
const NOW = 1_700_000_060_000; // 60s after base

function trade(overrides: Partial<CrowdTrade> & { t: number; px: number; sol: number; buy: boolean; w: string }): CrowdTrade {
  return { pp: overrides.px, tok: 1000, mc: 10000, ...overrides } as unknown as CrowdTrade;
}

function buyTrades(count: number, baseT: number, pxStart: number, solEach: number): CrowdTrade[] {
  return Array.from({ length: count }, (_, i) =>
    trade({ t: baseT + i * 1000, px: pxStart + i * 0.001, sol: solEach, buy: true, w: `buyer${i}` }),
  );
}

describe('entryQuality', () => {
  it('returns ok when disabled', () => {
    const r = entryQuality([], NOW, { ...cfg, enabled: false });
    expect(r.verdict).toBe('ok');
  });

  it('returns ok with too few trades', () => {
    const r = entryQuality([trade({ t: NOW - 5000, px: 1, sol: 0.1, buy: true, w: 'a' })], NOW, cfg);
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('too few trades');
  });

  it('blocks on price dump in 15s', () => {
    const trades = [
      // older trades so we have ≥2 in 30s
      trade({ t: NOW - 25_000, px: 1.0, sol: 0.5, buy: true, w: 'a' }),
      trade({ t: NOW - 20_000, px: 1.0, sol: 0.5, buy: true, w: 'b' }),
      trade({ t: NOW - 18_000, px: 1.0, sol: 0.5, buy: true, w: 'c' }),
      // 15s window: price drops 10%
      trade({ t: NOW - 14_000, px: 1.0, sol: 0.2, buy: true, w: 'd' }),
      trade({ t: NOW - 2_000, px: 0.88, sol: 0.2, buy: false, w: 'e' }),
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain('price dumping');
  });

  it('blocks on seller flood', () => {
    const trades = [
      // 30s window: heavy selling
      trade({ t: NOW - 28_000, px: 1.0, sol: 0.5, buy: true, w: 'a' }),
      trade({ t: NOW - 25_000, px: 1.0, sol: 0.5, buy: true, w: 'b' }),
      trade({ t: NOW - 22_000, px: 1.0, sol: 1.5, buy: false, w: 'c' }),
      trade({ t: NOW - 18_000, px: 0.99, sol: 1.5, buy: false, w: 'd' }),
      trade({ t: NOW - 10_000, px: 0.98, sol: 1.5, buy: false, w: 'e' }),
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain('sellers flooding');
  });

  it('blocks on spike retrace', () => {
    const trades = [
      trade({ t: NOW - 55_000, px: 1.0, sol: 0.2, buy: true, w: 'a' }),
      trade({ t: NOW - 45_000, px: 1.3, sol: 0.2, buy: true, w: 'b' }),
      trade({ t: NOW - 35_000, px: 1.5, sol: 0.2, buy: true, w: 'c' }), // peak — 50% above low
      trade({ t: NOW - 25_000, px: 1.15, sol: 0.2, buy: false, w: 'd' }),
      trade({ t: NOW - 15_000, px: 1.1, sol: 0.2, buy: false, w: 'e' }), // retraced 80% of the 0.5 move
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain('spike retracing');
  });

  it('blocks on too few unique buyers', () => {
    // Only 2 unique buyers in 30s, need 3
    const trades = [
      trade({ t: NOW - 28_000, px: 1.0, sol: 0.5, buy: true, w: 'a' }),
      trade({ t: NOW - 20_000, px: 1.01, sol: 0.5, buy: true, w: 'b' }),
      trade({ t: NOW - 15_000, px: 1.02, sol: 0.3, buy: true, w: 'a' }), // same buyer
      trade({ t: NOW - 5_000, px: 1.02, sol: 0.3, buy: true, w: 'b' }),   // same buyer
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain('buyer(s) in 30s');
  });

  it('blocks on volume dying', () => {
    // Prior 30s: lots of volume; recent 30s: almost none
    const trades = [
      ...buyTrades(6, NOW - 55_000, 1.0, 2.0),  // prior 30s: 12 SOL
      trade({ t: NOW - 25_000, px: 1.01, sol: 0.3, buy: true, w: 'x1' }),
      trade({ t: NOW - 15_000, px: 1.01, sol: 0.2, buy: true, w: 'x2' }),
      trade({ t: NOW - 5_000, px: 1.0, sol: 0.1, buy: true, w: 'x3' }),
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('block');
    expect(r.reason).toContain('volume dying');
  });

  it('returns boost on clean bounce', () => {
    // 15s: price rising, buyers dominate
    const trades = [
      trade({ t: NOW - 28_000, px: 1.0, sol: 0.5, buy: true, w: 'a' }),
      trade({ t: NOW - 22_000, px: 1.0, sol: 0.5, buy: true, w: 'b' }),
      trade({ t: NOW - 18_000, px: 1.0, sol: 0.5, buy: true, w: 'c' }),
      // 15s window: strong bounce
      trade({ t: NOW - 12_000, px: 1.0, sol: 2.0, buy: true, w: 'd' }),
      trade({ t: NOW - 8_000, px: 1.03, sol: 2.0, buy: true, w: 'e' }),
      trade({ t: NOW - 3_000, px: 1.06, sol: 2.0, buy: true, w: 'f' }),
      trade({ t: NOW - 1_000, px: 1.07, sol: 1.5, buy: true, w: 'g' }),
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('boost');
    expect(r.points).toBe(3);
    expect(r.reason).toContain('clean bounce');
  });

  it('returns ok when everything is normal', () => {
    const trades = [
      // Even buying and selling, normal volume, enough buyers
      ...buyTrades(5, NOW - 55_000, 1.0, 1.0),   // prior 30s
      trade({ t: NOW - 25_000, px: 1.01, sol: 0.5, buy: true, w: 'r1' }),
      trade({ t: NOW - 20_000, px: 1.01, sol: 0.3, buy: false, w: 'r2' }),
      trade({ t: NOW - 15_000, px: 1.02, sol: 0.5, buy: true, w: 'r3' }),
      trade({ t: NOW - 10_000, px: 1.02, sol: 0.4, buy: true, w: 'r4' }),
      trade({ t: NOW - 5_000, px: 1.01, sol: 0.3, buy: false, w: 'r5' }),
    ];
    const r = entryQuality(trades, NOW, cfg);
    expect(r.verdict).toBe('ok');
  });
});
