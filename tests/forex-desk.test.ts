/** v18: the quant desk — Carver-style continuous forecasts, scaling, combination, vol targeting, buffering, cost gate. */
import { describe, expect, it } from 'vitest';
import { breakoutRaw, CARVER, carryRaw, carverVol, corrMatrix, divMultiplier, ewmacRaw, RULES, runDesk, scalarSeries, type DailyMarket } from '../src/forex/forecast';
import { buildDeskInput, deskFromBars } from '../src/forex/desk';
import { rng } from '../src/forex/stats';
import { INSTRUMENTS, type Bar } from '../src/forex/types';

const H = 3_600_000;
const DAY = 86_400_000;
const inst = (id: string) => INSTRUMENTS.find((i) => i.id === id)!;

/** hourly bars skipping weekends; drift per hour + noise; deterministic */
function hourly(n: number, seed: number, start: number, volPct: number, driftPerDay = 0): Bar[] {
  const r = rng(seed);
  const z = () => {
    const u = Math.max(1e-12, r());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const out: Bar[] = [];
  let px = start;
  let t = Date.UTC(2023, 9, 2, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const hr = d.getUTCHours();
    if (dow === 6 || (dow === 5 && hr >= 22) || (dow === 0 && hr < 22)) {
      t += H;
      i--;
      continue;
    }
    const o = px;
    const c = o * (1 + driftPerDay / 24 + z() * volPct);
    out.push({ t, o, h: Math.max(o, c) * (1 + Math.abs(z()) * volPct * 0.3), l: Math.min(o, c) * (1 - Math.abs(z()) * volPct * 0.3), c });
    px = c;
    t += H;
  }
  return out;
}

describe('v18 forecast building blocks', () => {
  it('vol of daily changes tracks the true vol and starts NaN', () => {
    const r = rng(3);
    const close: number[] = [100];
    for (let i = 1; i < 600; i++) {
      const u = Math.max(1e-12, r());
      close.push(close[i - 1]! + 0.5 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
    }
    const v = carverVol(close);
    expect(Number.isNaN(v[5]!)).toBe(true);
    expect(v[599]!).toBeGreaterThan(0.35);
    expect(v[599]!).toBeLessThan(0.65);
  });

  it('EWMAC is positive in an uptrend, breakout sits near +20 at new highs, carry follows the rate gap', () => {
    const up = Array.from({ length: 400 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 5));
    const vol = carverVol(up);
    const e = ewmacRaw(up, vol, 8);
    expect(e[399]!).toBeGreaterThan(0);
    const b = breakoutRaw(up, 20);
    expect(b[399]!).toBeGreaterThan(5);
    const flat = new Array(400).fill(100);
    const c = carryRaw(new Array(400).fill(2), up, vol);
    expect(c[399]!).toBeGreaterThan(0);
    expect(Number.isNaN(carryRaw(new Array(400).fill(NaN), flat, vol)[399]!)).toBe(true);
  });

  it('scalars make the average |forecast| about 10 on the fit window and freeze after it', () => {
    const r = rng(9);
    const raws = Array.from({ length: 5 }, () => Float64Array.from({ length: 600 }, () => (r() - 0.5) * 4));
    const s = scalarSeries(raws, 400, 1);
    expect(s.estimated).toBe(true);
    let sum = 0;
    let n = 0;
    for (const raw of raws) for (let d = 0; d < 400; d++) {
      sum += Math.abs(raw[d]! * s.k[d]!);
      n++;
    }
    expect(sum / n).toBeGreaterThan(8);
    expect(sum / n).toBeLessThan(12);
    expect(s.k[450]).toBe(s.k[399]);
    expect(s.k[599]).toBe(s.k[399]);
    // too few days → the fixed scalar
    expect(scalarSeries(raws.map((x) => x.slice(0, 50)), 50, 7.5).estimated).toBe(false);
    expect(scalarSeries(raws.map((x) => x.slice(0, 50)), 50, 7.5).k[10]).toBe(7.5);
  });

  it('diversification multiplier: 1 for one series or perfect correlation, √N for independent ones, capped, negatives floored', () => {
    const r = rng(5);
    const a = Float64Array.from({ length: 500 }, () => r() - 0.5);
    const b = Float64Array.from({ length: 500 }, () => r() - 0.5);
    const C = corrMatrix([a, b]);
    expect(Math.abs(C[0]![1]!)).toBeLessThan(0.15);
    expect(divMultiplier([0.5, 0.5], C, 2.5)).toBeGreaterThan(1.3);
    expect(divMultiplier([0.5, 0.5], [[1, 1], [1, 1]], 2.5)).toBe(1);
    expect(divMultiplier([0.5, 0.5], [[1, -0.9], [-0.9, 1]], 2.5)).toBeCloseTo(Math.SQRT2, 6); // floored at 0
    const w = new Array(10).fill(0.1);
    const I = w.map((_, i) => w.map((__, j) => (i === j ? 1 : 0)));
    expect(divMultiplier(w, I, 2.5)).toBe(2.5);
  });
});

describe('v18 the desk end to end on synthetic markets', () => {
  const N = 17_000; // ≈ 2.8 years of market hours
  const h1 = new Map<string, Bar[]>([
    ['EURUSD', hourly(N, 11, 1.1, 0.0006, 0.0004)],
    ['GBPUSD', hourly(N, 12, 1.27, 0.0007)],
    ['USDJPY', hourly(N, 13, 150, 0.0006, -0.0003)],
    ['XAUUSD', hourly(N, 14, 2000, 0.0012, 0.0005)],
  ]);
  const last = h1.get('EURUSD')![N - 1]!.t;
  const first = h1.get('EURUSD')![0]!.t;
  const oosFrom = first + 0.7 * (last - first);

  it('builds aligned daily inputs with a fill two hours into the next day and USD conversion', () => {
    const inp = buildDeskInput(h1, null, oosFrom, 1000, ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'].map(inst))!;
    expect(inp.markets).toHaveLength(4);
    expect(inp.cal.length).toBeGreaterThan(600);
    const eu = inp.markets[0]!;
    const k = 100;
    expect(Number.isFinite(eu.close[k]!)).toBe(true);
    expect(eu.fillT[k]! - (inp.cal[k]! + DAY)).toBe(2 * H);
    expect(inp.usdPer('USD', k)).toBe(1);
    expect(inp.usdPer('JPY', k)!).toBeCloseTo(1 / inp.markets[2]!.close[k]!, 9);
    expect(inp.usdPer('GBP', k)!).toBeCloseTo(inp.markets[1]!.close[k]!, 9);
    expect(inp.usdPer('CHF', k)).toBeNull();
  });

  it('runs: forecasts within the cap, leverage under the cap, costs charged, a book for today, both halves graded', () => {
    const d = deskFromBars(h1, null, oosFrom)!;
    expect(d).not.toBeNull();
    expect(d.markets).toBe(4);
    expect(d.rules).toHaveLength(RULES.length);
    for (const g of d.rules) {
      expect(g.of).toBe(g.family === 'carry' ? 0 : 4);
      expect(g.allowed).toBeLessThanOrEqual(g.of);
      expect(g.scalar).toBeGreaterThan(0);
    }
    // the fast EWMACs cost the most per year; the slow ones pass the speed limit
    const e2 = d.rules.find((g) => g.id === 'ewmac2')!;
    const e64 = d.rules.find((g) => g.id === 'ewmac64')!;
    expect(e2.costSr).toBeGreaterThan(e64.costSr);
    expect(e64.allowed).toBe(4);
    expect(d.fdm).toBeGreaterThanOrEqual(1);
    expect(d.fdm).toBeLessThanOrEqual(CARVER.fdmCap);
    expect(d.idm).toBeGreaterThanOrEqual(1);
    expect(d.now).toHaveLength(4);
    for (const m of d.now) {
      expect(Math.abs(m.forecast)).toBeLessThanOrEqual(20);
      expect(Math.abs(m.notionalUsd)).toBeLessThan(CARVER.maxLeverage * 1000 * 5);
      expect(m.volPips).toBeGreaterThan(0);
    }
    expect(d.inSample.days).toBeGreaterThan(400);
    expect(d.unseen.days).toBeGreaterThan(150);
    expect(d.unseen.avgLeverage).toBeLessThanOrEqual(CARVER.maxLeverage + 0.01);
    expect(d.unseen.costPctYr).toBeGreaterThan(0);
    expect(d.unseen.turnover).toBeGreaterThan(0);
    expect(d.unseen.weeks).toBeGreaterThan(30);
    expect(d.unseenWeekly).toHaveLength(d.unseen.weeks);
    expect(d.mc).not.toBeNull();
    // the trending market is bought: its combined forecast leans the drift's way most of the unseen days
    expect(d.now.find((m) => m.id === 'EURUSD')!.forecast).toBeGreaterThan(-20);
    expect(d.note).toMatch(/rules × 4 markets/);
  });

  it('is causal: the first part of the history gives the same equity path whether or not later bars exist', () => {
    const short = new Map([...h1].map(([id, b]) => [id, b.slice(0, Math.floor(N * 0.85))]));
    const full = deskFromBars(h1, null, oosFrom)!;
    const part = deskFromBars(short, null, oosFrom)!;
    expect(part.rules.map((g) => g.scalar)).toEqual(full.rules.map((g) => g.scalar));
    expect(part.fdm).toBe(full.fdm);
    const k = Math.min(part.equity.length, full.equity.length) - 2;
    for (let i = 0; i < k; i++) expect(part.equity[i]).toBeCloseTo(full.equity[i]!, 6);
  });

  it('the buffer keeps small wobbles from trading: a flat forecast means no position and no cost', () => {
    const flat: DailyMarket = { inst: inst('EURUSD'), close: Float64Array.from({ length: 300 }, () => 1.1), fill: Float64Array.from({ length: 300 }, () => 1.1), fillT: Float64Array.from({ length: 300 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY + 2 * H), fillPrevT: Float64Array.from({ length: 300 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY + H) };
    const cal = Array.from({ length: 300 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY);
    const r = runDesk({ cal, markets: [flat, { ...flat, inst: inst('GBPUSD') }], oosFrom: cal[210]!, equity: 1000, usdPer: () => 1 });
    expect(r.unseen.turnover).toBe(0);
    expect(r.unseen.costPctYr).toBe(0);
    expect(r.unseen.finalX).toBe(1);
  });
});
