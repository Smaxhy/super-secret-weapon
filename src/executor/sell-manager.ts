/**
 * Sell manager — watches every open position and executes the exit rules.
 *
 * Runs every 2 seconds. For each open position it reads the live state and
 * asks `decideExit()` (a pure function — easy to test) what to do. In order:
 *
 *   1. MIGRATED       curve completed but no PumpSwap market appeared in 10 min
 *   2. RUG_DETECTED   bundlers dumped / dev dumped / concentration spike while underwater
 *   3. COPY_EXIT      the tracked wallet we copied sold
 *   4. STOP_LOSS      hard −40%, or an early cut when risk is high and we're down 15%+
 *   5. TAKE_PROFIT    tiers (% of the original): 25% at 1.3× (de-risk), 15% at 5× (bonus off a big run)
 *   6. TAKE_PROFIT    "initials out" at 2×: sell exactly enough that all SOL received
 *                     so far covers all SOL paid (incl. fees). The rest is the RUNNER
 *                     (house money) — it can no longer lose us money.
 *   7. TRAILING_STOP  (trailingStopLevel — the dashboard draws the same line)
 *                     before initials: armed at 1.25×, 2.5 × volatility, between 10% and
 *                     20% (15% from a 2× peak, 10% from 3×; 20% until volatility is known).
 *                     runner: 3 × volatility, kept between 12% and 35%, capped at
 *                     30/25/20% after 3×/5×/10× peaks.
 *                     Volatility = robust (outlier-proof) spread of 15s returns over 4 min.
 *                     Peak = real-trade prices only, held for two checks (no single wick).
 *                     Once 1.5× was seen, the stop never sits below break-even + fees.
 *                     A break must be confirmed (2 checks and 3s under the stop) unless
 *                     it gapped >1.5× the trail distance below the peak → sell at once.
 *                     RUG_DETECTED also fires when the insider cluster dumps (insiderDumpSignal).
 *   8. Protect profit (before initials) once it reached 1.3×, never let it fall back below 1.05×
 *   9. TAKE_PROFIT    resistance: rejected 2+ times at the same ceiling while ≥1.2× → sell
 *                     (before initials only — the runner ignores it)
 *  10. TAKE_PROFIT    "risk rising": in profit (≥1.15×) and momentum is fading
 *                     (before initials only — the runner rides through wobbles)
 *  11. Max hold time  don't sit in a trade forever (45m curve / 2h migration / 90m copy;
 *                     the runner gets twice as long)
 *  12. STALE          price hasn't moved >5% for 30 min
 *
 * Positions are re-read from the database every tick, so a restart loses nothing.
 */
import type { ExitReason, Position, Prisma } from '@prisma/client';
import { DEFAULT_CONFIG, type BotConfigShape } from '../config/default';
import { deepMerge, getConfig, refreshConfig } from '../config/runtime-config';
import { getSolUsd } from '../lib/sol-price';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { explainSell } from '../learner/explain';
import { logTrade } from '../learner/trade-logger';
import { poolFeeBps, quoteSell } from '../lib/pumpfun';
import { settledHigh } from '../lib/settled-price';
import { deriveMetrics, type LiveState } from '../scanner/live-state';
import type { Redis } from 'ioredis';
import { PublicKey } from '@solana/web3.js';
import { decodeBondingCurveAccount } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';
import { copySoldKey } from '../scanner/whale-tracker';
import { insiderDumpSignal } from '../evaluator/insider-cluster';
import { coachFor } from '../learner/trade-coach';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { kolActivity } from '../scanner/kol-signal';
import { analyzeChart } from '../evaluator/chart-reader';
import type { Executor } from './types';

const log = moduleLogger('sell-manager');
/** Fallback check for every open position (quiet coins, stale/max-hold exits). */
const TICK_MS = 1_000;
/** Trade-driven checks: at most one per coin every this many ms (a burst of trades coalesces). */
const FAST_MIN_GAP_MS = 200;
/**
 * Wait this long after a trade before checking, so the rest of that slot's trades
 * (a sandwich's back-run, a bundle) are applied first — never act on a half-applied slot.
 */
const FAST_SETTLE_MS = 120;
/** Risk / resistance / volatility samples are kept at roughly this spacing. */
const SAMPLE_GAP_MS = 1_500;

export interface PositionUpdate {
  id: string;
  priceSol: number;
  /** Highest real trade price since the previous update (a spike between checks), if above priceSol. */
  highSol?: number;
  multiple: number;
  peakMultiple: number;
  unrealizedPnlSol: number;
  risk: number;
  holders: number;
  ownSupplyPct: number;
  exitImpactPct: number;
}
/** A price change smaller than this doesn't count as "movement" for the stale rule. */
const MOVE_THRESHOLD = 0.05;

export interface ExitInput {
  entryPriceSol: number;
  peakPriceSol: number;
  remainingPct: number;
  tpTiersHit: number[];
  trailingActive: boolean;
  refPriceSol: number;
  lastMoveAtMs: number;
  staleMinutes: number;
  priceSol: number;
  /** Curve completed, no PumpSwap pool seen for 10+ minutes — nowhere left to price it. */
  migratedNoMarket: boolean;
  bundlePctEntry: number;
  bundlePctNow: number;
  devHoldingPctEntry: number;
  devHoldingPctNow: number;
  top10PctEntry: number;
  top10PctNow: number;
  nowMs: number;
  /** The wallet this copy trade followed has sold. */
  copyWalletSold: boolean;
  /** 0-1 "this is turning" score from recent activity (see computeRisk). */
  risk: number;
  riskWhy: string;
  openedAtMs: number;
  maxHoldMinutes: number;
  /** Price keeps getting rejected at the same ceiling (see detectResistance). */
  resistance: { hit: boolean; level: number; touches: number };
  /** SOL we put into the position (no fees). */
  sizeSol: number;
  /** Everything the position cost us: size + the buy's fees. */
  costSol: number;
  /** SOL received so far from all sells, after their fees. */
  proceedsSol: number;
  /** Recent volatility in % (see computeVolatilityPct); null = not enough history yet. */
  volatilityPct: number | null;
  /** Fixed SOL cost of every sell transaction (network + priority fee + tip), on top of the % fees. */
  txFeeSol: number;
  /**
   * The price agrees with the last real trade (see priceTrusted). An untrusted
   * price can still trigger exits but never raises the peak. Default true.
   */
  priceTrusted?: boolean;
  /** Price at the previous check. A new peak only counts once two checks in a row were up there. */
  prevPriceSol?: number | null;
  /** Price has been under the trailing stop since this time (null = it isn't). */
  breachSinceMs?: number | null;
  /** How many checks in a row the price has been under the trailing stop. */
  breachTicks?: number;
  /** Insider / hidden dev wallets dumped (insiderDumpSignal) → immediate rug exit. */
  insiderDump?: { hit: boolean; detail: string } | null;
  /** Trade coach: points added to the stop-loss % (still clamped to the 10–20% band). */
  coachStopBiasPct?: number;
  /** Trade coach: trail width multiplier. */
  trailFactor?: number;
  /** Cost of selling now (fee + slippage + tx fees) in % — the stop-loss band is net of it. */
  exitCostPct?: number;
  /** Strategy (strategy-specific stop limits). */
  strategy?: string;
  /** Minimum hold (copy trades): until then only stop-loss, rug and profit-taking exits fire. */
  minHoldUntilMs?: number | null;
  /**
   * Live mode (sell manager): the peak follows real trades — `recentHighSol` is the
   * highest level the price HELD since the last check (settledHigh: sandwich spikes and
   * bad prints don't count). Without it (legacy / no trade log), a new high must hold
   * for two checks.
   */
  instantPeak?: boolean;
  recentHighSol?: number | null;
  /** KOLs that bought this coin are selling → bank it if we're in profit. */
  kolDump?: { hit: boolean; detail: string } | null;
  /** Chart-timed selling: sell into a blow-off top / bearish divergence (from the chart reader). */
  smartSell?: { blowOff: boolean; divergence: boolean; summary: string; minMultiple: number; blowOffSellPct: number; divergenceSellPct: number } | null;
  /** When the (settled) peak last rose — for the stall exit. Unknown → openedAtMs. */
  peakAtMs?: number | null;
  /** Seconds since the coin migrated to PumpSwap (null = still on the curve / unknown). */
  migratedAgoSec?: number | null;
  /**
   * A winner on a BIG coin that still trends up (see holdLongerNow): the max-hold and no-movement
   * exits are skipped — the trailing stop and break-even floor still protect it.
   */
  holdLonger?: boolean;
  /** % the price rose over the spike window (exit.spikeSell.windowSec): now vs the lowest real price in it. */
  spikeRisePct?: number | null;
}

