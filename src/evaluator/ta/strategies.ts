/**
 * Chart strategy library — classic technical-analysis setups, each a precise rule the bot
 * can check on a coin's candles (15 s candles built from every real trade; 1 m resampled).
 *
 * Nothing here trades on its own. Every strategy is FORWARD-TESTED live by the TA lab
 * (src/learner/ta-lab.ts) against a random-entry baseline; only strategies that prove
 * themselves on enough real signals get to influence real buys (see TaLab.proven()).
 *
 * Each `check` looks at the last COMPLETED candle (the trigger candle) and returns a signal
 * (strength 0–1, a plain-English reason, a stop and targets) or null. All pure.
 */
import type { Candle } from '../chart-reader';
import type { CrowdTrade } from '../../scanner/crowd-tracker';
import { atr, bollinger, cvd, emaSeries, fibLevels, heikinAshi, lastImpulse, macd, obv, rsiSeries, sma, stochRsi, supertrend, swings, vwapBands } from './indicators';

export type TaFamily = 'fibonacci' | 'trend' | 'momentum' | 'mean-reversion' | 'breakout' | 'structure' | 'volume' | 'pattern';

export interface TaContext {
  /** Completed 15 s candles, oldest → newest, gaps filled with flat zero-volume candles. */
  c15: readonly Candle[];
  /** Same, resampled to 1 minute. */
  c1m: readonly Candle[];
  /** Price right now (last trade). */
  price: number;
  now: number;
  /** Coin age in seconds (null = unknown). */
  ageSec: number | null;
  /** The raw trade log (order-flow strategies), oldest → newest. Optional. */
  trades?: readonly CrowdTrade[];
  /** The coin's creator (left out of "organic" flow). */
  creator?: string | null;
}

export interface TaSignal {
  id: string;
  /** 0–1: how clean the setup is. */
  strength: number;
  why: string;
  /** Where the setup is wrong (price). */
  stop?: number;
  /** Price targets (nearest first). */
  targets?: number[];
}

