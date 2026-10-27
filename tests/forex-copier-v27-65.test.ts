/** v27.65 (owner: "count it in as well in the portfolio and don't miss shit again"). */
import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { COPIER_HB, copierDown, handleSignal, saveHeartbeat, loadHeartbeat, type CopyBook } from '../src/forex/discord';
import { bookMissedCopy, newAccount } from '../src/forex/practice';
import { fxMessageFor } from '../src/lib/push';

class FakeRedis {
  m = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      lpush: (k: string, v: string) => (ops.push(() => this.lists.set(k, [v, ...(this.lists.get(k) ?? [])])), chain),
      ltrim: () => chain,
      exec: async () => (ops.forEach((f) => f()), []),
    };
    return chain;
  }
}

describe('a missed call booked as if copied', () => {
  it('sizes it like a 20% copy on the safety stop, books the close after fees, refuses a second time', () => {
    const a = newAccount(1053.9);
    const line = bookMissedCopy(a, { pair: 'NDXUSD', side: -1, entry: 29189.75, exit: 29151.25, openedAt: 1, closedAt: 2, ref: 'discord_kojiro:signal:NDXUSD:missed-x', strategy: 'discord_kojiro', riskPct: 20, leverage: 50 });
    const c = a.closed[0]!;
    expect(c).toMatchObject({ pair: 'NDXUSD', side: -1, reason: 'signal', tf: 'signal', entry: 29189.75, exit: 29151.25 });
    expect(c.units).toBeCloseTo(210.78 / (29189.75 * 0.005), 2); // $210.78 at risk on a 0.5% stop
    const gross = 38.5 * c.units;
    expect(c.pnlUsd).toBeCloseTo(gross - (c.feeUsd ?? 0), 1);
    expect(a.balanceUsd).toBeCloseTo(1053.9 + c.pnlUsd, 2);
    expect(a.open).toHaveLength(0);
    expect(line).toMatch(/booked as if copied/);
    expect(bookMissedCopy(a, { pair: 'NDXUSD', side: -1, entry: 29189.75, exit: 29151.25, openedAt: 1, closedAt: 2, ref: 'discord_kojiro:signal:NDXUSD:missed-x', strategy: 'discord_kojiro', riskPct: 20, leverage: 50 })).toMatch(/already booked/);
  });
});

describe("don't miss his posts", () => {
  it('a post in his channel by someone else is logged, never traded', async () => {
    const r = new FakeRedis();
    const book = { copyOpen: () => { throw new Error('must not trade'); }, copyClose: () => { throw new Error('no'); }, copyBreakeven: () => { throw new Error('no'); } } as unknown as CopyBook;
    const row = await handleSignal(r as unknown as Redis, book, { id: '1400000000000000099', text: 'SIGNAL · NQ — LONG @ 29,000', at: Date.now(), other: true, author: 'mod' });
    expect(row).toMatchObject({ kind: 'other', ok: true });
    expect(row.what).toMatch(/posted by mod, not him/);
  });

  it('heartbeat → copier down after 15 quiet minutes; never reported = unknown', async () => {
    const r = new FakeRedis();
    expect(copierDown(await loadHeartbeat(r as unknown as Redis), Date.now())).toBeNull();
    const b = await saveHeartbeat(r as unknown as Redis, { channels: ['1', '2'], sent: 3 }, 1_000_000);
    expect(b.channels).toEqual(['1', '2']);
    expect(copierDown(b, 1_000_000 + COPIER_HB.staleMs - 1)).toBe(false);
    expect(copierDown(b, 1_000_000 + COPIER_HB.staleMs + 1)).toBe(true);
  });

  it('the phone gets the offline / back alert', () => {
    const s = { profitClose: true, minProfitSol: 0, lossClose: false, takeProfit: false } as unknown as Parameters<typeof fxMessageFor>[1];
    expect(fxMessageFor({ kind: 'copier', pair: '', side: 1, pnlUsd: 0, reason: 'quiet', acct: 'bot', ok: false }, s)?.title).toMatch(/offline/);
    expect(fxMessageFor({ kind: 'copier', pair: '', side: 1, pnlUsd: 0, reason: 'back', acct: 'bot', ok: true }, s)?.title).toMatch(/back online/);
  });
});