/** Marker stored in `tpTiersHit` once initials are out (real tiers are all > 1). */
export const INITIALS_MARKER = -1;
/** Markers: the blow-off / divergence partial sells already happened (once each per position). */
export const BLOWOFF_MARKER = -2;
export const DIVERGENCE_MARKER = -3;
/** Marker: sold into pump.fun's BOOST buying right after migration (once). */
export const BOOST_MARKER = -4;
/** Marker: the spike sell already happened (once per position). */
export const SPIKE_MARKER = -5;

export interface ActivitySample {
  t: number;
  buys: number;
  sells: number;
  holders: number;
  priceSol: number;
  /** false = the price was far from the last real trade (suspicious) — ignored for volatility. */
  trusted?: boolean;
}

/**
 * Resistance: has the price touched the same high at least `minTouches`
 * separate times, falling back `rejectPct`% between touches, and is it below
 * that ceiling now? Pure — exported for tests.
 */
export function detectResistance(
  samples: ActivitySample[],
  now: number,
  r: { minTouches: number; bandPct: number; rejectPct: number; windowSec: number },
): { hit: boolean; level: number; touches: number } {
  const win = samples.filter((x) => now - x.t <= r.windowSec * 1000 && x.priceSol > 0);
  const cur = win[win.length - 1];
  if (!cur || win.length < 10) return { hit: false, level: 0, touches: 0 };
  const top = Math.max(...win.map((x) => x.priceSol));
  const bandLow = top * (1 - r.bandPct / 100);
  const rejectBelow = top * (1 - r.rejectPct / 100);
  let touches = 0;
  let inTouch = false;
  for (const x of win) {
    if (!inTouch && x.priceSol >= bandLow) {
      touches++;
      inTouch = true;
    } else if (inTouch && x.priceSol <= rejectBelow) {
      inTouch = false;
    }
  }
  return { hit: touches >= r.minTouches && cur.priceSol <= rejectBelow, level: top, touches };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * How likely the move is over, 0-1, from the last ~90 seconds of activity:
 * sells outnumbering buys, holders leaving, price falling from its peak and
 * over the window. Pure — exported for tests.
 */
export function computeRisk(samples: ActivitySample[], peakPriceSol: number, now: number, windowMs = 90_000): { risk: number; why: string } {
  const cur = samples[samples.length - 1];
  const old = samples.find((x) => now - x.t <= windowMs);
  if (!cur || !old || cur.t - old.t < windowMs / 2) return { risk: 0, why: 'not enough history' };
  const dB = cur.buys - old.buys;
  const dS = cur.sells - old.sells;
  const sellShare = dB + dS >= 4 ? dS / (dB + dS) : 0.5;
  const holderDelta = old.holders > 0 ? (cur.holders - old.holders) / old.holders : 0;
  const fromPeak = peakPriceSol > 0 ? 1 - cur.priceSol / peakPriceSol : 0;
  const windowMove = old.priceSol > 0 ? cur.priceSol / old.priceSol - 1 : 0;
  const parts = {
    sellPressure: clamp01((sellShare - 0.5) / 0.3),
    holdersLeaving: clamp01(-holderDelta / 0.1),
    offPeak: clamp01(fromPeak / 0.3),
    falling: clamp01(-windowMove / 0.2),
  };
  const risk = 0.35 * parts.sellPressure + 0.25 * parts.holdersLeaving + 0.2 * parts.offPeak + 0.2 * parts.falling;
  const why = `${Math.round(sellShare * 100)}% sells, holders ${holderDelta >= 0 ? '+' : ''}${(holderDelta * 100).toFixed(0)}%, ${(fromPeak * 100).toFixed(0)}% off peak`;
  return { risk, why };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * How choppy the price is, ATR-style: the typical size of a `stepMs` price
 * move over the last `windowMs`, in %. E.g. 5 means "it typically moves about
 * 5% every 15 seconds". Built to ignore noise and one-off bad prints:
 *  1. samples flagged `trusted: false` (price far from the last real trade) are dropped,
 *  2. a median-of-3 filter removes isolated single-sample spikes (wicks),
 *  3. the series is re-sampled on a fixed time grid (last price at each grid
 *     point — time-weighted, so a burst of ticks doesn't count extra),
 *  4. the spread of the step returns is a robust one: the trimmed mean absolute
 *     deviation from the median (largest 10% dropped) or the MAD, whichever is
 *     larger, both scaled to match a standard deviation.
 * Returns null when there isn't enough history (fewer than 4 steps). Pure — exported for tests.
 */
export function computeVolatilityPct(samples: ActivitySample[], now: number, windowMs = 240_000, stepMs = 15_000): number | null {
  const win = samples.filter((x) => now - x.t <= windowMs && x.t <= now && x.priceSol > 0 && x.trusted !== false);
  if (win.length < 2) return null;
  // Median-of-3: a lone spike (both neighbours disagree with it) is replaced by the middle value.
  const px = win.map((x, k) => (k === 0 || k === win.length - 1 ? x.priceSol : median([win[k - 1]!.priceSol, x.priceSol, win[k + 1]!.priceSol])));
  // Time grid from the first sample to the last one, one price per step, interpolated
  // (log-linear) between the samples either side, so uneven tick timing doesn't alias.
  const grid: number[] = [];
  let j = 0;
  for (let t = win[0]!.t; t <= win[win.length - 1]!.t; t += stepMs) {
    while (j + 1 < win.length && win[j + 1]!.t <= t) j++;
    const a = win[j]!;
    const b = win[j + 1];
    if (!b || b.t === a.t) grid.push(px[j]!);
    else grid.push(px[j]! * (px[j + 1]! / px[j]!) ** ((t - a.t) / (b.t - a.t)));
  }
  const returns: number[] = [];
  for (let k = 1; k < grid.length; k++) returns.push((grid[k]! / grid[k - 1]! - 1) * 100);
  if (returns.length < 4) return null;
  const med = median(returns);
  const dev = returns.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
  const trim = returns.length >= 6 ? Math.max(1, Math.floor(returns.length * 0.1)) : 0;
  const kept = dev.slice(0, dev.length - trim);
  const trimmedMeanAbs = kept.reduce((a, b) => a + b, 0) / kept.length;
  // 1.2533 / 1.4826 turn a mean absolute / median absolute deviation into a standard-deviation-sized number.
  return Math.max(1.2533 * trimmedMeanAbs, 1.4826 * median(dev));
}

/** Runner trailing stop %: volatility × multiplier, clamped, tighter after a huge peak. Pure. */
export function runnerTrailPct(volatilityPct: number | null, peakMultiple: number, r: BotConfigShape['exit']['runner']): number {
  let pct = volatilityPct === null ? r.fallbackTrailPct : r.volMultiplier * volatilityPct;
  pct = Math.max(r.minTrailPct, Math.min(r.maxTrailPct, pct));
  if (peakMultiple >= r.bigWinMultiple) pct = Math.min(pct, r.bigWinMaxTrailPct);
  return Math.round(pct * 10) / 10;
}

type ExitRules = BotConfigShape['exit'];
type TrailRules = ExitRules['trail'];

/** Trail settings, falling back to the defaults (a saved exit section from an older version has none). */
export function trailRules(rules: ExitRules): TrailRules {
  const t = (rules as Partial<ExitRules>).trail;
  return t ? { ...DEFAULT_CONFIG.exit.trail, ...t } : DEFAULT_CONFIG.exit.trail;
}

/** What the trailing stop needs to know about a position. */
export interface TrailParams {
  entryPriceSol: number;
  /** Highest confirmed real-trade price so far. */
  peakPriceSol: number;
  trailingActive: boolean;
  initialsOut: boolean;
  volatilityPct: number | null;
  /** Trade coach: widen (>1) or tighten (<1) the trail from what recent exits taught it. */
  trailFactor?: number;
  sizeSol: number;
  costSol: number;
  remainingPct: number;
  txFeeSol: number;
}

export interface TrailLevel {
  phase: 'pre' | 'runner';
  /** Trail distance below the peak, %. */
  trailPct: number;
  /** Where the trail alone would sit. */
  trailPriceSol: number;
  /** Break-even (incl. fees) floor, once the peak reached `breakEvenAfterMultiple`. */
  floorPriceSol: number | null;
  /** The effective stop: max(trail, floor). */
  stopPriceSol: number;
  /** At or below this, sell immediately without waiting for confirmation (a gap / dump). */
  gapPriceSol: number;
}

/**
 * Price multiple at which selling what's left gets back its share of the cost
 * plus fees (% fees + this sale's tx fee). Pure.
 */
export function breakEvenMultiple(t: Pick<TrailParams, 'sizeSol' | 'costSol' | 'remainingPct' | 'txFeeSol'>, feeBufferPct: number): number {
  if (!(t.sizeSol > 0)) return 1;
  const slice = (t.sizeSol * Math.max(t.remainingPct, 1)) / 100;
  return t.costSol / t.sizeSol / (1 - feeBufferPct / 100) + t.txFeeSol / slice;
}

/**
 * The trailing stop right now — the ONE place this is computed, used by
 * decideExit and by the dashboard chart (so the line drawn is exactly the one
 * we sell on). Returns null when no trailing stop is active. Pure.
 *  - before initials: vol-adaptive (pre.volMultiplier × vol), between pre.minTrailPct
 *    and the classic trailingStopPct/trailingTightening value (also the fallback);
 *  - runner: runnerTrailPct, capped tighter at 3x/5x/10x peaks (runnerProfitCaps);
 *  - both: never below break-even + fees once the peak reached 1.5x.
 */
/** Trail % for a peak multiple from the ladder (linear between points). null = no ladder. Pure. */
export function ladderTrailPct(peakX: number, ladder: ReadonlyArray<{ fromMultiple: number; pct: number }> | undefined): number | null {
  if (!ladder?.length) return null;
  const pts = [...ladder].sort((a, b) => a.fromMultiple - b.fromMultiple);
  if (peakX <= pts[0]!.fromMultiple) return pts[0]!.pct;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    if (peakX <= b.fromMultiple) return a.pct + ((b.pct - a.pct) * (peakX - a.fromMultiple)) / (b.fromMultiple - a.fromMultiple);
  }
  return pts[pts.length - 1]!.pct;
}

export function trailingStopLevel(t: TrailParams, rules: ExitRules): TrailLevel | null {
  if (!(t.entryPriceSol > 0) || !(t.peakPriceSol > 0)) return null;
  const tr = trailRules(rules);
  const peakX = t.peakPriceSol / t.entryPriceSol;
  let pct: number;
  const lad = ladderTrailPct(peakX, tr.ladder);
  if (lad !== null) {
    // Dynamic trail: the ladder sets it from the peak (tight on small moves, wide on big
    // ones); volatility nudges it within volAdjust (a calm chart tighter, a wild one wider).
    pct = lad;
    if (t.volatilityPct !== null && lad > 0) {
      const va = tr.volAdjust ?? { min: 0.8, max: 1.3 };
      pct = lad * Math.max(va.min, Math.min(va.max, (tr.pre.volMultiplier * t.volatilityPct) / lad));
    }
  } else if (t.initialsOut) {
    pct = runnerTrailPct(t.volatilityPct, peakX, rules.runner);
    for (const c of tr.runnerProfitCaps) if (peakX >= c.fromMultiple) pct = Math.min(pct, c.maxTrailPct);
  } else {
    const classic = rules.trailingTightening.reduce<number>((acc, x) => (peakX >= x.fromMultiple ? Math.min(acc, x.pct) : acc), rules.trailingStopPct);
    pct = t.volatilityPct === null ? classic : Math.max(Math.min(tr.pre.minTrailPct, classic), Math.min(classic, tr.pre.volMultiplier * t.volatilityPct));
  }
  if (t.trailFactor && t.trailFactor > 0) pct *= Math.max(0.75, Math.min(1.3, t.trailFactor));
  pct = Math.round(pct * 10) / 10;
  const trailOn = t.initialsOut || t.trailingActive || (lad !== null && peakX >= (tr.ladder?.[0]?.fromMultiple ?? Infinity));
  const floorOn = peakX >= tr.breakEvenAfterMultiple;
  if (!trailOn && !floorOn) return null;
  const trailPriceSol = t.peakPriceSol * (1 - pct / 100);
  const floorPriceSol = floorOn ? t.entryPriceSol * breakEvenMultiple(t, rules.initials.feeBufferPct) : null;
  const stopPriceSol = Math.max(trailOn ? trailPriceSol : 0, floorPriceSol ?? 0);
  const gapPriceSol = Math.max(0, t.peakPriceSol - tr.gapMultiple * (t.peakPriceSol - stopPriceSol));
  return { phase: t.initialsOut ? 'runner' : 'pre', trailPct: pct, trailPriceSol, floorPriceSol, stopPriceSol, gapPriceSol };
}

/**
 * Stop loss: always between `minPct` and `maxPct` below entry (owner's rule:
 * lose at least room for 10% noise, never more than 20%). Inside that band it
 * follows the coin's volatility (wild coin → nearer 20%, calm coin → nearer 10%)
 * plus the trade coach's bias. Below `maxPct` it sells at once; between the
 * stop and `maxPct` it needs a confirmed break like the trailing stop. Pure.
 */
export function stopLossLevel(
  entryPriceSol: number,
  volatilityPct: number | null,
  rules: ExitRules,
  coachBiasPct = 0,
  /** What selling costs right now (fee + slippage + tx fees, % of the position). The band is the
   *  loss AFTER these costs, so the price trigger sits that much higher. */
  exitCostPct = 0,
  /** Strategy-specific max (e.g. migration plays 15%). */
  strategy?: string,
): { stopPct: number; stopPriceSol: number; hardPct: number; hardPriceSol: number } {
  const sl = { ...DEFAULT_CONFIG.exit.stopLoss, ...((rules as Partial<ExitRules>).stopLoss ?? {}) };
  const byStrategy = strategy ? (sl.maxPctByStrategy as Record<string, number | undefined> | undefined)?.[strategy] : undefined;
  const minPct = (strategy ? (sl as { minPctByStrategy?: Record<string, number | undefined> }).minPctByStrategy?.[strategy] : undefined) ?? sl.minPct;
  const hardPct = Math.max(minPct, Math.min(sl.maxPct, byStrategy ?? sl.maxPct, rules.hardStopLossPct ?? sl.maxPct));
  const base = volatilityPct === null ? sl.fallbackPct : sl.volMultiplier * volatilityPct;
  const stopPct = Math.round(Math.max(minPct, Math.min(hardPct, base + coachBiasPct)) * 10) / 10;
  const cost = Math.max(0, Math.min(15, exitCostPct)) / 100;
  // Loss after costs → price multiple that produces it (never closer than 3% to entry).
  const priceAt = (lossPct: number) => entryPriceSol * Math.min(0.97, (1 - lossPct / 100) / (1 - cost));
  return { stopPct, stopPriceSol: priceAt(stopPct), hardPct, hardPriceSol: priceAt(hardPct) };
}

/**
 * How far the price rose within the spike window: now vs the lowest real trade price in it (trades
 * ≥ 0.02 SOL, pool price after each trade; only since `sinceMs`, so the dip we bought doesn't count).
 * null = no trades in the window. Pure.
 */
export function spikeRisePct(trades: ReadonlyArray<{ t: number; sol: number; px: number; pp?: number }>, priceNow: number, sinceMs: number): number | null {
  let lo = Infinity;
  for (const x of trades) {
    if (x.t < sinceMs || x.sol < 0.02) continue;
    const px = x.pp && x.pp > 0 ? x.pp : x.px;
    if (px > 0 && px < lo) lo = px;
  }
  return Number.isFinite(lo) && lo > 0 && priceNow > 0 ? Math.round((priceNow / lo - 1) * 1000) / 10 : null;
}

/** Cost of selling now in % of the position: pool fee + assumed slippage + buy & sell tx fees. Pure. */
export function exitCostPctFor(paper: BotConfigShape['paper'], onAmm: boolean, sizeLeftSol: number, marketCapSol: number | null = null): number {
  const fee = poolFeeBps(paper, onAmm, marketCapSol) / 100;
  return fee + paper.slippagePct + (sizeLeftSol > 0 ? ((paper.txFeeSol * 2) / sizeLeftSol) * 100 : 0);
}

export { settledHigh } from '../lib/settled-price';

/**
 * Should this price count toward the peak? Only if it agrees with the last real
 * trade's execution price (live-state's reference) within `tolerancePct`. No
 * reference yet → trusted. Pure.
 */
export function priceTrusted(priceSol: number, refPriceSol: number | null | undefined, tolerancePct: number): boolean {
  if (!(priceSol > 0)) return false;
  if (!refPriceSol || !(refPriceSol > 0)) return true;
  return Math.abs(priceSol / refPriceSol - 1) * 100 <= tolerancePct;
}

/**
 * Turn insiderDumpSignal()'s answer ({ dumping, reason }; a plain boolean or a
 * hit/detail object also work) into { hit, detail } for decideExit. Pure.
 */
export function normaliseInsiderSignal(sig: unknown): { hit: boolean; detail: string } | null {
  if (sig === null || sig === undefined) return null;
  if (typeof sig === 'boolean') return sig ? { hit: true, detail: 'insiders dumping' } : null;
  if (typeof sig !== 'object') return null;
  const o = sig as Record<string, unknown>;
  const hit = [o.dumping, o.hit, o.dumped, o.triggered].some((v) => v === true);
  if (!hit) return null;
  const detail = [o.reason, o.detail].find((v): v is string => typeof v === 'string' && v.length > 0);
  return { hit, detail: detail ?? 'insiders dumping' };
}

const strategyRulesCache = new WeakMap<object, Map<string, ExitRules>>();

/**
 * Exit rules for one strategy: the shared rules with `exit.byStrategy[strategy]` layered on top
 * (any field; arrays replace). Cached per config object. Pure.
 */
export function exitRulesFor(strategy: string | null | undefined, rules: ExitRules): ExitRules {
  const over = strategy ? ((rules as Partial<ExitRules>).byStrategy as Record<string, Record<string, unknown> | undefined> | undefined)?.[strategy] : undefined;
  if (!over || !Object.keys(over).length) return rules;
  let m = strategyRulesCache.get(rules);
  if (!m) strategyRulesCache.set(rules, (m = new Map()));
  let r = m.get(strategy!);
  if (!r) m.set(strategy!, (r = deepMerge(rules, over) as ExitRules));
  return r;
}

/**
 * "Allowed to hold bigger MC coins if it sees potential" (owner): profit is already banked
 * (initials out or a take-profit hit), the market cap is ≥ holdLonger.minMarketCapUsd, the chart
 * still trends up (uptrend, or a range of higher lows — not breaking down), the risk score is low,
 * and it's held less than holdLonger.maxHours. Pure.
 */
export function holdLongerNow(i: {
  rules: ExitRules;
  tpTiersHit: readonly number[];
  marketCapUsd: number | null;
  chart: { trend: string; higherLows: boolean; verdict: string } | null;
  risk: number;
  heldMs: number;
}): boolean {
  const hl = (i.rules as Partial<ExitRules>).holdLonger;
  if (!hl?.enabled || i.marketCapUsd === null || i.marketCapUsd < hl.minMarketCapUsd || i.heldMs >= hl.maxHours * 3600_000) return false;
  const banked = i.tpTiersHit.some((t) => t === INITIALS_MARKER || t === SPIKE_MARKER || t > 1);
  const up = !!i.chart && i.chart.verdict !== 'avoid' && (i.chart.trend === 'up' || (i.chart.trend === 'range' && i.chart.higherLows));
  return banked && up && i.risk < i.rules.riskExit.threshold;
}

export interface ExitDecision {
  /** Sells to execute now, each as % of the ORIGINAL position. */
  sells: Array<{ pct: number; reason: ExitReason; detail: string }>;
  state: {
    peakPriceSol: number;
    trailingActive: boolean;
    refPriceSol: number;
    lastMoveAtMs: number;
    tpTiersHit: number[];
    /** Unconfirmed trailing-stop break in progress (kept in memory by the sell manager). */
    breachSinceMs: number | null;
    breachTicks: number;
    /** When the peak last rose. */
    peakAtMs: number;
  };
}

export function decideExit(i: ExitInput, rules: BotConfigShape['exit']): ExitDecision {
  // Peak from real trades only: a suspicious price can't raise it. Live mode: the highest
  // level the price actually HELD since the last check (settledHigh — spike prints don't
  // count). Otherwise a new high must hold for two checks in a row (min of this and the previous price).
  const legacyPeak = i.priceTrusted === false ? 0 : i.prevPriceSol && i.prevPriceSol > 0 ? Math.min(i.priceSol, i.prevPriceSol) : i.priceSol;
  const peakCandidate = i.instantPeak && i.recentHighSol && i.recentHighSol > 0 ? i.recentHighSol : legacyPeak;
  const newPeak = Math.max(i.peakPriceSol, peakCandidate);
  const state: ExitDecision['state'] = {
    peakPriceSol: newPeak,
    trailingActive: i.trailingActive,
    refPriceSol: i.refPriceSol,
    lastMoveAtMs: i.lastMoveAtMs,
    tpTiersHit: [...i.tpTiersHit],
    breachSinceMs: null,
    breachTicks: 0,
    peakAtMs: newPeak > i.peakPriceSol * 1.0001 ? i.nowMs : (i.peakAtMs ?? i.openedAtMs),
  };
  const all = (reason: ExitReason, detail: string): ExitDecision => ({ sells: [{ pct: i.remainingPct, reason, detail }], state });
  const multiple = i.priceSol / i.entryPriceSol;

  if (i.migratedNoMarket) return all('MIGRATED', 'migrated, no PumpSwap pool found');

  if (i.bundlePctEntry - i.bundlePctNow >= rules.rugExit.bundleDumpPct) {
    return all('RUG_DETECTED', `bundlers dumped ${(i.bundlePctEntry - i.bundlePctNow).toFixed(1)}% of supply`);
  }

  if (i.insiderDump?.hit) return all('RUG_DETECTED', i.insiderDump.detail);

  if (i.devHoldingPctEntry > 0.1) {
    const devSoldPct = ((i.devHoldingPctEntry - i.devHoldingPctNow) / i.devHoldingPctEntry) * 100;
    if (devSoldPct >= rules.rugExit.devDumpPct) return all('RUG_DETECTED', `dev sold ${devSoldPct.toFixed(0)}% of their bag`);
  }
  if (multiple < 1 && i.top10PctNow - i.top10PctEntry >= rules.rugExit.holderConcentrationSpikePct) {
    return all('RUG_DETECTED', `top-10 concentration ${i.top10PctEntry.toFixed(1)}% → ${i.top10PctNow.toFixed(1)}%`);
  }

  // Minimum hold (copy trades): wobbles and the copied wallet selling don't shake us out early.
  const holding = !!i.minHoldUntilMs && i.nowMs < i.minHoldUntilMs;
  if (i.copyWalletSold && !holding) return all('COPY_EXIT', 'the wallet we copied sold');
  if (i.kolDump?.hit && multiple >= 1.05) return all('TAKE_PROFIT', `KOLs dumping: ${i.kolDump.detail} — banked ${multiple.toFixed(2)}x`);

  // Stop loss: 10–20% band (volatility + coach). Past the hard limit → out at once.
  const sl = stopLossLevel(i.entryPriceSol, i.volatilityPct, rules, i.coachStopBiasPct ?? 0, i.exitCostPct ?? 0, i.strategy);
  if (i.priceSol <= sl.hardPriceSol) return all('STOP_LOSS', `price ${((multiple - 1) * 100).toFixed(1)}% (hard limit −${sl.hardPct}% after fees)`);
  if (i.priceSol <= sl.stopPriceSol) {
    const tr = trailRules(rules);
    const slc = { ...DEFAULT_CONFIG.exit.stopLoss, ...((rules as Partial<ExitRules>).stopLoss ?? {}) };
    const needTicks = slc.confirmTicks ?? tr.confirmTicks;
    const needSec = slc.confirmSec ?? tr.confirmSec;
    const ticks = (i.breachTicks ?? 0) + 1;
    const since = i.breachSinceMs ?? i.nowMs;
    if (ticks >= needTicks && i.nowMs - since >= needSec * 1000) {
      return all('STOP_LOSS', `price ${((multiple - 1) * 100).toFixed(1)}% held under the −${sl.stopPct}% stop (after fees) for ${Math.round((i.nowMs - since) / 1000)}s`);
    }
    state.breachTicks = ticks;
    state.breachSinceMs = since;
  }
  // Don't wait for the stop when it's clearly turning against us.
  if (!holding && multiple <= rules.riskExit.cutLossBelowMultiple && i.risk >= rules.riskExit.threshold) {
    return all('STOP_LOSS', `early exit at ${((multiple - 1) * 100).toFixed(0)}%: ${i.riskWhy}`);
  }
  // Time stops — a fresh-coin trade that works, works fast (only before any profit was taken):
  //  no follow-through: held N minutes, never got going and not above entry → out at a small loss;
  //  stall: no new high for N minutes while still below the first take-profit → out.
  const ts = (rules as Partial<ExitRules>).timeStop;
  if (ts?.enabled && !holding && !i.tpTiersHit.length) {
    const mins = (i.strategy ? (ts.minutes as Record<string, number | undefined>)[i.strategy] : undefined) ?? ts.defaultMinutes;
    const heldMin = (i.nowMs - i.openedAtMs) / 60_000;
    const bestX = state.peakPriceSol / i.entryPriceSol;
    if (mins > 0 && heldMin >= mins && bestX < ts.minPeakMultiple && multiple <= ts.maxMultiple) {
      return all('STALE', `no follow-through: ${heldMin.toFixed(1)} min in, best ${bestX.toFixed(2)}x, now ${multiple.toFixed(2)}x`);
    }
    const stall = i.strategy ? (ts.stallMinutes as Record<string, number | undefined> | undefined)?.[i.strategy] : undefined;
    const tp1 = rules.takeProfitTiers[0]?.multiple ?? Infinity;
    const quietMin = (i.nowMs - state.peakAtMs) / 60_000;
    if (stall && stall > 0 && heldMin >= stall && quietMin >= stall && multiple < tp1) {
      return all(multiple >= 1 ? 'TAKE_PROFIT' : 'STALE', `stalled: no new high for ${quietMin.toFixed(1)} min (best ${bestX.toFixed(2)}x, now ${multiple.toFixed(2)}x)`);
    }
  }

  const sells: ExitDecision['sells'] = [];
  let remaining = i.remainingPct;
  // Bought on the curve and it graduated: pump.fun's BOOST buys for the first ~5 minutes after
  // migration — sell a slice into that demand before it stops (once).
  const bs = (rules as Partial<ExitRules>).boostSell;
  if (bs?.enabled && remaining > 0 && i.migratedAgoSec !== null && i.migratedAgoSec !== undefined && i.migratedAgoSec >= bs.fromSec && i.migratedAgoSec <= bs.toSec && (i.strategy === 'CURVE_SNIPE' || i.strategy === 'SOON') && !state.tpTiersHit.includes(BOOST_MARKER)) {
    const pct = Math.round(Math.min(remaining, (i.remainingPct * bs.sellPct) / 100) * 100) / 100;
    sells.push({ pct, reason: 'TAKE_PROFIT', detail: `graduated — sold ${bs.sellPct}% into the BOOST buying at ${multiple.toFixed(2)}x` });
    state.tpTiersHit.push(BOOST_MARKER);
    remaining -= pct;
  }
  // Rough SOL we'd get for selling `pct`% of the original position right now, after the
  // % fees (curve fee, slippage, price impact). The fixed per-sell tx fee is taken off separately.
  const valueOf = (pct: number) => ((i.sizeSol * pct) / 100) * multiple * (1 - rules.initials.feeBufferPct / 100);
  let proceeds = i.proceedsSol;
  for (const tier of rules.takeProfitTiers) {
    if (multiple >= tier.multiple && !state.tpTiersHit.includes(tier.multiple) && remaining > 0) {
      const pct = Math.min(tier.sellPct, remaining);
      sells.push({ pct, reason: 'TAKE_PROFIT', detail: `${tier.multiple}x tier` });
      state.tpTiersHit.push(tier.multiple);
      remaining -= pct;
      proceeds += valueOf(pct) - i.txFeeSol; // each sale also pays its own tx fee
    }
  }

  // Sell into a spike (swings): up ≥ risePct within the window → bank part of it right now (once).
  // It stands in for the next take-profit tier (sold earlier, into the spike), so the later tiers and
  // the trail still get what's left instead of the next tier selling it all.
  const sp = (rules as Partial<ExitRules>).spikeSell;
  if (sp?.enabled && remaining > 0 && i.spikeRisePct != null && i.spikeRisePct >= sp.risePct && multiple >= sp.minMultiple && !state.tpTiersHit.includes(SPIKE_MARKER)) {
    const pct = Math.round(remaining * (sp.sellPct / 100) * 100) / 100;
    sells.push({ pct, reason: 'TAKE_PROFIT', detail: `spike +${i.spikeRisePct.toFixed(1)}% in ${Math.round(sp.windowSec / 60)} min — sold ${sp.sellPct}% into it at ${multiple.toFixed(2)}x` });
    state.tpTiersHit.push(SPIKE_MARKER);
    const nextTier = rules.takeProfitTiers.find((t) => !state.tpTiersHit.includes(t.multiple));
    if (nextTier && nextTier.multiple > multiple) state.tpTiersHit.push(nextTier.multiple);
    remaining -= pct;
    proceeds += valueOf(pct) - i.txFeeSol;
  }

  // Sell into strength, not after the dump: a blow-off top (vertical run on a volume climax that is
  // being rejected) or a new high on weaker momentum → take a chunk off the table (once each).
  const ss = i.smartSell;
  if (ss && remaining > 0 && multiple >= ss.minMultiple) {
    if (ss.blowOff && !state.tpTiersHit.includes(BLOWOFF_MARKER)) {
      const pct = Math.round(remaining * (ss.blowOffSellPct / 100) * 100) / 100;
      sells.push({ pct, reason: 'TAKE_PROFIT', detail: `blow-off top at ${multiple.toFixed(2)}x (${ss.summary}) — sold ${ss.blowOffSellPct}% into the spike` });
      state.tpTiersHit.push(BLOWOFF_MARKER);
      remaining -= pct;
      proceeds += valueOf(pct) - i.txFeeSol;
    } else if (ss.divergence && !state.tpTiersHit.includes(DIVERGENCE_MARKER)) {
      const pct = Math.round(remaining * (ss.divergenceSellPct / 100) * 100) / 100;
      sells.push({ pct, reason: 'TAKE_PROFIT', detail: `momentum fading at ${multiple.toFixed(2)}x (new high, weaker RSI) — sold ${ss.divergenceSellPct}%` });
      state.tpTiersHit.push(DIVERGENCE_MARKER);
      remaining -= pct;
      proceeds += valueOf(pct) - i.txFeeSol;
    }
  }

  // Take initials: sell just enough to get back everything we paid → the rest is house money.
  let initialsOut = state.tpTiersHit.includes(INITIALS_MARKER);
  if (!initialsOut && multiple >= rules.initials.atMultiple && remaining > 0) {
    // + txFeeSol: the initials sale itself pays a tx fee, so it must earn that back too.
    const stillOwed = i.costSol - proceeds + i.txFeeSol;
    if (stillOwed > 0) {
      const perPct = valueOf(1);
      // Round UP to 0.01% so we never come up a hair short.
      const pct = Math.min(remaining, perPct > 0 ? Math.ceil((stillOwed / perPct) * 100) / 100 : remaining);
      sells.push({ pct, reason: 'TAKE_PROFIT', detail: `initials out at ${multiple.toFixed(2)}x (house money from here)` });
      remaining -= pct;
    }
    state.tpTiersHit.push(INITIALS_MARKER);
    initialsOut = true;
  }

  if (state.peakPriceSol >= i.entryPriceSol * rules.trailingStopActivateMultiple) state.trailingActive = true;
  const peakX = state.peakPriceSol / i.entryPriceSol;
  // Trailing stop (vol-adaptive, break-even floor after 1.5x). Only a CONFIRMED break sells:
  // under the stop for N checks and N seconds — or straight away if it gapped far below.
  const lvl = remaining > 0
    ? trailingStopLevel(
        { entryPriceSol: i.entryPriceSol, peakPriceSol: state.peakPriceSol, trailingActive: state.trailingActive, initialsOut, volatilityPct: i.volatilityPct, sizeSol: i.sizeSol, costSol: i.costSol, remainingPct: remaining, txFeeSol: i.txFeeSol, trailFactor: i.trailFactor },
        rules,
      )
    : null;
  if (lvl && i.priceSol <= lvl.stopPriceSol) {
    const tr = trailRules(rules);
    // (the stop-loss check above may already have counted this check as a breach)
    const ticks = state.breachTicks || (i.breachTicks ?? 0) + 1;
    const since = state.breachSinceMs ?? i.breachSinceMs ?? i.nowMs;
    const gapped = i.priceSol <= lvl.gapPriceSol;
    const confirmed = ticks >= tr.confirmTicks && i.nowMs - since >= tr.confirmSec * 1000;
    if (gapped || confirmed) {
      const onFloor = lvl.floorPriceSol !== null && lvl.floorPriceSol >= lvl.trailPriceSol;
      const vol = i.volatilityPct === null ? 'no vol data yet' : `vol ${i.volatilityPct.toFixed(1)}%`;
      const how = gapped ? 'gapped through the stop' : `held under the stop ${Math.round((i.nowMs - since) / 1000)}s`;
      const what = onFloor
        ? `break-even floor ${(lvl.floorPriceSol! / i.entryPriceSol).toFixed(2)}x after a ${peakX.toFixed(2)}x peak`
        : `${peakX.toFixed(2)}x peak, trail ${lvl.trailPct}% (${vol})`;
      sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `${lvl.phase === 'runner' ? 'runner: ' : ''}${what}, ${how}, at ${multiple.toFixed(2)}x` });
      return { sells, state };
    }
    state.breachTicks = ticks;
    state.breachSinceMs = since;
  }
  if (!initialsOut) {
    // Once it reached e.g. 1.3×, a winner must not turn into a loser.
    if (remaining > 0 && state.peakPriceSol >= i.entryPriceSol * rules.protectProfit.afterMultiple && multiple <= rules.protectProfit.floorMultiple) {
      sells.push({ pct: remaining, reason: 'TRAILING_STOP', detail: `protecting profit: peaked ${peakX.toFixed(2)}x, back to ${multiple.toFixed(2)}x` });
      return { sells, state };
    }

    // Keeps failing at the same ceiling → take what's there.
    if (!holding && remaining > 0 && i.resistance.hit && multiple >= rules.resistance.minProfitMultiple) {
      sells.push({ pct: remaining, reason: 'TAKE_PROFIT', detail: `resistance at ${(i.resistance.level / i.entryPriceSol).toFixed(2)}x (${i.resistance.touches} rejections), sold at ${multiple.toFixed(2)}x` });
      return { sells, state };
    }

    // In profit and momentum is fading → bank it instead of riding it back down.
    if (!holding && remaining > 0 && multiple >= rules.riskExit.minProfitMultiple && i.risk >= rules.riskExit.threshold) {
      sells.push({ pct: remaining, reason: 'TAKE_PROFIT', detail: `${multiple.toFixed(2)}x, risk rising: ${i.riskWhy}` });
      return { sells, state };
    }
  }

  // Don't hold forever (the runner gets longer to play out; a big coin still trending up rides on).
  const maxHold = initialsOut ? i.maxHoldMinutes * rules.runner.maxHoldMultiplier : i.maxHoldMinutes;
  if (holding) return { sells, state };
  if (i.holdLonger) {
    if (Math.abs(i.priceSol / state.refPriceSol - 1) > MOVE_THRESHOLD) {
      state.refPriceSol = i.priceSol;
      state.lastMoveAtMs = i.nowMs;
    }
    return { sells, state };
  }
  if (remaining > 0 && i.nowMs - i.openedAtMs >= maxHold * 60_000) {
    sells.push({ pct: remaining, reason: multiple >= 1 ? 'TAKE_PROFIT' : 'STALE', detail: `max hold ${maxHold}m reached at ${multiple.toFixed(2)}x` });
    return { sells, state };
  }

  if (Math.abs(i.priceSol / state.refPriceSol - 1) > MOVE_THRESHOLD) {
    state.refPriceSol = i.priceSol;
    state.lastMoveAtMs = i.nowMs;
  } else if (remaining > 0 && i.nowMs - state.lastMoveAtMs >= i.staleMinutes * 60_000) {
    sells.push({ pct: remaining, reason: 'STALE', detail: `no movement for ${i.staleMinutes}m` });
  }
  return { sells, state };
}

