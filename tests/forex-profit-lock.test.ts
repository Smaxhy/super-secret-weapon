/** v17.11 the owner's profit lock: ⅓ of the way to the target → stop past the entry, then trail ⅓ behind the best price. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM, simulate } from '../src/forex/engine';
import { lockedStop, lockPlan, PROFIT_LOCK } from '../src/forex/profit-lock';
import { buildCtx } from '../src/forex/ta';
import { newAccount, tick, type PracticePosition, type Quote } from '../src/forex/practice';
import { tradeLines } from '../src/forex/plan';
import { summarizeLock, type Row } from '../src/forex/lab';
import { INSTRUMENTS, type Bar, type Signal } from '../src/forex/types';
import { VENUE_FEES } from '../src/forex/venue-fees';
// v27.28 made the live lock much tighter; this file pins the original ⅓ / ⅓ / 0.1 numbers its examples were written for
Object.assign(PROFIT_LOCK, { atFrac: 1 / 3, gapFrac: 1 / 3, keepFrac: 0.1 });


// v27.8: these tests pin the exit AT the target (the run-past-target trail is tested in forex-run-past-tp)
DEFAULT_SIM.runPastTarget = false;
// v26: these tests pin exact R / USD numbers of other features — the venue fee is tested on its own (forex-venue-fees)
VENUE_FEES.on = false;

const H = 3_600_000;
const EUR = INSTRUMENTS[0]!;
const HALF = (EUR.spreadPips * EUR.pip) / 2;

describe('lock plan', () => {
  it('owner example: target +30 → arms at +10, jumps to entry + costs + 3, trails 10 behind', () => {
    const p = lockPlan(1, 100, 90, 130, 0.5)!;
    expect(p.at).toBeCloseTo(110, 10);
    expect(p.to).toBeCloseTo(103.5, 10);
    expect(p.gap).toBeCloseTo(10, 10);
    // the stop after the price reached +20: +10; never under the locked level, never looser than the current stop
    expect(lockedStop(1, p, 120, 101)).toBeCloseTo(110, 10);
    expect(lockedStop(1, p, 111, 101)).toBeCloseTo(103.5, 10);
    expect(lockedStop(1, p, 111, 106)).toBe(106);
    // a short mirrors it
    const s = lockPlan(-1, 100, 110, 70, 0.5)!;
    expect(s.at).toBeCloseTo(90, 10);
    expect(s.to).toBeCloseTo(96.5, 10);
    expect(lockedStop(-1, s, 80, 99)).toBeCloseTo(90, 10);
  });

  it('no target → twice the stop distance; nothing usable or costs too big → no lock', () => {
    expect(lockPlan(1, 100, 95, null, 0)!.at).toBeCloseTo(100 + 10 / 3, 10);
    expect(lockPlan(1, 100, null, null, 0)).toBeNull();
    expect(lockPlan(1, 100, 101, null, 0)).toBeNull(); // stop already past the entry
    expect(lockPlan(1, 100, 90, 99, 0)!.at).toBeCloseTo(100 + 20 / 3, 10); // target on the wrong side → the stop decides
    expect(lockPlan(1, 100, 90, 103, 5)).toBeNull(); // costs eat the whole first third
    expect(PROFIT_LOCK.atFrac).toBeCloseTo(1 / 3, 10);
  });
});

describe('profit lock in the engine', () => {
  /** 260 flat hourly bars at 1.1000, a long signal at bar 250 (stop 10 pips, target 30 pips), then `after` from 260 on */
  function market(after: Array<Partial<Bar>>): Bar[] {
    const t0 = Date.UTC(2025, 0, 6);
    const bars = Array.from({ length: 260 }, (_, i) => ({ t: t0 + i * H, o: 1.1, h: 1.1001, l: 1.0999, c: 1.1 }));
    after.forEach((b, k) => {
      const px = b.c ?? 1.1;
      bars.push({ t: t0 + (260 + k) * H, o: b.o ?? px, h: b.h ?? px + 0.0001, l: b.l ?? px - 0.0001, c: px });
    });
    return bars;
  }
  const sig: Signal = { side: 1, stop: 1.099, target: 1.103 };
  const run = (bars: Bar[], lock = true) => simulate(EUR, '1h', buildCtx(bars, 60, 'EURUSD'), 'x', bars.map((_, i) => (i === 250 ? sig : null)), undefined, { ...DEFAULT_SIM, profitLock: lock })[0]!;

  it('a third of the way up, then a full reversal: closes in profit instead of at the stop', () => {
    const bars = market([{ c: 1.1005 }, { o: 1.1005, h: 1.1012, l: 1.1004, c: 1.1011 }, { o: 1.1011, h: 1.1011, l: 1.098, c: 1.098 }, { c: 1.098 }]);
    const off = run(bars, false);
    expect(off.reason).toBe('stop');
    expect(off.r).toBeLessThan(-0.9);
    const on = run(bars);
    expect(on.reason).toBe('breakeven');
    expect(on.r).toBeGreaterThan(0.1);
    expect(on.exit).toBeGreaterThan(on.entry);
  });

  it('keeps trailing a third of the target distance behind the best price', () => {
    const bars = market([{ c: 1.1005 }, { o: 1.1005, h: 1.1016, l: 1.1004, c: 1.1015 }, { o: 1.1015, h: 1.1026, l: 1.1014, c: 1.1025 }, { o: 1.1025, h: 1.1025, l: 1.099, c: 1.099 }, { c: 1.099 }]);
    const on = run(bars);
    expect(on.reason).toBe('trail');
    const d = 1.103 - on.entry;
    expect(on.stop).toBeCloseTo(1.1026 - d / 3, 6);
    expect(on.r).toBeGreaterThan(1.2);
    expect(run(bars, false).r).toBeLessThan(-0.9);
  });

  it('a red candle that touches the lock level and falls back closes at the locked stop in the same hour', () => {
    const bars = market([{ o: 1.1008, h: 1.1011, l: 1.1002, c: 1.1003 }, { c: 1.1003 }]);
    const on = run(bars);
    expect(on.reason).toBe('breakeven');
    expect(on.exitT).toBe(bars[260]!.t);
    expect(on.r).toBeGreaterThan(0);
  });

  it('the target still closes the trade when it comes first', () => {
    const on = run(market([{ o: 1.1, h: 1.1032, l: 1.0999, c: 1.1031 }, { c: 1.1031 }]));
    expect(on.reason).toBe('target');
  });

  it('the profit lock is on in the default simulation', () => {
    expect(DEFAULT_SIM.profitLock).toBe(true);
  });
});

