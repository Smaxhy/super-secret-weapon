import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS, applyMigration } from '../src/config/migrations';
import { sniperEntryFails, sniperExitOverlay, sniperSize, type SniperConfig } from '../src/evaluator/sniper';
import { exitRulesFor } from '../src/executor/sell-manager';
import { pumpFeedUrl, pumpFeedsOn } from '../src/scanner/trending-feeds';
import { deepMerge, overrideConfig } from '../src/config/runtime-config';

const C = DEFAULT_CONFIG.sniper as unknown as SniperConfig;
const flow = { buyers: 40, buySol: 20, sellSol: 8, buySharePct: 71, organicPct: 80, run3mPct: 12, priceSol: 1e-7 };
const ok = { flow, score: 80, threshold: 65, momentumGateWhy: null, entryQualityVerdict: 'ok', edgeGatePass: true, pressureSellersInControl: false, crowd: { provenSolPct: 30, fails: [] }, explore: false, probe: false, risky: false, dipEntry: false };

describe('sniper mode entry gate (v11.7)', () => {
  it('a full-conviction setup passes', () => expect(sniperEntryFails(ok, C)).toEqual([]));
  it('off → never refuses', () => expect(sniperEntryFails({ ...ok, flow: null, score: 1 }, { ...C, enabled: false })).toEqual([]));
  it('thin or bot-driven volume is refused', () => {
    expect(sniperEntryFails({ ...ok, flow: null }, C)[0]).toMatch(/not enough real trading/);
    expect(sniperEntryFails({ ...ok, flow: { ...flow, buyers: 12 } }, C)[0]).toMatch(/12 real buyers/);
    expect(sniperEntryFails({ ...ok, flow: { ...flow, buySol: 3 } }, C)[0]).toMatch(/SOL bought/);
    expect(sniperEntryFails({ ...ok, flow: { ...flow, buySharePct: 48 } }, C)[0]).toMatch(/buys only 48%/);
    expect(sniperEntryFails({ ...ok, flow: { ...flow, organicPct: 40 } }, C)[0]).toMatch(/organic/);
  });
  it('the score must beat the bar by the margin', () => {
    expect(sniperEntryFails({ ...ok, score: 70 }, C)[0]).toMatch(/not 8 over the bar/);
    expect(sniperEntryFails({ ...ok, score: 73 }, C)).toEqual([]);
  });
  it('every gate must be green', () => {
    expect(sniperEntryFails({ ...ok, momentumGateWhy: '+30% in 1 min' }, C)[0]).toMatch(/momentum/);
    expect(sniperEntryFails({ ...ok, entryQualityVerdict: 'block' }, C)[0]).toMatch(/entry quality/);
    expect(sniperEntryFails({ ...ok, entryQualityVerdict: 'boost' }, C)).toEqual([]);
    expect(sniperEntryFails({ ...ok, edgeGatePass: false }, C)[0]).toMatch(/edge gate/);
    expect(sniperEntryFails({ ...ok, edgeGatePass: null }, C)).toEqual([]);
    expect(sniperEntryFails({ ...ok, pressureSellersInControl: true }, C)[0]).toMatch(/sellers/);
    expect(sniperEntryFails({ ...ok, crowd: { provenSolPct: 0, fails: ['dump crew inside'] } }, C)[0]).toMatch(/crowd: dump crew/);
  });
  it('learning, probe and half-size entries are refused', () => {
    expect(sniperEntryFails({ ...ok, explore: true }, C)[0]).toMatch(/learning/);
    expect(sniperEntryFails({ ...ok, probe: true }, C)[0]).toMatch(/probe/);
    expect(sniperEntryFails({ ...ok, risky: true }, C)[0]).toMatch(/half-size/);
  });
  it('requireProvenCrowd asks for 20% of buying from proven wallets', () => {
    const c = { ...C, requireProvenCrowd: true };
    expect(sniperEntryFails({ ...ok, crowd: { provenSolPct: 10, fails: [] } }, c)[0]).toMatch(/proven wallets/);
    expect(sniperEntryFails({ ...ok, crowd: null }, c)[0]).toMatch(/proven wallets/);
    expect(sniperEntryFails(ok, c)).toEqual([]);
  });
});

