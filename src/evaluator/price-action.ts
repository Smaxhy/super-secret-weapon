/**
 * Price action — reads the trade tape the way a trader reads a chart.
 *
 * Everything here is a pure function of the tape (recent trades) plus "now",
 * so it runs for free at every checkpoint and every sell-manager tick.
 *
 * From the raw trades we build candles, then derive:
 *   - trend:        log-price regression slope + R² (how clean the move is),
 *   - structure:    swing highs / lows → higher lows, lower highs, nearest
 *                   support below and resistance above the current price,
 *   - momentum:     net SOL flow now vs the window before (acceleration),
 *                   buy share of volume, % change over 1 and 3 minutes,
 *   - extension:    how far price sits above its own trend line (chasing risk),
 *   - participants: unique buyers, biggest buyer's share, wallets that flip
 *                   both ways (wash / bot churn), size uniformity (bundles),
 *   - a setup label and two composite scores: `strength` (healthy demand) and
 *     `manipulation` (bot-driven pump likelihood).
 *
 * Ported from the owner's "big update" (Oct 11) onto the current bot: the evaluator stores it as
 * `features.pa.*` (all learners see it) and checks `entry.priceAction`; the sell manager / virtual book
 * use it for the structure stop, momentum fade, whale-exit rug signal and chart-strength trailing.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';

/** One trade as this module reads it (time, side, SOL size, price after the trade, wallet). */
export interface TapeTrade {
  tsMs: number;
  isBuy: boolean;
  solAmount: number;
  priceSol: number;
  user: string;
}

/** Crowd-log trades → tape (pool price after each trade when known). */
export function tapeFromCrowd(trades: readonly CrowdTrade[], sinceMs: number): TapeTrade[] {
  const out: TapeTrade[] = [];
  for (const t of trades) {
    if (t.t < sinceMs) continue;
    const px = t.pp && t.pp > 0 ? t.pp : t.px;
    if (px > 0) out.push({ tsMs: t.t, isBuy: t.buy, solAmount: t.sol, priceSol: px, user: t.w });
  }
  return out;
}

export const CANDLE_MS = 15_000;
/** Recent-flow window (the "last minute") and the window before it. */
const FLOW_WINDOW_MS = 60_000;

export interface Candle {
  tMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyVolSol: number;
  sellVolSol: number;
  trades: number;
  buyers: number;
  sellers: number;
}

export type Setup =
  | 'THIN' // too few trades to say anything
  | 'BREAKOUT' // pushing through resistance / ATH with buyers behind it
  | 'PULLBACK' // uptrend, dipped towards support, buyers still net positive
  | 'GRIND' // steady uptrend, no drama
  | 'EXTENDED' // far above trend after a vertical move — top risk
  | 'CHOP' // no direction
  | 'DISTRIBUTION' // sellers taking over while price stalls
  | 'BREAKDOWN'; // lost support, lower highs, sellers in control

export interface PriceAction {
  tradesAnalyzed: number;
  /** Seconds of history covered by the tape. */
  spanSec: number;
  candles: Candle[];
  priceSol: number;

  trendSlopePctPerMin: number;
  trendR2: number;
  recentSlopePctPerMin: number;
  higherLows: number;
  lowerHighs: number;
  support: number | null;
  resistance: number | null;
  /** Most recent swing low / high by time (regardless of where price is now) — the structure stop watches these. */
  lastSwingLow: number | null;
  lastSwingHigh: number | null;
  /** % below the current price (positive). null when unknown. */
  supportDistPct: number | null;
  /** % above the current price (positive). null when no level above. */
  resistanceDistPct: number | null;

  athPriceSol: number;
  drawdownFromAthPct: number;
  change60Pct: number;
  change180Pct: number;
  /** Price vs regression line now, in %. Positive = above the trend line. */
  extensionPct: number;

  netFlowSol60: number;
  netFlowSol60Prev: number;
  /** −1..1: is the net flow improving (positive) or deteriorating? */
  flowAcceleration: number;
  /** Buy volume / total volume over the last 60s (0.5 = balanced). */
  buyVolShare60: number;
  volumeSol60: number;
  volumeSol60Prev: number;
  trades60: number;