describe('profit lock on the practice / bot account (live prices)', () => {
  const T = Date.UTC(2026, 9, 14, 14, 0, 0);
  const q = (mid: number, bars: Array<[number, number, number, number, number]>): Quote => ({ id: 'EURUSD', mid, bid: mid - 0.00004, ask: mid + 0.00004, t: T, bars, dayChangePct: null, source: 'yahoo-live' });
  const long = (): PracticePosition => ({ id: 'p1', pair: 'EURUSD', side: 1, units: 10_000, entry: 1.1, marginUsd: 100, leverage: 110, stop: 1.097, target: 1.103, openedAt: T, checkedT: 0 });

  it('arms at a third of the way, trails every check, and closes in profit when the price turns', () => {
    const a = newAccount(1000);
    a.open = [long()];
    const m1 = T + 60_000;
    // minute 1: up to +12 pips at the bid → armed: stop past the entry
    const mv = { moved: false };
    let ev = tick(a, { EURUSD: q(1.1011, [[m1, 1.1012, 1.1004, 1.1011, 1.1004]]) }, m1 + 30_000, mv);
    const p = a.open[0]!;
    expect(ev.join(' ')).toMatch(/profit lock/);
    expect(mv.moved).toBe(true);
    expect(p.locked).toBe(true);
    expect(p.lock!.at).toBeCloseTo(1.101, 8);
    expect(p.stop!).toBeCloseTo(1.1 + 0.00004 + 0.0003, 8);
    // the same minute, its low now shown lower: it came before the stop moved → only the close counts
    ev = tick(a, { EURUSD: q(1.1011, [[m1, 1.1012, 1.0995, 1.1011, 1.1004]]) }, m1 + 50_000);
    expect(a.open).toHaveLength(1);
    // minute 2: up to +22 → the stop trails 10 pips behind the best bid
    const mv2 = { moved: false };
    tick(a, { EURUSD: q(1.102, [[m1, 1.1012, 1.0995, 1.1011, 1.1004], [m1 + 60_000, 1.1022, 1.101, 1.102, 1.1011]]) }, m1 + 125_000, mv2);
    expect(mv2.moved).toBe(true);
    expect(a.open[0]!.stop!).toBeCloseTo(1.1022 - 0.00004 - 0.001, 8);
    // minute 3: falls back → closed at the trailed stop, in profit
    ev = tick(a, { EURUSD: q(1.1005, [[m1 + 120_000, 1.102, 1.1005, 1.1006, 1.102]]) }, m1 + 185_000);
    expect(a.open).toHaveLength(0);
    expect(ev.join(' ')).toMatch(/stop hit/);
    expect(a.closed[0]!.pnlUsd).toBeGreaterThan(10);
    expect(a.balanceUsd).toBeGreaterThan(1010);
  });

  it('switched off on the account → no lock; a position with neither a stop nor a target → none', () => {
    const a = newAccount(1000);
    a.profitLock = false;
    a.open = [long()];
    tick(a, { EURUSD: q(1.1011, [[T + 60_000, 1.1012, 1.1004, 1.1011, 1.1004]]) }, T + 90_000);
    expect(a.open[0]!.lock).toBeNull();
    expect(a.open[0]!.stop).toBe(1.097);
    const b = newAccount(1000);
    b.open = [{ ...long(), stop: null, target: null }];
    tick(b, { EURUSD: q(1.1011, []) }, T + 90_000);
    expect(b.open[0]!.lock).toBeNull();
  });

  it("the trade's plan says where the lock arms and, once armed, that it is trailing", () => {
    const p = { ...long(), px: 1.1005, lock: lockPlan(1, 1.1, 1.097, 1.103, HALF) };
    const pnlAt = (x: PracticePosition, px: number) => x.side * x.units * (px - x.entry);
    expect(tradeLines(p, T, pnlAt).map((l) => l.text).join(' ')).toMatch(/Profit lock: at 1\.10100/);
    const armed = tradeLines({ ...p, locked: true, be: true, stop: 1.1004 }, T, pnlAt).map((l) => l.text).join(' ');
    expect(armed).toMatch(/Profit locked: stop at/);
    expect(armed).toMatch(/trails 10 pips behind/);
  });
});

describe('what the lock changed (lab summary)', () => {
  const row = (id: string, verdict: Row['verdict'], inR: number, outR: number, offIn: number, offOut: number, n = 40) =>
    ({ id, verdict, inSample: { n, avgR: inR }, outSample: { n, avgR: outR }, noLock: { inN: n, inAvgR: offIn, outN: n, outAvgR: offOut, outPf: 1, allN: n } }) as unknown as Row;
  it('averages with − without per strategy and for the ones the bot trades', () => {
    const s = summarizeLock([row('a', 'edge', 0.2, 0.1, 0.1, 0.2), row('b', 'no', 0.0, 0.3, 0.2, 0.1), row('random', 'no', 1, 1, 0, 0)], true);
    expect(s.compared).toBe(2);
    expect(s.inDeltaR).toBeCloseTo(-0.05, 6);
    expect(s.outDeltaR).toBeCloseTo(0.05, 6);
    expect(s.outBetterPct).toBe(50);
    expect(s.traded).toEqual({ n: 40, withR: 0.1, withoutR: 0.2 });
  });
});
