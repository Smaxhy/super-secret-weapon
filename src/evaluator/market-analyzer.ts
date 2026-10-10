/**
 * Market analyzer — "is real demand showing up for this token?"
 *
 * Works entirely from the live state in Redis (no RPC calls), so it's cheap
 * enough to run on every token at every checkpoint.
 *
 * Produces two things:
 *   - `raw`: the actual numbers (holders, ratios, %), stored with every
 *     evaluation for the dashboard and for ML training later.
 *   - `features`: each number squashed into 0-1 where 1 = good, ready for the scorer.
 */
import type { FeatureName } from '../config/default';
import { deriveMetrics, type LiveTokenView } from '../scanner/live-state';
import type { InsiderSummary } from './insider-cluster';

export interface MarketRaw {
  ageSec: number;
  holders: number;
  uniqueWallets: number;
  buys: number;
  sells: number;
  buySellRatio: number;
  volumeSol: number;
  liquiditySol: number;
  bondingCurvePct: number;
  /** Curve % gained per minute (recent if we have a previous checkpoint, else since launch). After migration: price % change per minute. */
  curveVelocity: number;
  priceSol: number;
  marketCapSol: number;
  devHoldingPct: number;
  devSoldFraction: number;
  top10HolderPct: number;
  earlyBuyerPct: number;
  /** Biggest single wallet (dev excluded), % of supply. */
  maxHolderPct: number;
  /** Volume per minute since the last checkpoint ÷ average per minute since launch (1 = normal). */
  volumeSpikeRatio: number;
  /** Current holders / every wallet that ever traded. Low = lots of flipping. */
  retention: number;
  complete: boolean;
  /** Trading on PumpSwap (migrated) rather than the bonding curve. */
  onAmm: boolean;
  /** Total fees traders paid, in SOL. Pump.fun fees only, until the fee estimator adds priority fees + tips. */
  totalFeesSol: number;
  /** USD values — null if the SOL price is unknown. */
  volumeUsd: number | null;
  marketCapUsd: number | null;
  /** Pool liquidity in USD (PumpSwap: both sides, like terminals show it; curve: SOL in the curve). */
  liquidityUsd: number | null;
  /** Real SOL in the bonding curve (market cap ≈ (30 + this)² ÷ 32.2 SOL). */
  curveSol?: number;
  /** Seconds since it migrated to PumpSwap (null = still on the curve). */
  migratedAgoSec?: number | null;
  /** Total supply is pump.fun's standard 1B (false = Mayhem mode / non-standard coin). */
  supplyStandard?: boolean;
  /**
   * Insider view (only after withInsider). The plain fields above stay as the
   * ledger sees them — the sell manager compares them with live values for rug exits.
   */
  hiddenDevPct?: number;
  /** Dev + hidden dev wallets, % of supply. */
  effectiveDevPct?: number;
  /** Every known insider wallet (bundles, bursts, transfers, funding clusters), % of supply. */
  insiderClusterPct?: number;
  /** max(early buyers, insider cluster). */
  effectiveBundlePct?: number;
  /** max(single wallet, biggest funding cluster). */
  effectiveMaxHolderPct?: number;
  insiderReasons?: string[];
}

/** What we remember from the previous checkpoint, to measure recent momentum. */
export interface PrevCheckpoint {
  atMs: number;
  bondingCurvePct: number;
  priceSol?: number;
  volumeSol?: number;
}

export type MarketFeatures = Pick<
  Record<FeatureName, number>,
  'holders' | 'buyPressure' | 'volume' | 'volumeSpike' | 'curveVelocity' | 'distribution' | 'devHolding' | 'devBehavior' | 'snipers' | 'retention'
