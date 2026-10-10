/**
 * Price shape before a buy (owner: "recognise patterns, notice trends, the spikes it moves in — much
 * better entrances"). Measured on the 15 s candles of the last 10 minutes, so the AI coach and the
 * loss autopsy can tell WHERE in a move the bot bought: after a vertical run, on a pullback, into a
 * fading spike, in a steady trend.
 *
 *   run1m / run3m / run10m   % change over the last 1 / 3 / 10 min
 *   offHigh10m               % below the 10-min high (0 = buying the top)
 *   fromLow10m               % above the 10-min low
 *   spikes10m                15 s candles that rose ≥ 15% (pump legs)
 *   dumps10m                 15 s candles that fell ≥ 15%
 *   greenStreak              green candles in a row right now
 *   lastCandlePct            the current candle's move
 *   wickTopPct               upper wick of the last 4 candles vs their range (selling into the push)
 *   volAccel                 SOL traded in the last 2 min ÷ the 2 min before
 *   buyShare2m               buy SOL ÷ all SOL over 2 min (%)
 *   rangePct10m              10-min high ÷ low − 1 (%)
 * Pure.
 */
import type { Candle } from './chart-reader';

export interface PriceShape {
  run1m: number;
  run3m: number;
  run10m: number;
  offHigh10m: number;
  fromLow10m: number;
  spikes10m: number;
  dumps10m: number;
  greenStreak: number;
  lastCandlePct: number;
  wickTopPct: number;
  volAccel: number;
  buyShare2m: number;
  rangePct10m: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function priceShape(candles: readonly Candle[], now: number): PriceShape | null {
  const cs = candles.filter((c) => c.t <= now && now - c.t <= 10 * 60_000 && c.c > 0);
  if (cs.length < 4) return null;
  const last = cs[cs.length - 1]!;
  const px = last.c;
  const closeAt = (ago: number) => {
    const target = now - ago;
    let best = cs[0]!;
    for (const c of cs) if (c.t <= target) best = c;
    return best.c;
  };
  const high = Math.max(...cs.map((c) => c.h));
  const low = Math.min(...cs.map((c) => (c.l > 0 ? c.l : c.c)));
  let greenStreak = 0;
  for (let i = cs.length - 1; i >= 0 && cs[i]!.c > cs[i]!.o; i--) greenStreak++;
  const tail = cs.slice(-4);
  const tailRange = tail.reduce((s, c) => s + Math.max(0, c.h - c.l), 0);
  const tailWick = tail.reduce((s, c) => s + Math.max(0, c.h - Math.max(c.o, c.c)), 0);
  const vol = (from: number, to: number) => cs.filter((c) => now - c.t < from && now - c.t >= to).reduce((s, c) => s + c.v, 0);
  const v2 = vol(120_000, 0);
  const vPrev = vol(240_000, 120_000);
  const recent = cs.filter((c) => now - c.t < 120_000);
  const bv = recent.reduce((s, c) => s + c.bv, 0);
  const sv = recent.reduce((s, c) => s + c.sv, 0);
  const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);
  return {
    run1m: r1(pct(px, closeAt(60_000))),
    run3m: r1(pct(px, closeAt(180_000))),
    run10m: r1(pct(px, cs[0]!.o > 0 ? cs[0]!.o : cs[0]!.c)),
    offHigh10m: r1(high > 0 ? (1 - px / high) * 100 : 0),
    fromLow10m: r1(pct(px, low)),
    spikes10m: cs.filter((c) => c.o > 0 && c.c >= c.o * 1.15).length,
    dumps10m: cs.filter((c) => c.o > 0 && c.c <= c.o * 0.85).length,
    greenStreak,
    lastCandlePct: r1(pct(last.c, last.o)),
    wickTopPct: r1(tailRange > 0 ? (tailWick / tailRange) * 100 : 0),
    volAccel: r1(vPrev > 0 ? v2 / vPrev : v2 > 0 ? 3 : 1),
    buyShare2m: r1(bv + sv > 0 ? (bv / (bv + sv)) * 100 : 50),
    rangePct10m: r1(pct(high, low)),
  };
}

/** Pure: the path after the buy (from the position's price history) — was the entry early, late or on top? */
export function afterEntry(points: ReadonlyArray<{ t: number; priceSol: number }>, entryPriceSol: number, openedAtMs: number): { min1m: number; max5m: number; min5m: number; secToPeak: number | null; peak: number } | null {
  if (!points.length || !(entryPriceSol > 0)) return null;
  const m = (from: number, to: number, f: (a: number, b: number) => number, init: number) =>
    points.filter((p) => p.t >= openedAtMs + from && p.t <= openedAtMs + to).reduce((a, p) => f(a, p.priceSol / entryPriceSol), init);
  let peak = 0;
  let peakAt: number | null = null;
  for (const p of points) {
    const x = p.priceSol / entryPriceSol;
    if (x > peak) {
      peak = x;
      peakAt = p.t;
    }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    min1m: r2(m(0, 60_000, Math.min, 1)),
    max5m: r2(m(0, 300_000, Math.max, 1)),
    min5m: r2(m(0, 300_000, Math.min, 1)),
    secToPeak: peakAt !== null ? Math.round((peakAt - openedAtMs) / 1000) : null,
    peak: r2(peak),
  };
}