/**
 * One-off upgrade of the saved exit rules. `npm run db:seed` stored the OLD
 * exit section in the BotConfig table (30% at 1.3x, 40% at 1.8x, ...), and
 * stored values win over the defaults in code — so the new "take initials at
 * 2x + big runner" rules would never switch on. An old saved section is easy
 * to spot: it has no `initials` setting. If so, replace it with the new
 * defaults (exit rules can't be edited from the dashboard yet, so nothing the
 * owner chose is lost) and reload the config. Runs on every start, but only
 * ever changes something once.
 */
async function upgradeStoredExitRules(): Promise<void> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: 'exit' } });
    const stored = row?.value as Record<string, unknown> | null | undefined;
    if (!row || (stored && typeof stored === 'object' && 'initials' in stored)) return;
    await prisma.botConfig.update({ where: { key: 'exit' }, data: { value: DEFAULT_CONFIG.exit as unknown as Prisma.InputJsonValue } });
    await refreshConfig();
    log.warn('saved exit rules were from an older version — replaced with the new defaults (take initials at 2x + runner)');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not upgrade saved exit rules');
  }
}

/** Insider / hidden-dev wallets dumping (the rug agent's cluster signal). Never throws. */
async function readInsiderDump(redis: Redis, mint: string): Promise<{ hit: boolean; detail: string } | null> {
  try {
    return normaliseInsiderSignal(await insiderDumpSignal(redis, mint));
  } catch (err) {
    log.debug({ mint, err: (err as Error).message }, 'insider dump check failed');
    return null;
  }
}

