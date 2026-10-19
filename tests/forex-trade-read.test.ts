/** v17.14: the live read of an open trade (goal, progress, moves, best price, lock, pace, thesis, levels, news, status). */
import { describe, expect, it } from 'vitest';
import { liveRead, minTxt, pipTxt, READ, type ReadInput, type ReadPos } from '../src/forex/trade-read';

const T = Date.UTC(2026, 9, 14, 14, 0, 0); // a Wednesday
const MIN = 60_000;
/** 1-minute mid candles from closes; candle k opens at `t0 + k min` */
const minutes = (t0: number, closes: number[]): Array<[number, number, number, number, number]> =>
  closes.map((c, k) => {
    const o = k ? closes[k - 1]! : c;
    return [t0 + k * MIN, Math.max(o, c) + 0.00001, Math.min(o, c) - 0.00001, c, o];
  });
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, k) => from + ((to - from) * k) / (n - 1));

const long = (over: Partial<ReadPos> = {}): ReadPos => ({ id: 'p1', pair: 'EURUSD', side: 1, entry: 1.1, px: 1.1012, stop: 1.0985, target: 1.103, openedAt: T - 90 * MIN, strategy: 'ema_cross', tf: '1h', ...over });
const base = (over: Partial<ReadInput> = {}): ReadInput => ({
  pos: long(),
  // 90 minutes from the entry up to +12 pips (steadily)
  bars: minutes(T - 90 * MIN, ramp(1.1, 1.1012, 90)),
  pip: 0.0001,
  digits: 5,
  label: 'EUR/USD',
  now: T,
  strategy: { name: 'EMA 20/50 cross', desc: 'Fast average crosses the slow one.', style: 'trend' },
  market: { atrPips: 10, mtf: { h1: 1, h4: 1, d1: 1 } },
  ...over,
});

