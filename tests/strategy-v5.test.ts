import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { decideExit, settledHigh, type ExitInput } from '../src/executor/sell-manager';
import { ammPostTradePrice, poolFeeBps, pumpSwapFeeBps } from '../src/lib/pumpfun';

const rules = DEFAULT_CONFIG.exit;
const NOW = 50_000_000;
const base: ExitInput = {
  entryPriceSol: 1, peakPriceSol: 1, remainingPct: 100, tpTiersHit: [], trailingActive: false, refPriceSol: 1, lastMoveAtMs: NOW,
  staleMinutes: 30, priceSol: 1, migratedNoMarket: false, bundlePctEntry: 8, bundlePctNow: 8, devHoldingPctEntry: 3, devHoldingPctNow: 3,
  top10PctEntry: 15, top10PctNow: 15, nowMs: NOW, copyWalletSold: false, risk: 0, riskWhy: '', openedAtMs: NOW - 5_000, maxHoldMinutes: 45,
  resistance: { hit: false, level: 0, touches: 0 }, sizeSol: 1, costSol: 1.0015, proceedsSol: 0, volatilityPct: null, txFeeSol: 0.0015,
};
const tr = (msAgo: number, px: number, sol = 0.5, pp?: number) => ({ t: NOW - msAgo, px, sol, ...(pp ? { pp } : {}) });

describe('settled peak (no more fake highs from sandwich spikes)', () => {
  it('a 5 ms spike print never counts as the peak', () => {
    // 1.0 for a while, a sandwiched buy prints 1.25 and the back-run puts it back to 1.0 within 5 ms.
    const trades = [tr(4_000, 1.0), tr(2_000, 1.25), tr(1_995, 1.0), tr(1_000, 1.01)];
    expect(settledHigh(trades, NOW - 5_000, NOW, 1_200)).toBeCloseTo(1.0, 5);
  });
  it('a level that held for the hold time counts (a real run registers)', () => {
    const trades = [tr(6_000, 1.0), tr(4_000, 1.3), tr(3_500, 1.32), tr(2_000, 1.31), tr(100, 1.1)];
    // 1.3+ held from 4.0s to 0.1s ago → the settled high is ~1.31 (the min over a 1.2s window up there).
    const h = settledHigh(trades, NOW - 6_000, NOW, 1_200)!;
    expect(h).toBeGreaterThanOrEqual(1.3);
    expect(h).toBeLessThan(1.33);
  });
  it('uses the pool price after the trade when known, ignores dust prints without one', () => {
    const trades = [tr(5_000, 1.0, 0.5, 1.02), tr(3_000, 9.0, 0.001), tr(2_900, 1.0, 0.5, 1.03)];
    expect(settledHigh(trades, NOW - 5_000, NOW, 1_200)).toBeCloseTo(1.03, 5);
  });
  it('the price in force when the position opened counts from the open; a too-fresh level not yet', () => {
    const trades = [tr(10_000, 1.1), tr(500, 1.5)];
    expect(settledHigh(trades, NOW - 3_000, NOW, 1_200)).toBeCloseTo(1.1, 5); // 1.5 only held 0.5s
    expect(settledHigh([], NOW - 3_000, NOW, 1_200)).toBeNull();
  });
  it('a spike can no longer arm the trailing stop and sell at a loss right after entry', () => {
    // The old bug: a real trade printed 1.22x one second after entry → trailing stop / break-even
    // floor armed → sold at 0.97x. With the settled high (≈ entry) nothing fires.
    const settled = settledHigh([tr(2_000, 1.0), tr(900, 1.22), tr(895, 0.97)], NOW - 2_000, NOW, 1_200);
    const d = decideExit({ ...base, priceSol: 0.97, instantPeak: true, recentHighSol: settled }, rules);
    expect(d.state.peakPriceSol).toBeLessThan(1.05);
    expect(d.sells).toEqual([]);
  });
});

