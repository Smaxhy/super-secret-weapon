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
  /** Curve % gained per minute (recent if we have a previous checkpoint, else since launch). */
  curveVelocity: number;
  priceSol: number;
  marketCapSol: number;
  devHoldingPct: number;
  devSoldFraction: number;
  top10HolderPct: number;
  earlyBuyerPct: number;
  /** Current holders / every wallet that ever traded. Low = lots of flipping. */
  retention: number;
  complete: boolean;
  totalFeesSol: number;
  /** USD values — null if the SOL price is unknown. */
  volumeUsd: number | null;
  marketCapUsd: number | null;
}

/** What we remember from the previous checkpoint, to measure recent momentum. */
export interface PrevCheckpoint {
  atMs: number;
  bondingCurvePct: number;
}

export type MarketFeatures = Pick<
  Record<FeatureName, number>,
  'holders' | 'buyPressure' | 'volume' | 'curveVelocity' | 'distribution' | 'devHolding' | 'devBehavior' | 'snipers' | 'retention'
>;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function analyzeMarket(
  view: LiveTokenView,
  prev: PrevCheckpoint | null,
  solUsd: number | null,
  now = Date.now(),
): { raw: MarketRaw; features: MarketFeatures } {
  const m = deriveMetrics(view);
  const ageSec = Math.max(1, (now - view.createdAtMs) / 1000);

  // Prefer momentum since the last checkpoint (needs ≥ 15s of history).
  let curveVelocity = (m.bondingCurvePct / ageSec) * 60;
  if (prev && now - prev.atMs >= 15_000) {
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
    retention: view.uniqueWallets > 0 ? m.holderCount / view.uniqueWallets : 0,
    complete: view.complete,
    totalFeesSol: view.feesSol,
    volumeUsd: solUsd ? m.volumeSol * solUsd : null,
    marketCapUsd: solUsd ? m.marketCapSol * solUsd : null,
  };

  return { raw, features: marketFeatures(raw) };
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
    // Sweet spot 2-8 %/min. Slower = no demand; much faster = usually a bot-driven pump.
    curveVelocity: velocityScore(r.curveVelocity),
    // Top 10 wallets ≤ 15% of supply = great, ≥ 50% = terrible.
    distribution: 1 - clamp01((r.top10HolderPct - 15) / 35),
    // Dev holding 0% = 1, 10%+ = 0.
    devHolding: 1 - clamp01(r.devHoldingPct / 10),
    // Dev dumping their bag is a classic exit signal.
    devBehavior: 1 - clamp01(r.devSoldFraction),
    // Snipers / bundles holding 20%+ of supply = 0.
    snipers: 1 - clamp01(r.earlyBuyerPct / 20),
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
