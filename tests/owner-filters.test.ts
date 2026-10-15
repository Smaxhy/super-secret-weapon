import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { excludedWord, flowPressure, ownerFilterFails, ownerProfile, pressureFail, type OwnerFilterInput } from '../src/evaluator/owner-filters';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const C = DEFAULT_CONFIG.ownerFilters;
const coin = (o: Partial<OwnerFilterInput> = {}): OwnerFilterInput => ({
  complete: false, onAmm: false, ageSec: 600, marketCapUsd: 20_000, volumeUsd: 30_000, liquidityUsd: null, holders: 80, totalFeesSol: 5,
  supplyStandard: true, name: 'Good Coin', symbol: 'GOOD', lateJoin: false, narrative: 0.5, ...o,
});

describe("owner's terminal filters (v10.27)", () => {
  it('picks the set by stage: migrated / new pair (≤ 1.5 min) / soon', () => {
    expect(ownerProfile({ complete: true, ageSec: 99_999 }, C)).toBe('migrated');
    expect(ownerProfile({ complete: false, ageSec: 60 }, C)).toBe('newPair');
    expect(ownerProfile({ complete: false, ageSec: 600 }, C)).toBe('soon');
  });
  it('migrated: MC ≥ $25k, ≥ 50 holders, liquidity ≥ $2k, ≥ 9 SOL fees', () => {
    const ok = coin({ complete: true, onAmm: true, marketCapUsd: 40_000, liquidityUsd: 8_000, holders: 120, totalFeesSol: 12 });
    expect(ownerFilterFails(ok, C).fails).toEqual([]);
    const bad = ownerFilterFails({ ...ok, marketCapUsd: 20_000, holders: 30, liquidityUsd: 1_500, totalFeesSol: 4 }, C).fails;
    expect(bad).toHaveLength(4);
    // A coin we joined late: holders / fees can't be judged from our partial ledger — MC + liquidity still are.
    expect(ownerFilterFails({ ...ok, holders: 3, totalFeesSol: 0.1, lateJoin: true }, C).fails).toEqual([]);
  });
  it('soon: ≤ 70 min old, volume ≥ $12k, MC ≥ $12k, ≥ 1 SOL fees', () => {
    expect(ownerFilterFails(coin(), C).fails).toEqual([]);
    expect(ownerFilterFails(coin({ ageSec: 71 * 60 }), C).fails[0]).toMatch(/71 min old/);
    expect(ownerFilterFails(coin({ marketCapUsd: 9_000 }), C).fails[0]).toMatch(/MC/);
    expect(ownerFilterFails(coin({ volumeUsd: 8_000 }), C).fails[0]).toMatch(/volume/);
    expect(ownerFilterFails(coin({ totalFeesSol: 0.5 }), C).fails[0]).toMatch(/fees/);
  });
  it('new pair: ≤ $100k MC, volume ≥ $200, ≥ 2 holders, no Mayhem, no "test" / "fuck"', () => {
    const fresh = coin({ ageSec: 60, marketCapUsd: 7_000, volumeUsd: 900, holders: 12 });
    expect(ownerFilterFails(fresh, C).fails).toEqual([]);
    expect(ownerFilterFails({ ...fresh, volumeUsd: 100 }, C).fails[0]).toMatch(/volume/);
    expect(ownerFilterFails({ ...fresh, supplyStandard: false }, C).fails[0]).toMatch(/Mayhem/);
    expect(ownerFilterFails({ ...fresh, name: 'Test Token' }, C).fails[0]).toMatch(/"test"/);
    expect(ownerFilterFails({ ...fresh, name: 'Contest' }, C).fails).toEqual([]); // whole words only
  });
  it('the terminal\'s "test, fuck" string counts as two words', () => {
    expect(excludedWord('fuck it', 'X', ['test, fuck'])).toBe('fuck');
    expect(excludedWord('nice', 'NICE', ['test, fuck'])).toBeNull();
  });
  it('a weak narrative blocks; unknown (metadata not read yet) does not', () => {
    expect(ownerFilterFails(coin({ narrative: 0.2 }), C).fails[0]).toMatch(/weak narrative/);
    expect(ownerFilterFails(coin({ narrative: null }), C).fails).toEqual([]);
  });
  it('switch off → nothing blocks', () => {
    expect(ownerFilterFails(coin({ marketCapUsd: 1 }), { ...C, enabled: false }).fails).toEqual([]);
  });
});

describe('buyers vs sellers right now', () => {
  const P = DEFAULT_CONFIG.entry.pressure;
  const NOW = 1_760_000_000_000;
  const t = (secAgo: number, buy: boolean, sol: number): CrowdTrade => ({ t: NOW - secAgo * 1000, w: `w${secAgo}`, buy, sol, tok: 1, px: 1 });
  it('sellers taking over in the last 30 s → not now', () => {
    const trades = [t(80, true, 2), t(70, true, 2), t(60, false, 0.5), t(25, false, 1.5), t(20, false, 1), t(10, true, 0.4), t(5, false, 1)];
    const p = flowPressure(trades, NOW, P)!;
    expect(p.trend).toBe('sellers_rising');
    expect(pressureFail(p, P)).toMatch(/sellers in control/);
  });
  it('buyers in control → fine; quiet windows are ignored', () => {
    const buyers = [t(25, true, 1), t(20, true, 2), t(10, false, 0.5), t(5, true, 1)];
    expect(pressureFail(flowPressure(buyers, NOW, P), P)).toBeNull();
    expect(pressureFail(flowPressure([t(10, false, 3)], NOW, P), P)).toBeNull();
    expect(flowPressure([], NOW, P)).toBeNull();
  });
});
