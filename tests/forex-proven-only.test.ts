/** v27.26 / v27.27 (owner: "only trade what's actually profitable, forex and crypto, with a big size like rsi_dip; keep
 * testing the rest"): both bots trade only Edge rows (the strict test), at 20% of the account on the tested stop. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { FX_CONFIG, onlyOk, planChosen, toLabTrade } from '../src/forex/lab';
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

describe('v27.27 only proven strategies trade, big size', () => {
  it('only Edge rows are chosen; no side doors (per-market cells, owner picks); the per-desk list is empty', () => {
    expect(FX_CONFIG.provenOnly).toEqual({ on: true, riskPct: 20, cells: { fx: true, crypto: false } });
    expect(FX_CONFIG.only).toEqual({ fx: [], crypto: [] });
    expect(onlyOk('crypto', 'pivot_bounce', '4h')).toBe(true);
    const cell = { pair: 'RUTUSD', n: 108, avgR: 0.19, pf: 2.4, inN: 60, inAvgR: 0.1, mc: { pProfit: 1 } } as never;
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, false, cell, '4h')).toBe(false); // no Monte Carlo field → not strict
    // v27.31: a strategy on the strict per-market bar trades that forex market; never a coin
    const strict = { pair: 'RUTUSD', n: 108, avgR: 0.19, pf: 2.4, winPct: 50, inN: 60, inAvgR: 0.1, mcP: 0.99, mcP5: 0.05 } as never;
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, false, strict, '4h')).toBe(true);
    expect(planChosen('pivot_bounce', 'BTCUSD', false, undefined, false, { ...(strict as object), pair: 'BTCUSD' } as never, '4h')).toBe(false);
    expect(planChosen('pivot_bounce', 'RUTUSD', false, undefined, true, strict, '4h')).toBe(false); // learner drop wins
    expect(planChosen('judas_swing', 'NDXUSD', false, undefined, false, null, '1h')).toBe(false); // the owner trial is off too
    expect(planChosen('rsi_dip', 'BTCUSD', true, undefined, false, null, '4h')).toBe(true);
    expect(planChosen('rsi_dip', 'BTCUSD', true, undefined, true, null, '4h')).toBe(false); // the learner can still drop it
    const rows = [{ id: 'rsi_dip', tf: '15m', verdict: 'edge' as const }, { id: 'news_drift', tf: '15m', verdict: 'maybe' as const }, { id: 'judas_swing', tf: '15m', verdict: 'no' as const }];
    expect(chosenOf(rows, [], ['judas_swing'], 'fx')).toEqual(['rsi_dip:15m']);
  });

  it('a chosen lab trade carries the big size; one that is not chosen does not', () => {
    const t = { strategy: 'rsi_dip', tf: '4h', pair: 'BTCUSD', side: 1, entryT: NOW, keyT: NOW, entry: 100_000, stop: 96_000, target: 108_000 } as unknown as Trade;
    expect(toLabTrade(t, { chosen: true, sizeF: 1, prio: 0, judge: null }).allIn).toBe(20);
    expect(toLabTrade(t, { chosen: false, sizeF: 1, prio: 0, judge: null }).allIn).toBeUndefined();
  });

  it('a proven coin trade risks 20% on its tested stop and the $20 cap leaves it alone', async () => {
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
    expect(pos.riskPct!).toBeGreaterThan(19.5);
    expect(pos.riskPct!).toBeLessThanOrEqual(20.1);
    expect(pos.stop).toBe(96_000);
    expect(a.maxLossUsd).toBe(20);
    const m1 = NOW + M;
    tick(a, { BTCUSD: { ...quote(99_000), bars: [[m1, 99_500, 98_900, 99_000, 99_500]] } }, m1 + 30_000);
    expect(a.open[0]!.stop).toBe(96_000);
    expect(BOT.allIn).toEqual({});
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
