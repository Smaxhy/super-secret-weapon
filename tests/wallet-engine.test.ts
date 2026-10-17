import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS, applyMigration } from '../src/config/migrations';
import { overrideConfig } from '../src/config/runtime-config';
import { crowdQuality } from '../src/evaluator/crowd-quality';
import { holderClock, watchedHolders, type WatchedHolder } from '../src/executor/holder-clock';
import { decideExit, HOLDER_CLOCK_MARKER, type ExitInput } from '../src/executor/sell-manager';
import { classify, decayRec, emptyRec, evictList, WalletBook, type WalletRec } from '../src/learner/wallet-book';
import { policyByName, Replay, type TapeRow, type TapeToken } from '../src/learner/replay';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const BOOK = DEFAULT_CONFIG.wallets;
const CQ = DEFAULT_CONFIG.wallets.entry;
const HC = DEFAULT_CONFIG.exit.holderClock;
const rec = (p: Partial<WalletRec>): WalletRec => ({ ...emptyRec(1), ...p });

describe('wallet book: classify', () => {
  it('proven / dumper / loser / bot / unknown', () => {
    expect(classify(undefined, BOOK)).toBe('unknown');
    expect(classify(rec({ n: 10, w: 7, gw: 5, gl: 2 }), BOOK)).toBe('proven');
    expect(classify(rec({ n: 10, w: 7, gw: 5, gl: 2, dumps: 3 }), BOOK)).toBe('dumper');
    expect(classify(rec({ n: 10, w: 2, gw: 1, gl: 4 }), BOOK)).toBe('loser');
    expect(classify(rec({ buys: 40, rep: 30 }), BOOK)).toBe('bot');
    expect(classify(rec({ n: 3, w: 3, gw: 2, gl: 0 }), BOOK)).toBe('unknown');
    expect(classify(rec({ n: 10, w: 6, gw: 2, gl: 2 }), BOOK)).toBe('unknown'); // PF 1 < 1.3
  });
  it('fades with a half-life and evicts the oldest', () => {
    const d = decayRec(rec({ n: 8, w: 4, pnl: 2, dumps: 2 }), 10, 10);
    expect(d.n).toBeCloseTo(4);
    expect(d.dumps).toBeCloseTo(1);
    const entries: Array<[string, WalletRec]> = [['a', rec({ last: 1 })], ['b', rec({ last: 3 })], ['c', rec({ last: 2 })]];
    expect(evictList(entries, 2)).toEqual(['a']);
    expect(evictList(entries, 3)).toEqual([]);
  });
});

describe('wallet book: learns from trades', () => {
  it('realised P&L, hold time, dump events and who got dumped on', () => {
    const b = new WalletBook(null);
    const t0 = 1_000_000;
    const tr = (mint: string, wallet: string, isBuy: boolean, sol: number, tokens: number, t: number, price?: number) => b.onTrade({ mint, wallet, isBuy, sol, tokens, t, price: price ?? sol / tokens });
    // launch (sniper window): ignored for cost basis
    tr('C', 'sniper', true, 1, 1e8, t0);
    // W buys at 1e-8, sells half at 2e-8 after 120 s → win; again at 60 s later
    tr('C', 'W', true, 1, 1e8, t0 + 20_000, 1e-8);
    tr('C', 'W', false, 1, 5e7, t0 + 140_000, 2e-8);
    // D: a whale that buys 3% of supply then dumps it → price drops 30% within 60 s
    tr('C', 'D', true, 3, 3e7, t0 + 150_000, 1e-7);
    tr('C', 'V', true, 0.2, 2e6, t0 + 160_000, 1e-7); // victim: bought right before the dump
    tr('C', 'D', false, 2.5, 3e7, t0 + 170_000, 1e-7);
    tr('C', 'X', true, 0.1, 2e6, t0 + 180_000, 6e-8); // price now 40% under the dump print
    const w = b.get('W')!;
    expect(w.n).toBe(1);
    expect(w.w).toBe(1);
    expect(w.pnl).toBeCloseTo(0.5);
    expect(w.hold).toBeCloseTo(120);
    expect(b.get('D')!.dumps).toBe(1);
    expect(b.get('V')!.dumpedOn).toBe(1);
    expect(b.get('sniper')!.n).toBe(0);
    const s = b.stats();
    expect(s.wallets).toBe(5);
    expect(s.dumpEvents).toBe(1);
  });
  it('keeps at most maxWallets (LRU by last seen)', () => {
    overrideConfig({ wallets: { maxWallets: 100 } });
    try {
      const b = new WalletBook(null);
      for (let i = 0; i < 120; i++) b.onTrade({ mint: 'M', wallet: `w${i}`, isBuy: true, sol: 0.1, tokens: 1000, t: 1_000_000 + i * 1000, price: 1e-4 });
      expect(b.size).toBeLessThanOrEqual(105);
      expect(b.get('w0')).toBeUndefined();
      expect(b.get('w119')).toBeDefined();
    } finally {
      overrideConfig({ wallets: { maxWallets: DEFAULT_CONFIG.wallets.maxWallets } });
    }
  });
});