describe('real pump.fun costs', () => {
  it('graduated coins pay tiered PumpSwap fees (1.25% when fresh, 0.3% only at huge market caps)', () => {
    expect(pumpSwapFeeBps(411)).toBe(125);
    expect(pumpSwapFeeBps(800)).toBe(120);
    expect(pumpSwapFeeBps(2_000)).toBe(115);
    expect(pumpSwapFeeBps(10_000)).toBeLessThan(115);
    expect(pumpSwapFeeBps(10_000)).toBeGreaterThan(30);
    expect(pumpSwapFeeBps(200_000)).toBe(30);
    const p = DEFAULT_CONFIG.paper;
    expect(poolFeeBps(p, false, 100)).toBe(125); // curve
    expect(poolFeeBps(p, true, 500)).toBe(120);
    expect(poolFeeBps({ ...p, ammTieredFees: false }, true, 500)).toBe(30);
  });
  it('PumpSwap price after a trade comes from the trade itself (exec × base before ÷ base after)', () => {
    // Pool 100 SOL / 1,000,000 tokens (raw 1e12): buy 10 SOL → 90,909.09 tokens out.
    const base = 1_000_000_000_000n;
    const out = (base * 10n) / 110n;
    const px = ammPostTradePrice({ isBuy: true, baseAmount: out, quoteAmount: 10_000_000_000n, baseReserve: base - out })!;
    // After: 110 SOL / 909,090.9 tokens = 1.21e-4 SOL per token.
    expect(px).toBeCloseTo(110 / 909_090.909, 8);
    expect(ammPostTradePrice({ isBuy: true, baseAmount: 0n, quoteAmount: 1n, baseReserve: 1n })).toBeNull();
  });
});

// ---- New pairs: absorption + organic demand ----
import { computeEarlyFlow, newPairCheck } from '../src/evaluator/new-pair';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

/** A fresh curve coin: constant product on virtual reserves (whole SOL / whole tokens). */
function freshCoin(t0: number) {
  let vSol = 30;
  let vTok = 1_073_000_000;
  const trades: CrowdTrade[] = [];
  const bal = new Map<string, number>();
  let slot = 1000;
  const trade = (msAfter: number, w: string, buy: boolean, amt: number) => {
    let sol: number;
    let tok: number;
    if (buy) {
      sol = amt;
      tok = vTok - (vSol * vTok) / (vSol + sol);
      vSol += sol;
      vTok -= tok;
    } else {
      tok = Math.min(amt, bal.get(w) ?? 0);
      sol = vSol - (vSol * vTok) / (vTok + tok);
      vSol -= sol;
      vTok += tok;
    }
    bal.set(w, (bal.get(w) ?? 0) + (buy ? tok : -tok));
    trades.push({ t: t0 + msAfter, w, buy, sol, tok, px: sol / tok, pp: vSol / vTok, s: slot++ });
  };
  const balances = () => new Map([...bal.entries()].filter(([, v]) => v > 1).map(([w, v]) => [w, BigInt(Math.round(v * 1e6))] as const));
  return { trade, trades, balances, held: (w: string) => bal.get(w) ?? 0 };
}

const NP = DEFAULT_CONFIG.focus.newPair;
const T0 = 80_000_000;
/** Snipers in, snipers out, then a growing crowd of real buyers with varied sizes. */
function healthyLaunch(opts: { snipersSell?: boolean; botSizes?: boolean; slowing?: boolean; devSells?: boolean } = {}) {
  const c = freshCoin(T0);
  c.trade(0, 'DEV', true, 1);
  for (let i = 0; i < 4; i++) c.trade(500 + i * 300, `SNIPER${i}`, true, 1.5);
  if (opts.snipersSell !== false) for (let i = 0; i < 4; i++) c.trade(15_000 + i * 2_000, `SNIPER${i}`, false, c.held(`SNIPER${i}`) * 0.8);
  if (opts.devSells) c.trade(30_000, 'DEV', false, c.held('DEV') * 0.5);
  // A few early retail trades while the snipers unload (no dead air).
  for (let k = 0; k < 4; k++) c.trade(24_000 + k * 5_000, `EARLY${k}`, true, 0.1 + k * 0.07);
  const sizes = [0.15, 0.4, 0.9, 0.25, 1.2, 0.3, 0.6, 0.12, 0.8, 0.5, 0.35, 1.0, 0.2, 0.7, 0.45, 0.28, 0.95, 0.18, 0.55, 0.65, 0.22, 0.85];
  // Organic buyers from 40 s on; the last 30 s busier than the 30 s before (unless slowing).
  let t = 40_000;
  sizes.forEach((sol, i) => {
    const gap = opts.slowing ? (i < 14 ? 2_000 : 5_000) : i < 8 ? 4_000 : 1_800;
    t += gap;
    c.trade(t, `BUYER${i}`, true, opts.botSizes ? 0.25 : sol / 2);
    if (i % 6 === 5) c.trade(t + 300, `BUYER${i - 3}`, false, c.held(`BUYER${i - 3}`) * 0.5);
  });
  return { c, now: T0 + t + 1_000 };
}