  uniqueBuyers60: number;
  uniqueSellers60: number;
  topBuyerShare60: number;
  /** Wallets that both bought and sold within the window / unique traders. */
  churnRatio: number;
  /** Coefficient of variation of buy sizes (low = suspiciously uniform). */
  buySizeCv: number | null;
  largestSellSol60: number;

  setup: Setup;
  strength: number;
  manipulation: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number) => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);
const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);

export function buildCandles(tape: TapeTrade[], candleMs = CANDLE_MS): Candle[] {
  const out: Candle[] = [];
  let cur: (Candle & { buyerSet: Set<string>; sellerSet: Set<string> }) | null = null;
  for (const t of tape) {
    const bucket = Math.floor(t.tsMs / candleMs) * candleMs;
    if (!cur || cur.tMs !== bucket) {
      if (cur) out.push(finish(cur));
      cur = { tMs: bucket, open: t.priceSol, high: t.priceSol, low: t.priceSol, close: t.priceSol, buyVolSol: 0, sellVolSol: 0, trades: 0, buyers: 0, sellers: 0, buyerSet: new Set(), sellerSet: new Set() };
    }
    cur.high = Math.max(cur.high, t.priceSol);
    cur.low = Math.min(cur.low, t.priceSol);
    cur.close = t.priceSol;
    cur.trades++;
    if (t.isBuy) {
      cur.buyVolSol += t.solAmount;
      cur.buyerSet.add(t.user);
    } else {
      cur.sellVolSol += t.solAmount;
      cur.sellerSet.add(t.user);
    }
  }
  if (cur) out.push(finish(cur));
  return out;
}

function finish(c: Candle & { buyerSet: Set<string>; sellerSet: Set<string> }): Candle {
  const { buyerSet, sellerSet, ...rest } = c;
  return { ...rest, buyers: buyerSet.size, sellers: sellerSet.size };
}

/** Least-squares fit of log(price) against minutes. Returns slope in %/min and R². */
export function logTrend(points: Array<{ tMs: number; price: number }>): { slopePctPerMin: number; r2: number; predict: (tMs: number) => number } {
  const n = points.length;
  if (n < 2) return { slopePctPerMin: 0, r2: 0, predict: () => points[0]?.price ?? 0 };
  const t0 = points[0]!.tMs;
  const xs = points.map((p) => (p.tMs - t0) / 60_000);
  const ys = points.map((p) => Math.log(Math.max(p.price, 1e-18)));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx > 0 && syy > 0 ? clamp01((sxy * sxy) / (sxx * syy)) : 0;
  return {
    slopePctPerMin: (Math.exp(slope) - 1) * 100,
    r2,
    predict: (tMs: number) => Math.exp(intercept + slope * ((tMs - t0) / 60_000)),
  };
}

/** Swing points: a candle whose high (low) beats both neighbours. */
export function swings(candles: Candle[]): { highs: Array<{ tMs: number; price: number }>; lows: Array<{ tMs: number; price: number }> } {
  const highs: Array<{ tMs: number; price: number }> = [];
  const lows: Array<{ tMs: number; price: number }> = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1]!;
    const c = candles[i]!;
    const b = candles[i + 1]!;
    if (c.high >= a.high && c.high > b.high) highs.push({ tMs: c.tMs, price: c.high });
    if (c.low <= a.low && c.low < b.low) lows.push({ tMs: c.tMs, price: c.low });
  }
  return { highs, lows };
}

/** A swing high only counts as resistance if price fell at least this much (%) after it. */
const MIN_DEFENDED_PCT = 6;

/** How far (%) price dropped below a swing high afterwards. */
function retraceAfter(candles: Candle[], h: { tMs: number; price: number }): number {
  let low = h.price;
  for (const c of candles) if (c.tMs > h.tMs) low = Math.min(low, c.low);
  return (1 - low / h.price) * 100;
}