const ct = (w: string, buy: boolean, sol: number, tok: number, t: number): CrowdTrade => ({ t, w, buy, sol, tok, px: sol / tok, pp: sol / tok });

describe('crowd quality (who is buying)', () => {
  const now = 10_000_000;
  const proven = rec({ n: 10, w: 7, gw: 5, gl: 2 });
  const dumper = rec({ n: 4, w: 2, gw: 1, gl: 1, dumps: 3 });
  const loser = rec({ n: 10, w: 2, gw: 1, gl: 4 });
  it('a known dumper still holding ≥2% of the supply → no buy', () => {
    const trades = [ct('dump', true, 3, 3e7, now - 200_000), ct('a', true, 1, 1e6, now - 60_000), ct('b', true, 1, 1e6, now - 30_000)];
    const q = crowdQuality({ trades, now }, (w) => (w === 'dump' ? dumper : undefined), () => null, BOOK, CQ)!;
    expect(q.dumpersInside).toBe(1);
    expect(q.dumperHoldPct).toBeCloseTo(3);
    expect(q.fails[0]).toMatch(/dump crew inside/);
  });
  it('proven wallets 40% of the buying → +12; losers 40%+ → −6', () => {
    const trades = [ct('p1', true, 2, 1e6, now - 60_000), ct('p2', true, 1, 1e6, now - 50_000), ct('p3', true, 1, 1e6, now - 40_000), ct('x', true, 6, 1e6, now - 30_000)];
    const q = crowdQuality({ trades, now }, (w) => (w.startsWith('p') ? proven : undefined), () => null, BOOK, CQ)!;
    expect(q.provenSolPct).toBe(40);
    expect(q.provenCount).toBe(3);
    expect(q.points).toBe(12);
    expect(q.fails).toEqual([]);
    const bad = crowdQuality({ trades: [ct('l1', true, 4, 1e6, now - 60_000), ct('y', true, 5, 1e6, now - 30_000)], now }, (w) => (w === 'l1' ? loser : undefined), () => null, BOOK, CQ)!;
    expect(bad.loserSolPct).toBeCloseTo(44.4, 0);
    expect(bad.points).toBe(-6);
    expect(bad.note).toMatch(/losing wallets/);
  });
  it('buyers sharing one funder show up as a crew (cache only); no buyers → null', () => {
    const trades = [ct('a', true, 1, 1e6, now - 60_000), ct('b', true, 1, 1e6, now - 50_000), ct('c', true, 1, 1e6, now - 40_000), ct('d', true, 1, 1e6, now - 30_000)];
    const q = crowdQuality({ trades, now }, () => undefined, (w) => (w === 'a' || w === 'b' || w === 'c' ? 'F' : null), BOOK, CQ)!;
    expect(q.crewPct).toBe(75);
    expect(crowdQuality({ trades: [ct('a', false, 1, 1e6, now - 1000)], now }, () => undefined, () => null, BOOK, CQ)).toBeNull();
  });
});

