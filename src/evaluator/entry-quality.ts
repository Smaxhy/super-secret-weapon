/**
 * Entry quality — real-time trade-level checks on the last 15–60 seconds.
 * Blocks buying into dumps, seller floods, spike retraces; boosts clean bounces.
 * Pure function, no side effects — called from the evaluator right before the buy decision.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';

export interface EntryQualityConfig {
  enabled: boolean;
  /** Block if the price dropped more than this % in the last 15 seconds. */
  maxDrop15sPct: number;
  /** Block if the sell/buy SOL ratio in the last 30 seconds exceeds this. */
  maxSellBuyRatio30s: number;
  /** Block if a spike (≥20% from a 60-second low) retraced more than this % of the move. */
  spikeRetracePct: number;
  /** Score bonus when the most recent 15 seconds show a clean bounce (buyers > sellers, price rising). */
  bounceBoostPct: number;
  /** Block if fewer than this many unique buyers in the last 30 seconds. */
  minBuyers30s: number;
  /** Block if volume in the last 30 seconds is less than this fraction of the prior 30 seconds. */
  minVolRatio: number;
}

export const DEFAULT_ENTRY_QUALITY: EntryQualityConfig = {
  enabled: true,
  maxDrop15sPct: 5,
  maxSellBuyRatio30s: 2.0,
  spikeRetracePct: 20,
  bounceBoostPct: 4,
  minBuyers30s: 3,
  minVolRatio: 0.3,
};

export interface EntryQualityResult {
  verdict: 'ok' | 'block' | 'boost';
  reason: string;
  points: number;
}

export function entryQuality(trades: CrowdTrade[], nowMs: number, cfg: EntryQualityConfig): EntryQualityResult {
  if (!cfg.enabled) return { verdict: 'ok', reason: '', points: 0 };

  const recent15 = trades.filter((t) => t.t >= nowMs - 15_000);
  const recent30 = trades.filter((t) => t.t >= nowMs - 30_000);
  const prior30 = trades.filter((t) => t.t >= nowMs - 60_000 && t.t < nowMs - 30_000);
  const recent60 = trades.filter((t) => t.t >= nowMs - 60_000);

  if (recent30.length < 2) return { verdict: 'ok', reason: 'too few trades', points: 0 };

  // 1. Price dump in the last 15 seconds
  if (recent15.length >= 2) {
    const firstPrice = recent15[0]!.px;
    const lastPrice = recent15[recent15.length - 1]!.px;
    if (firstPrice > 0 && lastPrice > 0) {
      const dropPct = ((firstPrice - lastPrice) / firstPrice) * 100;
      if (dropPct > cfg.maxDrop15sPct) {
        return { verdict: 'block', reason: `price dumping ${dropPct.toFixed(1)}% in 15s`, points: 0 };
      }
    }
  }

  // 2. Seller flood in the last 30 seconds
  const buySol30 = recent30.filter((t) => t.buy).reduce((s, t) => s + t.sol, 0);
  const sellSol30 = recent30.filter((t) => !t.buy).reduce((s, t) => s + t.sol, 0);
  if (buySol30 > 0 && sellSol30 / buySol30 > cfg.maxSellBuyRatio30s) {
    return { verdict: 'block', reason: `sellers flooding: ${(sellSol30 / buySol30).toFixed(1)}x sell/buy ratio in 30s`, points: 0 };
  }

  // 3. Spike retrace — a pump that's already giving back its gains
  if (recent60.length >= 4) {
    const prices = recent60.map((t) => t.px).filter((p) => p > 0);
    if (prices.length >= 4) {
      const low60 = Math.min(...prices);
      const high60 = Math.max(...prices);
      const currentPrice = prices[prices.length - 1]!;
      const spikeSize = high60 - low60;
      if (spikeSize > 0 && (high60 - low60) / low60 >= 0.2) {
        const retracePct = ((high60 - currentPrice) / spikeSize) * 100;
        if (retracePct > cfg.spikeRetracePct) {
          return { verdict: 'block', reason: `spike retracing ${retracePct.toFixed(0)}% (pumped ${((spikeSize / low60) * 100).toFixed(0)}%, giving it back)`, points: 0 };
        }
      }
    }
  }

  // 4. Not enough unique buyers in the last 30 seconds
  const uniqueBuyers30 = new Set(recent30.filter((t) => t.buy).map((t) => t.w)).size;
  if (uniqueBuyers30 < cfg.minBuyers30s) {
    return { verdict: 'block', reason: `only ${uniqueBuyers30} buyer(s) in 30s (need ${cfg.minBuyers30s})`, points: 0 };
  }

  // 5. Volume dying — recent 30s volume much lower than the prior 30s
  if (prior30.length >= 3) {
    const vol30 = recent30.reduce((s, t) => s + t.sol, 0);
    const volPrior = prior30.reduce((s, t) => s + t.sol, 0);
    if (volPrior > 0 && vol30 / volPrior < cfg.minVolRatio) {
      return { verdict: 'block', reason: `volume dying: ${(vol30 / volPrior * 100).toFixed(0)}% of prior 30s`, points: 0 };
    }
  }

  // 6. Clean bounce boost — price rising in the last 15 seconds with buyers in control
  if (recent15.length >= 2) {
    const firstPrice = recent15[0]!.px;
    const lastPrice = recent15[recent15.length - 1]!.px;
    const buySol15 = recent15.filter((t) => t.buy).reduce((s, t) => s + t.sol, 0);
    const sellSol15 = recent15.filter((t) => !t.buy).reduce((s, t) => s + t.sol, 0);
    if (firstPrice > 0 && lastPrice > firstPrice && buySol15 > sellSol15 * 1.5) {
      const bouncePct = ((lastPrice - firstPrice) / firstPrice) * 100;
      if (bouncePct >= cfg.bounceBoostPct) {
        return { verdict: 'boost', reason: `clean bounce +${bouncePct.toFixed(1)}% with ${(buySol15 / Math.max(0.01, sellSol15)).toFixed(1)}x buy pressure`, points: 3 };
      }
    }
  }

  return { verdict: 'ok', reason: '', points: 0 };
}
