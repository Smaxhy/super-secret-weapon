import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/evaluator/chart-reader';
import { bollinger, cvd, emaSeries, fibLevels, lastImpulse, macd, obv, rsiSeries, sma, supertrend, swings, vwapBands } from '../src/evaluator/ta/indicators';
import { fillGaps, runStrategies, TA_BY_ID, TA_STRATEGIES, taContext, type TaContext } from '../src/evaluator/ta/strategies';

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 15_000);
type Step = number | { c: number; v?: number; buy?: number; wick?: number; low?: number; high?: number };
/** Candles from closes: open = previous close, small wicks; v = SOL volume, buy = buy share. */
function chart(steps: Step[], start = 1): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  steps.forEach((s, i) => {
    const o = typeof s === 'number' ? { c: s } : s;
    const v = o.v ?? 1;
    const buy = o.buy ?? (o.c >= prev ? 0.65 : 0.35);
    const w = o.wick ?? 0.003;
    const h = o.high ?? Math.max(prev, o.c) * (1 + w);
    const l = o.low ?? Math.min(prev, o.c) * (1 - w);
    out.push({ t: T0 + i * 15_000, o: prev, h, l, c: o.c, v, bv: v * buy, sv: v * (1 - buy), n: 3 });
    prev = o.c;
  });
  return out;
}
const ctx = (c: Candle[], ageSec: number | null = 3600): TaContext => ({ c15: c, c1m: [], price: c[c.length - 1]!.c, now: c[c.length - 1]!.t + 15_000, ageSec });
const fires = (id: string, c: Candle[], ageSec: number | null = 3600) => TA_BY_ID.get(id)!.check(ctx(c, ageSec));
/** Does `id` fire at any candle of the scenario (checked candle by candle, like live)? */
const firesSomewhere = (id: string, c: Candle[], from = 10) => {
  const s = TA_BY_ID.get(id)!;
  for (let k = Math.max(from, s.minCandles); k <= c.length; k++) if (s.check(ctx(c.slice(0, k)))) return true;
  return false;
};
const ramp = (a: number, b: number, n: number, v = 1): Step[] => Array.from({ length: n }, (_, i) => ({ c: a + ((b - a) * (i + 1)) / n, v }));
const flat = (p: number, n: number, v = 1, noise = 0.004): Step[] => Array.from({ length: n }, (_, i) => ({ c: p * (1 + (i % 2 ? noise : -noise)), v }));

describe('indicators', () => {
  it('moving averages, RSI, MACD, Bollinger, VWAP, OBV/CVD behave', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5]);
    const up = Array.from({ length: 40 }, (_, i) => 1 + i * 0.01);
    expect(emaSeries(up, 9)[39]!).toBeLessThan(up[39]!);
    expect(rsiSeries(up, 14)[39]).toBe(100);
    expect(macd(up).line[39]!).toBeGreaterThan(0);
    const calm = bollinger(Array.from({ length: 30 }, () => 1), 20).width[29];
    expect(calm).toBe(0);
    const c = chart([...ramp(1, 1.2, 10), ...ramp(1.2, 1.1, 5)]);
    const { vwap } = vwapBands(c, 0);
    expect(vwap[c.length - 1]!).toBeGreaterThan(1);
    expect(obv(c)[9]!).toBeGreaterThan(0);
    expect(cvd(c)[c.length - 1]!).toBeGreaterThan(0);
  });
  it('supertrend flips on a reversal; swings and impulse legs are found', () => {
    const c = chart([...ramp(1, 0.6, 25), ...ramp(0.6, 1.2, 25)]);
    const st = supertrend(c, 10, 3);
    expect(st.dir.slice(10, 25).includes(-1)).toBe(true);
    expect(st.dir[c.length - 1]).toBe(1);
    const s = swings(chart([...ramp(1, 1.3, 6), ...ramp(1.3, 1.1, 6), ...ramp(1.1, 1.5, 6)]), 2);
    expect(s.highs.length).toBeGreaterThan(0);
    expect(s.lows.length).toBeGreaterThan(0);
    const imp = lastImpulse(chart([...ramp(1, 1.6, 20), ...ramp(1.6, 1.3, 6)]))!;
    expect(imp.high / imp.low).toBeGreaterThan(1.55);
  });
  it('the Fibonacci leg starts at the last swing low, not at launch', () => {
    // Launch pump 1 → 2, dump to 1.4 (previous leg), new leg 1.4 → 2.2, pullback.
    const c = chart([...ramp(1, 2, 10), ...ramp(2, 1.4, 8), ...ramp(1.4, 2.2, 12), ...ramp(2.2, 1.9, 4)]);
    const imp = lastImpulse(c, 80)!;
    expect(imp.low).toBeGreaterThan(1.35);
    expect(imp.low).toBeLessThan(1.45);
    expect(imp.high).toBeGreaterThan(2.19);
  });
  it('fibonacci levels', () => {
    const f = fibLevels(1, 2);
    expect(f.retrace(0.618)).toBeCloseTo(1.382);
    expect(f.extend(1.618)).toBeCloseTo(2.618);
    expect(f.depthOf(1.5)).toBeCloseTo(0.5);
  });
  it('fills gaps with flat zero-volume candles; the context only uses completed candles', () => {
    const c = chart([1.1, 1.2]);
    const gapped = [c[0]!, { ...c[1]!, t: c[0]!.t + 60_000 }];
    const f = fillGaps(gapped);
    expect(f).toHaveLength(5);
    expect(f[2]!.v).toBe(0);
    const x = taContext(c, 1.2, c[1]!.t + 5_000, 100);
    expect(x.c15).toHaveLength(1); // the candle still forming is left out
  });
});