describe('holder clock (sell before the big holders usually do)', () => {
  const now = 20_000_000;
  const h = (p: Partial<WatchedHolder>): WatchedHolder => ({ wallet: 'w', pctSupply: 2, boughtAtMs: now - 600_000, holdSecMedian: 300, dumper: false, soldPctOfBag: 0, ...p });
  it('≥80% of the watched supply past its usual hold and in profit → sell 40% once, trail tightened', () => {
    const holders = [h({ wallet: 'a', pctSupply: 3 }), h({ wallet: 'b', pctSupply: 2, holdSecMedian: 3600 })];
    const v = holderClock(holders, now, 1.3, false, HC);
    expect(v.action).toBe('none'); // 3 of 5 = 60% expired
    const v2 = holderClock([h({ wallet: 'a', pctSupply: 3 }), h({ wallet: 'b', pctSupply: 2 })], now, 1.3, false, HC);
    expect(v2.action).toBe('sell');
    expect(v2.expiredShare).toBe(1);
    expect(holderClock([h({ wallet: 'a' })], now, 1.3, true, HC).action).toBe('none');
    expect(holderClock([h({ wallet: 'a' })], now, 1.05, false, HC).action).toBe('none'); // below minMultiple
    expect(holderClock([h({ wallet: 'a' })], now, 1.3, false, { ...HC, enabled: false }).action).toBe('none');
  });
  it('a known dumper selling half its bag while we hold → rug', () => {
    expect(holderClock([h({ wallet: 'd', dumper: true, soldPctOfBag: 0.6 })], now, 0.9, false, HC).action).toBe('rug');
    expect(holderClock([h({ wallet: 'd', dumper: true, soldPctOfBag: 0.2 })], now, 0.9, false, HC).action).toBe('none');
  });
  it('watchedHolders: from the trade log, bags at open, sold since, hold time from the book', () => {
    const open = now - 300_000;
    const trades = [ct('big', true, 20, 2e7, open - 600_000), ct('small', true, 0.1, 1e5, open - 100_000), ct('big', false, 10, 1e7, open + 60_000), ct('late', true, 15, 1.5e7, open + 120_000)];
    const dumper = rec({ dumps: 5 });
    const hs = watchedHolders(trades, open, (w) => (w === 'big' ? rec({ hold: 400, holdN: 3 }) : w === 'late' ? dumper : undefined), BOOK, HC);
    const big = hs.find((x) => x.wallet === 'big')!;
    expect(big.pctSupply).toBeCloseTo(1);
    expect(big.soldPctOfBag).toBeCloseTo(0.5);
    expect(big.holdSecMedian).toBe(400);
    expect(hs.find((x) => x.wallet === 'late')!.dumper).toBe(true);
    expect(hs.find((x) => x.wallet === 'small')).toBeUndefined();
  });
  it('decideExit: sells into the clock once and marks it; a dumper selling → RUG', () => {
    const base: ExitInput = {
      entryPriceSol: 1e-7, peakPriceSol: 1.3e-7, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1e-7, lastMoveAtMs: now - 1000, staleMinutes: 60,
      priceSol: 1.3e-7, migratedNoMarket: false, bundlePctEntry: 0, bundlePctNow: 0, devHoldingPctEntry: 0, devHoldingPctNow: 0, top10PctEntry: 0, top10PctNow: 0, nowMs: now,
      copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: now - 600_000, maxHoldMinutes: 240, resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 0.2, costSol: 0.2011,
      proceedsSol: 0, volatilityPct: 5, txFeeSol: 0.002, priceTrusted: true, instantPeak: true, recentHighSol: 1.3e-7, strategy: 'MIGRATION_MOMENTUM', peakAtMs: now - 1000,
      holders: [h({ wallet: 'a', pctSupply: 3 }), h({ wallet: 'b', pctSupply: 2 })],
    };
    const rules = { ...DEFAULT_CONFIG.exit, takeProfitTiers: [{ multiple: 5, sellPct: 40 }], spikeSell: { ...DEFAULT_CONFIG.exit.spikeSell, enabled: false } } as unknown as Parameters<typeof decideExit>[1];
    const d = decideExit(base, rules);
    const clock = d.sells.find((s) => s.detail.startsWith('holder clock'));
    expect(clock?.pct).toBe(40);
    expect(d.state.tpTiersHit).toContain(HOLDER_CLOCK_MARKER);
    const again = decideExit({ ...base, tpTiersHit: d.state.tpTiersHit, remainingPct: 60 }, rules);
    expect(again.sells.find((s) => s.detail.startsWith('holder clock'))).toBeUndefined();
    const rug = decideExit({ ...base, priceSol: 0.95e-7, holders: [h({ wallet: 'd', dumper: true, soldPctOfBag: 0.7 })] }, rules);
    expect(rug.sells[0]?.reason).toBe('RUG_DETECTED');
    expect(rug.sells[0]?.detail).toMatch(/known dumper/);
  });
});

