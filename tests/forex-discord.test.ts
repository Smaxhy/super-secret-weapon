/** v27.46 (owner: "copy a trade every time it's posted in the channel"): Kojiro's Discord signals → paper copies. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DISCORD_COPY, copySize, copyStop, copyStrategy, handleSignal, parseSignal, symbolToPair, type CopyBook } from '../src/forex/discord';

DISCORD_COPY.live = true; // v27.77: these tests drive the live copy path (lab only is the default)
import { Practice, newAccount, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0); // a Tuesday, markets open

class FakeRedis {
  m = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.m.has(k)) return null;
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) { return ks.map((k) => this.m.get(k) ?? null); }
  async lrange(k: string) { return this.lists.get(k) ?? []; }
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
afterEach(() => vi.useRealTimers());

describe('parseSignal', () => {
  it('reads his entry post', () => {
    expect(parseSignal('SIGNAL · NQ — LONG @ 29,026.25')).toEqual({ kind: 'open', pair: 'NDXUSD', symbol: 'NQ', side: 1, price: 29026.25, stop: null, target: null });
    expect(parseSignal('**SIGNAL · MNQ1! — SHORT @ 29,100**')).toMatchObject({ kind: 'open', pair: 'NDXUSD', side: -1, price: 29100 });
    expect(parseSignal('SIGNAL · GC — LONG @ 4,012.5\nSL @ 3,995 TP @ 4,060')).toMatchObject({ kind: 'open', pair: 'XAUUSD', side: 1, stop: 3995, target: 4060 });
    expect(parseSignal('SIGNAL · ES — BUY @ 6,850')).toMatchObject({ kind: 'open', pair: 'SPXUSD', side: 1 });
  });
  it('reads his exits and stop moves; ignores chatter', () => {
    expect(parseSignal('SELL @ 29,189.75')).toEqual({ kind: 'close', pair: null, symbol: null, closes: 1, price: 29189.75 });
    expect(parseSignal('COVER @ 28,950')).toMatchObject({ kind: 'close', closes: -1 });
    expect(parseSignal('NQ close @ 29,000')).toMatchObject({ kind: 'close', pair: 'NDXUSD', closes: 0 });
    expect(parseSignal('SL to BE')).toMatchObject({ kind: 'breakeven' });
    expect(parseSignal('gm everyone, big week ahead')).toEqual({ kind: 'none' });
  });
  it('maps contract codes and our own ids', () => {
    expect(symbolToPair('NQZ6')).toBe('NDXUSD');
    expect(symbolToPair('MNQZ2026')).toBe('NDXUSD');
    expect(symbolToPair('US30')).toBe('DJIUSD');
    expect(symbolToPair('EURUSD')).toBe('EURUSD');
    expect(symbolToPair('BTCUSDT')).toBe('BTCUSD');
    expect(symbolToPair('ZZZ')).toBeNull();
    expect(copyStrategy('Kojiro')).toBe('discord_kojiro');
  });
});

describe('sizing', () => {
  it('safety stop: his SL when on the losing side, else 0.5% of the price', () => {
    expect(copyStop(1, 29_000, 28_900)).toBe(28_900);
    expect(copyStop(1, 29_000, 29_100)).toBeCloseTo(28_855, 6); // his SL above our (delayed) fill → ours
    expect(copyStop(-1, 29_000, null)).toBeCloseTo(29_145, 6);
  });
  it('the stop loses the asked risk; free margin caps it', () => {
    // NQ: $1 a point a unit; $20 over 145 points at 50× on a 29,000 price
    const s = copySize({ riskUsd: 20, stopDist: 145, usdPerUnitMove: 1, notionalPerUnit: 29_000, leverage: 50, freeMarginUsd: 1000 });
    expect(s.marginUsd).toBeCloseTo(80, 1);
    expect(s.riskUsd).toBe(20);
    const capped = copySize({ riskUsd: 20, stopDist: 145, usdPerUnitMove: 1, notionalPerUnit: 29_000, leverage: 50, freeMarginUsd: 80, marginShare: 0.5 });
    expect(capped.marginUsd).toBe(40);
    expect(capped.riskUsd).toBe(10);
  });
});

describe('handleSignal on the bot account', () => {
  const setup = () => {
    vi.useFakeTimers({ now: NOW });
    const r = new FakeRedis();
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), maxLossUsd: 20 }));
    const p = new Practice(r as unknown as Redis);
    let mid = 29_030;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ NDXUSD: { id: 'NDXUSD', mid, bid: mid - 1, ask: mid + 1, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() } as Quote });
    const acct = () => JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    return { r, p, acct, setMid: (x: number) => (mid = x) };
  };
  it('opens a long on his post at 20% of the account (past the $20 cap), no target, copy profit lock; once per message', async () => {
    const { r, p, acct } = setup();
    const row = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000001', text: 'SIGNAL · NQ — LONG @ 29,026.25', at: NOW - 20_000 });
    expect(row.ok).toBe(true);
    const a = acct();
    expect(a.open).toHaveLength(1);
    const pos = a.open[0]!;
    expect(pos).toMatchObject({ pair: 'NDXUSD', side: 1, entry: 29_031, target: null, strategy: 'discord_kojiro', tf: 'signal' });
    expect(pos.lock).toBeUndefined(); // v27.61: the copy lock is worked out at the first check (looser than the bot's)
    expect(pos.ref).toBe('discord_kojiro:signal:NDXUSD:1300000000000000001');
    expect((pos.entry - pos.stop!) * pos.units).toBeCloseTo(200, 0); // v27.57: the safety stop loses 20% ($200)
    expect(pos.allIn).toBe(true); // the account's $20 loss cap leaves it alone
    expect(pos.maxLossUsd).toBeUndefined();
    const again = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000001', text: 'SIGNAL · NQ — LONG @ 29,026.25', at: NOW - 20_000 });
    expect(again.kind).toBe('duplicate');
    expect(acct().open).toHaveLength(1);
  });
  it('v27.57: all open copies together risk at most 20% — a second call while 20% rides is refused', async () => {
    const { r, p, acct } = setup();
    expect((await handleSignal(r as unknown as Redis, p, { id: '1300000000000000011', text: 'SIGNAL · NQ — LONG @ 29,026.25', at: NOW })).ok).toBe(true);
    const second = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000012', text: 'SIGNAL · NQ — SHORT @ 29,026.25', at: NOW });
    expect(second.ok).toBe(false);
    expect(second.what).toMatch(/riding on his calls/);
    expect(acct().open).toHaveLength(1);
  });
  it('closes the long on his SELL @ with reason signal; a SELL with nothing open does nothing', async () => {
    const { r, p, acct, setMid } = setup();
    await handleSignal(r as unknown as Redis, p, { id: '1300000000000000002', text: 'SIGNAL · NQ — LONG @ 29,026.25', at: NOW });
    setMid(29_190);
    const row = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000003', text: 'SELL @ 29,189.75', at: NOW });
    expect(row.ok).toBe(true);
    const a = acct();
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]).toMatchObject({ reason: 'signal', strategy: 'discord_kojiro' });
    expect(a.closed[0]!.pnlUsd).toBeGreaterThan(0);
    const none = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000004', text: 'SELL @ 29,200', at: NOW });
    expect(none).toMatchObject({ kind: 'close', ok: false, what: 'no open copy to close' });
  });
  it('refuses an old post and a price far from his (wrong market)', async () => {
    const { r, p, acct } = setup();
    const old = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000005', text: 'SIGNAL · NQ — LONG @ 29,026.25', at: NOW - 30 * M });
    expect(old.kind).toBe('old');
    const far = await handleSignal(r as unknown as Redis, p, { id: '1300000000000000006', text: 'SIGNAL · NQ — LONG @ 21,000', at: NOW });
    expect(far.ok).toBe(false);
    expect(far.what).toMatch(/far from his/);
    expect(acct().open).toHaveLength(0);
  });
  it('every handled message is logged; chatter is not a trade', async () => {
    const r = new FakeRedis();
    const book: CopyBook = { copyOpen: vi.fn(), copyClose: vi.fn(), copyBreakeven: vi.fn() } as unknown as CopyBook;
    const row = await handleSignal(r as unknown as Redis, book, { id: '1300000000000000007', text: 'nice trade fam', at: NOW }, NOW);
    expect(row.kind).toBe('none');
    expect(book.copyOpen).not.toHaveBeenCalled();
    expect(r.lists.get('fx:discord:log')).toHaveLength(1);
  });
});

describe('v27.58 resizeCopies', () => {
  it('re-sizes an open 2% copy to 20% on its original stop, restores a stop the $ cap pulled in, lifts the cap', async () => {
    const { resizeCopies } = await import('../src/forex/practice');
    const a = { ...newAccount(1000), maxLossUsd: 20 } as PracticeAccount;
    // 0.5% safety stop at 29,000 = 145 points; $20 risk → 0.1379 units; the cap had pulled the stop in to $10
    const units = 20 / 145;
    a.open.push({ id: 'k1', pair: 'NDXUSD', side: 1, units, entry: 29_000, marginUsd: (units * 29_000) / 50, leverage: 50, stop: 29_000 - 10 / units, target: null, openedAt: NOW, checkedT: NOW, strategy: 'discord_kojiro', ref: 'discord_kojiro:signal:NDXUSD:1', tf: 'signal', riskPct: 2, riskUsd0: 20, maxLossUsd: 20 } as PracticePosition);
    const lines = resizeCopies(a, 20, {});
    const p = a.open[0]!;
    expect(lines[0]).toMatch(/re-sized as if opened at 20%/);
    expect((p.entry - p.stop!) * p.units).toBeCloseTo(200, 0);
    expect(p.entry - p.stop!).toBeCloseTo(145, 1);
    expect(p.allIn).toBe(true);
    expect(p.maxLossUsd).toBeUndefined();
    expect(p.marginUsd).toBeLessThanOrEqual(900);
    expect(a.balanceUsd).toBe(1000); // nothing booked
  });
});

describe('v27.59 reenterCopy', () => {
  it('re-opens the newest closed copy at the market on its original stop, 20% of the account, new ref', async () => {
    vi.useFakeTimers({ now: NOW });
    const r = new FakeRedis();
    const a = newAccount(1000);
    const units = 200 / 145; // re-sized copy: $200 at a 145-point stop from 29,000
    a.closed.push({ id: 'k1', pair: 'NDXUSD', side: 1, units, entry: 29_000, marginUsd: 800, leverage: 50, stop: 29_010, target: null, openedAt: NOW - 30 * M, checkedT: NOW, strategy: 'discord_kojiro', ref: 'discord_kojiro:signal:NDXUSD:9', tf: 'signal', riskPct: 20, riskUsd0: 200, exit: 29_010, closedAt: NOW - 2 * M, pnlUsd: 10, reason: 'stop' } as PracticeAccount['closed'][number]);
    r.m.set('fx:practice:bot', JSON.stringify(a));
    const p = new Practice(r as unknown as Redis);
    const mid = 29_050;
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ NDXUSD: { id: 'NDXUSD', mid, bid: mid - 1, ask: mid + 1, t: Date.now(), bars: [[Date.now() - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: Date.now() } as Quote });
    const line = await p.reenterCopy('bot', 20);
    expect(line).toMatch(/re-entered long NDXUSD/);
    const pos = (JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open[0]!;
    expect(pos.stop).toBeCloseTo(28_855, 0); // the original stop, not the profit-lock stop it closed on
    expect(pos.ref).toBe('discord_kojiro:signal:NDXUSD:9:re1');
    expect(pos.allIn).toBe(true);
    expect((pos.entry - pos.stop!) * pos.units).toBeCloseTo(200, -1);
    expect(await p.reenterCopy('bot', 20)).toMatch(/already back in/);
  });
});

describe('v27.60 reviveCopy', () => {
  it('strikes the close and puts the trade back on its original entry + stop at 20%, no profit lock', async () => {
    const { reviveCopy } = await import('../src/forex/practice');
    const a = { ...newAccount(1000), balanceUsd: 999.74 } as PracticeAccount;
    const units = 20 / 147.43;
    a.closed.push({ id: 'k1', pair: 'NDXUSD', side: 1, units, entry: 29_486, marginUsd: 80, leverage: 50, stop: 29_501.77, target: null, openedAt: NOW - 20 * M, checkedT: NOW, strategy: 'discord_kojiro', ref: 'discord_kojiro:signal:NDXUSD:7', tf: 'signal', riskPct: 1.9, riskUsd0: 20, lock: { at: 1, stop: 1, gap: 1 } as never, locked: true, exit: 29_501.77, closedAt: NOW - 3 * M, pnlUsd: -0.26, reason: 'stop' } as PracticeAccount['closed'][number]);
    const r = reviveCopy(a, 'discord_kojiro:signal:NDXUSD:7', 20);
    expect(r.ids).toEqual(['k1']);
    expect(a.closed).toHaveLength(0);
    expect(a.balanceUsd).toBe(1000);
    const p = a.open[0]!;
    expect(p.entry).toBe(29_486);
    expect(p.stop).toBeCloseTo(29_338.57, 1);
    expect(p.lock).toBeUndefined(); // the copy lock is worked out again at the next check
    expect(p.locked).toBe(false);
    expect(p.allIn).toBe(true);
    expect((p.entry - p.stop!) * p.units).toBeCloseTo(200, 0);
  });
});

describe('v27.61 copy lock', () => {
  it('is wide early (arms +0.5R, trails 0.5R) and tightens to 0.3R past +1.2R', async () => {
    const { COPY_LOCK, lockPlan, lockedStop } = await import('../src/forex/profit-lock');
    const plan = lockPlan(1, 29_486, 29_338.57, null, 1, COPY_LOCK)!;
    const r = 29_486 - 29_338.57;
    expect(plan.at - 29_486).toBeCloseTo(0.5 * r, 1); // +73.7: the Oct 27 run to 29,546 (+60) would not have armed it
    expect(29_546 < plan.at).toBe(true);
    expect(lockedStop(1, plan, 29_600, null)).toBeCloseTo(29_600 - 0.5 * r, 1); // trails 0.5R early
    expect(lockedStop(1, plan, 29_700, null)).toBeCloseTo(29_700 - 0.3 * r, 1); // past +1.2R: 0.3R
  });
});