describe('chart strategies catch their setups', () => {
  it('Fibonacci golden pocket: +60% leg, 62% pullback, reclaim candle with buyers — and its control depths', () => {
    const pocket = chart([...flat(1, 6), ...ramp(1, 1.6, 20, 2), ...ramp(1.6, 1.23, 8, 1), { c: 1.29, v: 4, buy: 0.8 }]);
    const s = fires('fib_golden_pocket', pocket);
    expect(s).not.toBeNull();
    expect(s!.why).toContain('pulled back');
    expect(s!.targets![0]!).toBeGreaterThan(1.59);
    expect(fires('pullback_shallow', pocket)).toBeNull();
    expect(fires('pullback_deep', pocket)).toBeNull();
    // The same rules at a shallow (~38%) or a deep (~78%) pullback are the CONTROL strategies.
    const shallow = chart([...flat(1, 6), ...ramp(1, 1.6, 20, 2), ...ramp(1.6, 1.37, 6, 1), { c: 1.42, v: 4, buy: 0.8 }]);
    expect(fires('fib_golden_pocket', shallow)).toBeNull();
    expect(fires('pullback_shallow', shallow)).not.toBeNull();
    const deep = chart([...flat(1, 6), ...ramp(1, 1.6, 20, 2), ...ramp(1.6, 1.14, 9, 1), { c: 1.2, v: 4, buy: 0.8 }]);
    expect(fires('pullback_deep', deep)).not.toBeNull();
    // Broken: a close under 78.6% voids the golden pocket.
    const broken = chart([...flat(1, 6), ...ramp(1, 1.6, 20, 2), ...ramp(1.6, 1.08, 6, 1), ...ramp(1.08, 1.25, 3, 1), { c: 1.3, v: 4, buy: 0.8 }]);
    expect(fires('fib_golden_pocket', broken)).toBeNull();
  });
  it('organic buying burst: many real wallets, strong imbalance, up 5–25% (not chasing)', () => {
    const now = T0 + 120_000;
    const base = chart(flat(1, 8));
    const burst = (n: number, move: number): import('../src/scanner/crowd-tracker').CrowdTrade[] =>
      Array.from({ length: n }, (_, i) => ({ t: now - 59_000 + i * (58_000 / n), w: `W${i}`, buy: true, sol: 0.2 + (i % 5) * 0.07, tok: 1, px: 1 + (move * i) / n, pp: 1 + (move * (i + 1)) / n }));
    const ok = { c15: base, c1m: [], price: 1.12, now, ageSec: 600, trades: burst(24, 0.12), creator: 'DEV' };
    expect(TA_BY_ID.get('organic_burst')!.check(ok)).not.toBeNull();
    expect(TA_BY_ID.get('organic_burst')!.check({ ...ok, trades: burst(24, 0.4) })).toBeNull(); // +40% = chasing
    expect(TA_BY_ID.get('organic_burst')!.check({ ...ok, trades: burst(12, 0.12) })).toBeNull(); // too few wallets
  });
  it('volume climax → calm retest → breakout (never the climax candle itself)', () => {
    const c = chart([...ramp(1, 1.3, 15), ...ramp(1.3, 1.0, 10), { c: 0.95, low: 0.8, high: 1.0, v: 12, buy: 0.3 }, { c: 0.93, v: 1 }, { c: 0.9, low: 0.86, v: 1.5, buy: 0.45 }, { c: 0.92, v: 1 }, { c: 0.98, v: 2, buy: 0.75 }]);
    expect(firesSomewhere('climax_retest', c, 30)).toBe(true);
    expect(fires('climax_retest', c.slice(0, 26))).toBeNull(); // on the climax bar itself: no
  });
  it('Fibonacci shallow retrace → breakout above the high on volume', () => {
    const c = chart([...flat(1, 6), ...ramp(1, 1.5, 15, 2), ...ramp(1.5, 1.33, 6, 1), ...ramp(1.33, 1.45, 4, 1), { c: 1.53, v: 6, buy: 0.8 }]);
    expect(fires('fib_extension_breakout', c)).not.toBeNull();
  });
  /** A realistic (noisy) uptrend: up 4%, down 2.5%, … — RSI ~60, not a perfect line (RSI 100). */
  const noisyUp = (start: number, n: number): Step[] => {
    let p = start;
    return Array.from({ length: n }, (_, i) => ({ c: (p *= i % 2 ? 0.975 : 1.04) }));
  };
  it('EMA ribbon pullback in a clean uptrend', () => {
    const up = noisyUp(1, 70);
    const base = chart(up);
    const e21 = emaSeries(base.map((x) => x.c), 21)[base.length - 1]!;
    const lastClose = base[base.length - 1]!.c;
    // Wicks down to the EMA 21 and closes green above it.
    const dip = chart([...up, { c: lastClose * 1.01, low: e21 * 0.998, v: 1.5, buy: 0.6 }]);
    expect(fires('ema_pullback', dip)).not.toBeNull();
  });
  it('RSI oversold bounce inside an uptrend', () => {
    const up = noisyUp(1, 60);
    const top = chart(up)[59]!.c;
    // A sharp flush (−28% in 6 candles) pushes RSI under 32 while the bigger trend is still up.
    const c = chart([...up, ...ramp(top, top * 0.72, 6, 2), { c: top * 0.78, v: 2, buy: 0.75 }, { c: top * 0.83, v: 2, buy: 0.75 }, { c: top * 0.87, v: 2, buy: 0.75 }]);
    expect(firesSomewhere('rsi_oversold_bounce', c, 60)).toBe(true);
  });
  it('MACD crosses up when an uptrend resumes after a pullback; Supertrend flips on a reversal', () => {
    const resume = chart([...ramp(1, 1.5, 30), ...ramp(1.5, 1.38, 6), ...ramp(1.38, 1.6, 10, 1.5)]);
    expect(firesSomewhere('macd_cross', resume, 40)).toBe(true);
    const rev = chart([...ramp(1, 0.7, 30), ...ramp(0.7, 1.3, 30, 1.5)]);
    expect(firesSomewhere('supertrend_flip', rev, 20)).toBe(true);
  });
  it('Bollinger squeeze → breakout on volume', () => {
    const c = chart([...flat(1, 60, 1, 0.002), { c: 1.07, v: 5, buy: 0.85 }]);
    expect(fires('bb_squeeze_breakout', c)).not.toBeNull();
  });
  it('Donchian / tight-range / Keltner breakouts', () => {
    const c = chart([...ramp(1, 1.05, 10), ...flat(1.05, 14, 1, 0.01), { c: 1.11, v: 4, buy: 0.85 }]);
    expect(fires('donchian_breakout', c)).not.toBeNull();
    expect(fires('range_breakout', c)).not.toBeNull();
    expect(fires('keltner_breakout', c)).not.toBeNull();
  });
  it('all-time-high breakout after consolidating under it', () => {
    const c = chart([...ramp(1, 1.5, 12, 2), ...ramp(1.5, 1.38, 4), ...flat(1.42, 8), { c: 1.53, v: 4, buy: 0.85 }]);
    expect(fires('ath_breakout', c, 600)).not.toBeNull();
    expect(fires('ath_breakout', c, 60)).toBeNull(); // too young — launch noise
  });
  it('higher low + break of structure; double bottom neckline break', () => {
    const bos = chart([...ramp(1, 0.8, 6), ...ramp(0.8, 0.95, 5), ...ramp(0.95, 0.85, 5), ...ramp(0.85, 0.94, 4), { c: 0.99, v: 2, buy: 0.75 }]);
    expect(firesSomewhere('break_of_structure', bos, 15)).toBe(true);
    const w = chart([...ramp(1.2, 1.0, 6), ...ramp(1.0, 1.13, 5), ...ramp(1.13, 1.01, 5), ...ramp(1.01, 1.12, 4), { c: 1.16, v: 2, buy: 0.75 }]);
    expect(firesSomewhere('double_bottom', w, 15)).toBe(true);
  });
  it('liquidity sweep: wick under the lows, close back above', () => {
    const c = chart([...flat(1, 26, 1, 0.01), { c: 0.995, low: 0.95, v: 2, buy: 0.4 }, { c: 1.01, v: 2, buy: 0.7 }]);
    expect(fires('liquidity_sweep', c)).not.toBeNull();
  });
  it('bull flag: fast pole, quiet flag, breakout', () => {
    const c = chart([...flat(1, 6), ...ramp(1, 1.42, 6, 4), ...ramp(1.42, 1.32, 6, 1), { c: 1.45, v: 3, buy: 0.8 }]);
    expect(fires('bull_flag', c)).not.toBeNull();
  });
  it('capitulation wick bought back, CVD absorption', () => {
    const cap = chart([...flat(1, 20), { c: 0.97, low: 0.85, v: 6, buy: 0.2 }, { c: 1.0, v: 2, buy: 0.8 }]);
    expect(fires('capitulation_reversal', cap)).not.toBeNull();
    // Second dip makes a lower low on light selling while buyers keep absorbing (CVD higher low).
    const div = chart([...ramp(1, 0.9, 10, 2).map((s) => ({ ...(s as object), buy: 0.2 }) as Step), ...ramp(0.9, 0.88, 9, 1).map((s) => ({ ...(s as object), buy: 0.7 }) as Step), { c: 0.9, v: 1, buy: 0.8 }]);
    expect(fires('cvd_divergence', div)).not.toBeNull();
  });
  it('VWAP reclaim after a dip below it', () => {
    const c = chart([...ramp(1, 1.3, 12), ...ramp(1.3, 1.08, 4, 2), { c: 1.07 }, { c: 1.21, v: 3, buy: 0.85 }]);
    expect(firesSomewhere('vwap_reclaim', c, 14)).toBe(true);
  });
  it('Heikin-Ashi flip, Stoch RSI cross, RSI divergence on reversals', () => {
    const rev = chart([...ramp(1, 0.7, 30), ...ramp(0.7, 1.3, 30, 1.5)]);
    expect(firesSomewhere('heikin_ashi_flip', rev, 10)).toBe(true);
    const up = noisyUp(1, 50);
    const top = chart(up)[49]!.c;
    const dipUp = chart([...up, ...ramp(top, top * 0.85, 5), ...ramp(top * 0.85, top * 1.02, 6, 1.5)]);
    expect(firesSomewhere('stoch_rsi_cross', dipUp, 40)).toBe(true);
    // Lower low in price on a slower fall → RSI higher low, then the turn.
    const div = chart([...flat(1, 16), ...ramp(1, 0.8, 4, 2), ...ramp(0.8, 0.88, 4), ...ramp(0.88, 0.78, 8, 1), ...ramp(0.78, 0.84, 3, 1.5)]);
    expect(firesSomewhere('rsi_bull_divergence', div, 25)).toBe(true);
  });
  it('opening-range breakout (young coins only), OBV leading price, VWAP band bounce', () => {
    const orb = chart([...ramp(1, 1.2, 6), ...ramp(1.2, 1.05, 6), ...flat(1.1, 6), { c: 1.25, v: 4, buy: 0.85 }]);
    expect(fires('opening_range_breakout', orb, 300)).not.toBeNull();
    expect(fires('opening_range_breakout', orb, 3000)).toBeNull();
    // Price chops under its high while buy volume keeps climbing (OBV makes new highs first).
    const lead = chart([...ramp(1, 1.3, 20), ...ramp(1.3, 1.15, 8), ...Array.from({ length: 14 }, (_, i) => ({ c: i % 2 ? 1.17 : 1.19, v: i % 2 ? 0.3 : 3 }) as Step), { c: 1.2, v: 3, buy: 0.8 }]);
    expect(firesSomewhere('obv_lead', lead, 42)).toBe(true);
    // Gentle chop upward (mostly above VWAP), a dip wicks through the −1σ band and closes back up.
    const chop = Array.from({ length: 30 }, (_, i) => ({ c: (1 + i * 0.0035) * (i % 2 ? 0.985 : 1.015) }) as Step);
    const band = chart([...chop, { c: 1.07 }, { c: 1.045 }, { c: 1.075, low: 0.99, v: 2, buy: 0.75 }]);
    expect(firesSomewhere('vwap_band_bounce', band, 20)).toBe(true);
  });
  it('quiet on a steady bleed: no breakout / trend strategy buys a downtrend', () => {
    const c = chart(ramp(2, 1, 80, 1).map((s) => ({ ...(s as object), buy: 0.3 }) as Step));
    const bullish = ['donchian_breakout', 'range_breakout', 'keltner_breakout', 'bb_squeeze_breakout', 'ath_breakout', 'ema_pullback', 'macd_cross', 'supertrend_flip', 'fib_extension_breakout', 'bull_flag'];
    for (let k = 30; k <= c.length; k++) expect(runStrategies(ctx(c.slice(0, k)), bullish)).toEqual([]);
  });
  it('every strategy has a name, a plain-words summary and survives short / odd charts', () => {
    expect(new Set(TA_STRATEGIES.map((s) => s.id)).size).toBe(TA_STRATEGIES.length);
    for (const s of TA_STRATEGIES) {
      expect(s.summary.length).toBeGreaterThan(40);
      expect(() => runStrategies(ctx(chart([1, 1, 1])), [s.id])).not.toThrow();
      expect(() => runStrategies(ctx(chart(flat(1, 90, 0))), [s.id])).not.toThrow();
    }
  });
});