describe('migration v37 + replay with the wallet engine', () => {
  it('migration v37 writes the wallet engine + holder clock into saved settings', () => {
    const m = MIGRATIONS.find((x) => x.version === 37)!;
    const out = applyMigration({ exit: { earlyBail: { enabled: true } } }, m) as { exit: { earlyBail: { enabled: boolean }; holderClock: { sellPct: number; enabled: boolean } } };
    expect(out.exit.holderClock).toMatchObject({ enabled: true, sellPct: 40 });
    expect(out.exit.earlyBail.enabled).toBe(true);
    // the wallet engine itself is a new section → defaults apply, nothing to migrate
    expect(DEFAULT_CONFIG.wallets.enabled).toBe(true);
    expect(DEFAULT_CONFIG.wallets.entry.points).toBe(12);
  });

  /** Two migrated coins with the same chart: one led by proven wallets, one with a known dumper holding 3% of the supply. */
  function tape(): { rows: TapeRow[]; tokens: Map<string, TapeToken>; from: number; to: number; book: WalletBook } {
    const t0 = Date.parse('2026-10-17T10:00:00Z');
    const rows: TapeRow[] = [];
    const tokens = new Map<string, TapeToken>();
    const book = new WalletBook(null);
    for (let i = 0; i < 6; i++) book.seed(`proven${i}`, rec({ n: 12, w: 9, gw: 6, gl: 2, last: t0 }));
    book.seed('crew', rec({ n: 4, w: 1, gw: 1, gl: 2, dumps: 4, last: t0 }));
    let seed = 11;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const build = (mint: string, leader: (i: number) => string | null) => {
      tokens.set(mint, { mint, symbol: mint, name: mint, creator: 'dev', createdAtMs: t0 - 2 * 3_600_000, completedAtMs: t0 - 3_600_000 });
      let p = 3e-7;
      if (mint === 'DUMP') rows.push({ mint, t: t0 - 60_000, w: 'crew', buy: true, sol: 9, tok: 3e7, px: 3e-7, pp: 3e-7, amm: true });
      for (let i = 0; i < 2400; i++) {
        const t = t0 + i * 500;
        const buy = rnd() < 0.68;
        const sol = 0.05 + rnd() * 0.9;
        p *= buy ? 1 + 0.0007 + rnd() * 0.0006 : 1 - 0.0004 - rnd() * 0.0005;
        const w = (buy && leader(i)) || `w${mint}${Math.floor(rnd() * 400)}`;
        rows.push({ mint, t, w, buy, sol: w.startsWith('proven') ? sol * 3 : sol, tok: sol / p, px: p, pp: p, amm: true });
      }
    };
    build('GOOD', (i) => (i % 4 === 0 ? `proven${i % 6}` : null));
    build('DUMP', () => null);
    rows.sort((a, b) => a.t - b.t);
    return { rows, tokens, from: t0 - 120_000, to: t0 + 2400 * 500 + 60_000, book };
  }

  it('the proven-wallet-led coin is bought, the dumper-led coin is refused', () => {
    overrideConfig({ trading: { enabledStrategies: { MIGRATION_MOMENTUM: true, CURVE_SNIPE: false, SOON: false } }, ownerFilters: { enabled: false }, entry: { minCombinedScore: 1, pressure: { enabled: false } }, momentumGate: { enabled: false }, entryQuality: { enabled: false }, focus: { migrated: { scan: { enabled: false }, minActiveWallets5m: 1, minMarketCapUsd: 0, minTotalFeesSol: 0, noEntryFirstSec: 0 } }, wallets: { enabled: true, entry: { enabled: true } } });
    try {
      const { rows, tokens, from, to, book } = tape();
      const r = new Replay({ policy: policyByName('wallets'), tokens, solUsd: 150, from, to, book });
      r.feed(rows);
      const rep = r.finish('t');
      const bought = new Set(rep.best.concat(rep.worst).map((t) => t.mint));
      expect(bought.has('GOOD')).toBe(true);
      expect(bought.has('DUMP')).toBe(false);
      expect(rep.skips.some((s) => /dump crew inside/.test(s.reason))).toBe(true);
    } finally {
      overrideConfig({});
    }
  });
});