>;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function analyzeMarket(
  view: LiveTokenView,
  prev: PrevCheckpoint | null,
  solUsd: number | null,
  now = Date.now(),
  extraFeePerTradeSol = 0,
): { raw: MarketRaw; features: MarketFeatures } {
  const m = deriveMetrics(view);
  const ageSec = Math.max(1, (now - view.createdAtMs) / 1000);

  // Prefer momentum since the last checkpoint (needs ≥ 15s of history).
  let curveVelocity = (m.bondingCurvePct / ageSec) * 60;
  if (view.complete) {
    // After migration the curve is full, so use price momentum instead: % price change per minute.
    curveVelocity = prev?.priceSol && now - prev.atMs >= 15_000 && m.priceSol > 0 ? ((m.priceSol / prev.priceSol - 1) * 100) / ((now - prev.atMs) / 60_000) : 0;
  } else if (prev && now - prev.atMs >= 15_000) {
    curveVelocity = ((m.bondingCurvePct - prev.bondingCurvePct) / ((now - prev.atMs) / 1000)) * 60;
  }

  const raw: MarketRaw = {
    ageSec: Math.round(ageSec),
    holders: m.holderCount,
    uniqueWallets: view.uniqueWallets,
    buys: view.buys,
    sells: view.sells,
    buySellRatio: m.buySellRatio,
    volumeSol: m.volumeSol,
    liquiditySol: m.liquiditySol,
    bondingCurvePct: m.bondingCurvePct,
    curveVelocity,
    priceSol: m.priceSol,
    marketCapSol: m.marketCapSol,
    devHoldingPct: m.devHoldingPct,
    devSoldFraction: m.devSoldFraction,
    top10HolderPct: m.top10HolderPct,
    earlyBuyerPct: m.earlyBuyerPct,
    maxHolderPct: m.maxHolderPct,
    volumeSpikeRatio:
      prev?.volumeSol !== undefined && now - prev.atMs >= 15_000 && m.volumeSol > 0
        ? ((m.volumeSol - prev.volumeSol) / ((now - prev.atMs) / 60_000)) / Math.max(1e-9, m.volumeSol / (ageSec / 60))
        : 1,
    retention: view.uniqueWallets > 0 ? m.holderCount / view.uniqueWallets : 0,
    complete: view.complete,
    onAmm: view.ammBaseReserve !== null && view.ammBaseReserve > 0n && view.ammTrades > 0,
    // Pump.fun/PumpSwap fees (exact) + assumed priority fees & tips per trade.
    totalFeesSol: view.feesSol + extraFeePerTradeSol * (view.buys + view.sells),
    volumeUsd: solUsd ? m.volumeSol * solUsd : null,
    marketCapUsd: solUsd ? m.marketCapSol * solUsd : null,
    liquidityUsd: solUsd ? (view.ammQuoteReserve !== null && view.ammBaseReserve !== null && view.ammBaseReserve > 0n ? 2 : 1) * m.liquiditySol * solUsd : null,
    curveSol: view.complete ? undefined : Math.max(0, (Number(view.virtualSolReserves) - Number(view.curve.initialVirtualSolReserves || 30_000_000_000n)) / 1e9),
    migratedAgoSec: view.complete && view.migratedAtMs ? Math.max(0, (now - view.migratedAtMs) / 1000) : null,
    supplyStandard: view.curve.totalSupply === 0n || view.curve.totalSupply === 1_000_000_000_000_000n,
  };

  return { raw, features: marketFeatures(raw) };
}

/**
 * Fold the insider analysis into the market numbers: adds the effective fields
 * and scores devHolding / snipers / distribution on them (so hidden wallets
 * count), without touching the plain ledger fields. Pure.
 */
export function withInsider(raw: MarketRaw, s: InsiderSummary | null | undefined): { raw: MarketRaw; features: MarketFeatures } {
  if (!s) return { raw, features: marketFeatures(raw) };
  const out: MarketRaw = {
    ...raw,
    hiddenDevPct: s.hiddenDevPct,
    effectiveDevPct: Math.max(raw.devHoldingPct, s.effectiveDevPct),
    insiderClusterPct: s.clusterPct,
    effectiveBundlePct: Math.max(raw.earlyBuyerPct, s.effectiveBundlePct),
    effectiveMaxHolderPct: Math.max(raw.maxHolderPct, s.effectiveMaxHolderPct),
    insiderReasons: s.reasons,
  };
  return { raw: out, features: marketFeatures(out) };
}

/** Normalise raw numbers to 0-1 scores. Pure — tuned by hand now, by the learner later. */
export function marketFeatures(r: MarketRaw): MarketFeatures {
  return {
    // 60+ holders = full marks.
    holders: clamp01(r.holders / 60),
    // Buy:sell count ratio of 1 = neutral (0), 4+ = strong (1).
    buyPressure: clamp01((r.buySellRatio - 1) / 3),
    // Log scale: 1 SOL ≈ 0.18, 10 SOL ≈ 0.61, 50 SOL = 1.
    volume: clamp01(Math.log10(1 + r.volumeSol) / Math.log10(51)),
    // Volume accelerating vs its own average: 1× = 0, 4×+ = 1.
    volumeSpike: clamp01((r.volumeSpikeRatio - 1) / 3),
    // Sweet spot 2-8 %/min. Slower = no demand; much faster = usually a bot-driven pump.
    curveVelocity: velocityScore(r.curveVelocity),
    // Top 10 wallets ≤ 15% of supply = great, ≥ 50% = terrible.
    // A funding cluster bigger than the top-10 share means even worse distribution.
    distribution: 1 - clamp01((Math.max(r.top10HolderPct, r.effectiveMaxHolderPct ?? 0) - 15) / 35),
    // Dev holding 0% = 1, 10%+ = 0 (hidden dev wallets included when known).
    devHolding: 1 - clamp01((r.effectiveDevPct ?? r.devHoldingPct) / 10),
    // Dev dumping their bag is a classic exit signal.
    devBehavior: 1 - clamp01(r.devSoldFraction),
    // Snipers / bundles holding 20%+ of supply = 0.
    snipers: 1 - clamp01((r.effectiveBundlePct ?? r.earlyBuyerPct) / 20),
    // ≥ 80% of traders still holding = 1, ≤ 30% = 0.
    retention: clamp01((r.retention - 0.3) / 0.5),
  };
}

function velocityScore(v: number): number {
  if (v <= 0) return 0;
  if (v < 2) return v / 2;
  if (v <= 8) return 1;
  return clamp01(1 - (v - 8) / 12);
}
