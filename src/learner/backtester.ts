/**
 * Backtester — replays a token's real trade tape through the entry rules, the
 * scorer and the sell manager exactly as the live bot would see them.
 *
 * The engine is pure: give it a tape + token facts + a policy, it returns the
 * simulated trade (or why it never entered). `runComparison()` runs several
 * policies over the same tapes so changes to the rules can be judged on
 * risk-adjusted numbers (P&L per SOL risked, win rate, drawdown, hold time)
 * before they go anywhere near real money.
 *
 * Approximations (documented so nobody mistakes this for truth):
 *   - Holder balances are rebuilt from SOL amount / price per trade (the tape
 *     has no token amounts), so holder/dev/top-10 figures are estimates.
 *   - Curve reserves are backed out of price via the constant product.
 *   - Fills happen at the tape price ± slippage + curve fee + tx fee.
 */
import type { ExitReason } from '@prisma/client';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS, type BotConfigShape, type Weights } from '../config/default';
import { STRATEGIES } from '../config/strategies';
import { marketFeatures, type MarketRaw } from '../evaluator/market-analyzer';
import { analyzePriceAction, roundTripCostPct, type PriceAction } from '../evaluator/price-action';
import { checkEntryRules, checkTimingRules, decide, isTimingReason, scoreFeatures, type FeatureVector } from '../evaluator/scorer';
import { NEUTRAL_WALLET_FEATURES, type WalletFeatures } from '../evaluator/wallet-analyzer';
import { decideExit, type PositionFlags } from '../executor/sell-manager';
import { bondingCurvePct, curveLiquiditySol, marketCapSol, type CurveParams } from '../lib/pumpfun';
import type { TapeTrade } from '../scanner/live-state';

export interface TokenMeta {
  mint: string;
  symbol: string;
  createdAtMs: number;
  creator: string;
  safetyScore: number;
  safetyHardFail: boolean;
  curve: CurveParams;
  solUsd: number;
  complete: boolean;
  /** Creator/funder features from the wallet analyzer, if the token got that far live. Neutral otherwise. */
  walletFeatures?: WalletFeatures;
}

export interface Policy {
  name: string;
  entry: BotConfigShape['entry'];
  exit: BotConfigShape['exit'];
  weights: Weights;
  threshold: number;
  checkpointsSec: readonly number[];
  recheckDelaysSec: readonly number[];
  /** Legacy mode: ignore the chart entirely (no chart/timing rules, static exits). */
  useChart: boolean;
  paper: BotConfigShape['paper'];
  sizeSol: number;
}

export interface SimTrade {
  mint: string;
  symbol: string;
  entered: true;
  entryAtSec: number;
  entryPriceSol: number;
  setup: string;
  score: number;
  sizeSol: number;
  pnlSol: number;
  peakMultiple: number;
  exitMultiple: number;
  heldSec: number;
  exitReason: ExitReason | 'END';
  sells: Array<{ atSec: number; pct: number; reason: string; multiple: number }>;
}

export interface SimSkip {
  mint: string;
  symbol: string;
  entered: false;
  /** Best score seen and the reasons at that checkpoint. */
  bestScore: number;
  reasons: string[];
  /** What the token did after our best-scoring look (peak multiple from the price at that look). */
  peakAfter: number;
}

export type SimResult = SimTrade | SimSkip;

const EARLY_WINDOW_MS = 1_000;
const EXIT_TICK_MS = 2_000;