describe('new pairs: only after the snipers are absorbed, while real buyers keep coming', () => {
  const m = (over: Partial<Parameters<typeof newPairCheck>[1]> = {}) => ({ devHoldingPct: 3, devSoldFraction: 0, top10HolderPct: 22, supplyStandard: true, botVolumePct: 10, ...over });
  it('a healthy launch passes every check', () => {
    const { c, now } = healthyLaunch();
    const f = computeEarlyFlow(c.trades, now, { balances: c.balances(), creator: 'DEV', supplyRaw: 1_000_000_000_000_000n, sniperWindowSec: 4 });
    expect(f.buyers60s).toBeGreaterThanOrEqual(12);
    expect(f.sniperSoldPct).toBeGreaterThan(70);
    expect(newPairCheck(f, m(), NP).fails, JSON.stringify(f)).toEqual([]);
  });
  it('snipers still holding their bags → no buy (we would be their exit liquidity)', () => {
    const { c, now } = healthyLaunch({ snipersSell: false });
    const f = computeEarlyFlow(c.trades, now, { balances: c.balances(), creator: 'DEV', supplyRaw: 1_000_000_000_000_000n, sniperWindowSec: 4 });
    expect(newPairCheck(f, m(), NP).fails.join()).toContain('snipers still hold');
  });
  it('same-size bot buys, slowing demand, a selling dev, a vertical candle → no buy', () => {
    const bots = healthyLaunch({ botSizes: true });
    const fb = computeEarlyFlow(bots.c.trades, bots.now, { balances: bots.c.balances(), creator: 'DEV', supplyRaw: 1_000_000_000_000_000n });
    expect(newPairCheck(fb, m(), NP).fails.join()).toMatch(/same size|uniform|organic buyers/);
    const slow = healthyLaunch({ slowing: true });
    const fs = computeEarlyFlow(slow.c.trades, slow.now, { balances: slow.c.balances(), creator: 'DEV', supplyRaw: 1_000_000_000_000_000n });
    expect(newPairCheck(fs, m(), NP).fails.join()).toContain('slowing');
    const { c, now } = healthyLaunch();
    const f = computeEarlyFlow(c.trades, now, { balances: c.balances(), creator: 'DEV', supplyRaw: 1_000_000_000_000_000n });
    expect(newPairCheck(f, m({ devSoldFraction: 0.5 }), NP).fails.join()).toContain('dev sold');
    expect(newPairCheck({ ...f, run30sPct: 60 }, m(), NP).fails.join()).toContain('vertical candle');
    expect(newPairCheck({ ...f, biggestSell5sPct: 2 }, m(), NP).fails.join()).toContain('just dumped');
    expect(newPairCheck(f, m({ supplyStandard: false }), NP).fails.join()).toContain('Mayhem');
  });
});

// ---- Exits v5: winners pay for losers ----
import { BOOST_MARKER } from '../src/executor/sell-manager';
import { coolOffReason } from '../src/executor/trader';
import { labStats, pickBest, variantRules } from '../src/learner/strategy-lab';

