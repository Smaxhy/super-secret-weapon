/**
 * Chart reader — looks at a coin's chart the way a trader would, so the bot
 * times its buys and sells instead of blasting in at the top.
 *
 * Input: 15-second candles built from every real trade (crowd tracker).
 * It reads:
 *   VWAP (10 min)      the "fair" price the crowd paid; far above it = stretched
 *   RSI (14)           momentum: >78 overbought, <30 oversold
 *   trend              fast vs slow EMA + higher lows / lower highs
 *   swings             pivot highs / lows (support / resistance)
 *   pullback / bounce  how far it dropped from the recent high, how far it bounced off the low
 *   blow-off top       vertical run on a volume climax that starts getting rejected
 *   bearish divergence a new high on weaker momentum (RSI lower than at the previous high)
 * and gives a verdict for entries:
 *   buy_now   healthy dip in an uptrend that is bouncing (the entry we want)
 *   wait_dip  stretched / overbought — don't chase, wait for the buy zone
 *   avoid     breaking down / downtrend under VWAP
 *   neutral   nothing special (or not enough chart yet)
 * All pure — exported for tests.
 */

export interface Candle {
  /** bucket start, ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** SOL traded */
  v: number;
  /** buy / sell SOL */
  bv: number;
  sv: number;
  /** trades */
  n: number;
}

export interface ChartConfig {
  minCandles: number;
  maxAboveVwapPct: number;
  overboughtRsi: number;
  maxRun2mPct: number;
  buyDip: { minPullbackPct: number; minBouncePct: number };
  dip: { minPullbackPct: number; maxPullbackPct: number };
}

export interface ChartRead {
  candles: number;
  price: number;
  vwap: number | null;
  vsVwapPct: number | null;
  rsi: number | null;
  trend: 'up' | 'down' | 'range' | 'unknown';
  higherLows: boolean;
  lowerHighs: boolean;
  recentHigh: number;
  lowSinceHigh: number;
  pullbackPct: number;
  bouncePct: number;
  run2mPct: number | null;
  support: number | null;
  blowOff: boolean;
  bearishDivergence: boolean;
  /** Last minute buy SOL ÷ sell SOL. */
  buyRatio1m: number | null;
  verdict: 'buy_now' | 'wait_dip' | 'avoid' | 'neutral';
  /** Price range to wait for (wait_dip). */
  zone: { lo: number; hi: number } | null;
  summary: string;
}

/** Add one trade to a 15s candle series (mutates; keeps at most `max` candles). */
export function addToCandles(candles: Candle[], t: number, px: number, sol: number, isBuy: boolean, stepMs = 15_000, max = 240): void {
  if (!(px > 0)) return;
  const b = Math.floor(t / stepMs) * stepMs;
  const last = candles[candles.length - 1];
  if (last && last.t === b) {
    last.h = Math.max(last.h, px);
    last.l = Math.min(last.l, px);
    last.c = px;
    last.v += sol;
    if (isBuy) last.bv += sol;
    else last.sv += sol;
    last.n++;
  } else if (!last || b > last.t) {
    candles.push({ t: b, o: last ? last.c : px, h: Math.max(px, last?.c ?? px), l: Math.min(px, last?.c ?? px), c: px, v: sol, bv: isBuy ? sol : 0, sv: isBuy ? 0 : sol, n: 1 });
    if (candles.length > max) candles.splice(0, candles.length - max);
  }
}

/** Merge candles into bigger ones (e.g. 15s → 30s or 1m). */
export function resample(candles: readonly Candle[], stepMs: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const b = Math.floor(c.t / stepMs) * stepMs;
    const last = out[out.length - 1];
    if (last && last.t === b) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
      last.bv += c.bv;
      last.sv += c.sv;
      last.n += c.n;
    } else out.push({ ...c, t: b });
  }
  return out;
}

/** Wilder's RSI over closes (null if too few). */
export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function ema(values: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1]! * (1 - k)));
  return out;
}

