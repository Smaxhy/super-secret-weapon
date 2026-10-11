/**
 * Synthetic trade tapes for tests and scenario backtests.
 *
 * `makeTape()` turns a price path (SOL per token as a function of seconds since
 * launch) into a realistic-looking tape: buys dominate while price rises,
 * sells while it falls, sizes and wallets come from a seeded PRNG so every run
 * is identical. Prices follow the path exactly — good for price-action unit
 * tests, but volume, liquidity and holders don't match the price.
 *
 * `makeCurveTape()` is for scenario backtests: the path is only a *target*.
 * Trades move real constant-product reserves towards it, sellers can only sell
 * what they hold, and price comes out of the reserves — so curve %, liquidity,
 * market cap, fees and holder counts all agree, like on Pump.fun. That also
 * means price can't drop below launch (the curve's real SOL can't go negative)
 * and the curve completes at ~14.7x.
 */
import type { TapeTrade } from '../src/scanner/live-state';
import type { TokenMeta } from '../src/learner/backtester';
import { PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES, PUMP_DEFAULT_TOTAL_SUPPLY } from '../src/lib/pumpfun';

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

export const LAUNCH_PRICE = 30 / 1_073_000_000; // ≈ 2.8e-8 SOL per token
export const T0 = 1_700_000_000_000;

export interface TapeSpec {
  /** Price at t seconds after launch. */
  price: (tSec: number) => number;
  durationSec: number;
  /** Average seconds between trades. */
  tradeEverySec?: number;
  wallets?: number;
  avgSizeSol?: number;
  /** Probability a trade is a buy when price is rising / falling. */
  buyProbUp?: number;
  buyProbDown?: number;
  seed?: number;
  creator?: string;
  /** Dev buys this much at launch (SOL). */
  devBuySol?: number;
  /** Override the buy/sell side per trade (for wash-trading / whale scenarios). */
  side?: (tSec: number, r: number) => boolean | undefined;
  /** Override trade size (SOL). */
  size?: (tSec: number, r: number, isBuy: boolean) => number | undefined;
  /** Override the wallet. */
  wallet?: (tSec: number, r: number, isBuy: boolean) => string | undefined;
}

export function makeTape(spec: TapeSpec): TapeTrade[] {
  const r = rng(spec.seed ?? 42);
  const every = spec.tradeEverySec ?? 2;
  const pool = Array.from({ length: spec.wallets ?? 40 }, (_, i) => `W${i.toString().padStart(3, '0')}`);
  const creator = spec.creator ?? 'DEV';
  const tape: TapeTrade[] = [];
  if (spec.devBuySol) tape.push({ tsMs: T0, isBuy: true, solAmount: spec.devBuySol, priceSol: spec.price(0), user: creator });
  let t = 0.5;
  let prev = spec.price(0);
  while (t < spec.durationSec) {
    const price = spec.price(t);
    const rising = price >= prev;
    const rr = r();
    const forced = spec.side?.(t, rr);
    const isBuy = forced ?? rr < (rising ? spec.buyProbUp ?? 0.8 : spec.buyProbDown ?? 0.3);
    const sizeR = r();
    const size = spec.size?.(t, sizeR, isBuy) ?? Math.max(0.01, (spec.avgSizeSol ?? 0.4) * (0.3 + 1.4 * sizeR));
    const wR = r();
    const user = spec.wallet?.(t, wR, isBuy) ?? pool[Math.floor(wR * pool.length)]!;
    tape.push({ tsMs: T0 + Math.round(t * 1000), isBuy, solAmount: +size.toFixed(4), priceSol: price, user });
    prev = price;
    t += every * (0.5 + r());
  }
  return tape;
}

export function meta(overrides: Partial<TokenMeta> = {}): TokenMeta {
  return {
    mint: 'MINT',
    symbol: 'TEST',
    createdAtMs: T0,
    creator: 'DEV',
    safetyScore: 100,
    safetyHardFail: false,
    curve: {
      initialVirtualSolReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
      initialVirtualTokenReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
      initialRealTokenReserves: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
      totalSupply: PUMP_DEFAULT_TOTAL_SUPPLY,
    },
    solUsd: 200,
    complete: false,
    ...overrides,
  };
}

/** Piecewise-linear price path through (tSec, multipleOfLaunch) points. */
export function path(points: Array<[number, number]>, base = LAUNCH_PRICE): (t: number) => number {
  return (t) => {
    if (t <= points[0]![0]) return base * points[0]![1];
    for (let i = 1; i < points.length; i++) {
      const [t1, m1] = points[i]!;
      const [t0, m0] = points[i - 1]!;
      if (t <= t1) return base * (m0 + ((m1 - m0) * (t - t0)) / (t1 - t0));
    }
    return base * points[points.length - 1]![1];
  };
}

