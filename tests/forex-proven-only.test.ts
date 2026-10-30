/** v27.26 / v27.27 (owner: "only trade what's actually profitable, forex and crypto, with a big size like rsi_dip; keep
 * testing the rest"): both bots trade only Edge rows (the strict test), at 20% of the account on the tested stop. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type Redis from 'ioredis';
import { FX_CONFIG, onlyOk, planChosen, provenCells, toLabTrade } from '../src/forex/lab';
import type { Trade } from '../src/forex/types';
import { chosenOf } from '../src/forex/fast';
import { BOT, Practice, newAccount, tick, type PracticeAccount, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 23, 16, 2, 0);
class NxRedis {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, mode?: string) { if (mode === 'NX' && this.m.has(k)) return null; this.m.set(k, v); return 'OK'; }
  async mget(...ks: string[]) { return ks.map((k) => this.m.get(k) ?? null); }
}
const quote = (mid: number): Quote => ({ id: 'BTCUSD', mid, bid: mid - 5, ask: mid + 5, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'coinbase-live', priceT: Date.now() });
afterEach(() => vi.useRealTimers());
const OK = { n: 108, pf: 2.4, totalR: 20, ok: true };

describe('v27.27 only proven strategies trade, big size', () => {
  it('only Edge rows are chosen; no side doors (per-market cells, owner picks); the per-desk list is empty', () => {
    expect(FX_CONFIG.provenOnly).toEqual({ on: true, riskPct: 10, cells: { fx: true, crypto: false }, verdicts: { fx: ['edge', 'maybe'], crypto: ['edge', 'maybe'] }, maybeMinPf: { fx: 0, crypto: 1.3 }, cellAllIn: { fx: true, crypto: false } });
    // v27.82 / v27.85: coin cells off — even a strict per-market record doesn't trade without an Edge row; forex cells on
    const strict0 = { pair: 'BTCUSD', n: 108, avgR: 0.19, pf: 2.4, winPct: 50, inN: 60, inAvgR: 0.1, mcP: 0.99, mcP5: 0.05 } as never;
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, strict0, '4h', { n: 400, avgR: 0.05, pf: 1.2, verdict: 'maybe' as const })).toBe(false);
    // a Maybe row on forex is chosen but never all-in; an Edge row is
    const tr = { strategy: 'pivot_bounce', tf: '4h', pair: 'EURUSD', side: 1, entryT: NOW, keyT: NOW, entry: 1.1, stop: 1.09, target: 1.12 } as unknown as Trade;
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: false, sizeF: 1, prio: 0, judge: null }).allIn).toBeUndefined();
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: true, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBe(10);
    // v27.98: Edge but not proven on THIS market → normal size
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: true, sizeF: 1, prio: 0, judge: null, marketRec: { ...OK, ok: false } }).allIn).toBeUndefined();
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: true, sizeF: 1, prio: 0, judge: null }).allIn).toBeUndefined();
    FX_CONFIG.provenOnly.cells.fx = true;
    FX_CONFIG.provenOnly.cells.crypto = true;
    try {
    expect(FX_CONFIG.only).toEqual({ fx: [], crypto: [] });
    expect(onlyOk('crypto', 'pivot_bounce', '4h')).toBe(true);
    const cell = { pair: 'RUTUSD', n: 108, avgR: 0.19, pf: 2.4, inN: 60, inAvgR: 0.1, mc: { pProfit: 1 } } as never;
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, false, cell, '4h')).toBe(false); // no Monte Carlo field → not strict
    // v27.31: a strategy on the strict per-market bar trades that forex market; v27.34: coins too (experimental desk)
    const strict = { pair: 'RUTUSD', n: 108, avgR: 0.19, pf: 2.4, winPct: 50, inN: 60, inAvgR: 0.1, mcP: 0.99, mcP5: 0.05 } as never;
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, false, strict, '4h')).toBe(true);
    // v27.44: a coin cell also needs the deeper coin bar: 50+ unseen trades, +0.15R, PF 1.5, and the strategy not losing across the coins
    const btc = { ...(strict as object), pair: 'BTCUSD' } as never;
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, btc, '4h')).toBe(false); // no pooled record
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, btc, '4h', { n: 400, avgR: 0.05, pf: 1.2, verdict: 'maybe' as const })).toBe(true);
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, btc, '4h', { n: 400, avgR: -0.02, pf: 0.95, verdict: 'maybe' as const })).toBe(false); // loses on the coins together
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, btc, '4h', { n: 400, avgR: 0.05, pf: 1.2, verdict: 'no' as const })).toBe(false); // pooled row failed (e.g. its random-timing twins did as well)
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, { ...(btc as object), avgR: 0.12 } as never, '4h', { n: 400, avgR: 0.05, pf: 1.2, verdict: 'maybe' as const })).toBe(false); // edge too thin
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, { ...(btc as object), n: 40 } as never, '4h', { n: 400, avgR: 0.05, pf: 1.2, verdict: 'maybe' as const })).toBe(false); // too few unseen trades
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, true, strict, '4h')).toBe(false); // learner drop wins
    expect(planChosen('judas_swing', 'NDXUSD', false, undefined, false, null, '1h')).toBe(false); // the owner trial is off too
    expect(planChosen('rsi_dip', 'BTCUSD', true, undefined, false, null, '4h')).toBe(true);
    expect(planChosen('rsi_dip', 'BTCUSD', true, undefined, true, null, '4h')).toBe(false); // the learner can still drop it
    const rows = [{ id: 'rsi_dip', tf: '15m', verdict: 'edge' as const }, { id: 'news_drift', tf: '15m', verdict: 'maybe' as const }, { id: 'judas_swing', tf: '15m', verdict: 'no' as const }];
    expect(chosenOf(rows, [], ['judas_swing'], 'fx')).toEqual(['rsi_dip:15m', 'news_drift:15m']); // v27.85: forex takes Maybe rows
    expect(chosenOf(rows, [], ['judas_swing'], 'crypto')).toEqual(['rsi_dip:15m']); // coins: a Maybe row without a strong unseen PF stays out
    // v27.93: a coin Maybe row trades once its unseen profit factor is 1.3+ (and the floor passes)
    const st = (pf: number) => ({ n: 400, avgR: 0.1, pf, winRate: 0.5, totalR: 40, maxDdR: 5 }) as never;
    const solid = [{ id: 'stoch_trend', tf: '15m', verdict: 'maybe' as const, outSample: st(1.43), inSample: st(1.3) }, { id: 'cci_break', tf: '15m', verdict: 'maybe' as const, outSample: st(1.23), inSample: st(1.3) }];
    expect(chosenOf(solid, [], [], 'crypto')).toEqual(['stoch_trend:15m']);
    expect(chosenOf(solid, [], [], 'fx')).toEqual(['stoch_trend:15m', 'cci_break:15m']);
    } finally {
      FX_CONFIG.provenOnly.cells.fx = true;
      FX_CONFIG.provenOnly.cells.crypto = false;
    }
  });

  it('a chosen lab trade carries the big size; one that is not chosen does not', () => {
    const t = { strategy: 'rsi_dip', tf: '4h', pair: 'BTCUSD', side: 1, entryT: NOW, keyT: NOW, entry: 100_000, stop: 96_000, target: 108_000 } as unknown as Trade;
    expect(toLabTrade(t, { chosen: true, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBe(10);
    expect(toLabTrade(t, { chosen: false, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBeUndefined();
    // v27.34: a coin trade live only through its cell practises at the normal size; a forex cell trade stays all-in
    expect(toLabTrade(t, { chosen: true, rowChosen: false, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBeUndefined();
    expect(toLabTrade(t, { chosen: true, rowChosen: true, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBe(10);
    const fx = { ...t, pair: 'RUTUSD' } as Trade;
    expect(toLabTrade(fx, { chosen: true, rowChosen: false, sizeF: 1, prio: 0, judge: null, marketRec: OK }).allIn).toBe(10);
  });

  it('v27.34: per-market cells count as live setups in provenCells only where they trade', () => {
    const cell = (pair: string) => ({ pair, n: 108, avgR: 0.19, pf: 2.4, winPct: 50, inN: 60, inAvgR: 0.1, mcP: 0.99, mcP5: 0.05, sess: [] });
    const pooled = { n: 400, winPct: 50, avgR: 0.05, medianR: 0, pf: 1.2, totalR: 20, maxDdR: 5 };
    expect(provenCells([{ id: 'news_drift', tf: '1h', outSample: pooled, verdict: 'maybe', markets: [cell('ETHUSD'), cell('RUTUSD')] }])).toEqual({ RUTUSD: ['news_drift:1h'] }); // v27.85: forex cells on, coin cells off
    FX_CONFIG.provenOnly.cells.fx = true;
    FX_CONFIG.provenOnly.cells.crypto = true;
    try {
    const out = provenCells([{ id: 'news_drift', tf: '1h', outSample: pooled, verdict: 'maybe', markets: [cell('ETHUSD'), cell('RUTUSD'), { ...cell('BTCUSD'), mcP: 0.8 }, { ...cell('XRPUSD'), avgR: 0.12 }] }]);
    expect(out).toEqual({ ETHUSD: ['news_drift:1h'], RUTUSD: ['news_drift:1h'] });
    // v27.44: without a pooled record (or with a losing one) a coin cell doesn't count; forex cells are unchanged
    expect(provenCells([{ id: 'news_drift', tf: '1h', markets: [cell('ETHUSD'), cell('RUTUSD')] }])).toEqual({ RUTUSD: ['news_drift:1h'] });
    } finally {
      FX_CONFIG.provenOnly.cells.fx = true;
      FX_CONFIG.provenOnly.cells.crypto = false;
    }
  });

  it('a proven coin trade is sized so its tested stop + fee lose ≤ the $20 cap (v27.86 / v27.95), and the cap never pulls the stop in', async () => {
    const big0 = BOT.bigLossPct.cbot;
    BOT.bigLossPct.cbot = 0; // the v27.95 behaviour; v27.98's very-sure size is tested below
    const cap0 = BOT.maxLossUsdByAcct.cbot;
    BOT.maxLossUsdByAcct.cbot = 20; // v28.7 took the coin bot's cap off; the cap mechanism is still tested here
    onTestFinished(() => { BOT.bigLossPct.cbot = big0; BOT.maxLossUsdByAcct.cbot = cap0; });
    vi.useFakeTimers({ now: NOW });
    const r = new NxRedis();
    r.m.set('fx:practice:cbot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ BTCUSD: quote(100_000) });
    const lab = { allIn: 20, ref: `rsi_dip:4h:BTCUSD:${NOW - 2 * M}`, strategy: 'rsi_dip', tf: '4h', pair: 'BTCUSD', side: 1 as const, entryT: NOW - 2 * M, stop: 96_000, target: 108_000, chosen: true, sizeF: 0.5, prio: 0.4, judge: null };
    await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'], acct: 'cbot' });
    const a = JSON.parse(r.m.get('fx:practice:cbot')!) as PracticeAccount;
    expect(a.open).toHaveLength(1);
    const pos = a.open[0]!;
    expect(pos.allIn).toBe(true);
    expect(pos.riskPct!).toBeCloseTo(1.76, 1); // v27.95: $20 × 0.9, minus the round-trip fee, at the tested stop
    const feeUsd = (2 * 0.045 * pos.marginUsd * pos.leverage) / 100;
    expect(pos.units * (pos.entry - 96_000) + feeUsd).toBeLessThanOrEqual(20);
    expect(pos.stop).toBe(96_000);
    expect(a.maxLossUsd).toBe(BOT.maxLossUsdByAcct.cbot);
    const m1 = NOW + M;
    tick(a, { BTCUSD: { ...quote(99_000), bars: [[m1, 99_500, 98_900, 99_000, 99_500]] } }, m1 + 30_000);
    expect(a.open[0]!.stop).toBe(96_000);
    expect(BOT.allIn).toEqual({});
  });

  it('v27.98: a very-sure trade loses ≤ 10% of the account at its tested stop (fee incl.), keeps that cap, one at a time', async () => {
    vi.useFakeTimers({ now: NOW });
    expect(BOT.bigLossPct).toEqual({ cbot: 10, bot: 10 });
    const r = new NxRedis();
    r.m.set('fx:practice:cbot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ BTCUSD: quote(100_000), ETHUSD: { ...quote(4_000), id: 'ETHUSD' } });
    const lab = { allIn: 10, ref: `rsi_dip:4h:BTCUSD:${NOW - 2 * M}`, strategy: 'rsi_dip', tf: '4h', pair: 'BTCUSD', side: 1 as const, entryT: NOW - 2 * M, stop: 96_000, target: 108_000, chosen: true, sizeF: 0.5, prio: 0.4, judge: null };
    const eth = { ...lab, ref: `rsi_dip:4h:ETHUSD:${NOW - 2 * M}`, pair: 'ETHUSD', side: -1 as const, stop: 4_160, target: 3_680 };
    await p.syncBot([lab, eth], () => null, {}, { scope: ['1h', '4h'], acct: 'cbot' });
    const a = JSON.parse(r.m.get('fx:practice:cbot')!) as PracticeAccount;
    expect(a.open).toHaveLength(1); // the second big one waits — one at a time
    const pos = a.open[0]!;
    expect(pos.allIn).toBe(true);
    expect(pos.maxLossUsd).toBe(100);
    expect(pos.riskPct!).toBeGreaterThan(8.5);
    const feeUsd = (2 * 0.045 * pos.marginUsd * pos.leverage) / 100;
    expect(pos.units * (pos.entry - 96_000) + feeUsd).toBeLessThanOrEqual(100); // 10% of $1,000, with the 0.9 headroom for slips
    // the $20 account cap doesn't trim it: its own $100 cap applies
    const m1 = NOW + M;
    tick(a, { BTCUSD: { ...quote(99_000), bars: [[m1, 99_500, 98_900, 99_000, 99_500]] } }, m1 + 30_000);
    expect(a.open[0]!.units).toBe(pos.units);
    expect(a.open[0]!.stop).toBe(96_000);
  });
});

import { lockPlan, lockedStop, PROFIT_LOCK } from '../src/forex/profit-lock';

describe('v27.28 tight trail once in profit (owner: "trail its SL VERY tightly")', () => {
  it('arms at 15% of the way to the target, locks entry + costs + 5%, then trails 15% of the target distance', () => {
    expect(PROFIT_LOCK).toMatchObject({ on: true, atFrac: 0.15, gapFrac: 0.15, keepFrac: 0.05 });
    // long at 100, stop 96 (1R = 4), target 108 (2R): arms at 101.2 (+0.3R), jumps to 100.4, trails 1.2 (0.3R) behind
    const plan = lockPlan(1, 100, 96, 108, 0)!;
    expect(plan.at).toBeCloseTo(101.2, 9);
    expect(plan.to).toBeCloseTo(100.4, 9);
    expect(plan.gap).toBeCloseTo(1.2, 9);
    expect(lockedStop(1, plan, 101.2, 96)).toBeCloseTo(100.4, 9);
    expect(lockedStop(1, plan, 104, 100.4)).toBeCloseTo(102.8, 9);
    expect(lockedStop(1, plan, 103, 102.8)).toBeCloseTo(102.8, 9); // never loosens
  });
});

describe('v27.44 the coin bot counts a market move once', () => {
  it('at most 2 open trades the same way across the coins (best-tested first); the other way still opens', async () => {
    vi.useFakeTimers({ now: NOW });
    expect(BOT.maxSameSide.cbot).toBe(2); // v27.97 1, v28.11 2 again
    const sameSide = BOT.maxSameSide.cbot;
    BOT.maxSameSide.cbot = 2;
    onTestFinished(() => { BOT.maxSameSide.cbot = sameSide; });
    const r = new NxRedis();
    r.m.set('fx:practice:cbot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    const px: Record<string, number> = { BTCUSD: 100_000, ETHUSD: 4_000, SOLUSD: 200, XRPUSD: 2 };
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => Object.fromEntries(Object.entries(px).map(([id, m]) => [id, { ...quote(m), id, bid: m * 0.9999, ask: m * 1.0001, bars: [[NOW - M, m, m, m]] }]));
    const short = (pair: string, prio: number) => ({ ref: `keltner:1h:${pair}:${NOW - 2 * M}`, strategy: 'keltner', tf: '1h', pair, side: -1 as const, entryT: NOW - 2 * M, stop: px[pair]! * 1.02, target: px[pair]! * 0.96, chosen: true, sizeF: 1, prio, judge: null });
    const long = { ...short('XRPUSD', 0.1), ref: `rsi_dip:1h:XRPUSD:${NOW - 2 * M}`, strategy: 'rsi_dip', side: 1 as const, stop: 1.96, target: 2.08 };
    await p.syncBot([short('BTCUSD', 0.2), short('ETHUSD', 0.5), short('SOLUSD', 0.4), long], () => null, {}, { scope: ['1h', '4h'], acct: 'cbot' });
    const a = JSON.parse(r.m.get('fx:practice:cbot')!) as PracticeAccount;
    expect(a.open.filter((x) => x.side === -1).map((x) => x.pair).sort()).toEqual(['ETHUSD', 'SOLUSD']); // the two best-tested shorts
    expect(a.open.some((x) => x.side === 1 && x.pair === 'XRPUSD')).toBe(true);
  });
});
