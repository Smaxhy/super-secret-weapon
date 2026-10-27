/** v27.67 (owner: "if there is a big spike, sell — I close it way earlier"). */
import { describe, expect, it } from 'vitest';
import { SPIKE_EXIT, newAccount, spikeExitFor, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { VENUE_FEES } from '../src/forex/venue-fees';

VENUE_FEES.on = false;
const T = Date.UTC(2026, 9, 27, 14, 0, 0);
// a BTC long: 0.01 BTC, tested stop 2,000 below → riskUsd0 $20 (1R = $2,000 of price)
const long = (o: Partial<PracticePosition> = {}): PracticePosition => ({ id: 'b1', pair: 'BTCUSD', side: 1, units: 0.01, entry: 80_000, marginUsd: 40, leverage: 20, stop: 78_000, target: 84_000, openedAt: T - 3_600_000, checkedT: T - 60_000, ref: 'round_break:1h:BTCUSD:1', strategy: 'round_break', tf: '1h', riskUsd0: 20, lock: null, ...o });
const quote = (mid: number, lows: number[]): Quote => ({ id: 'BTCUSD', mid, bid: mid - 5, ask: mid + 5, t: T, bars: lows.map((l, i) => [T - (lows.length - i) * 60_000, Math.max(l, mid), l, mid] as [number, number, number, number]), dayChangePct: null, source: 'coinbase-live' });

describe('sell into a big spike', () => {
  it('a jump of +0.3R in a few minutes with the trade +0.3R or more in profit → sold', () => {
    // 5 minutes ago it sat at 80,200 (+0.1R); now 81,000 (+0.5R): a +0.4R jump
    expect(spikeExitFor(long(), quote(81_000, [80_200, 80_400, 80_700]), { BTCUSD: 81_000 }, 5, T)).toMatch(/\+0\.40R in 5 min/);
    const a = newAccount(1000);
    a.open = [long()];
    const ev = tick(a, { BTCUSD: quote(81_000, [80_200, 80_400, 80_700]) }, T);
    expect(a.open).toHaveLength(0);
    expect(a.closed[0]).toMatchObject({ reason: 'spike' });
    expect(a.closed[0]!.pnlUsd).toBeCloseTo(0.01 * (80_995 - 80_000), 2);
    expect(ev.join(' ')).toMatch(/sold into it/);
  });

  it('a slow climb, a jump while still under +0.3R, the owner\'s own trade or a Kojiro copy → kept', () => {
    const slow = quote(81_000, [80_900, 80_950, 80_980]); // only +0.05R in the window
    expect(spikeExitFor(long(), slow, { BTCUSD: 81_000 }, 5, T)).toBeNull();
    expect(spikeExitFor(long(), quote(80_500, [79_700, 80_000]), { BTCUSD: 80_500 }, 5, T)).toBeNull(); // +0.25R only
    expect(spikeExitFor(long({ ref: undefined }), quote(81_000, [80_200]), { BTCUSD: 81_000 }, 5, T)).toBeNull();
    expect(spikeExitFor(long({ tf: 'signal' }), quote(81_000, [80_200]), { BTCUSD: 81_000 }, 5, T)).toBeNull();
    SPIKE_EXIT.on = false;
    expect(spikeExitFor(long(), quote(81_000, [80_200]), { BTCUSD: 81_000 }, 5, T)).toBeNull();
    SPIKE_EXIT.on = true;
  });

  it('a short spikes down the same way', () => {
    const s = long({ side: -1, stop: 82_000, target: 76_000 });
    const q: Quote = { id: 'BTCUSD', mid: 79_000, bid: 78_995, ask: 79_005, t: T, bars: [[T - 180_000, 79_800, 79_500, 79_600], [T - 60_000, 79_300, 79_000, 79_000]], dayChangePct: null, source: 'coinbase-live' };
    expect(spikeExitFor(s, q, { BTCUSD: 79_000 }, 5, T)).toMatch(/\+0\.40R/);
  });
});