export class SellManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly samples = new Map<string, ActivitySample[]>();
  private readonly lastPoll = new Map<string, number>();
  /** Per position: unconfirmed trailing-stop break + last measured volatility (memory only). */
  private readonly trail = new Map<string, { breachSinceMs: number | null; breachTicks: number; volatilityPct: number | null; peakAtMs?: number }>();
  /** Live per-trade log (set in index.ts): real trade prices between checks, so spikes register. */
  crowd: CrowdTracker | null = null;
  /** Coins we hold (refreshed every tick) — trades on these trigger an immediate check. */
  private readonly openMints = new Set<string>();
  private readonly fast = new Map<string, { running: boolean; again: boolean; last: number }>();
  private readonly manageLocks = new Map<string, Promise<unknown>>();
  private readonly lastCheck = new Map<string, number>();

  constructor(
    private readonly executor: Executor,
    private readonly liveState: LiveState,
    private readonly redis: Redis,
  ) {}

  start(): void {
    void upgradeStoredExitRules();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * A trade just happened on `mint` (wired from the token registry). If we hold it,
   * check the exits right away instead of waiting for the next tick — so a spike
   * to 2-3x and back within seconds still gets sold into. Bursts coalesce: at most
   * one check per coin every FAST_MIN_GAP_MS, plus one more if trades came in meanwhile.
   */
  onTrade(mint: string): void {
    if (!this.openMints.has(mint)) return;
    let s = this.fast.get(mint);
    if (!s) {
      s = { running: false, again: false, last: 0 };
      this.fast.set(mint, s);
    }
    if (s.running) {
      s.again = true;
      return;
    }
    void this.runFast(mint, s);
  }

  private async runFast(mint: string, s: { running: boolean; again: boolean; last: number }): Promise<void> {
    s.running = true;
    try {
      do {
        s.again = false;
        const wait = Math.max(FAST_SETTLE_MS, FAST_MIN_GAP_MS - (Date.now() - s.last));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        s.last = Date.now();
        const open = await prisma.position.findMany({ where: { mint, mode: this.executor.mode, status: 'OPEN' }, select: { id: true } });
        if (!open.length) {
          this.openMints.delete(mint);
          break;
        }
        const updates: PositionUpdate[] = [];
        for (const { id } of open) await this.managePosition(id, updates);
        if (updates.length) bus.publish({ type: 'positions', data: { updates } });
      } while (s.again);
    } catch (err) {
      log.warn({ mint, err: (err as Error).message }, 'trade-driven exit check failed');
    } finally {
      s.running = false;
    }
  }

  /** Check one position (fresh from the DB) — never two checks of the same position at once. */
  private async managePosition(id: string, out: PositionUpdate[], before?: (p: Position & { token: { symbol: string; bondingCurve: string } }) => Promise<void>): Promise<void> {
    const prev = this.manageLocks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const p = await prisma.position.findUnique({ where: { id }, include: { token: { select: { symbol: true, bondingCurve: true } } } });
      if (!p || p.status !== 'OPEN') return;
      if (before) await before(p);
      await this.manage(p, p.token.symbol, out);
    });
    const tail = run.catch(() => undefined);
    this.manageLocks.set(id, tail);
    try {
      await run;
    } catch (err) {
      log.error({ positionId: id, err: (err as Error).message }, 'failed to manage position');
    } finally {
      if (this.manageLocks.get(id) === tail) this.manageLocks.delete(id);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // previous tick still working
    this.running = true;
    try {
      const positions = await prisma.position.findMany({ where: { mode: this.executor.mode, status: 'OPEN' }, select: { id: true, mint: true } });
      const openIds = new Set(positions.map((x) => x.id));
      this.openMints.clear();
      for (const p of positions) this.openMints.add(p.mint);
      for (const id of this.samples.keys()) if (!openIds.has(id)) this.samples.delete(id);
      for (const id of this.trail.keys()) if (!openIds.has(id)) this.trail.delete(id);
      for (const id of this.lastCheck.keys()) if (!openIds.has(id)) this.lastCheck.delete(id);
      for (const m of this.fast.keys()) if (!this.openMints.has(m)) this.fast.delete(m);
      const updates: PositionUpdate[] = [];
      for (const p of positions) await this.managePosition(p.id, updates, (pos) => this.refreshIfStale(pos.mint, pos.token.bondingCurve));
      // Live prices for the dashboard's Positions page.
      if (updates.length) bus.publish({ type: 'positions', data: { updates } });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'sell manager tick failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Safety net: if the live stream hasn't updated a token we HOLD for 20s,
   * read its bonding curve straight from the chain (1 Helius credit, at most
   * every 15s per position) so exits never act on a frozen price.
   */
  private async refreshIfStale(mint: string, bondingCurve: string): Promise<void> {
    const view = await this.liveState.read(mint);
    if (!view || view.complete || !bondingCurve) return;
    const now = Date.now();
    if (now - (view.lastTradeAtMs ?? 0) < 20_000 || now - (this.lastPoll.get(mint) ?? 0) < 15_000) return;
    this.lastPoll.set(mint, now);
    try {
      const info = await getConnection().getAccountInfo(new PublicKey(bondingCurve), 'confirmed');
      const state = info ? decodeBondingCurveAccount(info.data) : null;
      if (state) await this.liveState.applyCurveState(mint, state);
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, 'curve poll failed');
    }
  }

  /** Latest measured volatility for a position (for the dashboard's trailing-stop line); null = not measured yet. */
  volatilityFor(positionId: string): number | null {
    return this.trail.get(positionId)?.volatilityPct ?? null;
  }

  /** Force-sell everything left in a position (manual sell / kill switch). */
  async closeNow(positionId: string, reason: ExitReason): Promise<void> {
    const p = await prisma.position.findUnique({ where: { id: positionId }, include: { token: { select: { symbol: true } } } });
    if (!p || p.status !== 'OPEN') return;
    // 'all' = whatever is left at the moment the sell actually runs (another sell may finish first).
    await this.executeSell(p, p.token.symbol, 'all', reason, 'forced');
  }

  /**
   * One sell at a time per position. A paper (or live) fill takes 0.4–1.2s to
   * land, so without this a manual "sell now" and the exit tick could both sell
   * the same tokens and BOTH get paid — double-counted proceeds, fake profit.
   */
  private readonly sellLocks = new Map<string, Promise<unknown>>();
  private async withSellLock<T>(positionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sellLocks.get(positionId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.sellLocks.set(positionId, tail);
    try {
      return await run;
    } finally {
      if (this.sellLocks.get(positionId) === tail) this.sellLocks.delete(positionId);
    }
  }

  private async manage(p: Position, symbol: string, out: PositionUpdate[]): Promise<void> {
    const cfg = getConfig();
    // Shared exit rules + this strategy's own (exit.byStrategy, e.g. SWING).
    const ex = exitRulesFor(p.strategy, cfg.exit);
    const view = await this.liveState.read(p.mint);
    if (!view) {
      log.warn({ mint: p.mint }, 'no live state for open position — closing as STALE at zero value');
      await this.writeOff(p);
      return;
    }
    const m = deriveMetrics(view);
    const entry = (p.entryContext ?? {}) as { devHoldingPct?: number; top10HolderPct?: number; earlyBuyerPct?: number };
    // Migrated but no PumpSwap trades seen 10 min later → we can't price it anymore.
    const completedLongAgo = view.complete && view.ammTrades === 0 && Date.now() - (view.migratedAtMs ?? view.lastTradeAtMs ?? 0) > 10 * 60_000;
    // Recent activity for the risk score (kept in memory, last ~3 minutes).
    const now = Date.now();
    const hist = this.samples.get(p.id) ?? [];
    const trusted = priceTrusted(m.priceSol, view.refPriceSol, trailRules(ex).peakRefTolerancePct);
    const prevPriceSol = [...hist].reverse().find((x) => x.trusted !== false)?.priceSol ?? null;
    // The peak = the highest level the price really HELD since the last check (≥ peakHoldMs),
    // so a sandwiched buy printing +20% for a few ms can't arm the trailing stop. The raw
    // highest print is still sent to the dashboard chart (spikes stay visible there).
    const since = Math.max(this.lastCheck.get(p.id) ?? 0, p.openedAt.getTime());
    this.lastCheck.set(p.id, now);
    const sane = Math.max(m.priceSol, view.refPriceSol ?? 0) * 2.5;
    const crowdTrades = this.crowd?.trades(p.mint) ?? [];
    const holdMs = trailRules(ex).peakHoldMs ?? 1_200;
    const recentHighSol = crowdTrades.length ? settledHigh(crowdTrades, Math.max(p.openedAt.getTime(), since - holdMs - 2_000), now, holdMs, sane) : null;
    const spikeHighSol = crowdTrades.reduce((mx, x) => (x.t > since && x.sol >= 0.02 && x.px > 0 && x.px <= sane ? Math.max(mx, x.px) : mx), 0) || null;
    // Samples for risk / resistance / volatility stay ~1.5s apart (checks can be 5×/s).
    const lastSample = hist[hist.length - 1];
    if (!lastSample || now - lastSample.t >= SAMPLE_GAP_MS) hist.push({ t: now, buys: view.buys, sells: view.sells, holders: m.holderCount, priceSol: m.priceSol, trusted });
    while (hist.length && now - hist[0]!.t > Math.max(180_000, ex.resistance.windowSec * 1000, ex.runner.volWindowSec * 1000)) hist.shift();
    this.samples.set(p.id, hist);
    const { risk, why } = computeRisk(hist, Math.max(p.peakPriceSol, m.priceSol), now);
    {
      const costLeft = (p.sizeSol * p.remainingPct) / 100;
      const multiple = m.priceSol / p.entryPriceSol;
      const feeBps = poolFeeBps(cfg.paper, !!view.ammBaseReserve, m.marketCapSol);
      // How much of the supply we hold, and how much our own sell would push the price down.
      const tokensLeft = (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n;
      const [rs, rt] = view.ammBaseReserve && view.ammQuoteReserve ? [view.ammQuoteReserve, view.ammBaseReserve] : [view.virtualSolReserves, view.virtualTokenReserves];
      const ideal = (Number(tokensLeft) / 1e6) * m.priceSol;
      const real = Number(quoteSell(tokensLeft, rs, rt, 0).solOutLamports) / 1e9;
      out.push({
        id: p.id,
        ...(spikeHighSol && spikeHighSol > m.priceSol ? { highSol: spikeHighSol } : {}),
        ownSupplyPct: (Number(tokensLeft) / Number(view.curve.totalSupply || 1n)) * 100,
        exitImpactPct: ideal > 0 ? (1 - real / ideal) * 100 : 0,
        priceSol: m.priceSol,
        multiple,
        peakMultiple: Math.max(p.peakPriceSol, recentHighSol ?? 0) / p.entryPriceSol,
        unrealizedPnlSol: costLeft * multiple * (1 - feeBps / 10_000) - costLeft,
        risk,
        holders: m.holderCount,
      });
    }
    const copied = (entry as { copiedWallet?: string | null }).copiedWallet;
    const copyWalletSold = !!copied && (await this.redis.exists(copySoldKey(p.mint, copied))) === 1;
    const insiderDump = await readInsiderDump(this.redis, p.mint);
    const kolAct = cfg.kol?.enabled ? await kolActivity(this.redis, p.mint, cfg.kol).catch(() => null) : null;
    // Chart-timed selling (blow-off top / bearish divergence).
    const cc = cfg.chart;
    const read = cc?.enabled && this.crowd ? analyzeChart(this.crowd.candles(p.mint), now, cc) : null;
    const chartSell = read && cc.smartSell.enabled && (read.blowOff || read.bearishDivergence)
      ? { blowOff: read.blowOff, divergence: read.bearishDivergence, summary: read.summary, minMultiple: cc.smartSell.minMultiple, blowOffSellPct: cc.smartSell.blowOffSellPct, divergenceSellPct: cc.smartSell.divergenceSellPct }
      : null;
    const kolDump = kolAct?.dumping ? { hit: true, detail: `${kolAct.recentSellers.map((s) => s.name).slice(0, 3).join(', ')} sold` } : null;
    const volatilityPct = computeVolatilityPct(hist, now, ex.runner.volWindowSec * 1000, ex.runner.volStepSec * 1000);
    const tr = this.trail.get(p.id) ?? { breachSinceMs: null, breachTicks: 0, volatilityPct: null };
    // Money in vs money out, for "take initials". realizedPnlSol already subtracts
    // the cost of every slice sold, so adding that cost back gives what we received.
    const costSol = p.sizeSol + Number((entry as { buyFeeSol?: number }).buyFeeSol ?? 0);
    const proceedsSol = p.realizedPnlSol + (costSol * (100 - p.remainingPct)) / 100;

    // What the trade coach learned from recent exits of this strategy.
    const coach = coachFor(p.strategy);
    const tiers = Array.isArray(p.tpTiersHit) ? (p.tpTiersHit as number[]).filter((n) => typeof n === 'number') : [];
    const solUsd = await getSolUsd().catch(() => null);
    // Selling costs (so the 10–20% stop band is the real loss after fees).
    const exitCostPct = exitCostPctFor(cfg.paper, !!view.ammBaseReserve, (p.sizeSol * p.remainingPct) / 100, m.marketCapSol);
    const decision = decideExit(
      {
        entryPriceSol: p.entryPriceSol,
        peakPriceSol: p.peakPriceSol,
        remainingPct: p.remainingPct,
        tpTiersHit: tiers,
        trailingActive: p.trailingActive,
        refPriceSol: p.refPriceSol ?? p.entryPriceSol,
        lastMoveAtMs: (p.lastMoveAt ?? p.openedAt).getTime(),
        staleMinutes: ex.staleMinutes[p.strategy],
        priceSol: m.priceSol,
        migratedNoMarket: completedLongAgo,
        // An adopted (bigger, older) coin's ledger only covers trades since we started following it, so
        // its holder / dev / bundle numbers can't flag a rug — the stop loss and insider exits still can.
        bundlePctEntry: view.adopted ? 0 : (entry.earlyBuyerPct ?? m.earlyBuyerPct),
        bundlePctNow: view.adopted ? 0 : m.earlyBuyerPct,
        devHoldingPctEntry: view.adopted ? 0 : (entry.devHoldingPct ?? 0),
        devHoldingPctNow: view.adopted ? 0 : m.devHoldingPct,
        top10PctEntry: view.adopted ? 0 : (entry.top10HolderPct ?? m.top10HolderPct),
        top10PctNow: view.adopted ? 0 : m.top10HolderPct,
        nowMs: now,
        copyWalletSold,
        risk,
        riskWhy: why,
        openedAtMs: p.openedAt.getTime(),
        maxHoldMinutes: ex.maxHoldMinutes[p.strategy],
        resistance: detectResistance(hist, now, ex.resistance),
        sizeSol: p.sizeSol,
        costSol,
        proceedsSol,
        volatilityPct,
        txFeeSol: cfg.paper.txFeeSol,
        priceTrusted: trusted,
        prevPriceSol,
        breachSinceMs: tr.breachSinceMs,
        breachTicks: tr.breachTicks,
        insiderDump,
        coachStopBiasPct: coach.stopBiasPct,
        trailFactor: coach.trailFactor,
        exitCostPct,
        strategy: p.strategy,
        minHoldUntilMs: p.strategy === 'SMART_MONEY_COPY' ? p.openedAt.getTime() + (cfg.copy.minHoldSec ?? 0) * 1000 : null,
        instantPeak: true,
        recentHighSol,
        kolDump,
        smartSell: chartSell,
        peakAtMs: tr.peakAtMs ?? null,
        migratedAgoSec: view.complete && view.migratedAtMs ? Math.max(0, (now - view.migratedAtMs) / 1000) : null,
        holdLonger: holdLongerNow({ rules: ex, tpTiersHit: tiers, marketCapUsd: solUsd ? m.marketCapSol * solUsd : null, chart: read, risk, heldMs: now - p.openedAt.getTime() }),
        spikeRisePct: ex.spikeSell?.enabled ? spikeRisePct(crowdTrades, m.priceSol, Math.max(p.openedAt.getTime(), now - ex.spikeSell.windowSec * 1000)) : null,
      },
      ex,
    );

    const s = decision.state;
    this.trail.set(p.id, { breachSinceMs: s.breachSinceMs, breachTicks: s.breachTicks, volatilityPct, peakAtMs: s.peakAtMs });
    await prisma.position.update({
      where: { id: p.id },
      data: { peakPriceSol: s.peakPriceSol, trailingActive: s.trailingActive, refPriceSol: s.refPriceSol, lastMoveAt: new Date(s.lastMoveAtMs), tpTiersHit: s.tpTiersHit },
    });

    let current: Position = { ...p, peakPriceSol: s.peakPriceSol };
    for (const sell of decision.sells) {
      const before = current.remainingPct;
      current = await this.executeSell(current, symbol, sell.pct, sell.reason, sell.detail);
      // Closed, or someone else sold in the meantime (our decision is stale) → stop.
      if (current.status !== 'OPEN' || current.remainingPct === before) break;
    }
  }

  /**
   * Sell `pct`% of the ORIGINAL position ('all' = everything left). Serialised per
   * position; re-reads the position first and skips if another sell changed it
   * since this one was decided, and the DB update only applies if nothing changed
   * in between (so proceeds are never counted twice). Returns the position after.
   */
  private async executeSell(p0: Position, symbol: string, pctIn: number | 'all', reason: ExitReason, detail: string): Promise<Position> {
    return this.withSellLock(p0.id, async () => {
      const fresh = await prisma.position.findUnique({ where: { id: p0.id } });
      if (!fresh || fresh.status !== 'OPEN' || fresh.remainingPct <= 0) return fresh ?? p0;
      if (pctIn !== 'all' && Math.abs(fresh.remainingPct - p0.remainingPct) > 1e-9) {
        log.warn({ positionId: p0.id, reason }, 'position changed by another sell while deciding — skipping this sell');
        return fresh;
      }
      const p: Position = { ...fresh, peakPriceSol: Math.max(fresh.peakPriceSol, p0.peakPriceSol) };
      const pct = pctIn === 'all' ? p.remainingPct : Math.min(pctIn, p.remainingPct);
      const closing = p.remainingPct - pct <= 0.01;
      // On the final sell, sell exactly what's left (avoids rounding dust).
      const tokens = closing
        ? (p.tokenAmountRaw * BigInt(Math.round(p.remainingPct * 100))) / 10_000n
        : (p.tokenAmountRaw * BigInt(Math.round(pct * 100))) / 10_000n;
      const fill = await this.executor.sell({ mint: p.mint, tokenAmountRaw: tokens, maxSlippageBps: 2_500 });
      // Cost = what we paid for this slice, including its share of the buy's gas/priority/tip.
      const buyFee = Number((p.entryContext as { buyFeeSol?: number } | null)?.buyFeeSol ?? 0);
      const costBasis = ((p.sizeSol + buyFee) * pct) / 100;
      const pnl = fill.ok ? fill.solAmount - fill.feeSol - costBasis : 0;

      return prisma.$transaction(async (tx) => {
        if (fill.ok) {
          // Only applies if the position is exactly as we read it (guards against any other writer).
          const upd = await tx.position.updateMany({
            where: { id: p.id, status: 'OPEN', remainingPct: p.remainingPct },
            data: {
              remainingPct: closing ? 0 : p.remainingPct - pct,
              realizedPnlSol: { increment: pnl },
              ...(closing ? { status: 'CLOSED' as const, closedAt: new Date(), exitReason: reason } : {}),
            },
          });
          if (upd.count === 0) {
            log.warn({ positionId: p.id, reason }, 'position changed during the sell — not counting it twice');
            return (await tx.position.findUnique({ where: { id: p.id } })) ?? p;
          }
        }
        await logTrade(
          {
            positionId: p.id,
            mint: p.mint,
            symbol,
            side: 'SELL',
            mode: p.mode,
            strategy: p.strategy,
            fill,
            reason: `${reason}: ${detail}`,
            context: {
              pct,
              costBasis,
              multiple: fill.priceSol / p.entryPriceSol,
              peakMultiple: p.peakPriceSol / p.entryPriceSol,
              explanation: explainSell({
                symbol,
                reason,
                detail,
                multiple: fill.priceSol / p.entryPriceSol,
                peakMultiple: p.peakPriceSol / p.entryPriceSol,
                pct,
                closing,
                heldMinutes: (Date.now() - p.openedAt.getTime()) / 60_000,
                pnlSol: pnl,
              }),
            },
            pnlSol: fill.ok ? pnl : undefined,
            peakMultiple: p.peakPriceSol / p.entryPriceSol,
            closed: fill.ok && closing,
            totalPnlSol: fill.ok ? p.realizedPnlSol + pnl : undefined,
          },
          tx,
        );
        if (!fill.ok) return p;
        if (closing && reason === 'RUG_DETECTED') await tx.token.update({ where: { mint: p.mint }, data: { status: 'RUGGED' } });
        return tx.position.findUniqueOrThrow({ where: { id: p.id } });
      });
    });
  }

  private async writeOff(p: Position): Promise<void> {
    await prisma.position.update({
      where: { id: p.id },
      data: { status: 'CLOSED', closedAt: new Date(), exitReason: 'STALE', remainingPct: 0, realizedPnlSol: { decrement: (p.sizeSol * p.remainingPct) / 100 } },
    });
  }
}