/** Add deterministic noise (±pct) to a path. */
export function noisy(f: (t: number) => number, pct: number, seed = 7): (t: number) => number {
  const r = rng(seed);
  const cache = new Map<number, number>();
  return (t) => {
    const k = Math.round(t * 10);
    if (!cache.has(k)) cache.set(k, 1 + (r() * 2 - 1) * (pct / 100));
    return f(t) * cache.get(k)!;
  };
}

const V_SOL0 = Number(PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES) / 1e9; // 30 SOL
const V_TOK0 = Number(PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES) / 1e6;
const CURVE_K = V_SOL0 * V_TOK0;
/** Virtual token reserves left when the curve completes (all real tokens sold). */
const V_TOK_DONE = V_TOK0 - Number(PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES) / 1e6;

export interface CurveTapeSpec extends Omit<TapeSpec, 'side' | 'buyProbUp' | 'buyProbDown'> {
  /** Probability a trade goes WITH the target (buy below it, sell above it). Default 0.8. */
  follow?: number;
}

/** Bonding-curve-consistent tape; see the file header. Stops when the curve completes. */
export function makeCurveTape(spec: CurveTapeSpec): { tape: TapeTrade[]; complete: boolean } {
  const r = rng(spec.seed ?? 42);
  const every = spec.tradeEverySec ?? 2;
  const avg = spec.avgSizeSol ?? 0.4;
  const follow = spec.follow ?? 0.8;
  const pool = Array.from({ length: spec.wallets ?? 40 }, (_, i) => `W${i.toString().padStart(3, '0')}`);
  const creator = spec.creator ?? 'DEV';
  const balances = new Map<string, number>(); // tokens held
  const tape: TapeTrade[] = [];
  let vSol = V_SOL0;

  const trade = (tSec: number, isBuy: boolean, sol: number, user: string): boolean => {
    if (isBuy) {
      vSol += sol;
      const vTok = CURVE_K / vSol;
      if (vTok <= V_TOK_DONE) return false; // curve complete
      balances.set(user, (balances.get(user) ?? 0) + (CURVE_K / (vSol - sol) - vTok));
    } else {
      const held = balances.get(user) ?? 0;
      const tokensOut = CURVE_K / vSol;
      // Can't take more SOL out than the wallet's tokens are worth, nor below the launch reserves.
      const maxSol = Math.min(vSol - CURVE_K / (tokensOut + held), vSol - V_SOL0 - 1e-6);
      sol = Math.min(sol, maxSol);
      if (sol <= 0.001) return true;
      const tokensIn = CURVE_K / (vSol - sol) - tokensOut;
      vSol -= sol;
      const left = held - tokensIn;
      if (left > 1) balances.set(user, left);
      else balances.delete(user);
    }
    tape.push({ tsMs: T0 + Math.round(tSec * 1000), isBuy, solAmount: +sol.toFixed(4), priceSol: (vSol * vSol) / CURVE_K, user });
    return true;
  };

  if (spec.devBuySol && !trade(0, true, spec.devBuySol, creator)) return { tape, complete: true };
  let t = 0.5;
  while (t < spec.durationSec) {
    // Target reserves for the target price: price = vSol² / k.
    const target = Math.max(V_SOL0, Math.sqrt(Math.max(spec.price(t), 0) * CURVE_K));
    const gap = target - vSol;
    const rr = r();
    const sizeR = r();
    const wR = r();
    const base = Math.max(0.01, avg * (0.3 + 1.4 * sizeR));
    // Close to target → two-way churn; away from it → most trades push towards it.
    const wantBuy = Math.abs(gap) < base ? rr < 0.55 : (gap > 0) === rr < follow;
    const towards = (gap > 0) === wantBuy;
    let size = towards ? Math.min(base + Math.abs(gap) * 0.35, base * 5) : base;
    size = spec.size?.(t, sizeR, wantBuy) ?? size;
    let user = spec.wallet?.(t, wR, wantBuy);
    if (!user) {
      if (wantBuy) user = pool[Math.floor(wR * pool.length)]!;
      else {
        const holders = [...balances.keys()].filter((w) => w !== creator);
        user = holders.length ? holders[Math.floor(wR * holders.length)]! : pool[0]!;
      }
    }
    if (!trade(t, wantBuy, size, user)) return { tape, complete: true };
    t += every * (0.5 + r());
  }
  return { tape, complete: false };
}

/** Launch-price multiple ↔ curve progress, for writing scenarios. */
export function curvePctAt(multiple: number): number {
  const vTok = Math.sqrt(CURVE_K / (multiple * LAUNCH_PRICE));
  return Math.max(0, Math.min(100, ((V_TOK0 - vTok) / (V_TOK0 - V_TOK_DONE)) * 100));
}