function countMonotone(seq: number[], up: boolean): number {
  let n = 0;
  for (let i = seq.length - 1; i > 0; i--) {
    const ok = up ? seq[i]! > seq[i - 1]! : seq[i]! < seq[i - 1]!;
    if (!ok) break;
    n++;
  }
  return n;
}

export function analyzePriceAction(tape: TapeTrade[], athPriceSol: number, nowMs = Date.now(), fallbackPriceSol = 0): PriceAction {
  const candles = buildCandles(tape);
  const last = tape[tape.length - 1];
  const priceSol = last?.priceSol ?? fallbackPriceSol;
  const ath = Math.max(athPriceSol, ...tape.map((t) => t.priceSol), priceSol);
  const spanSec = tape.length ? Math.max(0, (nowMs - tape[0]!.tsMs) / 1000) : 0;

  // --- flow windows -------------------------------------------------------
  const w1 = tape.filter((t) => t.tsMs > nowMs - FLOW_WINDOW_MS);
  const w2 = tape.filter((t) => t.tsMs <= nowMs - FLOW_WINDOW_MS && t.tsMs > nowMs - 2 * FLOW_WINDOW_MS);
  const flow = (ts: TapeTrade[]) => {
    let buy = 0;
    let sell = 0;
    for (const t of ts) if (t.isBuy) buy += t.solAmount; else sell += t.solAmount;
    return { buy, sell, net: buy - sell, total: buy + sell };
  };
  const f1 = flow(w1);
  const f2 = flow(w2);
  const flowAcceleration = f1.total + f2.total > 0 ? clamp((f1.net - f2.net) / (f1.total + f2.total), -1, 1) : 0;
  const buyVolShare60 = f1.total > 0 ? f1.buy / f1.total : 0.5;

  // --- participants --------------------------------------------------------
  const buyByWallet = new Map<string, number>();
  const sellers = new Set<string>();
  const buySizes: number[] = [];
  for (const t of w1) {
    if (t.isBuy) {
      buyByWallet.set(t.user, (buyByWallet.get(t.user) ?? 0) + t.solAmount);
      buySizes.push(t.solAmount);
    } else sellers.add(t.user);
  }
  const uniqueBuyers60 = buyByWallet.size;
  const topBuyerShare60 = f1.buy > 0 ? Math.max(0, ...buyByWallet.values()) / f1.buy : 0;
  let churn = 0;
  for (const w of buyByWallet.keys()) if (sellers.has(w)) churn++;
  const uniqueTraders = new Set([...buyByWallet.keys(), ...sellers]).size;
  const churnRatio = uniqueTraders > 0 ? churn / uniqueTraders : 0;
  let buySizeCv: number | null = null;
  if (buySizes.length >= 6) {
    const mean = buySizes.reduce((a, b) => a + b, 0) / buySizes.length;
    const sd = Math.sqrt(buySizes.reduce((s, x) => s + (x - mean) ** 2, 0) / buySizes.length);
    buySizeCv = mean > 0 ? sd / mean : null;
  }
  const largestSellSol60 = Math.max(0, ...w1.filter((t) => !t.isBuy).map((t) => t.solAmount));

  // --- price changes -------------------------------------------------------
  const priceAt = (agoMs: number): number | null => {
    const cutoff = nowMs - agoMs;
    let p: number | null = null;
    for (const t of tape) {
      if (t.tsMs <= cutoff) p = t.priceSol;
      else break;
    }
    // Before the tape starts? Use the first trade if it's not far off.
    if (p === null && tape.length && tape[0]!.tsMs - cutoff < CANDLE_MS) p = tape[0]!.priceSol;
    return p;
  };
  const p60 = priceAt(60_000);
  const p180 = priceAt(180_000);
  const change60Pct = p60 ? pct(priceSol, p60) : 0;
  const change180Pct = p180 ? pct(priceSol, p180) : 0;

  // --- trend & extension ---------------------------------------------------
  const trend = logTrend(candles.map((c) => ({ tMs: c.tMs + CANDLE_MS / 2, price: c.close })));
  const recentCandles = candles.filter((c) => c.tMs >= nowMs - 90_000);
  const recent = recentCandles.length >= 3 ? logTrend(recentCandles.map((c) => ({ tMs: c.tMs + CANDLE_MS / 2, price: c.close }))) : trend;
  const extensionPct = candles.length >= 4 ? pct(priceSol, trend.predict(nowMs)) : 0;

  // --- structure -----------------------------------------------------------
  const sw = swings(candles);
  const higherLows = countMonotone(sw.lows.map((l) => l.price), true);
  const lowerHighs = countMonotone(sw.highs.map((h) => h.price), false);
  const belowLows = sw.lows.filter((l) => l.price < priceSol * 0.995).map((l) => l.price);
  const support = belowLows.length ? Math.max(...belowLows) : null;
  // Resistance = a high sellers actually defended (price fell ≥ MIN_DEFENDED_PCT after it), not every
  // 15s wiggle inside an uptrend — those would block entries on the edge-vs-fees rule for no reason.
  const aboveHighs = sw.highs.filter((h) => h.price > priceSol * 1.005 && retraceAfter(candles, h) >= MIN_DEFENDED_PCT).map((h) => h.price);
  let resistance: number | null = aboveHighs.length ? Math.min(...aboveHighs) : null;
  // The ATH only counts as a level when price is clearly below it; within 5% we're in price discovery.
  if (resistance === null && ath > priceSol * 1.05) resistance = ath;

  const drawdownFromAthPct = ath > 0 ? Math.max(0, (1 - priceSol / ath) * 100) : 0;

  // --- composites ------------------------------------------------------------
  let manipulation = 0;
  if (topBuyerShare60 > 0.5 && uniqueBuyers60 >= 1) manipulation += 0.4 * clamp01((topBuyerShare60 - 0.5) / 0.3 + 0.5);
  if (churnRatio > 0.2) manipulation += 0.3 * clamp01((churnRatio - 0.2) / 0.3);
  if (uniqueTraders > 0 && w1.length / uniqueTraders > 3) manipulation += 0.2;
  if (buySizeCv !== null && buySizeCv < 0.15) manipulation += 0.3;
  manipulation = clamp01(manipulation);

  const strength = clamp01(
    0.25 * clamp01(trend.slopePctPerMin / 4) * (0.5 + 0.5 * trend.r2) +
      0.2 * clamp01(higherLows / 3) +
      0.2 * clamp01((buyVolShare60 - 0.45) / 0.35) +
      0.15 * clamp01((flowAcceleration + 0.3) / 0.8) +
      0.2 * clamp01(uniqueBuyers60 / 12),
  );

  const base: Omit<PriceAction, 'setup'> = {
    tradesAnalyzed: tape.length,
    spanSec,
    candles,
    priceSol,
    trendSlopePctPerMin: trend.slopePctPerMin,
    trendR2: trend.r2,
    recentSlopePctPerMin: recent.slopePctPerMin,
    higherLows,
    lowerHighs,
    support,
    resistance,
    lastSwingLow: sw.lows.length ? sw.lows[sw.lows.length - 1]!.price : null,
    lastSwingHigh: sw.highs.length ? sw.highs[sw.highs.length - 1]!.price : null,
    supportDistPct: support ? pct(priceSol, support) : null,
    resistanceDistPct: resistance ? pct(resistance, priceSol) : null,
    athPriceSol: ath,
    drawdownFromAthPct,
    change60Pct,
    change180Pct,
    extensionPct,
    netFlowSol60: f1.net,
    netFlowSol60Prev: f2.net,
    flowAcceleration,
    buyVolShare60,
    volumeSol60: f1.total,
    volumeSol60Prev: f2.total,
    trades60: w1.length,
    uniqueBuyers60,
    uniqueSellers60: sellers.size,
    topBuyerShare60,
    churnRatio,
    buySizeCv,
    largestSellSol60,
    strength,
    manipulation,
  };
  return { ...base, setup: classify(base) };
}

