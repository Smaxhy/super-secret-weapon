/**
 * Market analyzer — "is real demand showing up for this token?"
 *
 * Works entirely from the live state in Redis (no RPC calls), so it's cheap
 * enough to run on every token at every checkpoint.
 *
 * Produces three things:
 *   - `raw`: the actual numbers (holders, ratios, %), stored with every
 *     evaluation for the dashboard and for ML training later.
 *   - `features`: each number squashed into 0-1 where 1 = good, ready for the scorer.
 *   - `priceAction`: the chart read (trend, structure, flow, participants) the
 *     entry rules and the sell manager use directly.
 */
import type { FeatureName } from '../config/default';
import { deriveMetrics, type LiveTokenView } from '../scanner/live-state';
import { analyzePriceAction, type PriceAction, type Setup } from './price-action';

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

  // ---- Price action summary (full detail lives in `priceAction`) ----
  setup: Setup;
  trendSlopePctPerMin: number;
  trendR2: number;
  higherLows: number;
  lowerHighs: number;
  supportSol: number | null;
  resistanceSol: number | null;
  supportDistPct: number | null;
  resistanceDistPct: number | null;
  athPriceSol: number;
  drawdownFromAthPct: number;
  change60Pct: number;
  change180Pct: number;
  extensionPct: number;
  buyVolShare60: number;
  flowAcceleration: number;
  uniqueBuyers60: number;
  trades60: number;
  topBuyerShare60: number;
  churnRatio: number;
  manipulation: number;
  strength: number;
}

/** What we remember from the previous checkpoint, to measure recent momentum. */
export interface PrevCheckpoint {
  atMs: number;
  bondingCurvePct: number;
}

export type MarketFeatures = Pick<
  Record<FeatureName, number>,
  'holders' | 'buyPressure' | 'volume' | 'curveVelocity' | 'distribution' | 'devHolding' | 'devBehavior' | 'snipers' | 'retention' | 'trend' | 'structure' | 'momentumQuality' | 'buyerQuality'
>;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function analyzeMarket(
  view: LiveTokenView,
  prev: PrevCheckpoint | null,
  solUsd: number | null,
  now = Date.now(),
): { raw: MarketRaw; features: MarketFeatures; priceAction: PriceAction } {
  const m = deriveMetrics(view);
  const ageSec = Math.max(1, (now - view.createdAtMs) / 1000);

  // Prefer momentum since the last checkpoint (needs ≥ 15s of history).
  let curveVelocity = (m.bondingCurvePct / ageSec) * 60;
  if (prev && now - prev.atMs >= 15_000) {
    curveVelocity = ((m.bondingCurvePct - prev.bondingCurvePct) / ((now - prev.atMs) / 1000)) * 60;
  }

  const pa = analyzePriceAction(view.tape, view.athPriceSol, now, m.priceSol);

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

  return { raw, features: marketFeatures(raw), priceAction: pa };
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
    ...priceActionFeatures(r),
  };
}

/** The chart features. Exported so the backtester can re-score stored evaluations. */
export function priceActionFeatures(r: Pick<MarketRaw, 'trendSlopePctPerMin' | 'trendR2' | 'higherLows' | 'lowerHighs' | 'drawdownFromAthPct' | 'supportDistPct' | 'extensionPct' | 'buyVolShare60' | 'flowAcceleration' | 'change60Pct' | 'uniqueBuyers60' | 'topBuyerShare60' | 'churnRatio' | 'manipulation' | 'trades60'>): Pick<MarketFeatures, 'trend' | 'structure' | 'momentumQuality' | 'buyerQuality'> {
  // No tape yet → neutral, don't punish or reward.
  if (r.trades60 === 0 && r.uniqueBuyers60 === 0 && r.trendR2 === 0) {
    return { trend: 0.5, structure: 0.5, momentumQuality: 0.5, buyerQuality: 0.5 };
  }
  // Trend: a clean climb of +3..+30 %/min is ideal — that's how fast a curve token has to move to reach
  // the buyable band at all. Flat = 0.3, down = 0. Steeper than 30 %/min tapers to 0.5, not 0: chasing a
  // vertical candle is the timing rules' job (EXTENDED / change60 / extension), not this feature's.
  // Noisy (low R²) trends count less.
  const slope = r.trendSlopePctPerMin;
  const trendBase = slope <= 0 ? clamp01(0.3 + slope / 10) : slope < 3 ? 0.3 + 0.7 * (slope / 3) : slope <= 30 ? 1 : Math.max(0.5, 1 - (slope - 30) / 60);
  const trend = clamp01(trendBase * (0.6 + 0.4 * r.trendR2));

  // Structure: higher lows and sitting near (not far below) the high; lower highs hurt.
  const hl = clamp01(r.higherLows / 3);
  const dd = 1 - clamp01((r.drawdownFromAthPct - 10) / 40);
  const lh = 1 - clamp01(r.lowerHighs / 3);
  const structure = clamp01(0.4 * hl + 0.35 * dd + 0.25 * lh);

  // Momentum quality: buyers in control, flow improving, NOT a vertical candle.
  const share = clamp01((r.buyVolShare60 - 0.4) / 0.4);
  const accel = clamp01((r.flowAcceleration + 0.5) / 1.0);
  const notChasing = 1 - clamp01((r.extensionPct - 10) / 30) * 0.7 - clamp01((r.change60Pct - 25) / 40) * 0.3;
  const momentumQuality = clamp01(0.4 * share + 0.25 * accel + 0.35 * clamp01(notChasing));

  // Buyer quality: many distinct buyers, nobody dominating, no wash churn, low manipulation score.
  const buyers = clamp01(r.uniqueBuyers60 / 12);
  const spread = 1 - clamp01((r.topBuyerShare60 - 0.25) / 0.5);
  const clean = 1 - clamp01(r.churnRatio / 0.4);
  const buyerQuality = clamp01((0.4 * buyers + 0.3 * spread + 0.3 * clean) * (1 - 0.5 * r.manipulation));

  return { trend, structure, momentumQuality, buyerQuality };
}

function velocityScore(v: number): number {
  if (v <= 0) return 0;
  if (v < 2) return v / 2;
  if (v <= 8) return 1;
  return clamp01(1 - (v - 8) / 12);
}
