import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { organicFlow, scanVerdict } from '../src/scanner/migrated-scanner';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const NOW = 1_760_000_000_000;
const C = DEFAULT_CONFIG.focus.migrated.scan;
const t = (sec: number, w: string, buy: boolean, sol: number, px = 1e-6): CrowdTrade => ({ t: NOW - sec * 1000, w, buy, sol, tok: sol / px, px, pp: px });

describe('migrated-coin scanner (organic volume)', () => {
  it('counts real buyers and leaves volume bots out', () => {
    const real = Array.from({ length: 30 }, (_, i) => t(10 + i * 8, `buyer${i}`, true, 0.2 + (i % 5) * 0.1));
    const sells = Array.from({ length: 8 }, (_, i) => t(15 + i * 20, `seller${i}`, false, 0.3));
    const bot = Array.from({ length: 12 }, (_, i) => t(5 + i * 20, 'washbot', i % 2 === 0, 0.5));
    const f = organicFlow([...bot, ...real, ...sells].sort((a, b) => a.t - b.t), NOW)!;
    expect(f.buyers).toBe(30);
    expect(f.buySol).toBeCloseTo(12, 0);
    expect(f.organicPct).toBeLessThan(100);
    expect(scanVerdict(f, 80_000, C)).toBeNull();
  });
  it('skips thin, sell-heavy, fake or already-pumped coins', () => {
    const thin = organicFlow(Array.from({ length: 8 }, (_, i) => t(i * 20, `w${i}`, true, 0.3)), NOW);
    expect(scanVerdict(thin, 80_000, C)).toMatch(/real buyers/);
    const dumping = organicFlow([...Array.from({ length: 25 }, (_, i) => t(i * 10, `b${i}`, true, 0.3)), ...Array.from({ length: 20 }, (_, i) => t(i * 10 + 5, `s${i}`, false, 1))], NOW);
    expect(scanVerdict(dumping, 80_000, C)).toMatch(/buyers .*% of volume/);
    const pumped = organicFlow([t(240, 'old', true, 0.3, 1e-6), ...Array.from({ length: 30 }, (_, i) => t(150 - i * 4, `b${i}`, true, 0.3, 1.6e-6))], NOW);
    expect(scanVerdict(pumped, 80_000, C)).toMatch(/already up/);
    expect(scanVerdict(organicFlow(Array.from({ length: 30 }, (_, i) => t(i * 8, `b${i}`, true, 0.3)), NOW), 10_000, C)).toMatch(/market cap/);
  });
});