export interface TaStrategy {
  id: string;
  name: string;
  family: TaFamily;
  /** What it looks for, in plain words (dashboard). */
  summary: string;
  minCandles: number;
  check(ctx: TaContext): TaSignal | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const last = <T>(a: readonly T[], k = 1): T | undefined => a[a.length - k];
const avg = (a: readonly number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const avgVol = (c: readonly Candle[], n: number, skipLast = 1) => avg(c.slice(Math.max(0, c.length - n - skipLast), c.length - skipLast).map((x) => x.v));
const green = (x: Candle) => x.c > x.o;
const buyers = (x: Candle, k = 1) => x.bv >= x.sv * k && x.bv > 0;
const maxH = (c: readonly Candle[]) => c.reduce((m, x) => Math.max(m, x.h), 0);
const minL = (c: readonly Candle[]) => c.reduce((m, x) => Math.min(m, x.l), Infinity);

/** Fill missing 15 s buckets with flat, zero-volume candles (indicators assume even spacing). */
export function fillGaps(c: readonly Candle[], stepMs = 15_000, maxFill = 40): Candle[] {
  const out: Candle[] = [];
  for (const x of c) {
    const prev = out[out.length - 1];
    if (prev) {
      let missing = Math.round((x.t - prev.t) / stepMs) - 1;
      missing = Math.min(missing, maxFill);
      for (let k = 1; k <= missing; k++) out.push({ t: prev.t + k * stepMs, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0, bv: 0, sv: 0, n: 0 });
    }
    out.push(x);
  }
  return out;
}

/**
 * Pullback reclaim at a given depth band of the last leg (the golden pocket = 0.5–0.7):
 *  - leg: swing low → high of +30%+ within 20 minutes; the high 3+ candles but ≤ 10 min ago,
 *  - the deepest pullback since the high is within [lo, hi] of the leg, and no close since
 *    the high went below `voidAt` (the setup is broken there),
 *  - trigger: a candle closes above the previous candle's high with the last minute's buy SOL
 *    ≥ 1.2 × sell SOL.
 */
function pullbackReclaim(id: string, name: string, lo: number, hi: number, voidAt: number, summary: string): TaStrategy {
  return {
    id,
    name,
    family: 'fibonacci',
    summary,
    minCandles: 16,
    check({ c15, price }) {
      const imp = lastImpulse(c15, 80);
      const n = c15.length;
      if (!imp || imp.high / imp.low < 1.3 || imp.highIdx - imp.lowIdx > 80) return null;
      const since = n - 1 - imp.highIdx;
      if (since < 3 || since > 40) return null;
      const after = c15.slice(imp.highIdx + 1);
      const fib = fibLevels(imp.low, imp.high);
      const depth = fib.depthOf(minL(after));
      if (depth < lo || depth > hi || after.some((x) => x.c < fib.retrace(voidAt))) return null;
      const lc = c15[n - 1]!;
      const prev = c15[n - 2]!;
      const minute = c15.slice(-4);
      const bs = minute.reduce((s2, x) => s2 + x.bv, 0) / Math.max(1e-9, minute.reduce((s2, x) => s2 + x.sv, 0));
      if (!(lc.c > prev.h && bs >= 1.2) || fib.depthOf(price) < lo * 0.5) return null;
      return {
        id,
        strength: clamp01(1 - Math.abs(depth - (lo + hi) / 2) / (hi - lo)),
        why: `+${pct(imp.high / imp.low - 1)} leg pulled back ${pct(depth)} and reclaimed (buy/sell ${bs.toFixed(1)})`,
        stop: Math.min(fib.retrace(voidAt), minL(after)) * 0.98,
        targets: [imp.high, fib.extend(1.272), fib.extend(1.618)],
      };
    },
  };
}

export const TA_STRATEGIES: TaStrategy[] = [
  // ---------------- Fibonacci ----------------
  // The golden pocket and two CONTROL depths with the exact same rules: if the 50–70% pocket
  // doesn't beat a 30–45% or 70–85% pullback, the Fibonacci levels themselves add nothing
  // (research: the evidence for Fibonacci levels is weak — let the live test decide).
  pullbackReclaim('fib_golden_pocket', 'Fibonacci golden pocket reclaim', 0.5, 0.7, 0.786, 'After a strong leg (+30%+), the price pulls back into the 50–70% Fibonacci retrace (the 61.8–65% "golden pocket"), never closes below 78.6%, then a candle closes above the previous candle\'s high with buyers ahead (1-min buy/sell ≥ 1.2). Targets: the old high, then the 1.272 / 1.618 extensions.'),
  pullbackReclaim('pullback_shallow', 'Shallow pullback reclaim (30–45%) — control', 0.3, 0.45, 0.6, 'Control test for the golden pocket: identical rules, but only a shallow 30–45% pullback. If this does as well as the golden pocket, the Fibonacci levels are not special.'),
  pullbackReclaim('pullback_deep', 'Deep pullback reclaim (70–85%) — control', 0.7, 0.85, 0.92, 'Control test for the golden pocket: identical rules, but a deep 70–85% pullback.'),
  {
    id: 'fib_extension_breakout',
    name: 'Fibonacci shallow retrace → breakout',
    family: 'fibonacci',
    summary: 'A run that only retraced 23.6–50% (strong hands) breaks back above its high on volume. Targets: the 1.272 and 1.618 Fibonacci extensions of the leg.',
    minCandles: 16,
    check({ c15 }) {
      const prior = c15.slice(0, -1);
      const imp = lastImpulse(prior, 80);
      if (!imp || imp.high / imp.low < 1.3 || prior.length - 1 - imp.highIdx < 4) return null;
      const fib = fibLevels(imp.low, imp.high);
      const depth = fib.depthOf(minL(prior.slice(imp.highIdx + 1)));
      const lc = last(c15)!;
      if (depth < 0.236 || depth > 0.5 || !(lc.c > imp.high) || !(lc.v >= 1.3 * avgVol(c15, 20)) || !buyers(lc, 1.2)) return null;
      return { id: 'fib_extension_breakout', strength: clamp01((0.5 - depth) / 0.26 * 0.5 + 0.5), why: `Fibonacci: held a ${pct(depth)} retrace and broke the high on volume`, stop: fib.retrace(0.5) * 0.97, targets: [fib.extend(1.272), fib.extend(1.618)] };
    },
  },
  // ---------------- Trend ----------------
  {
    id: 'ema_pullback',
    name: 'EMA ribbon pullback',
    family: 'trend',
    summary: 'In a clean uptrend (fast EMA 9 > EMA 21 > EMA 50, all rising) the price dips to the EMA 21 and bounces — buying the trend\'s pullback, not its top.',
    minCandles: 50,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const e9 = emaSeries(cl, 9);
      const e21 = emaSeries(cl, 21);
      const e50 = emaSeries(cl, 50);
      const i = cl.length - 1;
      const lc = c15[i]!;
      if (!(e9[i]! > e21[i]! && e21[i]! > e50[i]! && e50[i]! > e50[i - 10]!)) return null;
      const r = rsiSeries(cl, 14)[i]!;
      if (!(lc.l <= e21[i]! * 1.01 && lc.c > e21[i]! && green(lc) && r >= 40 && r <= 70)) return null;
      return { id: 'ema_pullback', strength: clamp01((e9[i]! / e50[i]! - 1) * 5), why: 'EMA ribbon: uptrend pulled back to the EMA 21 and bounced', stop: e50[i]! * 0.97, targets: [maxH(c15.slice(-40))] };
    },
  },
  {
    id: 'supertrend_flip',
    name: 'Supertrend flip to bullish',
    family: 'trend',
    summary: 'The ATR-based Supertrend line flips from bearish to bullish (price closes above it) — the trend just turned up.',
    minCandles: 20,
    check({ c15 }) {
      const st = supertrend(c15, 10, 3);
      const i = c15.length - 1;
      if (!(st.dir[i] === 1 && st.dir[i - 1] === -1)) return null;
      const lc = c15[i]!;
      if (!buyers(lc)) return null;
      return { id: 'supertrend_flip', strength: clamp01(lc.v / Math.max(1e-9, avgVol(c15, 20)) / 3), why: 'Supertrend flipped bullish', stop: st.line[i]! * 0.98 };
    },
  },
  {
    id: 'heikin_ashi_flip',
    name: 'Heikin-Ashi trend flip',
    family: 'trend',
    summary: 'Smoothed (Heikin-Ashi) candles turn from 3+ red to 3 strong green ones with no lower wicks — a clean change of trend.',
    minCandles: 10,
    check({ c15 }) {
      const ha = heikinAshi(c15);
      const n = ha.length;
      const bull = (k: number) => ha[n - k]!.c > ha[n - k]!.o && ha[n - k]!.l >= Math.min(ha[n - k]!.o, ha[n - k]!.c) * 0.999;
      const bear = (k: number) => ha[n - k]!.c < ha[n - k]!.o;
      if (!(bull(1) && bull(2) && bull(3) && bear(4) && bear(5) && bear(6))) return null;
      return { id: 'heikin_ashi_flip', strength: 0.6, why: 'Heikin-Ashi: 3 strong green candles after a red run', stop: Math.min(...c15.slice(-6).map((x) => x.l)) * 0.98 };
    },
  },
  // ---------------- Momentum ----------------
  {
    id: 'macd_cross',
    name: 'MACD bullish cross',
    family: 'momentum',
    summary: 'The MACD line crosses above its signal line (momentum turning up) while the price is above the EMA 50 (with the trend).',
    minCandles: 40,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const m = macd(cl, 12, 26, 9);
      const i = cl.length - 1;
      if (!(m.hist[i]! > 0 && m.hist[i - 1]! <= 0)) return null;
      const e50 = emaSeries(cl, 50);
      if (!(cl[i]! > e50[i]!)) return null;
      return { id: 'macd_cross', strength: clamp01(0.5 + (m.line[i]! > 0 ? 0.3 : 0)), why: `MACD crossed up${m.line[i]! > 0 ? ' above zero' : ''}, price over the EMA 50`, stop: minL(c15.slice(-8)) * 0.98 };
    },
  },
  {
    id: 'rsi_oversold_bounce',
    name: 'RSI oversold bounce in an uptrend',
    family: 'momentum',
    summary: 'The bigger trend is up (EMA 21 > EMA 50) but a quick dip pushed RSI under 32; RSI climbs back over 40 — the dip is being bought.',
    minCandles: 50,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const r = rsiSeries(cl, 14);
      const i = cl.length - 1;
      const e21 = emaSeries(cl, 21);
      const e50 = emaSeries(cl, 50);
      const dipped = Math.min(...r.slice(i - 6, i).filter(Number.isFinite));
      if (!(e21[i]! > e50[i]! && dipped < 32 && r[i - 1]! < 40 && r[i]! >= 40)) return null;
      return { id: 'rsi_oversold_bounce', strength: clamp01((32 - dipped) / 15 + 0.4), why: `RSI dipped to ${dipped.toFixed(0)} in an uptrend and recovered past 40`, stop: minL(c15.slice(-8)) * 0.97 };
    },
  },
  {
    id: 'rsi_bull_divergence',
    name: 'RSI bullish divergence',
    family: 'momentum',
    summary: 'The price makes a lower low but RSI makes a higher low — sellers are running out of steam; the price starts turning up.',
    minCandles: 30,
    check({ c15, price }) {
      const cl = c15.map((x) => x.c);
      const r = rsiSeries(cl, 14);
      const lows = swings(c15, 2).lows.filter((s) => s.i >= c15.length - 40 && Number.isFinite(r[s.i]!));
      if (lows.length < 2) return null;
      const a = lows[lows.length - 2]!;
      const b = lows[lows.length - 1]!;
      const lc = last(c15)!;
      if (!(b.p < a.p && r[b.i]! > r[a.i]! + 3 && c15.length - 1 - b.i >= 2 && green(lc) && price > b.p * 1.03)) return null;
      return { id: 'rsi_bull_divergence', strength: clamp01((r[b.i]! - r[a.i]!) / 15), why: `RSI divergence: lower low in price, RSI ${r[a.i]!.toFixed(0)} → ${r[b.i]!.toFixed(0)}`, stop: b.p * 0.97 };
    },
  },
  {
    id: 'stoch_rsi_cross',
    name: 'Stochastic RSI cross from oversold',
    family: 'momentum',
    summary: 'Stochastic RSI %K crosses above %D from under 20 while the trend is up — a fast, early dip-buy timing signal.',
    minCandles: 40,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const s = stochRsi(cl);
      const i = cl.length - 1;
      const e21 = emaSeries(cl, 21);
      const e50 = emaSeries(cl, 50);
      // (≤: at a hard bottom %K and %D both sit at 0 — %K lifting off is the cross)
      if (!(s.k[i - 1]! <= s.d[i - 1]! && s.k[i]! > s.d[i]! && s.k[i - 1]! < 20 && e21[i]! > e50[i]!)) return null;
      return { id: 'stoch_rsi_cross', strength: 0.5, why: 'Stoch RSI crossed up from oversold in an uptrend', stop: minL(c15.slice(-6)) * 0.97 };
    },
  },
  // ---------------- Mean reversion ----------------
  {
    id: 'vwap_reclaim',
    name: 'VWAP reclaim',
    family: 'mean-reversion',
    summary: 'The price spent a while under the VWAP (the average price everyone paid) and closes back above it with buyers in control — the crowd is back in profit.',
    minCandles: 12,
    check({ c15 }) {
      const { vwap } = vwapBands(c15, 0);
      const i = c15.length - 1;
      const lc = c15[i]!;
      const under = [1, 2, 3].filter((k) => c15[i - k]!.c < vwap[i - k]!).length;
      if (!(under >= 2 && lc.c > vwap[i]! * 1.01 && buyers(lc, 1.2) && lc.v >= avgVol(c15, 20))) return null;
      return { id: 'vwap_reclaim', strength: clamp01(lc.bv / Math.max(1e-9, lc.sv) / 4), why: 'reclaimed the VWAP with buyers in control', stop: minL(c15.slice(-6)) * 0.97, targets: [maxH(c15.slice(-40))] };
    },
  },
  {
    id: 'vwap_band_bounce',
    name: 'VWAP −1σ band bounce',
    family: 'mean-reversion',
    summary: 'In an uptrend (mostly above VWAP), a dip tags the VWAP −1 standard-deviation band and snaps back — buying a stretched dip.',
    minCandles: 20,
    check({ c15 }) {
      const { vwap, sd } = vwapBands(c15, 0);
      const i = c15.length - 1;
      const above = c15.slice(-20).filter((x, k) => x.c > vwap[i - 19 + k]!).length;
      const touched = [0, 1].some((k) => c15[i - k]!.l <= vwap[i - k]! - sd[i - k]!);
      const lc = c15[i]!;
      if (!(above >= 14 && touched && lc.c > vwap[i]! - 0.5 * sd[i]! && green(lc))) return null;
      return { id: 'vwap_band_bounce', strength: 0.55, why: 'dip to the VWAP −1σ band in an uptrend, bouncing', stop: (vwap[i]! - 2 * sd[i]!) * 0.98, targets: [vwap[i]! + sd[i]!] };
    },
  },
  {
    id: 'capitulation_reversal',
    name: 'Capitulation wick reversal',
    family: 'mean-reversion',
    summary: 'A panic candle (sell volume 3× normal, long lower wick = dip bought instantly) followed by a green candle with buyers in control.',
    minCandles: 20,
    check({ c15 }) {
      const i = c15.length - 1;
      const sAvg = avg(c15.slice(-22, -2).map((x) => x.sv));
      for (const k of [1, 2]) {
        const x = c15[i - k]!;
        const range = x.h - x.l;
        const wick = Math.min(x.o, x.c) - x.l;
        if (x.sv >= 3 * Math.max(sAvg, 1e-9) && range > 0 && wick / range >= 0.5 && range / x.l >= 0.05) {
          const lc = c15[i]!;
          if (green(lc) && buyers(lc, 1.2) && lc.c > x.c) return { id: 'capitulation_reversal', strength: clamp01(x.sv / Math.max(sAvg, 1e-9) / 6), why: 'panic sell got bought (long lower wick), green follow-through', stop: x.l * 0.97 };
        }
      }
      return null;
    },
  },
  // ---------------- Breakouts ----------------
  {
    id: 'bb_squeeze_breakout',
    name: 'Bollinger squeeze breakout',
    family: 'breakout',
    summary: 'The Bollinger Bands squeeze tight (quiet, coiling) and the price closes above the upper band on strong buy volume — volatility expanding upward.',
    minCandles: 40,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const bb = bollinger(cl, 20, 2);
      const i = cl.length - 1;
      const widths = bb.width.slice(-80, -1).filter(Number.isFinite).sort((a, b) => a - b);
      if (widths.length < 20) return null;
      const q25 = widths[Math.floor(widths.length * 0.25)]!;
      const lc = c15[i]!;
      if (!(bb.width[i - 1]! <= q25 && lc.c > bb.upper[i]! && lc.v >= 1.5 * avgVol(c15, 20) && buyers(lc))) return null;
      return { id: 'bb_squeeze_breakout', strength: clamp01(lc.v / Math.max(1e-9, avgVol(c15, 20)) / 4), why: 'Bollinger squeeze broke out upward on volume', stop: bb.mid[i]! * 0.98 };
    },
  },
  {
    id: 'donchian_breakout',
    name: 'Donchian 20-candle breakout',
    family: 'breakout',
    summary: 'Classic "turtle" breakout: closes above the highest high of the last 20 candles (5 min) on 1.5× volume with buyers ahead — not when already overbought.',
    minCandles: 25,
    check({ c15 }) {
      const i = c15.length - 1;
      const lc = c15[i]!;
      const hi = maxH(c15.slice(i - 20, i));
      const r = rsiSeries(c15.map((x) => x.c), 14)[i]!;
      if (!(lc.c > hi && lc.v >= 1.5 * avgVol(c15, 20) && buyers(lc, 1.3) && r < 80)) return null;
      return { id: 'donchian_breakout', strength: clamp01((80 - r) / 40), why: 'broke the 5-minute high on volume', stop: minL(c15.slice(i - 10, i)) * 0.98 };
    },
  },
  {
    id: 'range_breakout',
    name: 'Tight range breakout',
    family: 'breakout',
    summary: 'Three minutes of tight sideways action (range ≤ 12%), then a candle breaks the range top by 2%+ on double volume with buyers in control.',
    minCandles: 16,
    check({ c15 }) {
      const i = c15.length - 1;
      const rng = c15.slice(i - 12, i);
      const hi = maxH(rng);
      const lo = minL(rng);
      const lc = c15[i]!;
      if (!(lo > 0 && (hi - lo) / lo <= 0.12 && lc.c > hi * 1.02 && lc.v >= 2 * avg(rng.map((x) => x.v)) && buyers(lc))) return null;
      return { id: 'range_breakout', strength: clamp01(1 - (hi - lo) / lo / 0.12 + 0.3), why: `broke out of a ${pct((hi - lo) / lo)} range on volume`, stop: lo * 0.98, targets: [hi + (hi - lo) * 2] };
    },
  },
  {
    id: 'keltner_breakout',
    name: 'Keltner channel breakout',
    family: 'breakout',
    summary: 'Closes above the Keltner channel (EMA 20 + 2 × ATR) on volume — a move bigger than the coin\'s normal noise.',
    minCandles: 25,
    check({ c15 }) {
      const cl = c15.map((x) => x.c);
      const e20 = emaSeries(cl, 20);
      const a = atr(c15, 14);
      const i = cl.length - 1;
      const lc = c15[i]!;
      if (!(Number.isFinite(a[i]!) && lc.c > e20[i]! + 2 * a[i]! && lc.v >= 1.5 * avgVol(c15, 20) && buyers(lc))) return null;
      return { id: 'keltner_breakout', strength: 0.5, why: 'closed above the Keltner channel on volume', stop: e20[i]! * 0.98 };
    },
  },
  {
    id: 'opening_range_breakout',
    name: 'Opening-range breakout',
    family: 'breakout',
    summary: 'For coins 3–20 minutes old: the first time the price closes 2%+ above the high of its first 3 minutes, on volume.',
    minCandles: 14,
    check({ c15, ageSec }) {
      if (ageSec === null || ageSec < 180 || ageSec > 1200) return null;
      const or = c15.slice(0, 12);
      const hi = maxH(or);
      const i = c15.length - 1;
      const lc = c15[i]!;
      const before = c15.slice(12, i).some((x) => x.c > hi * 1.02);
      if (before || !(lc.c > hi * 1.02 && lc.v >= 1.5 * avgVol(c15, 20) && buyers(lc))) return null;
      return { id: 'opening_range_breakout', strength: 0.5, why: 'first close above its opening 3-minute range', stop: minL(or) };
    },
  },
  {
    id: 'ath_breakout',
    name: 'All-time-high breakout (price discovery)',
    family: 'breakout',
    summary: 'The coin consolidated under its all-time high for 2+ minutes, then closes above it with strong buying — nobody above is waiting to sell.',
    minCandles: 16,
    check({ c15, ageSec }) {
      if (ageSec !== null && ageSec < 180) return null;
      const i = c15.length - 1;
      const prior = c15.slice(0, i - 1);
      const ath = maxH(prior);
      const athIdx = prior.findIndex((x) => x.h === ath);
      const lc = c15[i]!;
      if (!(i - athIdx >= 8 && lc.c > ath * 1.01 && buyers(lc, 1.5) && lc.v >= 1.3 * avgVol(c15, 20))) return null;
      return { id: 'ath_breakout', strength: clamp01(lc.bv / Math.max(1e-9, lc.sv) / 4), why: 'broke its all-time high after consolidating', stop: ath * 0.9 };
    },
  },
  // ---------------- Structure ----------------
  {
    id: 'break_of_structure',
    name: 'Higher low + break of structure',
    family: 'structure',
    summary: 'The chart prints a higher low, then closes above the last swing high (a "break of structure") — the trend changed from down to up.',
    minCandles: 20,
    check({ c15 }) {
      const sw = swings(c15, 2);
      const lows = sw.lows.filter((s) => s.i >= c15.length - 60);
      if (lows.length < 2) return null;
      const l1 = lows[lows.length - 2]!;
      const l2 = lows[lows.length - 1]!;
      const h = sw.highs.filter((s) => s.i > l1.i && s.i < c15.length - 1).pop();
      const lc = last(c15)!;
      const prev = c15[c15.length - 2]!;
      if (!(h && l2.p > l1.p && lc.c > h.p && prev.c <= h.p && green(lc))) return null;
      return { id: 'break_of_structure', strength: clamp01((l2.p / l1.p - 1) * 10 + 0.3), why: 'higher low, then broke the last swing high', stop: l2.p * 0.97 };
    },
  },
  {
    id: 'liquidity_sweep',
    name: 'Liquidity sweep reclaim',
    family: 'structure',
    summary: 'A wick dips below the recent swing low (stop losses get hit), then the price closes back above it — weak hands shaken out, buyers stepped in.',
    minCandles: 28,
    check({ c15 }) {
      const i = c15.length - 1;
      const s = minL(c15.slice(i - 25, i - 2));
      const swept = [0, 1].some((k) => c15[i - k]!.l < s * 0.98);
      const lc = c15[i]!;
      if (!(Number.isFinite(s) && swept && lc.c > s && green(lc) && buyers(lc))) return null;
      return { id: 'liquidity_sweep', strength: 0.6, why: 'swept the lows (stops hit) and reclaimed', stop: Math.min(c15[i]!.l, c15[i - 1]!.l) * 0.98 };
    },
  },
  // ---------------- Patterns ----------------
  {
    id: 'bull_flag',
    name: 'Bull flag breakout',
    family: 'pattern',
    summary: 'A fast pole (+30% in ≤2 min), then a calm flag (shallow pullback on fading volume), then a breakout above the flag on rising volume.',
    minCandles: 20,
    check({ c15 }) {
      const i = c15.length - 1;
      for (let b = i - 4; b >= Math.max(1, i - 18); b--) {
        const a = Math.max(0, b - 8);
        const poleLow = minL(c15.slice(a, b + 1));
        const poleHigh = c15[b]!.h;
        if (!(poleHigh / poleLow >= 1.3)) continue;
        const flag = c15.slice(b + 1, i);
        if (flag.length < 3 || flag.length > 16) continue;
        const flagLow = minL(flag);
        const flagHigh = maxH(flag);
        const poleVol = avg(c15.slice(a, b + 1).map((x) => x.v));
        const flagVol = avg(flag.map((x) => x.v));
        const lc = c15[i]!;
        if ((poleHigh - flagLow) / (poleHigh - poleLow) <= 0.5 && flagVol <= 0.7 * poleVol && lc.c > flagHigh && lc.v > 1.5 * flagVol && buyers(lc)) {
          return { id: 'bull_flag', strength: clamp01(poleVol / Math.max(1e-9, flagVol) / 4), why: `bull flag: +${pct(poleHigh / poleLow - 1)} pole, quiet flag, breakout`, stop: flagLow * 0.98, targets: [flagHigh + (poleHigh - poleLow)] };
        }
      }
      return null;
    },
  },
  {
    id: 'double_bottom',
    name: 'Double bottom (W) breakout',
    family: 'pattern',
    summary: 'Two lows at about the same price with a bounce between them; the price breaks the middle peak (the neckline) — buyers defended the same level twice.',
    minCandles: 20,
    check({ c15 }) {
      const lows = swings(c15, 2).lows.filter((s) => s.i >= c15.length - 60);
      if (lows.length < 2) return null;
      const l1 = lows[lows.length - 2]!;
      const l2 = lows[lows.length - 1]!;
      if (!(Math.abs(l2.p / l1.p - 1) <= 0.03 && l2.i - l1.i >= 5)) return null;
      const neck = maxH(c15.slice(l1.i, l2.i + 1));
      const lc = last(c15)!;
      const prev = c15[c15.length - 2]!;
      if (!(neck >= Math.max(l1.p, l2.p) * 1.08 && lc.c > neck && prev.c <= neck && green(lc))) return null;
      return { id: 'double_bottom', strength: 0.65, why: 'double bottom: broke the neckline', stop: Math.min(l1.p, l2.p) * 0.97, targets: [neck + (neck - Math.min(l1.p, l2.p))] };
    },
  },
  // ---------------- Volume / order flow ----------------
  {
    id: 'cvd_divergence',
    name: 'CVD bullish divergence (absorption)',
    family: 'volume',
    summary: 'The price makes a lower low but cumulative buy − sell volume makes a higher low — sellers are being absorbed by buyers; the price turns up.',
    minCandles: 22,
    check({ c15 }) {
      const d = cvd(c15);
      const n = c15.length;
      const pNow = minL(c15.slice(n - 10));
      const pPrev = minL(c15.slice(n - 20, n - 10));
      const dNow = Math.min(...d.slice(n - 10));
      const dPrev = Math.min(...d.slice(n - 20, n - 10));
      const lc = last(c15)!;
      if (!(pNow < pPrev && dNow > dPrev && green(lc) && buyers(lc))) return null;
      return { id: 'cvd_divergence', strength: 0.55, why: 'lower low in price, higher low in buy/sell volume (absorption)', stop: pNow * 0.97 };
    },
  },
  {
    id: 'obv_lead',
    name: 'OBV leads price',
    family: 'volume',
    summary: 'On-balance volume hits a new high while the price is still below its high — volume is accumulating ahead of the price.',
    minCandles: 42,
    check({ c15 }) {
      const o = obv(c15);
      const n = c15.length;
      const e21 = emaSeries(c15.map((x) => x.c), 21);
      const obvHi = Math.max(...o.slice(n - 41, n - 1));
      const pxHi = maxH(c15.slice(n - 41, n - 1));
      const lc = last(c15)!;
      if (!(o[n - 1]! > obvHi && lc.c < pxHi * 0.97 && lc.c > e21[n - 1]!)) return null;
      return { id: 'obv_lead', strength: 0.5, why: 'volume (OBV) at a new high before the price', stop: minL(c15.slice(-8)) * 0.97, targets: [pxHi] };
    },
  },
  {
    id: 'organic_burst',
    name: 'Organic buying burst',
    family: 'volume',
    summary: 'In the last minute many different real wallets (20+, bots and the dev left out) bought hard: buy − sell imbalance ≥ 40%, ≥ 3 SOL net in, price up 5–25% (not more — no chasing a vertical candle). Research ranks this the strongest mechanism for small coins.',
    minCandles: 8,
    check({ trades, now, creator, c15 }) {
      if (!trades?.length) return null;
      const sizes = new Map<string, number[]>();
      for (const x of trades) if (x.buy) sizes.set(x.w, [...(sizes.get(x.w) ?? []), x.sol]);
      const bot = (w: string) => {
        const a = sizes.get(w) ?? [];
        if (a.length < 3) return false;
        const m = [...a].sort((p, q) => p - q)[a.length >> 1]!;
        return m > 0 && a.filter((v) => Math.abs(v - m) / m <= 0.02).length >= 3;
      };
      const minute = trades.filter((x) => x.t <= now && now - x.t <= 60_000);
      const buys = minute.filter((x) => x.buy && x.w !== creator && !bot(x.w));
      const buySol = buys.reduce((s2, x) => s2 + x.sol, 0);
      const sellSol = minute.filter((x) => !x.buy).reduce((s2, x) => s2 + x.sol, 0);
      const imb = buySol + sellSol > 0 ? (buySol - sellSol) / (buySol + sellSol) : 0;
      const wallets = new Set(buys.map((x) => x.w)).size;
      const px = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
      const first = minute[0];
      const lastT = minute[minute.length - 1];
      const move = first && lastT ? px(lastT) / px(first) - 1 : 0;
      if (!(imb >= 0.4 && wallets >= 20 && buySol - sellSol >= 3 && move >= 0.05 && move <= 0.25)) return null;
      const a = atr(c15, 14);
      const stop = Math.max(minL(c15.slice(-4)), (lastT ? px(lastT) : 0) - 2 * (a[a.length - 1] ?? 0)) * 0.99;
      return { id: 'organic_burst', strength: clamp01((wallets - 20) / 30 + imb / 2), why: `${wallets} real buyers in 1 min, imbalance ${pct(imb)}, +${(buySol - sellSol).toFixed(1)} SOL net, +${pct(move)}`, stop };
    },
  },
  {
    id: 'climax_retest',
    name: 'Volume climax → retest',
    family: 'mean-reversion',
    summary: 'A selling climax (volume 3× normal, wide range, 25%+ below the recent high, closed off its lows), then a calmer retest that holds above the climax low on half the volume, then a close above the retest candle\'s high. Never buys the climax candle itself.',
    minCandles: 30,
    check({ c15 }) {
      const n = c15.length;
      const a = atr(c15, 14);
      for (let k = n - 3; k >= Math.max(21, n - 30); k--) {
        const x = c15[k]!;
        const prior = c15.slice(k - 20, k).map((y) => y.v);
        const mu = avg(prior);
        // (noise floor: on perfectly even volume the z-score would divide by zero)
        const sd = Math.max(Math.sqrt(avg(prior.map((v) => (v - mu) ** 2))), mu * 0.25);
        const range = x.h - x.l;
        const recentHigh = maxH(c15.slice(Math.max(0, k - 40), k));
        const z = sd > 0 ? (x.v - mu) / sd : 0;
        if (!(z >= 3 && Number.isFinite(a[k]!) && range >= 2 * a[k]! && x.c <= recentHigh * 0.75 && (Math.min(x.o, x.c) - x.l) / Math.max(range, 1e-12) >= 0.5)) continue;
        const after = c15.slice(k + 1, n - 1);
        const test = after.filter((y) => y.l > x.l && y.v <= 0.5 * x.v);
        const testBar = test.reduce<Candle | null>((m, y) => (!m || y.l < m.l ? y : m), null);
        const lc = c15[n - 1]!;
        if (testBar && lc.c > testBar.h && green(lc)) {
          return { id: 'climax_retest', strength: clamp01(z / 6), why: 'selling climax, calm retest held above its low, now breaking up', stop: x.l * 0.98, targets: [x.l + (recentHigh - x.l) * 0.5] };
        }
        return null;
      }
      return null;
    },
  },
];

