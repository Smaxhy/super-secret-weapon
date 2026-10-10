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
 *   - (rug guard v2) the biggest holders could crash it too far, or known ruggers hold it
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { dumpRisk, launchPump, launchPumpVerdict, ruggerVerdict, topHolders, type RuggerMemory } from './rug-watch';
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
  /** Price drop if the biggest holders sold everything now (null = unknown, e.g. adopted coins). */
  dumpRisk?: { top1Pct: number; top3Pct: number } | null;
  /** Known dumpers / ruggers among the holders (reason) or null. */
  ruggers?: string | null;
  /** Launch-whale pump set-up (rug-watch.launchPumpVerdict) or null. */
  launchPump?: string | null;
  guard?: { maxTop3DumpImpactPct: number; maxTopDumpImpactPct: number } | null;
}

/** Pure: the reason to refuse the buy, or null when it looks clean. */
export function rugScreen(i: RugScreenInput): string | null {
  const a = i.atSignal;
  const n = i.now;
  if (i.insider?.dumping) return `insiders dumping (${i.insider.reason})`;
  if (i.kolDump) return `KOLs dumping (${i.kolDump})`;
  if (i.ruggers) return `rugger memory: ${i.ruggers}`;
  if (i.launchPump) return i.launchPump;
  if (i.dumpRisk && i.guard) {
    if (i.dumpRisk.top1Pct > i.guard.maxTopDumpImpactPct) return `one holder could dump it ${i.dumpRisk.top1Pct.toFixed(0)}% (max ${i.guard.maxTopDumpImpactPct}%)`;
    if (i.dumpRisk.top3Pct > i.guard.maxTop3DumpImpactPct) return `top-3 holders could dump it ${i.dumpRisk.top3Pct.toFixed(0)}% (max ${i.guard.maxTop3DumpImpactPct}%)`;
  }
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
  deps: { liveState: LiveState; redis: Redis; crowd: CrowdTracker | null; ruggers?: RuggerMemory | null },
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
    // Rug guard v2: dump risk of the biggest holders + wallets that rugged us before.
    // (An adopted coin's ledger only starts at adoption — its holder numbers mean nothing.)
    const g = getConfig().antiRug?.rugGuard ?? DEFAULT_CONFIG.antiRug.rugGuard;
    let dumpRiskNow: { top1Pct: number; top3Pct: number } | null = null;
    let ruggers: string | null = null;
    let launch: string | null = null;
    if (g.enabled && !view.adopted) {
      // Launch whale + spike + swarm of brand-new wallets = the classic pump-and-dump set-up.
      const lpc = g.launchPump ?? DEFAULT_CONFIG.antiRug.rugGuard.launchPump;
      const lp = lpc.enabled && deps.crowd ? launchPump(deps.crowd.trades(req.mint), { creator: view.creator, createdAtMs: view.createdAtMs, balances: view.balances, supplyRaw: view.curve.totalSupply }, lpc) : null;
      let freshPct: number | null = null;
      if (lp?.whale && lp.swarm.length >= lpc.swarmMinBuyers) {
        // "Brand-new" = no trading record in the smart-money ledger (wallets that bought AND sold other coins).
        const sample = lp.swarm.slice(0, 60);
        const known = await deps.redis.hmget('wpnl:n', ...sample).catch(() => null);
        if (known) freshPct = (known.filter((x) => x === null).length / sample.length) * 100;
      }
      launch = launchPumpVerdict(lp, freshPct, lpc);
      const reserve = view.ammBaseReserve && view.ammBaseReserve > 0n ? view.ammBaseReserve : view.virtualTokenReserves;
      dumpRiskNow = dumpRisk(view.balances, reserve);
      if (deps.ruggers) {
        const top = topHolders(view.balances, 20).map((h) => h.w);
        const flagged = await deps.ruggers.flagged([view.creator, ...top, ...view.earlyBuyers.slice(0, 30)], g.ruggerMemoryDays, now).catch(() => new Set<string>());
        ruggers = ruggerVerdict(flagged, view.creator, [...new Set([...top, ...view.earlyBuyers.slice(0, 30)])], g.ruggerWalletMin);
      }
    }
    return rugScreen({
      launchPump: launch,
      dumpRisk: dumpRiskNow,
      ruggers,
      guard: g.enabled ? g : null,
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