export function classify(p: Omit<PriceAction, 'setup'>): Setup {
  if (p.tradesAnalyzed < 8 || p.candles.length < 3) return 'THIN';
  const up = p.trendSlopePctPerMin > 0.5;
  const down = p.trendSlopePctPerMin < -0.5;
  const sellersInControl = p.buyVolShare60 < 0.42 && p.netFlowSol60 < 0;

  if (p.change60Pct > 35 && p.extensionPct > 20) return 'EXTENDED';
  if (p.extensionPct > 45) return 'EXTENDED';
  if ((p.support === null || p.priceSol < p.support) && p.lowerHighs >= 1 && (down || sellersInControl) && p.drawdownFromAthPct > 25) return 'BREAKDOWN';
  if (down && sellersInControl) return 'BREAKDOWN';
  if (sellersInControl && !up && p.drawdownFromAthPct > 10) return 'DISTRIBUTION';
  if (p.drawdownFromAthPct <= 3 && p.change60Pct > 5 && p.buyVolShare60 >= 0.55 && p.uniqueBuyers60 >= 3) return 'BREAKOUT';
  if (up && p.drawdownFromAthPct >= 8 && p.drawdownFromAthPct <= 35 && p.buyVolShare60 >= 0.5 && p.higherLows >= 1) return 'PULLBACK';
  if (up && p.trendR2 >= 0.5 && p.drawdownFromAthPct < 15) return 'GRIND';
  if (up && p.drawdownFromAthPct >= 8 && p.drawdownFromAthPct <= 35 && p.buyVolShare60 >= 0.5) return 'PULLBACK';
  return 'CHOP';
}

