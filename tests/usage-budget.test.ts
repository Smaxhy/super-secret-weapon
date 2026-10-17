import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE, UsageBudget, dayKey, providerOf, softLimitHit } from '../src/lib/usage-budget';

describe('usage guards (v11.7)', () => {
  it('knows the provider from the URL', () => {
    expect(providerOf('https://mainnet.helius-rpc.com/?api-key=x')).toBe('helius');
    expect(providerOf('wss://ws.eu.fluxrpc.com?key=x')).toBe('flux');
    expect(providerOf('https://api.mainnet-beta.solana.com')).toBe('other');
    expect(providerOf(undefined)).toBe('other');
  });
  it('soft limit: at softPct of the budget; 0 budget = never', () => {
    expect(softLimitHit(19_999, 25_000, 80)).toBe(false);
    expect(softLimitHit(20_000, 25_000, 80)).toBe(true);
    expect(softLimitHit(1e9, 0, 80)).toBe(false);
  });
  it('counts per provider, pauses optional lookups at the soft limit, warns once, resets at midnight UTC', () => {
    const warned: string[] = [];
    const b = new UsageBudget(null, () => ({ ...DEFAULT_USAGE, helius: { dailyBudget: 100 } }), (p) => warned.push(p));
    const t0 = Date.parse('2026-10-17T10:00:00Z');
    expect(b.optionalAllowed('helius', t0)).toBe(true);
    b.note('helius', 79, t0);
    expect(b.optionalAllowed('helius', t0)).toBe(true);
    b.note('helius', 1, t0);
    expect(b.optionalAllowed('helius', t0)).toBe(false);
    expect(b.optionalAllowed('flux', t0)).toBe(true);
    b.note('helius', 5, t0);
    expect(warned).toEqual(['helius']);
    expect(b.snapshot(t0).providers.helius).toEqual({ used: 85, budget: 100, softLimitHit: true });
    const next = Date.parse('2026-10-18T00:00:01Z');
    expect(dayKey(next)).toBe('2026-10-18');
    expect(b.optionalAllowed('helius', next)).toBe(true);
    expect(b.snapshot(next).providers.helius.used).toBe(0);
  });
});