describe('sniper exits lie over every strategy', () => {
  const overlay = sniperExitOverlay(C.exits, 12);
  it('the overlay carries the tiers, trail, break-even, stop and time stop', () => {
    expect(overlay.takeProfitTiers).toEqual([{ multiple: 1.5, sellPct: 25 }, { multiple: 2.5, sellPct: 25 }, { multiple: 5, sellPct: 20 }]);
    expect(overlay.trailingStopActivateMultiple).toBe(1.5);
    expect((overlay.trail as { ladder: unknown[] }).ladder).toEqual([{ fromMultiple: 1.5, pct: 25 }]);
    expect((overlay.stopLoss as { maxPct: number; minPct: number }).maxPct).toBe(12);
    expect((overlay.timeStop as { minutes: Record<string, number> }).minutes.SWING).toBe(2);
    expect((sniperExitOverlay({ ...C.exits, stopMaxPct: 10 }, 12).stopLoss as { minPct: number }).minPct).toBe(10);
  });
  it('exitRulesFor: sniper on → the overlay wins over the strategy rules; off → the strategy rules as before', () => {
    const base = DEFAULT_CONFIG.exit as unknown as Parameters<typeof exitRulesFor>[1];
    overrideConfig({ sniper: { enabled: true } });
    const swingOn = exitRulesFor('SWING', base);
    expect(swingOn.takeProfitTiers[0]).toEqual({ multiple: 1.5, sellPct: 25 });
    expect(swingOn.stopLoss.maxPct).toBe(12);
    expect(swingOn.trail.breakEvenAfterMultiple).toBe(1.5);
    expect(exitRulesFor('MIGRATION_MOMENTUM', base).takeProfitTiers.map((x) => x.multiple)).toEqual([1.5, 2.5, 5]);
    overrideConfig({ sniper: { enabled: false } });
    const swingOff = exitRulesFor('SWING', base);
    expect(swingOff.takeProfitTiers[0]!.multiple).toBeLessThan(1.5);
    expect(exitRulesFor('MIGRATION_MOMENTUM', base).takeProfitTiers[0]!.multiple).toBe(1.15);
    overrideConfig({ sniper: { enabled: true } });
  });
});

describe('sniper size = the conviction size under the hard caps only', () => {
  it('takes the smallest of size, % of capital, budget and balance − reserve', () => {
    expect(sniperSize({ sizeSol: 1, maxPctOfCapital: 12, capital: 15, budget: 5, balance: 14, reserve: 0.03 })).toBeCloseTo(1, 6);
    expect(sniperSize({ sizeSol: 1, maxPctOfCapital: 5, capital: 15, budget: 5, balance: 14, reserve: 0.03 })).toBeCloseTo(0.75, 6);
    expect(sniperSize({ sizeSol: 1, maxPctOfCapital: 12, capital: 15, budget: 0.4, balance: 14, reserve: 0.03 })).toBeCloseTo(0.4, 6);
    expect(sniperSize({ sizeSol: 1, maxPctOfCapital: 12, capital: 15, budget: 5, balance: 0.5, reserve: 0.03 })).toBeCloseTo(0.47, 6);
    expect(sniperSize({ sizeSol: 1, maxPctOfCapital: 12, capital: 15, budget: 5, balance: 0.01, reserve: 0.03 })).toBe(0);
  });
});

describe('migration v38 + defaults', () => {
  it('new pairs and runners are off; the budget goes to migrated / SOON and adds up to 1', () => {
    expect(DEFAULT_CONFIG.sniper.enabled).toBe(true);
    expect(DEFAULT_CONFIG.trading.enabledStrategies.CURVE_SNIPE).toBe(false);
    expect(DEFAULT_CONFIG.trading.enabledStrategies.RUNNER).toBe(false);
    expect(Object.values(DEFAULT_CONFIG.trading.allocation).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const m = MIGRATIONS.find((x) => x.version === 38)!;
    const out = applyMigration({ trading: { enabledStrategies: { CURVE_SNIPE: true, RUNNER: true }, allocation: { CURVE_SNIPE: 0.15 } }, trending: { pump: { enabled: true } } }, m) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out.trading!.enabledStrategies).toMatchObject({ CURVE_SNIPE: false, RUNNER: false });
    expect(Object.values(out.trading!.allocation as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect((out.trending!.pumpUrls as Record<string, string>).koth).toBe('');
  });
});

describe('pump.fun lists with configurable URLs', () => {
  it('a path is relative to frontend-api-v3, a full URL is used as is, empty = off', () => {
    expect(pumpFeedUrl('/coins/top-runners')).toBe('https://frontend-api-v3.pump.fun/coins/top-runners');
    expect(pumpFeedUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(pumpFeedsOn(DEFAULT_CONFIG.trending.pumpUrls)).toEqual(['pump_live']);
    expect(pumpFeedsOn({ live: '', koth: '/k', forYou: '', runners: 'https://a/b' })).toEqual(['pump_koth', 'pump_runners']);
  });
});