/** Rebuild a MarketRaw from the tape up to `nowMs`. */
export function marketFromTape(tape: TapeTrade[], meta: TokenMeta, nowMs: number, prev: { atMs: number; curvePct: number } | null, ath: number): { raw: MarketRaw; pa: PriceAction } {
  const supplyTokens = Number(meta.curve.totalSupply) / 1e6 || 1e9;
  const balances = new Map<string, number>();
  const wallets = new Set<string>();
  const early = new Set<string>();
  let buys = 0;
  let sells = 0;
  let buyVol = 0;
  let sellVol = 0;
  let devBought = 0;
  let devSold = 0;
  for (const t of tape) {
    const tokens = t.priceSol > 0 ? t.solAmount / t.priceSol : 0;
    wallets.add(t.user);
    const bal = (balances.get(t.user) ?? 0) + (t.isBuy ? tokens : -tokens);
    if (bal > 1e-9) balances.set(t.user, bal);
    else balances.delete(t.user);
    if (t.isBuy) {
      buys++;
      buyVol += t.solAmount;
      if (t.user !== meta.creator && t.tsMs - meta.createdAtMs <= EARLY_WINDOW_MS) early.add(t.user);
    } else {
      sells++;
      sellVol += t.solAmount;
    }
    if (t.user === meta.creator) {
      if (t.isBuy) devBought += tokens;
      else devSold += tokens;
    }
  }
  const last = tape[tape.length - 1];
  const price = last?.priceSol ?? 0;
  // Back out reserves from price via the constant product k = vSol × vTok.
  const k = Number(meta.curve.initialVirtualSolReserves) * Number(meta.curve.initialVirtualTokenReserves);
  const pRaw = price * 1e3; // lamports per raw token unit
  const vTok = pRaw > 0 ? Math.sqrt(k / pRaw) : Number(meta.curve.initialVirtualTokenReserves);
  const vSol = k / vTok;
  const curvePct = meta.complete && nowMs >= (last?.tsMs ?? 0) ? 100 : Math.min(100, bondingCurvePct(BigInt(Math.round(vTok)), meta.curve));
  const ageSec = Math.max(1, (nowMs - meta.createdAtMs) / 1000);
  let curveVelocity = (curvePct / ageSec) * 60;
  if (prev && nowMs - prev.atMs >= 15_000) curveVelocity = ((curvePct - prev.curvePct) / ((nowMs - prev.atMs) / 1000)) * 60;

  const sorted = [...balances.values()].sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((s, b) => s + b, 0);
  const dev = balances.get(meta.creator) ?? 0;
  const earlyHeld = [...early].reduce((s, w) => s + (balances.get(w) ?? 0), 0);
  const pa = analyzePriceAction(tape, ath, nowMs, price);
  const volumeSol = buyVol + sellVol;
  const mc = marketCapSol(price, meta.curve.totalSupply);

  const raw: MarketRaw = {
    ageSec: Math.round(ageSec),
    holders: balances.size,
    uniqueWallets: wallets.size,
    buys,
    sells,
    buySellRatio: sells === 0 ? buys : buys / sells,
    volumeSol,
    liquiditySol: curveLiquiditySol(BigInt(Math.round(vSol)), meta.curve),
    bondingCurvePct: curvePct,
    curveVelocity,
    priceSol: price,
    marketCapSol: mc,
    devHoldingPct: (dev / supplyTokens) * 100,
    devSoldFraction: devBought > 0 ? Math.min(1, devSold / devBought) : 0,
    top10HolderPct: (top10 / supplyTokens) * 100,
    earlyBuyerPct: (earlyHeld / supplyTokens) * 100,
    retention: wallets.size ? balances.size / wallets.size : 0,
    complete: curvePct >= 100,
    totalFeesSol: volumeSol * 0.0125,
    volumeUsd: volumeSol * meta.solUsd,
    marketCapUsd: mc * meta.solUsd,
    setup: pa.setup,
    trendSlopePctPerMin: pa.trendSlopePctPerMin,
    trendR2: pa.trendR2,
    higherLows: pa.higherLows,
    lowerHighs: pa.lowerHighs,
    supportSol: pa.support,
    resistanceSol: pa.resistance,
    supportDistPct: pa.supportDistPct,
    resistanceDistPct: pa.resistanceDistPct,
    athPriceSol: pa.athPriceSol,
    drawdownFromAthPct: pa.drawdownFromAthPct,
    change60Pct: pa.change60Pct,
    change180Pct: pa.change180Pct,
    extensionPct: pa.extensionPct,
    buyVolShare60: pa.buyVolShare60,
    flowAcceleration: pa.flowAcceleration,
    uniqueBuyers60: pa.uniqueBuyers60,
    trades60: pa.trades60,
    topBuyerShare60: pa.topBuyerShare60,
    churnRatio: pa.churnRatio,
    manipulation: pa.manipulation,
    strength: pa.strength,
  };
  return { raw, pa };
}

/** Everything that happened up to and including `nowMs`. */
function prefix(tape: TapeTrade[], nowMs: number): TapeTrade[] {
  let hi = tape.length;
  // tape is sorted; binary search for the first trade after nowMs
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape[mid]!.tsMs <= nowMs) lo = mid + 1;
    else hi = mid;
  }
  return tape.slice(0, lo);
}

const athUpTo = (tape: TapeTrade[]) => tape.reduce((m, t) => Math.max(m, t.priceSol), 0);

