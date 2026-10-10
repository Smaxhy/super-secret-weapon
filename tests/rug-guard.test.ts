import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { decideExit, type ExitInput } from '../src/executor/sell-manager';
import { rugScreen, type RugScreenInput } from '../src/executor/rug-screen';
import { dumpImpactPct, dumpRisk, holderDump, ruggerVerdict, sellCascade, topHolders } from '../src/executor/rug-watch';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const M = 1_000_000n; // 1 whole token = 1e6 raw
const tok = (n: number) => BigInt(n) * M;
const SUPPLY = tok(1_000_000_000);
const G = DEFAULT_CONFIG.antiRug.rugGuard;
const NOW = 1_760_000_000_000;

describe('rug guard v2: dump risk at entry', () => {
  it('constant-product impact of a holder selling everything', () => {
    // 100M tokens into an 800M-token curve: price × (800/900)² → −21%.
    expect(dumpImpactPct(tok(100_000_000), tok(800_000_000))).toBeCloseTo(21, 0);
    expect(dumpImpactPct(0n, tok(800_000_000))).toBe(0);
  });
  it('flags coins whose top holders can crash them, passes spread-out ones', () => {
    const concentrated = new Map([['a', tok(120_000_000)], ['b', tok(80_000_000)], ['c', tok(60_000_000)], ['d', tok(5_000_000)]]);
    const spread = new Map(Array.from({ length: 40 }, (_, i) => [`w${i}`, tok(5_000_000)] as [string, bigint]));
    const reserve = tok(500_000_000); // late curve: few tokens left in it
    const bad = dumpRisk(concentrated, reserve);
    const good = dumpRisk(spread, reserve);
    expect(bad.top3Pct).toBeGreaterThan(G.maxTop3DumpImpactPct);
    expect(good.top3Pct).toBeLessThan(G.maxTop3DumpImpactPct);
    const snap = { devHoldingPct: 1, devSoldFraction: 0, earlyBuyerPct: 2, top10HolderPct: 20, liquiditySol: 40, priceSol: 1 };
    const base: RugScreenInput = { atSignal: snap, now: snap, onAmm: false, flow60s: null, insider: null, maxDevHoldingPct: 10, guard: G };
    expect(rugScreen({ ...base, dumpRisk: good })).toBeNull();
    expect(rugScreen({ ...base, dumpRisk: bad })).toMatch(/could dump it/);
    expect(rugScreen({ ...base, ruggers: 'dev rugged us before' })).toMatch(/rugger memory/);
  });
  it('rugger list: the dev counts double, two known dumpers among the holders block it', () => {
    const flagged = new Set(['dev1', 'x', 'y']);
    expect(ruggerVerdict(flagged, 'dev1', ['a', 'b'], 2)).toMatch(/dev rugged us before/);
    expect(ruggerVerdict(flagged, 'clean', ['x', 'b'], 2)).toBeNull();
    expect(ruggerVerdict(flagged, 'clean', ['x', 'y', 'b'], 2)).toMatch(/2 wallets/);
  });
});

describe('rug guard v2: while holding', () => {
  const entry = topHolders(new Map([['big', tok(40_000_000)], ['mid', tok(25_000_000)], ['small', tok(5_000_000)], ['dust', 1n]]), 15);
  it('snapshots the biggest holders, biggest first', () => {
    expect(entry.map((h) => h.w)).toEqual(['big', 'mid', 'small', 'dust']);
  });
  it('detects top holders dumping a slice of the supply', () => {
    const calm = holderDump(entry, new Map([['big', tok(39_000_000)], ['mid', tok(25_000_000)], ['small', tok(5_000_000)]]), SUPPLY);
    expect(calm.soldSupplyPct).toBeLessThan(G.holderDumpPct);
    const dumped = holderDump(entry, new Map([['big', 0n], ['mid', tok(20_000_000)], ['small', tok(5_000_000)]]), SUPPLY);
    expect(dumped.soldSupplyPct).toBeCloseTo(4.5, 1);
    expect(dumped.sellers).toEqual(['big']);
    expect(dumped.biggest).toMatchObject({ w: 'big', soldPct: 100 });
  });
  it('detects a sell cascade but not a normal dip', () => {
    const t = (sec: number, buy: boolean, sol: number, px: number, w: string): CrowdTrade => ({ t: NOW - sec * 1000, w, buy, sol, tok: sol / px, px, pp: px });
    const rug = [t(18, true, 1, 1, 'b1'), t(15, true, 0.5, 1.02, 'b2'), t(8, false, 3, 0.9, 's1'), t(5, false, 4, 0.78, 's2'), t(1, false, 2, 0.7, 's3')];
    const dip = [t(18, true, 1, 1, 'b1'), t(10, false, 1, 0.92, 's1'), t(5, true, 1, 0.9, 'b2'), t(1, false, 0.5, 0.88, 's2')];
    expect(sellCascade(rug, NOW, G.cascade).hit).toBe(true);
    expect(sellCascade(dip, NOW, G.cascade).hit).toBe(false);
  });
  it('decideExit sells everything on a holder dump or a cascade (cascade only below 1.3x)', () => {
    const exitBase: ExitInput = {
      entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: NOW,
      staleMinutes: 120, priceSol: 0.95, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0,
      top10PctEntry: 0, top10PctNow: 0, nowMs: NOW, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: NOW - 5_000, maxHoldMinutes: 720,
      resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015, strategy: 'CURVE_SNIPE',
    };
    const ex = DEFAULT_CONFIG.exit;
    expect(decideExit(exitBase, ex).sells).toEqual([]);
    expect(decideExit({ ...exitBase, holderDump: { hit: true, detail: 'top holders dumped 5%' } }, ex).sells[0]).toMatchObject({ pct: 100, reason: 'RUG_DETECTED' });
    const cascade = { hit: true, detail: 'sell cascade', maxMultiple: 1.3 };
    expect(decideExit({ ...exitBase, sellCascade: cascade }, ex).sells[0]).toMatchObject({ reason: 'RUG_DETECTED' });
    // A big winner dipping hard is the trailing stop's job, not a rug.
    expect(decideExit({ ...exitBase, priceSol: 1.6, peakPriceSol: 1.6, sellCascade: cascade }, ex).sells.some((s) => s.reason === 'RUG_DETECTED')).toBe(false);
  });
});
