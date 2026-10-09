/**
 * Pre-entry rug screen — the last check, right before a buy executes.
 *
 * The evaluation may be seconds old (and the confirmation delay adds more), so
 * the trader re-reads the coin and refuses the buy if, since the signal:
 *   - insiders / hidden dev wallets started dumping
 *   - the dev started selling, or now holds too much
 *   - bundlers are dumping, or the top-10 suddenly got more concentrated
 *   - pool liquidity dropped sharply (pulled)
 *   - the last minute is a dump (sellers 2× buyers and price −12% off the 1-min high)
 *   - a whale just sold a big chunk of the liquidity
 *   - the price fell 15%+ since the signal
 */
import type { Redis } from 'ioredis';
import { getConfig } from '../config/runtime-config';
import { insiderDumpSignal } from '../evaluator/insider-cluster';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { kolActivity } from '../scanner/kol-signal';
import { deriveMetrics, type LiveState } from '../scanner/live-state';

export interface RugSnapshot {
  devHoldingPct: number;
  devSoldFraction: number;
  earlyBuyerPct: number;
  top10HolderPct: number;
  liquiditySol: number;
  priceSol: number;
}

export interface RugScreenInput {
  atSignal: RugSnapshot;
  now: RugSnapshot;
  onAmm: boolean;
  /** Last 60 seconds of trades. null = no trade log. */
  flow60s: { buySol: number; sellSol: number; biggestSellSol: number; highPx: number; lastPx: number } | null;
  insider: { dumping: boolean; reason: string } | null;
  maxDevHoldingPct: number;
  /** KOLs that bought are selling (e.g. "Cupsey, Cented sold"). */
  kolDump?: string | null;
}

/** Pure: the reason to refuse the buy, or null when it looks clean. */
export function rugScreen(i: RugScreenInput): string | null {
  const a = i.atSignal;
  const n = i.now;
  if (i.insider?.dumping) return `insiders dumping (${i.insider.reason})`;
  if (i.kolDump) return `KOLs dumping (${i.kolDump})`;
  if (a.devHoldingPct > 0.5 && n.devSoldFraction - a.devSoldFraction >= 0.1) return `dev started selling (${Math.round(n.devSoldFraction * 100)}% of their bag gone)`;
  if (n.devHoldingPct > i.maxDevHoldingPct) return `dev now holds ${n.devHoldingPct.toFixed(1)}%`;
  if (a.earlyBuyerPct - n.earlyBuyerPct >= 2) return `bundlers dumping (${a.earlyBuyerPct.toFixed(1)}% → ${n.earlyBuyerPct.toFixed(1)}%)`;
  if (n.top10HolderPct - a.top10HolderPct >= 10) return `top-10 jumped ${a.top10HolderPct.toFixed(0)}% → ${n.top10HolderPct.toFixed(0)}%`;
  if (i.onAmm && a.liquiditySol > 0 && n.liquiditySol < a.liquiditySol * 0.6) return `liquidity dropped ${Math.round((1 - n.liquiditySol / a.liquiditySol) * 100)}%`;
  if (a.priceSol > 0 && n.priceSol > 0 && n.priceSol <= a.priceSol * 0.85) return `down ${Math.round((1 - n.priceSol / a.priceSol) * 100)}% since the signal`;
  const f = i.flow60s;
  if (f) {
    if (f.sellSol >= 2 * Math.max(f.buySol, 0.01) && f.highPx > 0 && f.lastPx <= f.highPx * 0.88) return `dumping right now (sells ${f.sellSol.toFixed(1)} vs buys ${f.buySol.toFixed(1)} SOL in 1 min)`;
    if (n.liquiditySol > 0 && f.biggestSellSol >= n.liquiditySol * 0.15) return `whale just sold ${f.biggestSellSol.toFixed(1)} SOL`;
  }
  return null;
}

/** Build the inputs from live data and run the screen. Never throws (a failed read is treated as clean). */
export async function screenEntry(
  req: { mint: string; market: MarketRaw },
  deps: { liveState: LiveState; redis: Redis; crowd: CrowdTracker | null },
  now = Date.now(),
): Promise<string | null> {
  try {
    const view = await deps.liveState.read(req.mint);
    if (!view) return 'coin no longer tracked';
    const m = deriveMetrics(view);
    const trades = (deps.crowd?.trades(req.mint) ?? []).filter((x) => now - x.t <= 60_000);
    const flow60s = trades.length
      ? {
          buySol: trades.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0),
          sellSol: trades.filter((x) => !x.buy).reduce((s, x) => s + x.sol, 0),
          biggestSellSol: trades.filter((x) => !x.buy).reduce((mx, x) => Math.max(mx, x.sol), 0),
          highPx: trades.reduce((mx, x) => Math.max(mx, x.px), 0),
          lastPx: trades[trades.length - 1]!.px,
        }
      : null;
    const insider = await insiderDumpSignal(deps.redis, req.mint).catch(() => null);
    const kc = getConfig().kol;
    const kol = kc?.enabled ? await kolActivity(deps.redis, req.mint, kc, now).catch(() => null) : null;
    const r = req.market;
    return rugScreen({
      atSignal: { devHoldingPct: r.devHoldingPct, devSoldFraction: r.devSoldFraction, earlyBuyerPct: r.earlyBuyerPct, top10HolderPct: r.top10HolderPct, liquiditySol: r.liquiditySol, priceSol: r.priceSol },
      now: { devHoldingPct: m.devHoldingPct, devSoldFraction: m.devSoldFraction, earlyBuyerPct: m.earlyBuyerPct, top10HolderPct: m.top10HolderPct, liquiditySol: m.liquiditySol, priceSol: m.priceSol },
      onAmm: r.onAmm,
      flow60s,
      insider,
      maxDevHoldingPct: getConfig().entry.maxDevHoldingPct,
      kolDump: kol?.dumping ? `${kol.recentSellers.map((s) => s.name).slice(0, 3).join(', ')} sold` : null,
    });
  } catch {
    return null;
  }
}