/** 3-bar pivot highs / lows (index + price). */
export function pivots(c: readonly Candle[]): { highs: Array<{ i: number; p: number }>; lows: Array<{ i: number; p: number }> } {
  const highs: Array<{ i: number; p: number }> = [];
  const lows: Array<{ i: number; p: number }> = [];
  for (let i = 1; i < c.length - 1; i++) {
    if (c[i]!.h >= c[i - 1]!.h && c[i]!.h > c[i + 1]!.h) highs.push({ i, p: c[i]!.h });
    if (c[i]!.l <= c[i - 1]!.l && c[i]!.l < c[i + 1]!.l) lows.push({ i, p: c[i]!.l });
  }
  return { highs, lows };
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function analyzeChart(c15: readonly Candle[], now: number, cfg: ChartConfig): ChartRead {
  const recent = c15.filter((c) => now - c.t <= 20 * 60_000);
  const price = recent[recent.length - 1]?.c ?? 0;
  const base: ChartRead = {
    candles: recent.length, price, vwap: null, vsVwapPct: null, rsi: null, trend: 'unknown', higherLows: false, lowerHighs: false,
    recentHigh: price, lowSinceHigh: price, pullbackPct: 0, bouncePct: 0, run2mPct: null, support: null, blowOff: false, bearishDivergence: false,
    buyRatio1m: null, verdict: 'neutral', zone: null, summary: 'not enough chart yet',
  };
  if (recent.length < cfg.minCandles || !(price > 0)) return base;

  // VWAP over the last 10 minutes.
  const last10 = recent.filter((c) => now - c.t <= 10 * 60_000);
  const vSum = last10.reduce((s, c) => s + c.v, 0);
  const vwap = vSum > 0 ? last10.reduce((s, c) => s + ((c.h + c.l + c.c) / 3) * c.v, 0) / vSum : null;
  const vsVwapPct = vwap ? (price / vwap - 1) * 100 : null;

  const c30 = resample(recent, 30_000);
  const closes = c30.map((c) => c.c);
  const r = rsi(closes);
  const fast = ema(closes, 6);
  const slow = ema(closes, 20);
  const f = fast[fast.length - 1]!;
  const s = slow[slow.length - 1]!;
  const fPrev = fast[Math.max(0, fast.length - 4)]!;
  const pv = pivots(c30);
  const lows = pv.lows.slice(-3);
  const highs = pv.highs.slice(-3);
  const higherLows = lows.length >= 2 && lows[lows.length - 1]!.p > lows[lows.length - 2]!.p;
  const lowerHighs = highs.length >= 2 && highs[highs.length - 1]!.p < highs[highs.length - 2]!.p;
  const trend: ChartRead['trend'] = f > s * 1.01 && f >= fPrev ? 'up' : f < s * 0.99 && f <= fPrev ? 'down' : 'range';

  // Pullback from the recent (10 min) high and bounce off the low since then.
  let hiIdx = 0;
  last10.forEach((c, i) => {
    if (c.h >= last10[hiIdx]!.h) hiIdx = i;
  });
  const recentHigh = last10[hiIdx]?.h ?? price;
  const lowSinceHigh = Math.min(...last10.slice(hiIdx).map((c) => c.l), price);
  const pullbackPct = recentHigh > 0 ? (1 - lowSinceHigh / recentHigh) * 100 : 0;
  const bouncePct = lowSinceHigh > 0 ? (price / lowSinceHigh - 1) * 100 : 0;
  // How much of the dip it has already won back (0 = at the low, 1 = back at the high).
  const recovered = recentHigh > lowSinceHigh ? (price - lowSinceHigh) / (recentHigh - lowSinceHigh) : 1;
  const twoMinAgo = [...recent].reverse().find((c) => now - c.t >= 2 * 60_000);
  const run2mPct = twoMinAgo ? (price / twoMinAgo.c - 1) * 100 : null;
  const support = lows.length ? Math.max(...lows.filter((l) => l.p < price).map((l) => l.p), 0) || null : null;

  // Blow-off: vertical run on a volume climax that starts getting rejected.
  const vols = last10.map((c) => c.v);
  const medVol = median(vols);
  const tail = recent.slice(-2);
  const climax = tail.some((c) => medVol > 0 && c.v >= 3 * medVol);
  const lastC = recent[recent.length - 1]!;
  const range = lastC.h - lastC.l;
  const upperWick = range > 0 ? (lastC.h - Math.max(lastC.o, lastC.c)) / range : 0;
  const rejected = upperWick >= 0.4 || price < Math.max(...tail.map((c) => c.h)) * 0.95;
  const blowOff = climax && rejected && (run2mPct ?? 0) >= 25 && (r ?? 0) >= 75 && (vsVwapPct ?? 0) >= 30;

  // Bearish divergence: the last two pivot highs rise but RSI at them falls.
  let bearishDivergence = false;
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2) as [{ i: number; p: number }, { i: number; p: number }];
    const r1 = rsi(closes.slice(0, h1.i + 1));
    const r2 = rsi(closes.slice(0, h2.i + 1));
    bearishDivergence = h2.p > h1.p && r1 !== null && r2 !== null && r2 < r1 - 8 && c30.length - 1 - h2.i <= 4;
  }

  const lastMin = recent.filter((c) => now - c.t <= 60_000);
  const b1 = lastMin.reduce((x, c) => x + c.bv, 0);
  const s1 = lastMin.reduce((x, c) => x + c.sv, 0);
  const buyRatio1m = b1 + s1 >= 0.2 ? (s1 > 0 ? b1 / s1 : 5) : null;

  const out: ChartRead = { ...base, vwap, vsVwapPct, rsi: r, trend, higherLows, lowerHighs, recentHigh, lowSinceHigh, pullbackPct, bouncePct, run2mPct, support, blowOff, bearishDivergence, buyRatio1m };

  const bits: string[] = [];
  bits.push(`${trend === 'up' ? 'uptrend' : trend === 'down' ? 'downtrend' : 'ranging'}${higherLows ? ', higher lows' : lowerHighs ? ', lower highs' : ''}`);
  if (vsVwapPct !== null) bits.push(`${vsVwapPct >= 0 ? '+' : ''}${vsVwapPct.toFixed(0)}% vs VWAP`);
  if (r !== null) bits.push(`RSI ${r.toFixed(0)}`);
  if (pullbackPct >= 5) bits.push(`pulled back ${pullbackPct.toFixed(0)}%${bouncePct >= 1 ? `, bounced ${bouncePct.toFixed(0)}%` : ''}`);

  // Breaking down: lost support outside an uptrend, or a downtrend under VWAP (lower highs, or a falling knife > 10% under it).
  const breakdown =
    (support !== null && price < support * 0.97 && trend !== 'up') ||
    (trend === 'down' && vwap !== null && price < vwap && (lowerHighs || (vsVwapPct ?? 0) < -10));
  const extended = (vsVwapPct ?? 0) > cfg.maxAboveVwapPct || (r ?? 0) > cfg.overboughtRsi || (run2mPct ?? 0) > cfg.maxRun2mPct;
  if (breakdown) {
    out.verdict = 'avoid';
    bits.push('breaking down');
  } else if (extended && (pullbackPct < cfg.buyDip.minPullbackPct || recovered > 0.6)) {
    out.verdict = 'wait_dip';
    // Buy zone: back toward VWAP / support, but at least `dip.minPullbackPct` off the high.
    const anchor = Math.max(vwap ?? 0, support ?? 0, recentHigh * (1 - cfg.dip.maxPullbackPct / 100));
    const hi = Math.min(recentHigh * (1 - cfg.dip.minPullbackPct / 100), anchor * 1.05);
    const lo = Math.max(recentHigh * (1 - cfg.dip.maxPullbackPct / 100), Math.min(anchor, hi) * 0.92);
    out.zone = { lo: Math.min(lo, hi), hi };
    bits.push('stretched — waiting for a dip');
  } else if (pullbackPct >= cfg.buyDip.minPullbackPct && bouncePct >= cfg.buyDip.minBouncePct && recovered <= 0.6 && (trend !== 'down' || higherLows) && (vwap === null || price >= vwap * 0.95)) {
    out.verdict = 'buy_now';
    bits.push('dip + bounce');
  }
  out.summary = bits.join(', ');
  return out;
}
