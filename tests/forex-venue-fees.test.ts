/** v26: the trading venue's own fee (gTrade) in the tests and on the paper accounts. */
import { describe, expect, it } from 'vitest';
import { newAccount, tick, type Quote } from '../src/forex/practice';
import { instrument } from '../src/forex/types';
import { VENUE_FEES, feePctPerSide, feeR, feeUsd } from '../src/forex/venue-fees';

const inst = (id: string) => instrument(id)!;
const q = (id: string, mid: number, bars: Array<[number, number, number, number]> = []): Quote => ({ id, mid, bid: mid - 0.00004, ask: mid + 0.00004, t: 0, bars, dayChangePct: null, source: 'yahoo' });

describe('v26 venue fees (gTrade)', () => {
  it('rates per market group: majors, crosses, metals; coins already pay theirs in the spread', () => {
    expect(feePctPerSide(inst('EURUSD'))).toBe(0.012);
    expect(feePctPerSide(inst('USDJPY'))).toBe(0.012);
    expect(feePctPerSide(inst('EURJPY'))).toBe(0.016);
    expect(feePctPerSide(inst('XAUUSD'))).toBe(0.05);
    expect(feePctPerSide(inst('BTCUSD'))).toBe(0);
  });

  it('in R: wider stops pay a smaller share; on $25k of EUR/USD the round trip is $6', () => {
    // 20-pip stop at 1.1000 → 0.024% × 1.1 ÷ 0.0020 = 0.132R
    expect(feeR(inst('EURUSD'), 1.1, 0.002)).toBeCloseTo(0.132, 3);
    expect(feeR(inst('EURUSD'), 1.1, 0.004)).toBeCloseTo(0.066, 3);
    expect(feeUsd(inst('EURUSD'), 125, 200)).toBe(6); // $125 margin × 200 = $25,000
    expect(feeUsd(inst('XAUUSD'), 125, 200)).toBe(25);
  });

  it('a practice close pays open + close on the closed size, and the row says how much', () => {
    const T = Date.UTC(2026, 9, 19, 10);
    const a = newAccount(1000);
    a.open.push({ id: 'a', pair: 'EURUSD', side: 1, units: 100_000, entry: 1.1, marginUsd: 110, leverage: 1000, stop: 1.098, target: 1.105, openedAt: T, checkedT: T });
    tick(a, { EURUSD: q('EURUSD', 1.104, [[T + 60_000, 1.106, 1.1, 1.104]]) }, T + 70_000);
    // +$500 at the target − 0.024% × $110,000 = $26.40
    expect(a.closed[0]!.feeUsd).toBe(26.4);
    expect(a.balanceUsd).toBeCloseTo(1473.6, 1);
  });

  it('switching it off restores the old numbers', () => {
    VENUE_FEES.on = false;
    try {
      expect(feeR(inst('EURUSD'), 1.1, 0.002)).toBe(0);
      expect(feeUsd(inst('EURUSD'), 125, 200)).toBe(0);
    } finally {
      VENUE_FEES.on = true;
    }
  });
});
