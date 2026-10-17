import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { scaleInPlan, scaleInVerdict, type ScaleInState } from '../src/executor/scale-in';
import { changeOver } from '../src/learner/market-mood';
import { klinger } from '../src/evaluator/ta/indicators';
import { TA_STRATEGIES, type TaContext } from '../src/evaluator/ta/strategies';
import type { Candle } from '../src/evaluator/chart-reader';

const SI = DEFAULT_CONFIG.trading.scaleIn;
const NOW = 1_760_000_000_000;

describe('two-step buys (v10.30)', () => {
  it('splits the size in two; learning trades and too-small legs buy at once', () => {
    expect(scaleInPlan(0.4, 0.1, SI, false)).toEqual({ firstSol: 0.16, laterSol: 0.24 });
    expect(scaleInPlan(0.15, 0.1, SI, false)).toBeNull(); // 0.075 < the 0.1 minimum
    expect(scaleInPlan(0.4, 0.1, SI, true)).toBeNull(); // learning / probe trade
    expect(scaleInPlan(0.4, 0.1, { ...SI, enabled: false }, false)).toBeNull();
  });
  const s = (o: Partial<ScaleInState> = {}): ScaleInState => ({ nowMs: NOW, openedAtMs: NOW - 60_000, entryPriceSol: 1, priceSol: 1.05, buySharePct: 65, danger: null, alreadySelling: false, ...o });
  it('adds the second half when it holds above the entry with buyers in control', () => {
    expect(scaleInVerdict(s(), SI).action).toBe('add');
  });
  it('waits while it is too early, flat, chasing or sellers lead', () => {
    expect(scaleInVerdict(s({ openedAtMs: NOW - 5_000 }), SI).action).toBe('wait');
    expect(scaleInVerdict(s({ priceSol: 1.01 }), SI).action).toBe('wait');
    expect(scaleInVerdict(s({ priceSol: 1.5 }), SI).action).toBe('wait');
    expect(scaleInVerdict(s({ buySharePct: 40 }), SI).action).toBe('wait');
  });
  it('cancels on a drop, a rug signal, a take-profit or no follow-through', () => {
    expect(scaleInVerdict(s({ priceSol: 0.93 }), SI).action).toBe('cancel');
    expect(scaleInVerdict(s({ danger: 'holder dump' }), SI).action).toBe('cancel');
    expect(scaleInVerdict(s({ alreadySelling: true }), SI).action).toBe('cancel');
    expect(scaleInVerdict(s({ openedAtMs: NOW - 10 * 60_000 }), SI).action).toBe('cancel');
  });
});

describe('market mood (data only)', () => {
  it("SOL's % change over 1 h / 24 h from 5-min samples", () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ t: NOW - (299 - i) * 5 * 60_000, price: 100 + i * 0.1 }));
    expect(changeOver(pts, 3600_000)).toBeCloseTo(((129.9 / 128.7) - 1) * 100, 0);
    expect(changeOver(pts, 24 * 3600_000)).not.toBeNull();
    expect(changeOver(pts.slice(-3), 24 * 3600_000)).toBeNull(); // not enough history
  });
});

describe('dip analyser (RSI dip + Klinger volume turn)', () => {
  const candle = (i: number, c: number, prev: number, v: number, up: boolean): Candle => ({ t: NOW - (200 - i) * 15_000, o: prev, h: Math.max(c, prev) * 1.005, l: Math.min(c, prev) * 0.995, c, v, bv: up ? v * 0.8 : v * 0.2, sv: up ? v * 0.2 : v * 0.8, n: 5 });
  const series = (): Candle[] => {
    const out: Candle[] = [];
    let p = 1;
    for (let i = 0; i < 70; i++) { const n = p * (1 + 0.004 * Math.sin(i / 3) + 0.002); out.push(candle(i, n, p, 2, n >= p)); p = n; }
    for (let i = 70; i < 82; i++) { const n = p * 0.95; out.push(candle(i, n, p, 1.5, false)); p = n; }
    for (let i = 82; i < 90; i++) { const n = p * 1.06; out.push(candle(i, n, p, 9, true)); p = n; }
    return out;
  };
  const strat = TA_STRATEGIES.find((x) => x.id === 'dip_analyser')!;
  const ctx = (c15: Candle[]): TaContext => ({ c15, c1m: [], price: c15[c15.length - 1]!.c, now: NOW } as unknown as TaContext);
  it('is in the Strategies lab', () => {
    expect(strat).toBeDefined();
  });
  it('fires on the volume-backed turn after a dip — and not on a quiet chart', () => {
    const c = series();
    const hits = [];
    for (let n = 75; n <= c.length; n++) if (strat.check(ctx(c.slice(0, n)))) hits.push(n);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((n) => n > 82)).toBe(true); // only once the bounce started
    const flat = Array.from({ length: 90 }, (_, i) => candle(i, 1, 1, 1, true));
    expect(strat.check(ctx(flat))).toBeNull();
  });
  it('Klinger turns up when buying volume comes in', () => {
    const k = klinger(series());
    expect(k.ko[89]! - k.signal[89]!).toBeGreaterThan(k.ko[80]! - k.signal[80]!);
  });
});
