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
 *   - a spread-out bundle: many top holders with the same size, or wallets created the same day
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { staircase } from '../evaluator/price-shape';
import { dumpRisk, holderBundleVerdict, launchPump, launchPumpVerdict, ruggerVerdict, topHolders, type BundleGuardConfig, type RuggerMemory } from './rug-watch';
import { antiRugConfig, insiderDumpSignal, lookupFunder, type FunderInfo, type FundingRpc } from '../evaluator/insider-cluster';
import { largestHolderAccounts } from '../lib/holders-rpc';
import { canonicalPumpPool } from '../lib/pump-pda';
import { PUMP_DEFAULT_TOTAL_SUPPLY } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';
import type { MarketRaw } from '../evaluator/market-analyzer';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import { kolActivity } from '../scanner/kol-signal';
import { ADOPTED_CREATOR, deriveMetrics, type LiveState, type LiveTokenView } from '../scanner/live-state';

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
  /** Spread-out bundle (rug-watch.holderBundleVerdict) or null. */
  bundle?: string | null;
  /** Staircase chart (price-shape.staircase) or null. */
  staircase?: string | null;
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
  if (i.bundle) return i.bundle;
  if (i.staircase) return i.staircase;
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

const lateCache = new Map<string, { at: number; why: string | null }>();

/** Resolves to null when `p` takes longer than `ms` (the work keeps going and still fills caches). */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => resolve(v), () => resolve(null)).finally(() => clearTimeout(t));
  });
}

/**
 * Spread-out bundle check. Coins we saw from launch: the wallet ledger (free) + wallet ages of the biggest
 * holders (funding-graph cache, RPC for missing ones within `lookupTimeoutMs`). Coins we joined late
 * (ledger incomplete): RPC top-20 accounts, same-size check only.
 */
export async function bundleCheck(mint: string, view: LiveTokenView, redis: Redis, c: BundleGuardConfig, now = Date.now()): Promise<string | null> {
  if (!c.enabled) return null;
  const supply = Number(view.curve.totalSupply) || Number(PUMP_DEFAULT_TOTAL_SUPPLY);
  const nowSec = now / 1000;
  const late = !!view.adopted || !view.creator || view.creator === ADOPTED_CREATOR;
  if (late) {
    if (!c.rpcLookups) return null;
    // Refused coins are retried every few seconds (swing trader): one RPC read per coin per minute.
    const hit = lateCache.get(mint);
    if (hit && now - hit.at < 60_000) return hit.why;
    const pool = view.ammBaseReserve !== null || view.complete ? canonicalPumpPool(mint) : null;
    const accts = await within(largestHolderAccounts(mint, pool), c.lookupTimeoutMs);
    const why = accts ? holderBundleVerdict(accts.map((a) => ({ w: a.account, amt: a.amount })), supply, [], nowSec, c) : null;
    if (accts) {
      if (lateCache.size > 2000) lateCache.clear();
      lateCache.set(mint, { at: now, why });
    }
    return why;
  }
  const holders = topHolders(view.balances, c.topHolders, new Set([view.creator])).map((h) => ({ w: h.w, amt: Number(h.raw) }));
  const sameSize = holderBundleVerdict(holders, supply, [], nowSec, c);
  if (sameSize) return sameSize;
  const wallets = holders.slice(0, c.ageWallets).map((h) => h.w);
  if (wallets.length < Math.min(c.sameDayMinWallets, c.comboMinWallets)) return null;
  let rpc: FundingRpc | null = null;
  if (c.rpcLookups) {
    try {
      rpc = getConnection() as unknown as FundingRpc;
    } catch {
      rpc = null;
    }
  }
  const cacheHours = antiRugConfig().fundingCacheHours;
  const look = (r: FundingRpc | null) => Promise.all(wallets.map((w) => lookupFunder(redis, w, r, cacheHours).catch(() => null)));
  const infos: Array<FunderInfo | null> = (rpc ? await within(look(rpc), c.lookupTimeoutMs) : null) ?? (await look(null));
  const births = wallets.flatMap((w, k) => (infos[k]?.firstSec ? [{ w, bornSec: infos[k]!.firstSec! }] : []));
  return holderBundleVerdict(holders, supply, births, nowSec, c);
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
    const bundle = g.enabled ? await bundleCheck(req.mint, view, deps.redis, g.bundle ?? DEFAULT_CONFIG.antiRug.rugGuard.bundle, now).catch(() => null) : null;
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
        // Top-10 holders only: sniper bots are early buyers (and sellers) in almost every launch, so counting
        // early buyers / the top 20 refused nearly every coin once a few snipers were on the list.
        const top = topHolders(view.balances, 10).map((h) => h.w);
        const flagged = await deps.ruggers.flagged([view.creator, ...top], g.ruggerMemoryDays, now).catch(() => new Set<string>());
        ruggers = ruggerVerdict(flagged, view.creator, top, g.ruggerWalletMin);
      }
    }
    // Even, wickless green steps with narrow buying = a laddered chart waiting for its one red candle.
    const stair = deps.crowd ? staircase(deps.crowd.candles(req.mint), deps.crowd.trades(req.mint), now) : null;
    return rugScreen({
      staircase: stair?.hit ? stair.why : null,
      launchPump: launch,
      bundle,
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
