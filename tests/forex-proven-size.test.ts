/** v28.13 (owner: "trade way less, only the closest to 100% win rate, with a high account size" → chose "only the sure
 * setups" + "proven size, cap 10%"): very-sure trades are sized from their own record on the market (a quarter of the
 * Kelly size with a cautious win rate, ≤ 10%), and the coin bot opens nothing else. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { FX_CONFIG, marketRecOf, provenSizePct, toLabTrade } from '../src/forex/lab';
import type { Trade } from '../src/forex/types';
import { BOT, Practice, newAccount, type PracticeAccount, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 30, 12, 2, 0);
afterEach(() => vi.useRealTimers());

describe('proven size', () => {
  it('a quarter of the Kelly size with a cautious win rate, capped at 10%', () => {
    expect(FX_CONFIG.provenSize).toEqual({ on: true, kellyShare: 0.25, z: 1.2816, maxPct: 10, minPct: 0.5 });
    // AVAX adx_trend 4h: 35 unseen trades, 94% won, +0.28R, PF 5.68 → Kelly ≈ 51% on the cautious win rate → capped at 10
    expect(provenSizePct({ n: 35, winPct: 94, avgR: 0.28, pf: 5.68 })).toBe(10);
    // DOGE round_break 4h: 130 trades, 86% won, +0.21R, PF 2.54 → about 9.6%
    const doge = provenSizePct({ n: 130, winPct: 86, avgR: 0.21, pf: 2.54 });
    expect(doge).toBeGreaterThan(8.5);
    expect(doge).toBeLessThan(10);
    // a thin edge on few trades → small; no edge → 0
    const thin = provenSizePct({ n: 30, winPct: 60, avgR: 0.1, pf: 1.3 });
    expect(thin).toBeLessThan(1);
    expect(provenSizePct({ n: 200, winPct: 80, avgR: -0.02, pf: 0.95 })).toBe(0);
    // a big-win strategy: 45% won, +0.25R, PF 1.45 on 400 trades
    const big = provenSizePct({ n: 400, winPct: 45, avgR: 0.25, pf: 1.45 });
    expect(big).toBeGreaterThan(1);
    expect(big).toBeLessThan(10);
  });

  it('the lab marks a very-sure trade with its proven size; a weak record is not very sure', () => {
    const cell = { pair: 'BTCUSD', inN: 92, inAvgR: 0.09, n: 130, avgR: 0.21, pf: 2.54, winPct: 86, mcP: 0.99, mcP5: 0.05, sess: [] };
    const rec = marketRecOf({ n: 222, pf: 2.1, totalR: 40 }, cell as never, false, 'BTCUSD');
    expect(rec.strict).toBe(true);
    expect(rec.sizePct).toBeGreaterThan(8.5);
    const tr = { strategy: 'round_break', tf: '4h', pair: 'BTCUSD', side: 1, entryT: NOW, keyT: NOW, entry: 100_000, stop: 98_000, target: 104_000 } as unknown as Trade;
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: true, sizeF: 1, prio: 0, judge: null, marketRec: rec }).allIn).toBe(rec.sizePct);
    expect(toLabTrade(tr, { chosen: true, rowChosen: true, edge: true, sizeF: 1, prio: 0, judge: null, marketRec: { ...rec, sizePct: 0.2 } }).allIn).toBeUndefined();
  });

  it('the coin bot opens only sure setups, sized to lose at most their proven % at the tested stop', async () => {
    vi.useFakeTimers({ now: NOW });
    expect(BOT.sureOnly).toEqual({ cbot: true });
    const m = new Map<string, string>();
    const r = { m, async get(k: string) { return m.get(k) ?? null; }, async set(k: string, v: string, mode?: string) { if (mode === 'NX' && m.has(k)) return null; m.set(k, v); return 'OK'; }, async mget(...ks: string[]) { return ks.map((k) => m.get(k) ?? null); } };
    m.set('fx:practice:cbot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    const q = (id: string, mid: number): Quote => ({ id, mid, bid: mid * 0.99995, ask: mid * 1.00005, t: NOW, bars: [[NOW - M, mid, mid, mid]], dayChangePct: 0, source: 'coinbase-live', priceT: NOW });
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ BTCUSD: q('BTCUSD', 100_000), ETHUSD: q('ETHUSD', 4_000) });
    const base = { strategy: 'round_break', tf: '4h', entryT: NOW - 2 * M, chosen: true, sizeF: 1, prio: 0.5, judge: null };
    const ordinary = { ...base, ref: `round_break:4h:ETHUSD:${NOW - 2 * M}`, pair: 'ETHUSD', side: 1 as const, stop: 3_920, target: 4_160 };
    const sure = { ...base, allIn: 6, ref: `round_break:4h:BTCUSD:${NOW - 2 * M}`, pair: 'BTCUSD', side: 1 as const, stop: 98_000, target: 104_000 };
    await p.syncBot([ordinary, sure], () => null, {}, { scope: ['1h', '4h'], acct: 'cbot' });
    const a = JSON.parse(m.get('fx:practice:cbot')!) as PracticeAccount;
    expect(a.open.map((x) => x.pair)).toEqual(['BTCUSD']);
    const pos = a.open[0]!;
    expect(pos.maxLossUsd).toBe(60); // its proven 6% of $1,000, not the flat 10%
    expect(pos.units * (pos.entry - 98_000)).toBeLessThanOrEqual(60);
    expect(pos.riskPct!).toBeGreaterThan(5);
  });
});