// ---- The chart-strategy lab: only strategies that beat random entries get a say ----
import { baselinePick, BASELINE_ID, labGate, provenStrategies, taPoints } from '../src/learner/ta-lab';
import { labStats } from '../src/learner/strategy-lab';

describe('chart-strategy lab', () => {
  const st = (id: string, xs: number[]) => labStats(id, id, xs.map((pnlPct) => ({ pnlPct })));
  const many = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  it('a strategy is proven only with enough results AND a real edge over random entries', () => {
    const base = st(BASELINE_ID, many(60, (i) => (i % 3 ? -8 : 10))); // random ≈ −2%/trade
    const fib = st('fib_golden_pocket', many(50, (i) => (i % 2 ? -7 : 18))); // ≈ +5.5%
    const meh = st('macd_cross', many(50, (i) => (i % 3 ? -7 : 12))); // ≈ −0.7% (beats random, but loses)
    const few = st('bull_flag', many(10, () => 30));
    const p = provenStrategies([fib, meh, few], base, { minTrades: 40, minEdgePct: 2 });
    expect([...p.keys()]).toEqual(['fib_golden_pocket']);
    expect(p.get('fib_golden_pocket')!.edgePct).toBeGreaterThan(5);
  });
  it('lucky moonshots and multiple-testing luck do not count as an edge', () => {
    const base = st(BASELINE_ID, many(60, (i) => (i % 3 ? -8 : 10)));
    // Loses on 47 of 50 trades; 3 huge moonshots make the average look great.
    const lucky = st('ath_breakout', many(50, (i) => (i < 3 ? 400 : -8)));
    expect(lucky.avgPnlPct).toBeGreaterThan(10);
    expect(lucky.trimmedAvgPct).toBeLessThan(0);
    expect(provenStrategies([lucky], base, { minTrades: 40, minEdgePct: 2 }).size).toBe(0);
    // A small, noisy edge among many tested strategies doesn't survive false-discovery control.
    const noisy = many(20, (k) => st(`s${k}`, many(60, (i) => (i % 2 ? -20 : 18.5 + (k === 3 ? 2 : 0)))));
    expect(provenStrategies(noisy, base, { minTrades: 40, minEdgePct: 2 }).size).toBe(0);
  });
  it('random baseline picks ~1 in N looks, deterministically', () => {
    let hits = 0;
    for (let t = 0; t < 4000; t++) if (baselinePick('So1anaMint', t, 40)) hits++;
    expect(hits).toBeGreaterThan(60);
    expect(hits).toBeLessThan(140);
    expect(baselinePick('x', 7, 40)).toBe(baselinePick('x', 7, 40));
  });
  it('cheap quality gate and score points for proven signals', () => {
    const c = { minMarketCapUsd: 3_000, maxTop10Pct: 50, maxDevHoldingPct: 15, maxBundlePct: 25 };
    const ok = { marketCapSol: 100, top10HolderPct: 25, devHoldingPct: 3, earlyBuyerPct: 5, liquiditySol: 20 };
    expect(labGate(ok, 80, c)).toBeNull();
    expect(labGate({ ...ok, marketCapSol: 20 }, 80, c)).toContain('market cap');
    expect(labGate({ ...ok, top10HolderPct: 70 }, 80, c)).toContain('top 10');
    const proven = new Map([['fib_golden_pocket', { id: 'fib_golden_pocket', n: 50, avgPnlPct: 6, edgePct: 8 }]]);
    const r = taPoints([{ id: 'fib_golden_pocket', strength: 1, why: '' }, { id: 'macd_cross', strength: 1, why: '' }], proven, { pointsPerSignal: 3, maxPoints: 8 });
    expect(r.points).toBeCloseTo(2.4, 1); // 3 × (8/10 edge) × full strength; MACD isn't proven
    expect(r.notes[0]).toContain('Fibonacci');
  });
});
