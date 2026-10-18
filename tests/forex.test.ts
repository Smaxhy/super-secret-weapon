import { describe, expect, it } from 'vitest';
import { mergeBars, parseYahoo } from '../src/forex/data';
import { equityCurve, rStats, runSeries } from '../src/forex/engine';
import { verdictFor } from '../src/forex/lab';
import { STRATEGIES } from '../src/forex/strategies';
import { buildCtx, to4h } from '../src/forex/ta';
import { INSTRUMENTS, type Bar, type Trade } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6); // a Monday
const EUR = INSTRUMENTS[0]!;

/** seeded random walk with regimes: trends, ranges, spikes */
function market(n: number, seed = 7): Bar[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Bar[] = [];
  let px = 1.1;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 400) * 0.00008;
    const vol = 0.0008 * (1 + 0.5 * Math.sin(i / 97));
    const o = px;
    const c = o + drift + (rnd() - 0.5) * vol * 2;
    const h = Math.max(o, c) + rnd() * vol;
    const l = Math.min(o, c) - rnd() * vol;
    out.push({ t: T0 + i * H, o, h, l, c });
    px = c;
  }
  return out;
}

describe('forex lab v12', () => {
  it('every strategy runs on 1h and 4h without crashing and the library is big', () => {
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(25);
    const bars = market(4000);
    const c1 = buildCtx(bars, 60);
    const c4 = buildCtx(to4h(bars), 240);
    let total = 0;
    for (const s of STRATEGIES) {
      const t1 = runSeries(EUR, '1h', c1, s);
      total += t1.length;
      if (!s.onlyHourly) runSeries(EUR, '4h', c4, s);
      for (const t of t1) {
        expect(Number.isFinite(t.r)).toBe(true);
        expect(t.exitT).toBeGreaterThanOrEqual(t.entryT);
        expect(t.stopPct).toBeGreaterThan(0);
      }
    }
    expect(total).toBeGreaterThan(200);
  });

  it('no peeking: a signal at bar i never changes when later bars change', () => {
    const a = market(1500, 11);
    const b = a.map((x, i) => (i > 900 ? { ...x, o: x.o * 1.05, h: x.h * 1.06, l: x.l * 1.04, c: x.c * 1.05 } : x));
    const ca = buildCtx(a, 60);
    const cb = buildCtx(b, 60);
    for (const s of STRATEGIES) for (let i = 220; i < 895; i++) expect(JSON.stringify(s.signal(ca, i))).toBe(JSON.stringify(s.signal(cb, i)));
  });

  it('engine: stop wins when stop and target are in the same bar; spread is charged', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 260; i++) bars.push({ t: T0 + i * H, o: 1, h: 1.0005, l: 0.9995, c: 1 });
    // bar 251: huge range touching both a 1.01 target and a 0.99 stop
    bars[251] = { t: T0 + 251 * H, o: 1, h: 1.02, l: 0.98, c: 1 };
    const s = { id: 'x', name: 'x', family: 'control' as const, desc: '', signal: (_c: unknown, i: number) => (i === 249 ? { side: 1 as const, stop: 0.99, target: 1.01 } : null) };
    const t = runSeries(EUR, '1h', buildCtx(bars, 60), s);
    expect(t).toHaveLength(1);
    expect(t[0]!.reason).toBe('stop');
    expect(t[0]!.r).toBeLessThan(-1);
    // a clean target
    bars[251] = { t: T0 + 251 * H, o: 1, h: 1.02, l: 0.9995, c: 1.015 };
    const t2 = runSeries(EUR, '1h', buildCtx(bars, 60), s);
    expect(t2[0]!.reason).toBe('target');
    expect(t2[0]!.r).toBeGreaterThan(0.9);
    expect(t2[0]!.r).toBeLessThan(1);
  });

  it('equity: risk per trade scales results; leverage is capped; a wipe-out is flagged', () => {
    const mk = (k: number, r: number): Trade => ({ strategy: 's', tf: '1h', pair: 'EURUSD', side: 1, entryT: T0 + k * 6 * H, exitT: T0 + k * 6 * H + 3 * H, entry: 1, exit: 1, r, stopPct: 0.2, reason: r > 0 ? 'target' : 'stop', bars: 3 });
    const win = Array.from({ length: 60 }, (_, k) => mk(k, k % 2 ? 2 : -1));
    const a = equityCurve(win, 1, 50);
    const b = equityCurve(win, 2, 50);
    expect(a.finalX).toBeGreaterThan(1);
    expect(b.finalX).toBeGreaterThan(a.finalX);
    expect(a.medianLeverage).toBe(5); // 1% risk / 0.2% stop
    expect(equityCurve(win, 20, 50).medianLeverage).toBe(50); // capped
    const lose = Array.from({ length: 40 }, (_, k) => mk(k, -1));
    expect(equityCurve(lose, 10, 50).blown).toBe(true);
    expect(rStats(win).pf).toBeCloseTo(2, 1);
  });

  it('verdict needs out-of-sample trades, both halves positive and to beat random', () => {
    const st = (n: number, avgR: number, pf: number) => ({ n, winPct: 50, avgR, medianR: 0, pf, totalR: n * avgR, maxDdR: 1 });
    expect(verdictFor({ all: st(200, 0.2, 1.5), inSample: st(140, 0.2, 1.5), outSample: st(60, 0.2, 1.5) }, 0).verdict).toBe('edge');
    expect(verdictFor({ all: st(200, 0.2, 1.5), inSample: st(140, -0.1, 0.9), outSample: st(60, 0.2, 1.5) }, 0).verdict).toBe('maybe');
    expect(verdictFor({ all: st(200, 0.2, 1.5), inSample: st(190, 0.2, 1.5), outSample: st(10, 0.5, 3) }, 0).verdict).toBe('no');
    expect(verdictFor({ all: st(200, 0.02, 1.05), inSample: st(140, 0.1, 1.2), outSample: st(60, -0.1, 0.8) }, 0).verdict).toBe('no');
  });

  it('data: Yahoo JSON → closed bars only, merged by time', () => {
    const now = T0 + 3 * H + 10;
    const json = { chart: { result: [{ timestamp: [T0 / 1000, (T0 + H) / 1000, (T0 + 2 * H) / 1000, (T0 + 3 * H) / 1000], indicators: { quote: [{ open: [1, 1.1, null, 1.2], high: [1.2, 1.2, 1, 1.3], low: [0.9, 1, 1, 1.1], close: [1.1, 1.15, 1, 1.25] }] } }] } };
    const bars = parseYahoo(json, now);
    expect(bars.map((b) => b.t)).toEqual([T0, T0 + H]); // null row dropped, forming bar dropped
    const merged = mergeBars(bars, [{ t: T0 + H, o: 2, h: 2, l: 2, c: 2 }, { t: T0 + 2 * H, o: 1, h: 1, l: 1, c: 1 }]);
    expect(merged).toHaveLength(3);
    expect(merged[1]!.c).toBe(2);
    expect(to4h(market(9)).length).toBe(2);
  });
});
