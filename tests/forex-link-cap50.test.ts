// v27.78: a closed bot trade replayed with a bigger $ loss cap on the minutes since its entry.
import { describe, expect, it } from 'vitest';
import { BOT, newAccount, replayBotTrade, type ClosedPractice } from '../src/forex/practice';
import type { Bar } from '../src/forex/types';

const T0 = Date.parse('2026-10-28T04:07:09Z');
const M = 60_000;
const row = (): ClosedPractice => ({
  id: 'x1', pair: 'LINKUSD', side: 1, units: 507.36, entry: 11.717, marginUsd: 297.11, leverage: 20, stop: 11.67758, target: null,
  openedAt: T0, checkedT: T0, strategy: 'keltner', ref: 'keltner:1h:LINKUSD:1793160000000', tf: '1h', riskPct: 5.68, riskUsd0: 67.57, maxLossUsd: 20,
  exit: 11.6775, closedAt: T0 + 21 * M, pnlUsd: -20.04, reason: 'stop',
});
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });

describe('v27.78 replay a capped bot trade with a $50 cap', () => {
  it('the coin bot cap is $50 and smart caps may not go under it', () => {
    expect(BOT.maxLossUsdByAcct.cbot).toBe(50);
    expect(BOT.capFloorAccts.cbot).toBe(true);
  });
  it('a dip that hit the $20 stop but not the $50 one: struck, then still running from the last minute', () => {
    const a = newAccount(1000);
    a.balanceUsd = 979.96;
    a.closed = [row()];
    const start = Math.floor(T0 / M) * M + M;
    const bars = [bar(start, 11.71, 11.72, 11.677, 11.69), bar(start + M, 11.69, 11.71, 11.68, 11.70)];
    const r = replayBotTrade(a, 'keltner:1h:LINKUSD:1793160000000', 50, bars);
    expect(r.ids).toEqual(['x1']);
    expect(a.balanceUsd).toBe(1000);
    expect(a.closed).toHaveLength(0);
    expect(a.open).toHaveLength(1);
    const p = a.open[0]!;
    expect(p.maxLossUsd).toBe(50);
    expect(p.stop).toBeCloseTo(11.717 - 50 / 507.36, 5); // the $50 stop (tighter than the tested 11.5838)
    expect(r.line).toContain('still running');
    expect(a.skipRefs ?? []).not.toContain('keltner:1h:LINKUSD:1793160000000');
  });
  it("ends at the lab exit time at that minute's close when nothing closed it before", () => {
    const a = newAccount(1000);
    a.balanceUsd = 979.96;
    a.closed = [row()];
    const start = Math.floor(T0 / M) * M + M;
    const bars = [bar(start, 11.71, 11.72, 11.70, 11.71), bar(start + M, 11.71, 11.73, 11.70, 11.72)];
    const r = replayBotTrade(a, 'keltner:1h:LINKUSD:1793160000000', 50, bars, start + M);
    expect(a.open).toHaveLength(0);
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]!.reason).toBe('signal');
    expect(r.line).toContain('the lab closed its trade');
  });
  it('a cap wider than the tested stop keeps the tested stop', () => {
    const a = newAccount(1000);
    a.closed = [{ ...row(), units: 366.49, entry: 11.8435, riskUsd0: 46.49, ref: 'b' }];
    replayBotTrade(a, 'b', 50, []);
    expect(a.open[0]!.stop).toBeCloseTo(11.8435 - 46.49 / 366.49, 5);
  });
});