/** What a position should expect to pay to get in and out (curve fee twice + slippage twice), in %. */
export function roundTripCostPct(curveFeeBps: number, slippagePct: number): number {
  return (2 * curveFeeBps) / 100 + 2 * slippagePct;
}

/** Numeric features for the learners (setup as a code: THIN 0 … BREAKDOWN 7). */
export const SETUP_CODE: Record<Setup, number> = { THIN: 0, BREAKOUT: 1, PULLBACK: 2, GRIND: 3, EXTENDED: 4, CHOP: 5, DISTRIBUTION: 6, BREAKDOWN: 7 };
export function paFeatures(p: PriceAction): Record<string, number | null> {
  const r = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
  return {
    setup: SETUP_CODE[p.setup],
    trendSlope: r(p.trendSlopePctPerMin),
    trendR2: r(p.trendR2),
    recentSlope: r(p.recentSlopePctPerMin),
    higherLows: p.higherLows,
    lowerHighs: p.lowerHighs,
    supportDistPct: r(p.supportDistPct, 1),
    resistanceDistPct: r(p.resistanceDistPct, 1),
    offHighPct: r(p.drawdownFromAthPct, 1),
    change60Pct: r(p.change60Pct, 1),
    change180Pct: r(p.change180Pct, 1),
    extensionPct: r(p.extensionPct, 1),
    netFlow60: r(p.netFlowSol60),
    flowAccel: r(p.flowAcceleration),
    buyShare60: r(p.buyVolShare60),
    trades60: p.trades60,
    buyers60: p.uniqueBuyers60,
    topBuyerShare60: r(p.topBuyerShare60),
    churn: r(p.churnRatio),
    buySizeCv: r(p.buySizeCv),
    strength: r(p.strength),
    manipulation: r(p.manipulation),
  };
}

const cache = new Map<string, { at: number; n: number; pa: PriceAction }>();
/**
 * Price action for a coin from its crowd log (last `windowMin` minutes), cached per coin for `ttlMs`
 * (the sell manager + virtual book ask many times a second).
 */
export function priceActionFor(mint: string, trades: readonly CrowdTrade[], nowMs: number, windowMin = 15, ttlMs = 1_500): PriceAction | null {
  const c = cache.get(mint);
  if (c && nowMs - c.at < ttlMs && c.n === trades.length) return c.pa;
  const tape = tapeFromCrowd(trades, nowMs - windowMin * 60_000);
  if (tape.length < 3) return null;
  const pa = analyzePriceAction(tape, 0, nowMs);
  if (cache.size > 5_000) cache.clear();
  cache.set(mint, { at: nowMs, n: trades.length, pa });
  return pa;
}