describe('v5 exits', () => {
  it('no 1.15x trail any more: a +25% wobble back to +5% is held (the old exits sold it at ~+3%)', () => {
    const d = decideExit({ ...base, peakPriceSol: 1.25, priceSol: 1.05, strategy: 'CURVE_SNIPE' }, rules);
    expect(d.sells).toEqual([]);
  });
  it('first take-profit: 40% at 1.4x, then the rest can no longer close red (break-even floor)', () => {
    const d = decideExit({ ...base, peakPriceSol: 1.4, priceSol: 1.42, strategy: 'CURVE_SNIPE' }, rules);
    expect(d.sells[0]).toMatchObject({ pct: 40, reason: 'TAKE_PROFIT' });
    const after = decideExit({ ...base, peakPriceSol: 1.45, priceSol: 1.0, tpTiersHit: [1.4], remainingPct: 60, trailingActive: true, proceedsSol: 0.55, strategy: 'CURVE_SNIPE' }, rules);
    expect(after.sells.map((s) => s.reason)).toEqual(['TRAILING_STOP']);
  });
  it('time stop: a new pair that never got going is cut after 1.5 min at a small loss', () => {
    const t = { ...base, strategy: 'CURVE_SNIPE', openedAtMs: NOW - 95_000, peakPriceSol: 1.04, priceSol: 0.97 };
    expect(decideExit(t, rules).sells[0]?.detail).toContain('no follow-through');
    expect(decideExit({ ...t, openedAtMs: NOW - 60_000 }, rules).sells).toEqual([]); // too early to judge
  });
  it('stall: no new high for 3 min below the first take-profit → out', () => {
    const t = { ...base, strategy: 'CURVE_SNIPE', openedAtMs: NOW - 300_000, peakPriceSol: 1.3, peakAtMs: NOW - 200_000, priceSol: 1.15 };
    expect(decideExit(t, rules).sells[0]?.detail).toContain('stalled');
    expect(decideExit({ ...t, peakAtMs: NOW - 60_000 }, rules).sells).toEqual([]);
  });
  it('graduated while held: sells 40% into the BOOST buying (minutes 1–4), once', () => {
    const t = { ...base, strategy: 'SOON', peakPriceSol: 1.2, priceSol: 1.18, migratedAgoSec: 90 };
    const d = decideExit(t, rules);
    expect(d.sells[0]).toMatchObject({ pct: 40, reason: 'TAKE_PROFIT' });
    expect(d.state.tpTiersHit).toContain(BOOST_MARKER);
    expect(decideExit({ ...t, tpTiersHit: d.state.tpTiersHit, remainingPct: 60 }, rules).sells).toEqual([]);
    expect(decideExit({ ...t, migratedAgoSec: 400 }, rules).sells).toEqual([]); // BOOST is over
    expect(decideExit({ ...t, strategy: 'MIGRATION_MOMENTUM' }, rules).sells).toEqual([]); // bought after migration
  });
});

describe('strategy cool-off', () => {
  const b = { enabled: true, lastN: 20, minTrades: 12, maxAvgPnlPct: -4, pauseMinutes: 120 };
  it('pauses a strategy whose last trades clearly lose, for a while after the last loss', () => {
    const losing = Array.from({ length: 14 }, (_, i) => ({ pnlPct: -8, closedAtMs: NOW - i * 60_000 }));
    expect(coolOffReason(losing, NOW + 10 * 60_000, b)).toContain('cooling off');
    expect(coolOffReason(losing, NOW + 121 * 60_000, b)).toBeNull(); // pause over → it may try again
    expect(coolOffReason(losing.slice(0, 5), NOW, b)).toBeNull(); // too few trades to judge
    expect(coolOffReason(losing.map((x, i) => ({ ...x, pnlPct: i % 2 ? 12 : -8 })), NOW, b)).toBeNull(); // not losing on average
  });
});

describe('strategy lab', () => {
  it('summarises a variant and picks a winner only on real evidence', () => {
    const rows = (xs: number[]) => xs.map((pnlPct) => ({ pnlPct }));
    const live = labStats('L', 'live', rows(Array.from({ length: 50 }, (_, i) => (i % 3 ? -6 : 4))));
    const good = labStats('B', 'big', rows(Array.from({ length: 50 }, (_, i) => (i % 3 ? -6 : 30))));
    const few = labStats('R', 'runner', rows([80, 60, 40]));
    expect(live.avgPnlPct).toBeLessThan(0);
    expect(good.avgPnlPct).toBeGreaterThan(5);
    expect(good.lowerPct).toBeGreaterThan(0);
    expect(pickBest([live, good, few], 'L', { minTrades: 40, minEdgePct: 2 })?.id).toBe('B');
    expect(pickBest([live, few], 'L', { minTrades: 40, minEdgePct: 2 })).toBeNull(); // 3 trades prove nothing
    expect(pickBest([good, live], 'B', { minTrades: 40, minEdgePct: 2 })).toBeNull(); // already using the best
  });
  it('variants never move the stop band unless they are owner-only tests', () => {
    const wide = { exit: { stopLoss: { minPct: 25, maxPct: 30 } } };
    expect(variantRules(rules, wide).stopLoss.maxPct).toBe(rules.stopLoss.maxPct);
    expect(variantRules(rules, { ...wide, ownerOnly: true }).stopLoss.maxPct).toBe(30);
    const scalp = variantRules(rules, { exit: { takeProfitTiers: [{ multiple: 1.25, sellPct: 50 }] } });
    expect(scalp.takeProfitTiers).toEqual([{ multiple: 1.25, sellPct: 50 }]);
    expect(scalp.trail.ladder).toEqual(rules.trail.ladder);
  });
});