/** Resolve which strategy best fits the token's current market state — mirrors the live evaluator. */
function resolveStrategy(market: { bondingCurvePct: number; complete: boolean; ageSec: number; strength: number }): import('../config/strategies').StrategyParams {
  if (market.complete) return STRATEGIES.MIGRATION_MOMENTUM;
  if (market.bondingCurvePct >= 60 && market.bondingCurvePct < 100) return STRATEGIES.SOON;
  if (market.bondingCurvePct >= 15 && market.ageSec > 180 && market.strength > 0.6) return STRATEGIES.RUNNER;
  if (market.ageSec > 600 && market.bondingCurvePct >= 20) return STRATEGIES.SWING;
  return STRATEGIES.CURVE_SNIPE;
}

export function simulateToken(tape: TapeTrade[], meta: TokenMeta, policy: Policy): SimResult {
  // Strategy is resolved dynamically per checkpoint based on market state (no more hardcoded CURVE_SNIPE)
  const cost = roundTripCostPct(policy.paper.curveFeeBps, policy.paper.slippagePct);
  // Mirror the evaluator's queue: fixed checkpoints, plus at most one chained
  // re-check at a time (re-check i fires delays[i] after the previous look).
  const lastCheckpoint = Math.max(...policy.checkpointsSec);
  const queue: Array<{ atMs: number; final: boolean; recheck?: number }> = policy.checkpointsSec.map((s) => ({ atMs: meta.createdAtMs + s * 1000, final: s === lastCheckpoint }));
  let prev: { atMs: number; curvePct: number } | null = null;
  let best: SimSkip = { mint: meta.mint, symbol: meta.symbol, entered: false, bestScore: 0, reasons: ['never evaluated'], peakAfter: 0 };
  let bestLook: { atMs: number; priceSol: number } | null = null;

  while (queue.length) {
    queue.sort((a, b) => a.atMs - b.atMs);
    const job = queue.shift()!;
    const now = job.atMs;
    const seen = prefix(tape, now);
    if (seen.length === 0) continue;
    const { raw } = marketFromTape(seen, meta, now, prev, athUpTo(seen));
    // Re-checks keep the checkpoint-to-checkpoint velocity baseline, like the evaluator.
    if (job.recheck === undefined) prev = { atMs: now, curvePct: raw.bondingCurvePct };
    if (raw.complete) break;

    const entryCfg = policy.useChart ? policy.entry : { ...policy.entry, maxDrawdownFromAthPct: 1e9, maxManipulation: 1e9 };
    const rawForRules = policy.useChart ? raw : { ...raw, setup: 'THIN' as const };
    const strategy = resolveStrategy(raw);
    const ruleFails = checkEntryRules({ safetyScore: meta.safetyScore, safetyHardFail: meta.safetyHardFail, market: rawForRules, strategy, entry: entryCfg });
    const timingFails = policy.useChart ? checkTimingRules(raw, policy.entry, cost) : [];
    const features: FeatureVector = { safety: meta.safetyScore / 100, ...marketFeatures(raw), ...(meta.walletFeatures ?? NEUTRAL_WALLET_FEATURES), patternPrior: 0.5 };
    if (!policy.useChart) Object.assign(features, { trend: 0.5, structure: 0.5, momentumQuality: 0.5, buyerQuality: 0.5 });
    const { score } = scoreFeatures(features, policy.weights);
    const { decision, reasons } = decide(score, policy.threshold, [...ruleFails, ...timingFails], meta.safetyHardFail);

    if (score > best.bestScore || !bestLook) {
      best = { ...best, bestScore: score, reasons };
      bestLook = { atMs: now, priceSol: raw.priceSol };
    }
    if (decision === 'REJECT') break;
    if (decision === 'BUY') return simulateExit(tape, meta, policy, now, raw, score);
    if (!job.final && reasons.length > 0 && reasons.every(isTimingReason)) {
      const next = (job.recheck ?? -1) + 1;
      const delay = policy.recheckDelaysSec[next];
      if (delay !== undefined) queue.push({ atMs: now + delay * 1000, final: false, recheck: next });
    }
  }
  if (bestLook && bestLook.priceSol > 0) {
    const after = tape.filter((t) => t.tsMs > bestLook!.atMs);
    best.peakAfter = after.length ? Math.max(...after.map((t) => t.priceSol)) / bestLook.priceSol : 0;
  }
  return best;
}

