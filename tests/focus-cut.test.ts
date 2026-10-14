import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS, applyMigration } from '../src/config/migrations';
import { exitRulesFor } from '../src/executor/sell-manager';
import { inQuietHours } from '../src/executor/trader';

describe('v10.21 focus cut (owner CSV, 515 trades)', () => {
  it('only SOON, migrated coins and KOL follow trade, and the budget adds up to 1', () => {
    const t = DEFAULT_CONFIG.trading;
    expect(Object.entries(t.enabledStrategies).filter(([, on]) => on).map(([s]) => s).sort()).toEqual(['MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SOON']);
    expect(Object.values(t.allocation).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
  it('night pause 00–04 UTC (and wraps past midnight when asked)', () => {
    expect([0, 1, 2, 3].every((h) => inQuietHours(h, 0, 4))).toBe(true);
    expect([4, 12, 23].some((h) => inQuietHours(h, 0, 4))).toBe(false);
    expect(inQuietHours(23, 22, 2) && inQuietHours(1, 22, 2) && !inQuietHours(2, 22, 2)).toBe(true);
    expect(inQuietHours(5, 3, 3)).toBe(false);
  });
  it('SOON and migrated coins bank 30% at 1.2x; others keep their own tiers', () => {
    const r = DEFAULT_CONFIG.exit as unknown as Parameters<typeof exitRulesFor>[1];
    expect(exitRulesFor('SOON', r).takeProfitTiers[0]).toEqual({ multiple: 1.2, sellPct: 30 });
    expect(exitRulesFor('MIGRATION_MOMENTUM', r).takeProfitTiers.map((x) => x.multiple)).toEqual([1.2, 1.4, 5]);
    expect(exitRulesFor('SMART_MONEY_COPY', r).takeProfitTiers[0]).toEqual({ multiple: 1.4, sellPct: 40 });
  });
  it('the buy wait is 25 s and the price must hold', () => {
    expect(DEFAULT_CONFIG.entry.confirmDelaySec).toBe(25);
    expect(DEFAULT_CONFIG.entry.confirm).toEqual({ maxDropPct: 4, maxPumpPct: 15, minBuyRatio: 1.1 });
  });
  it('migration v19 pushes it into saved settings', () => {
    const m = MIGRATIONS.find((x) => x.version === 19)!;
    const out = applyMigration({ trading: { enabledStrategies: { RUNNER: true, SWING: true, CURVE_SNIPE: true }, allocation: { SOON: 0.05 } }, entry: { confirmDelaySec: 12 }, exit: { byStrategy: { SWING: {} } } }, m) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out.trading!.enabledStrategies).toMatchObject({ RUNNER: false, SWING: false, CURVE_SNIPE: false });
    expect(out.trading!.allocation!.SOON).toBe(0.35);
    expect(out.entry!.confirmDelaySec).toBe(25);
    expect((out.exit!.byStrategy as Record<string, { takeProfitTiers?: unknown[] }>).SOON!.takeProfitTiers).toHaveLength(3);
  });
});