export const TA_BY_ID = new Map(TA_STRATEGIES.map((s) => [s.id, s]));

/** Run every strategy (or `ids`) on the context; strategies that need more candles are skipped. Never throws. */
export function runStrategies(ctx: TaContext, ids?: readonly string[]): TaSignal[] {
  const out: TaSignal[] = [];
  const list = ids ? TA_STRATEGIES.filter((s) => ids.includes(s.id)) : TA_STRATEGIES;
  for (const s of list) {
    if (ctx.c15.length < s.minCandles) continue;
    try {
      const sig = s.check(ctx);
      if (sig && Number.isFinite(sig.strength)) out.push(sig);
    } catch {
      /* a strategy bug must never break the bot */
    }
  }
  return out;
}

/** Build the strategy context from raw 15 s candles: completed candles only, gaps filled, 1 m resample. */
export function taContext(raw: readonly Candle[], price: number, now: number, ageSec: number | null, stepMs = 15_000, extra: { trades?: readonly CrowdTrade[]; creator?: string | null } = {}): TaContext {
  const cur = Math.floor(now / stepMs) * stepMs;
  const done = fillGaps(raw.filter((c) => c.t < cur), stepMs);
  const c1m: Candle[] = [];
  for (const c of done) {
    const b = Math.floor(c.t / 60_000) * 60_000;
    const l = c1m[c1m.length - 1];
    if (l && l.t === b) {
      l.h = Math.max(l.h, c.h);
      l.l = Math.min(l.l, c.l);
      l.c = c.c;
      l.v += c.v;
      l.bv += c.bv;
      l.sv += c.sv;
      l.n += c.n;
    } else c1m.push({ ...c, t: b });
  }
  return { c15: done, c1m, price, now, ageSec, ...extra };
}

// Exported for tests.
export const _internals = { sma, avgVol };