function simulateExit(tape: TapeTrade[], meta: TokenMeta, policy: Policy, entryMs: number, entryRaw: MarketRaw, score: number): SimTrade {
  const p = policy.paper;
  const feeFrac = p.curveFeeBps / 10_000;
  const slip = p.slippagePct / 100;
  const sizeSol = policy.sizeSol;
  // Buy: pay the curve fee, get slightly fewer tokens than the quote.
  const entryPrice = entryRaw.priceSol * (1 + slip) / (1 - feeFrac);
  const tokens = sizeSol / entryPrice;
  let cash = -sizeSol - p.txFeeSol;

  let remainingPct = 100;
  let peak = entryRaw.priceSol;
  let tiers: number[] = [];
  let trailing = false;
  let ref = entryRaw.priceSol;
  let lastMove = entryMs;
  let flags: PositionFlags = {};
  const sells: SimTrade['sells'] = [];
  let exitReason: ExitReason | 'END' = 'END';

  const sellPct = (pct: number, price: number, reason: ExitReason | 'END', atMs: number) => {
    const sold = Math.min(pct, remainingPct);
    const proceeds = tokens * (sold / 100) * price * (1 - slip) * (1 - feeFrac) - p.txFeeSol;
    cash += proceeds;
    remainingPct -= sold;
    sells.push({ atSec: Math.round((atMs - entryMs) / 1000), pct: sold, reason, multiple: price / entryRaw.priceSol });
    if (remainingPct <= 0.01) exitReason = reason;
  };

  const end = (tape[tape.length - 1]?.tsMs ?? entryMs) + 60_000;
  let t = entryMs + EXIT_TICK_MS;
  let lastIdx = 0;
  for (; t <= end && remainingPct > 0.01; t += EXIT_TICK_MS) {
    while (lastIdx < tape.length && tape[lastIdx]!.tsMs <= t) lastIdx++;
    const seen = tape.slice(0, lastIdx);
    if (seen.length === 0) continue;
    const { raw, pa } = marketFromTape(seen, meta, t, null, athUpTo(seen));
    const price = raw.priceSol;
    peak = Math.max(peak, price);
    const useChart = policy.useChart && seen.length > 0;
    const d = decideExit(
      {
        entryPriceSol: entryRaw.priceSol,
        peakPriceSol: peak,
        remainingPct,
        tpTiersHit: tiers,
        trailingActive: trailing,
        refPriceSol: ref,
        lastMoveAtMs: lastMove,
        staleMinutes: policy.exit.staleMinutes.CURVE_SNIPE,
        priceSol: price,
        complete: raw.complete || (meta.complete && lastIdx >= tape.length),
        devHoldingPctEntry: entryRaw.devHoldingPct,
        devHoldingPctNow: raw.devHoldingPct,
        top10PctEntry: entryRaw.top10HolderPct,
        top10PctNow: raw.top10HolderPct,
        nowMs: t,
        openedAtMs: useChart ? entryMs : undefined,
        timeStopMinutes: useChart ? policy.exit.timeStopMinutes.CURVE_SNIPE : undefined,
        liquiditySol: raw.liquiditySol,
        chart: useChart ? pa : null,
        flags,
      },
      policy.exit,
    );
    peak = d.state.peakPriceSol;
    tiers = d.state.tpTiersHit;
    trailing = d.state.trailingActive;
    ref = d.state.refPriceSol;
    lastMove = d.state.lastMoveAtMs;
    flags = d.state.flags;
    for (const s of d.sells) sellPct(s.pct, price, s.reason, t);
  }
  if (remainingPct > 0.01) {
    // Tape ended with the position open: mark to the last price.
    const price = tape[tape.length - 1]?.priceSol ?? entryRaw.priceSol;
    sellPct(remainingPct, price, 'END', t);
  }
  const lastSell = sells[sells.length - 1];
  return {
    mint: meta.mint,
    symbol: meta.symbol,
    entered: true,
    entryAtSec: Math.round((entryMs - meta.createdAtMs) / 1000),
    entryPriceSol: entryRaw.priceSol,
    setup: entryRaw.setup,
    score,
    sizeSol,
    pnlSol: cash,
    peakMultiple: peak / entryRaw.priceSol,
    exitMultiple: lastSell?.multiple ?? 1,
    heldSec: lastSell?.atSec ?? 0,
    exitReason,
    sells,
  };
}

export interface PolicyReport {
  policy: string;
  tokens: number;
  trades: number;
  wins: number;
  winRate: number | null;
  pnlSol: number;
  riskedSol: number;
  /** P&L per SOL risked — the headline risk-adjusted number. */
  returnOnRisk: number | null;
  avgPnlSol: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  profitFactor: number | null;
  maxDrawdownSol: number;
  avgHeldSec: number | null;
  avgPeakMultiple: number | null;
  /** Share of the peak we actually captured, on winners. */
  captureRatio: number | null;
  byExitReason: Array<{ reason: string; trades: number; pnlSol: number }>;
  bySetup: Array<{ setup: string; trades: number; winRate: number | null; pnlSol: number }>;
  /** Skipped tokens that went ≥ 2x after our last look. */
  missed: number;
  skipReasons: Array<{ reason: string; count: number }>;
}