/**
 * Staircase (owner: "avoid odd-looking staircase charts"): a run of evenly sized green candles with
 * tiny wicks and almost no sellers — one or a few wallets laddering the price up so others buy, then
 * one red candle takes it all back. Real demand is messy (uneven candles, wicks, sellers, many wallets).
 *
 * Read on 1-minute candles (built from the 15 s ones) over the last 15 minutes + the trades behind them:
 *   ≥ 6 candles, ≥ 80% green, no red candle bigger than 3%, steady steps (CV of the green moves ≤ 0.6),
 *   small wicks (≤ 35% of the range on average), price up ≥ 25% over the run — AND the buying is narrow
 *   (top-3 wallets ≥ 50% of the buy SOL, or ≤ 12 different buyers) or almost nobody sells (≤ 15%).
 */
export interface Staircase {
  hit: boolean;
  candles: number;
  greenPct: number;
  stepCv: number | null;
  wickPct: number;
  runPct: number;
  top3BuyPct: number | null;
  buyers: number | null;
  sellPct: number | null;
  why: string;
}

export function staircase(candles: readonly Candle[], trades: ReadonlyArray<{ t: number; w: string; buy: boolean; sol: number }> | null, now: number): Staircase {
  const none = (why: string): Staircase => ({ hit: false, candles: 0, greenPct: 0, stepCv: null, wickPct: 0, runPct: 0, top3BuyPct: null, buyers: null, sellPct: null, why });
  // 15 s → 1 min candles over the last 15 minutes.
  const mins = new Map<number, Candle>();
  for (const c of candles) {
    if (c.t > now || now - c.t > 15 * 60_000 || !(c.c > 0)) continue;
    const k = Math.floor(c.t / 60_000) * 60_000;
    const m = mins.get(k);
    if (!m) mins.set(k, { ...c, t: k });
    else mins.set(k, { t: k, o: m.o, h: Math.max(m.h, c.h), l: Math.min(m.l, c.l), c: c.c, v: m.v + c.v, bv: m.bv + c.bv, sv: m.sv + c.sv, n: m.n + c.n });
  }
  const all = [...mins.values()].sort((a, b) => a.t - b.t);
  // The run = the latest stretch without a red candle bigger than 3%.
  let start = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i]!;
    if (c.o > 0 && c.c < c.o * 0.97) break;
    start = i;
  }
  const run = all.slice(start);
  if (run.length < 6) return none('no long one-way run');
  const green = run.filter((c) => c.c > c.o);
  const greenPct = Math.round((green.length / run.length) * 100);
  const steps = green.map((c) => c.c / c.o - 1);
  const mean = steps.reduce((a, b) => a + b, 0) / (steps.length || 1);
  const sd = Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / (steps.length || 1));
  const stepCv = mean > 0 ? Math.round((sd / mean) * 100) / 100 : null;
  const wickPct = Math.round((run.reduce((s, c) => {
    const range = c.h - c.l;
    return s + (range > 0 ? (range - Math.abs(c.c - c.o)) / range : 0);
  }, 0) / run.length) * 100);
  const runPct = Math.round((run[run.length - 1]!.c / run[0]!.o - 1) * 100);
  let top3BuyPct: number | null = null;
  let buyers: number | null = null;
  let sellPct: number | null = null;
  if (trades) {
    const tr = trades.filter((x) => x.t >= run[0]!.t && x.t <= now);
    const byW = new Map<string, number>();
    let buySol = 0;
    let sellSol = 0;
    for (const x of tr) {
      if (x.buy) {
        buySol += x.sol;
        byW.set(x.w, (byW.get(x.w) ?? 0) + x.sol);
      } else sellSol += x.sol;
    }
    buyers = byW.size;
    top3BuyPct = buySol > 0 ? Math.round(([...byW.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / buySol) * 100) : null;
    sellPct = buySol + sellSol > 0 ? Math.round((sellSol / (buySol + sellSol)) * 100) : null;
  }
  const shape = greenPct >= 80 && stepCv !== null && stepCv <= 0.6 && wickPct <= 35 && runPct >= 25;
  const narrow = (top3BuyPct !== null && top3BuyPct >= 50) || (buyers !== null && buyers <= 12) || (sellPct !== null && sellPct <= 15);
  const hit = shape && (trades === null || narrow);
  const who = top3BuyPct !== null && top3BuyPct >= 50 ? `3 wallets did ${top3BuyPct}% of the buying` : buyers !== null && buyers <= 12 ? `only ${buyers} buyers` : sellPct !== null ? `${sellPct}% sells` : 'no trade data';
  return {
    hit,
    candles: run.length,
    greenPct,
    stepCv,
    wickPct,
    runPct,
    top3BuyPct,
    buyers,
    sellPct,
    why: hit ? `staircase chart: ${run.length} even green candles (+${runPct}%), tiny wicks, ${who}` : 'no staircase',
  };
}
