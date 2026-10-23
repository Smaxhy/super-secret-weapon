/** v27.30 (owner: "a notification when it enters a trade, a weekly log, and make it skip the charts it loses on"). */
import { describe, expect, it } from 'vitest';
import { inSkipped, losingSlices } from '../src/forex/lab';
import { sessionOf } from '../src/forex/montecarlo';
import { weeklyLog, weekText, mondayOf, type PnlRow } from '../src/forex/pnl';
import { DEFAULT_PUSH_SETTINGS, fxMessageFor } from '../src/lib/push';
import type { Trade } from '../src/forex/types';

const H = 3_600_000;
const OOS = Date.UTC(2026, 6, 1);
// a Wednesday; 04:00 UTC = 00:00 New York (Asia), 12:00 UTC = 08:00 New York (NY open), 08:00 UTC = 04:00 NY (London)
const day0 = Date.UTC(2026, 3, 1);
const tr = (i: number, hourUtc: number, pair: string, r: number, out = false): Trade =>
  ({ strategy: 'rsi_dip', tf: '4h', pair, side: 1, entryT: (out ? OOS + 86_400_000 : day0) + i * 86_400_000 + hourUtc * H, exitT: (out ? OOS + 86_400_000 : day0) + i * 86_400_000 + (hourUtc + 4) * H, r, reason: 'stop' }) as unknown as Trade;

describe('v27.30 skip the slices it loses on (first 70% only)', () => {
  it('drops a session and a market that lost on 8+ first-part trades, keeps the rest', () => {
    const ts: Trade[] = [];
    for (let i = 0; i < 30; i++) ts.push(tr(i, 4, 'BTCUSD', 1)); // Asia, wins
    for (let i = 0; i < 9; i++) ts.push(tr(40 + i, 8, 'ETHUSD', -1)); // London, loses
    for (let i = 0; i < 8; i++) ts.push(tr(60 + i, 4, 'LINKUSD', -0.5)); // LINK loses (in Asia)
    for (let i = 0; i < 5; i++) ts.push(tr(i, 8, 'BTCUSD', -1, true)); // unseen London losers: not used to pick
    expect(sessionOf(ts[0]!.entryT)).toBe(0);
    expect(sessionOf(ts[30]!.entryT)).toBe(1);
    const sl = losingSlices(ts, OOS);
    expect(sl.sessions).toEqual([1]);
    expect(sl.pairs.sort()).toEqual(['ETHUSD', 'LINKUSD']);
    expect(inSkipped(sl, ts[0]!)).toBe(false);
    expect(inSkipped(sl, ts[ts.length - 1]!)).toBe(true); // an unseen London trade is skipped by the first-part rule
  });
  it('a strategy that loses nearly everywhere is not rescued by slicing it', () => {
    const ts: Trade[] = [];
    for (let i = 0; i < 10; i++) ts.push(tr(i, 4, 'BTCUSD', 1));
    for (let i = 0; i < 20; i++) ts.push(tr(20 + i, 8, 'ETHUSD', -1));
    expect(losingSlices(ts, OOS)).toEqual({ sessions: [], pairs: [] });
  });
});

describe('v27.30 weekly log', () => {
  const row = (id: string, t: number, usd: number, strategy = 'rsi_dip', pair = 'XRPUSD'): PnlRow => ({ id, t, usd, pair, side: 1, strategy, tf: '4h', reason: usd > 0 ? 'target' : 'stop', entry: 1, exit: 1, openedAt: null });
  it('groups closes by Monday-start week, newest first, with strategies and markets', () => {
    expect(mondayOf('2026-10-23')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    const rows = [row('a', Date.UTC(2026, 9, 13, 10), 80), row('b', Date.UTC(2026, 9, 20, 10), -200, 'rsi_dip', 'BTCUSD'), row('c', Date.UTC(2026, 9, 22, 10), 120), row('d', Date.UTC(2026, 9, 25, 23), 40)];
    const w = weeklyLog(rows, 0);
    expect(w.map((x) => x.week)).toEqual(['2026-10-19', '2026-10-12']);
    expect(w[0]).toMatchObject({ pnlUsd: -40, trades: 3, wins: 2, bestUsd: 120, worstUsd: -200 });
    expect(w[0]!.byPair[0]).toEqual({ pair: 'XRPUSD', trades: 2, pnlUsd: 160 });
    expect(weekText(w[0]!)).toMatch(/^3 trades, 2 won \(67%\) · rsi_dip 4h −\$40\.00/);
  });
});

describe('v27.30 phone alerts', () => {
  it('a bot trade opening is announced with side, strategy, stop and target in $; the owner\'s own trades are not', () => {
    const m = fxMessageFor({ kind: 'open', acct: 'cbot', pair: 'XRPUSD', side: -1, pnlUsd: 0, stopPnlUsd: -200, targetPnlUsd: 400, strategy: 'rsi_dip', tf: '4h', riskPct: 20 }, DEFAULT_PUSH_SETTINGS)!;
    expect(m.title).toBe('📈 Coin bot sold XRP/USD');
    expect(m.body).toBe('rsi_dip 4h · stop −$200.00 · target +$400.00 (20% of the account at risk)');
    expect(m.url).toBe('/crypto/bot');
    expect(fxMessageFor({ kind: 'open', acct: 'me', pair: 'EURUSD', side: 1, pnlUsd: 0 }, DEFAULT_PUSH_SETTINGS)).toBeNull();
    expect(fxMessageFor({ kind: 'open', acct: 'bot', pair: 'EURUSD', side: 1, pnlUsd: 0 }, { ...DEFAULT_PUSH_SETTINGS, fxOpen: false })).toBeNull();
  });
  it('the Monday summary', () => {
    const m = fxMessageFor({ kind: 'week', acct: 'bot', pair: '', side: 1, pnlUsd: 53.59, reason: '3 trades, 3 won (100%)' }, DEFAULT_PUSH_SETTINGS)!;
    expect(m.title).toBe('📒 Forex bot last week +$53.59');
    expect(m.body).toBe('3 trades, 3 won (100%)');
  });
});