export function summarisePolicy(name: string, results: SimResult[]): PolicyReport {
  const trades = results.filter((r): r is SimTrade => r.entered);
  const skips = results.filter((r): r is SimSkip => !r.entered);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    cum += t.pnlSol;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const group = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const risked = sum(trades.map((t) => t.sizeSol));
  const grossWin = sum(wins.map((t) => t.pnlSol));
  const grossLoss = -sum(losses.map((t) => t.pnlSol));
  const capture = wins.map((t) => (t.peakMultiple > 1 ? (t.exitMultiple - 1) / (t.peakMultiple - 1) : 1));
  return {
    policy: name,
    tokens: results.length,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    pnlSol: r4(cum),
    riskedSol: r4(risked),
    returnOnRisk: risked ? r4(cum / risked) : null,
    avgPnlSol: avg(trades.map((t) => t.pnlSol)) === null ? null : r4(avg(trades.map((t) => t.pnlSol))!),
    avgWinSol: wins.length ? r4(grossWin / wins.length) : null,
    avgLossSol: losses.length ? r4(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : wins.length ? Infinity : null,
    maxDrawdownSol: r4(dd),
    avgHeldSec: trades.length ? Math.round(avg(trades.map((t) => t.heldSec))!) : null,
    avgPeakMultiple: trades.length ? r2(avg(trades.map((t) => t.peakMultiple))!) : null,
    captureRatio: capture.length ? r2(avg(capture)!) : null,
    byExitReason: [...group(trades, (t) => t.exitReason).entries()].map(([reason, ts]) => ({ reason, trades: ts.length, pnlSol: r4(sum(ts.map((t) => t.pnlSol))) })).sort((a, b) => b.trades - a.trades),
    bySetup: [...group(trades, (t) => t.setup).entries()].map(([setup, ts]) => ({ setup, trades: ts.length, winRate: r2((ts.filter((t) => t.pnlSol > 0).length / ts.length) * 100), pnlSol: r4(sum(ts.map((t) => t.pnlSol))) })),
    missed: skips.filter((s) => s.peakAfter >= 2).length,
    skipReasons: [...group(skips, (s) => (s.reasons[0] ?? 'n/a').replace(/[\d.]+/g, '#')).entries()].map(([reason, xs]) => ({ reason, count: xs.length })).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

/** The bot's current rules. */
export function currentPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    name: 'current',
    entry: DEFAULT_CONFIG.entry,
    exit: DEFAULT_CONFIG.exit,
    weights: { ...DEFAULT_WEIGHTS },
    threshold: DEFAULT_CONFIG.entry.minCombinedScore,
    checkpointsSec: DEFAULT_CONFIG.scoring.checkpointsSec,
    recheckDelaysSec: DEFAULT_CONFIG.scoring.recheckDelaysSec,
    useChart: true,
    paper: DEFAULT_CONFIG.paper,
    sizeSol: DEFAULT_CONFIG.trading.maxPositionSol,
    ...overrides,
  };
}

/** The pre-upgrade rules: totals only, static exits. */
export function legacyPolicy(): Policy {
  const cur = currentPolicy();
  return {
    ...cur,
    name: 'legacy',
    useChart: false,
    recheckDelaysSec: [],
    exit: {
      ...cur.exit,
      breakEvenActivateMultiple: Number.POSITIVE_INFINITY,
      trailingStopPctStrong: cur.exit.trailingStopPct,
      trailingStopPctWeak: cur.exit.trailingStopPct,
      structureStop: { ...cur.exit.structureStop, minPeakMultiple: Number.POSITIVE_INFINITY },
      momentumFade: { ...cur.exit.momentumFade, minMultiple: Number.POSITIVE_INFINITY },
      rugExit: { ...cur.exit.rugExit, devAnySellMinHoldingPct: Number.POSITIVE_INFINITY, sellSpike: { sellSharePct: 101, dropPct: 1e9 }, singleSellLiquidityPct: 1e9 },
    },
  };
}

export function runComparison(tokens: Array<{ tape: TapeTrade[]; meta: TokenMeta }>, policies: Policy[]): { reports: PolicyReport[]; results: Map<string, SimResult[]> } {
  const results = new Map<string, SimResult[]>();
  for (const p of policies) results.set(p.name, tokens.map((t) => simulateToken(t.tape, t.meta, p)));
  return { reports: policies.map((p) => summarisePolicy(p.name, results.get(p.name)!)), results };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