describe('v17.14 live read', () => {
  it('a long on its way: goal, progress, moves, pace, trend still with it', () => {
    const r = liveRead(base());
    expect(r.status).toBe('on_track');
    expect(r.goal).toMatch(/Bought EUR\/USD on "EMA 20\/50 cross" \(1h chart\): aims for 1\.10300 \(\+30 pips\); gives up at 1\.09850 \(−15 pips\)/);
    expect(r.why).toMatch(/Fast average/);
    expect(r.pips.now).toBeCloseTo(12, 6);
    expect(r.pips.target).toBe(30);
    expect(r.pips.stop).toBe(-15);
    expect(r.progressPct).toBe(40);
    expect(r.move.m60!).toBeGreaterThan(7);
    expect(r.move.m15!).toBeGreaterThan(1);
    expect(r.thesisOk).toBe(true);
    expect(r.etaMin).toBeGreaterThan(60);
    const text = r.lines.join(' ');
    expect(text).toMatch(/Up 12 pips — 40% of the way to the target/);
    expect(text).toMatch(/Moving its way: \+\d.* in 15 min/);
    expect(text).toMatch(/hourly trend still points its way, and so does the daily/);
    expect(text).toMatch(/At the last hour's pace the target is about/);
    expect(text).toMatch(/Open 1 h 30 min/);
  });

  it('a short mirrors it (JPY pips)', () => {
    const r = liveRead(base({
      pos: long({ pair: 'USDJPY', side: -1, entry: 150, px: 149.88, stop: 150.15, target: 149.7 }),
      bars: minutes(T - 90 * MIN, ramp(150, 149.88, 90)),
      pip: 0.01,
      digits: 3,
      label: 'USD/JPY',
      market: { atrPips: 10, mtf: { h1: -1, h4: 0, d1: 0 } },
    }));
    expect(r.goal).toMatch(/^Sold USD\/JPY/);
    expect(r.pips.now).toBeCloseTo(12, 6);
    expect(r.progressPct).toBe(40);
    expect(r.thesisOk).toBe(true);
    expect(r.move.m60!).toBeGreaterThan(0);
  });

  it('almost at the target / close to the stop / closing', () => {
    expect(liveRead(base({ pos: long({ px: 1.1026 }) })).status).toBe('near_target');
    expect(liveRead(base({ pos: long({ px: 1.0988 }), bars: minutes(T - 90 * MIN, ramp(1.1, 1.0988, 90)) })).status).toBe('near_stop');
    expect(liveRead(base({ pos: long({ closePending: { reason: 'manual', at: T } }) })).status).toBe('closing');
  });

  it('under water with the last 15 minutes against it by a third of the hourly range → under pressure', () => {
    const closes = [...ramp(1.1, 1.1003, 75), ...ramp(1.1003, 1.0996, 15)];
    const r = liveRead(base({ pos: long({ px: 1.0996 }), bars: minutes(T - 90 * MIN, closes) }));
    expect(r.move.m15!).toBeLessThanOrEqual(-READ.pressureAtr * 10);
    expect(r.status).toBe('pressure');
    expect(r.lines.join(' ')).toMatch(/Moving against it/);
    expect(r.lines.join(' ')).toMatch(/Down 4 pips — 27% of the way to the stop/);
  });

  it('the trend on its chart turned against it → the reason is weaker; under water too → under pressure', () => {
    const r = liveRead(base({ pos: long({ px: 1.0999 }), bars: minutes(T - 90 * MIN, ramp(1.1, 1.0999, 90)), market: { atrPips: 10, mtf: { h1: -1, h4: 1, d1: 1 } } }));
    expect(r.thesisOk).toBe(false);
    expect(r.status).toBe('pressure');
    expect(r.lines.join(' ')).toMatch(/hourly trend now points against it/);
  });

  it('a fade waits for the turn; once it turns its way the read says so', () => {
    const fade = { name: 'RSI dip', desc: 'Buys a dip.', style: 'revert' };
    const down = liveRead(base({ strategy: fade, pos: long({ px: 1.0991 }), bars: minutes(T - 90 * MIN, ramp(1.1, 1.0991, 90)) }));
    expect(down.thesisOk).toBe(false);
    const up = liveRead(base({ strategy: fade }));
    expect(up.thesisOk).toBe(true);
    expect(up.lines.join(' ')).toMatch(/turning back the way it bet/);
  });

  it('profit lock: where it arms before, the worst case once armed (status: profit locked)', () => {
    const before = liveRead(base({ pos: long({ px: 1.1005, lock: { at: 1.101, to: 1.1004, gap: 0.001 } }), bars: minutes(T - 90 * MIN, ramp(1.1, 1.1005, 90)) }));
    expect(before.pips.lockAt).toBe(10);
    expect(before.lines.join(' ')).toMatch(/Profit lock arms at \+10 pips \(1\.10100\) — 5 pips to go/);
    const armed = liveRead(base({ pos: long({ stop: 1.1004, locked: true, lock: { at: 1.101, to: 1.1004, gap: 0.001 } }) }));
    expect(armed.status).toBe('locked');
    expect(armed.goal).toMatch(/the stop at 1\.10040 already keeps \+4 pips/);
    expect(armed.lines.join(' ')).toMatch(/worst case now is \+4 pips/);
  });

  it('no new best for a while and less than half way → stalling (not when the candles do not reach the best)', () => {
    // a 1-minute chart trade: up to +8 in 10 min, then sideways for 30 min
    const closes = [...ramp(1.1, 1.1008, 10), ...Array.from({ length: 30 }, () => 1.1005)];
    const pos = long({ px: 1.1005, tf: '1m', openedAt: T - 40 * MIN });
    const r = liveRead(base({ pos, bars: minutes(T - 40 * MIN, closes) }));
    expect(r.sinceBestMin!).toBeGreaterThanOrEqual(READ.stallMin);
    expect(r.status).toBe('stalling');
    expect(r.lines.join(' ')).toMatch(/Best so far \+8\.1 pips \(30 min ago\); 3\.1 pips back from it/);
    // the candles start after the entry and the best is their first one → its age is unknown, no stall call
    const late = liveRead(base({ pos: long({ px: 1.1005, tf: '1m', openedAt: T - 400 * MIN }), bars: minutes(T - 40 * MIN, [1.1012, ...Array.from({ length: 39 }, () => 1.1005)]) }));
    expect(late.status).not.toBe('stalling');
    expect(late.lines.join(' ')).toMatch(/in the candles kept/);
  });

  it('just opened; flat or slightly against inside the plan', () => {
    expect(liveRead(base({ pos: long({ px: 1.1001, openedAt: T - 2 * MIN }), bars: minutes(T - 2 * MIN, [1.1, 1.1001]) })).status).toBe('early');
    const r = liveRead(base({ pos: long({ px: 1.0998 }), bars: minutes(T - 90 * MIN, [...ramp(1.1, 1.0996, 80), ...ramp(1.0996, 1.0998, 10)]), market: { atrPips: 10, mtf: { h1: 0, h4: 0, d1: 0 } } }));
    expect(r.status).toBe('on_track'); // under water but the last 15 min went its way
    const h = liveRead(base({ pos: long({ px: 1.0998 }), bars: minutes(T - 90 * MIN, Array.from({ length: 90 }, () => 1.0998)), market: { atrPips: 10, mtf: { h1: 0, h4: 0, d1: 0 } } }));
    expect(h.status).toBe('holding');
    expect(h.thesisOk).toBeNull();
  });

  it('the nearest level ahead and behind, and news coming up', () => {
    const r = liveRead(base({
      market: { atrPips: 10, mtf: { h1: 1, h4: 1, d1: 1 }, levels: [{ kind: 'resistance', price: 1.1018, touches: 3 }, { kind: 'resistance', price: 1.1025, touches: 2 }, { kind: 'support', price: 1.1006, touches: 2 }], prevDay: { h: 1.105, l: 1.09 } },
      news: [{ t: T + 25 * MIN, ccy: 'USD', title: 'CPI m/m', impact: 'High' }, { t: T + 5 * 3_600_000, ccy: 'EUR', title: 'later', impact: 'High' }],
    }));
    const text = r.lines.join(' ');
    expect(text).toMatch(/Ahead: resistance at 1\.10180 \(3 touches\), 6 pips away/);
    expect(text).toMatch(/Behind: support at 1\.10060 \(2 touches\), 6 pips under the price/);
    expect(text).toMatch(/USD CPI m\/m in 25 min/);
    expect(text).not.toMatch(/later/);
  });

  it('no candles: still a goal and a status, no moves', () => {
    const r = liveRead(base({ bars: [] }));
    expect(r.move).toEqual({ m5: null, m15: null, m60: null });
    expect(r.status).toBe('on_track');
    expect(r.pips.best).toBeCloseTo(12, 6);
  });

  it('words', () => {
    expect(pipTxt(3.04)).toBe('3');
    expect(pipTxt(-7.25)).toBe('7.3');
    expect(pipTxt(12.6)).toBe('13');
    expect(minTxt(0.5)).toBe('under a minute');
    expect(minTxt(135)).toBe('2 h 15 min');
    expect(minTxt(3 * 1440)).toBe('3 days');
  });
});
