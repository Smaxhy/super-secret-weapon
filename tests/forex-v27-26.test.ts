/** v27.26 (owner: "I just need 1 strategy that sticks… if it happens trade it with extreme size up to 20% of the wallet"):
 * the coin bot trades only rsi_dip 4h, at 20% of the account on its own tested stop. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { FX_CONFIG, onlyOk, planChosen } from '../src/forex/lab';
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

describe('v27.26 one strategy on the coin bot', () => {
  it('only rsi_dip 4h is allowed on coins; forex is unchanged', () => {
    expect(FX_CONFIG.only.crypto).toEqual(['rsi_dip:4h']);
    expect(onlyOk('crypto', 'rsi_dip', '4h')).toBe(true);
    expect(onlyOk('crypto', 'pivot_bounce', '4h')).toBe(false);
    expect(onlyOk('fx', 'pivot_bounce', '4h')).toBe(true);
    expect(planChosen('pivot_bounce', 'BTCUSD', true, undefined, false, null, '4h')).toBe(false);
    expect(planChosen('rsi_dip', 'BTCUSD', true, undefined, false, null, '4h')).toBe(true);
    const rows = [{ id: 'rsi_dip', tf: '15m', verdict: 'maybe' as const }, { id: 'news_drift', tf: '15m', verdict: 'maybe' as const }];
    expect(chosenOf(rows, [], [], 'crypto')).toEqual([]);
    expect(chosenOf(rows, [], [], 'fx')).toHaveLength(2);
  });

  it('an rsi_dip 4h coin trade risks 20% on its tested stop and the $20 cap leaves it alone', async () => {
    expect(BOT.allIn.cbot?.['rsi_dip:4h']).toBe(20);
    vi.useFakeTimers({ now: NOW });
    const r = new NxRedis();
    r.m.set('fx:practice:cbot', JSON.stringify(newAccount(1000)));
    const p = new Practice(r as unknown as Redis);
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ BTCUSD: quote(100_000) });
    const lab = { ref: `rsi_dip:4h:BTCUSD:${NOW - 2 * M}`, strategy: 'rsi_dip', tf: '4h', pair: 'BTCUSD', side: 1 as const, entryT: NOW - 2 * M, stop: 96_000, target: 108_000, chosen: true, sizeF: 0.5, prio: 0.4, judge: null };
    await p.syncBot([lab], () => null, {}, { scope: ['1h', '4h'], acct: 'cbot' });
    const a = JSON.parse(r.m.get('fx:practice:cbot')!) as PracticeAccount;
    expect(a.open).toHaveLength(1);
    const pos = a.open[0]!;
    expect(pos.allIn).toBe(true);
    expect(pos.riskPct!).toBeGreaterThan(19.5);
    expect(pos.riskPct!).toBeLessThanOrEqual(20.1);
    expect(pos.stop).toBe(96_000);
    // the account's $20 cap does not pull an all-in stop in
    expect(a.maxLossUsd).toBe(20);
    const m1 = NOW + M;
    tick(a, { BTCUSD: { ...quote(99_000), bars: [[m1, 99_500, 98_900, 99_000, 99_500]] } }, m1 + 30_000);
    expect(a.open[0]!.stop).toBe(96_000);
  });
});
