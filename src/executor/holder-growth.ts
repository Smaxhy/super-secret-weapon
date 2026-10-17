/**
 * Holder-growth exit (v11.10) — a memecoin pumps while NEW wallets keep arriving and rolls over when they stop:
 * the arrival rate turns before the price does. From the coin's trade log since our entry: new unique buyers per
 * minute (a wallet's FIRST buy in this coin) over a rolling 60 s window vs the settled peak of that rate since
 * entry. In profit, the rate under `collapsePct`% of its peak for `holdSec` AND sellers ≥ `minSellerSharePct` of
 * the last minute's volume → sell part of what's left (once) and tighten the trail. It never sells everything on
 * growth alone. Pure; the sell manager, the virtual book and the replay all use it.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';

export interface HolderGrowthConfig {
  enabled: boolean;
  minMultiple: number;
  collapsePct: number;
  holdSec: number;
  minSellerSharePct: number;
  sellPct: number;
  tightenTrailFactor: number;
  /** kept for the owner's reference: at/above this multiple the same rule still only tightens (never a full exit) */
  fullTrailFromMultiple: number;
}

export interface HolderGrowthState {
  newBuyersPerMin: number;
  peakNewBuyersPerMin: number;
  peakAtMs: number;
  /** since when the rate has been under the collapse line (null = it isn't) */
  belowSinceMs: number | null;
  sellerSharePct60: number;
}

const WINDOW_MS = 60_000;
const STEP_MS = 5_000;
const SETTLE_MS = 10_000;
/** fewer new buyers per minute at the peak than this = not enough of a crowd to judge */
const MIN_PEAK = 3;

/** Pure: the arrival rate now + its settled peak since entry (+ the seller share of the last minute). */
export function holderGrowth(trades: readonly CrowdTrade[], openedAtMs: number, nowMs: number, prev: HolderGrowthState | null, c: Pick<HolderGrowthConfig, 'collapsePct'>): HolderGrowthState {
  const firstBuy = new Map<string, number>();
  let buySol60 = 0, sellSol60 = 0;
  for (const t of trades) {
    if (t.buy && !firstBuy.has(t.w)) firstBuy.set(t.w, t.t);
    if (nowMs - t.t <= WINDOW_MS && t.t <= nowMs) {
      if (t.buy) buySol60 += t.sol;
      else sellSol60 += t.sol;
    }
  }
  const arrivals = [...firstBuy.values()].filter((t) => t >= openedAtMs - WINDOW_MS).sort((a, b) => a - b);
  const rateAt = (t: number): number => {
    // arrivals in (t − 60 s, t]
    let lo = 0, hi = arrivals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arrivals[m]! <= t - WINDOW_MS) lo = m + 1; else hi = m; }
    let lo2 = 0, hi2 = arrivals.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (arrivals[m]! <= t) lo2 = m + 1; else hi2 = m; }
    return lo2 - lo;
  };
  const now = rateAt(nowMs);
  // Settled peak: a level counts only when the rate was still at least that high 10 s later.
  let peak = 0, peakAt = openedAtMs;
  for (let t = openedAtMs; t + SETTLE_MS <= nowMs; t += STEP_MS) {
    const v = Math.min(rateAt(t), rateAt(t + SETTLE_MS));
    if (v > peak) { peak = v; peakAt = t; }
  }
  if (prev && prev.peakNewBuyersPerMin > peak) { peak = prev.peakNewBuyersPerMin; peakAt = prev.peakAtMs; }
  const total = buySol60 + sellSol60;
  const sellerShare = total > 0 ? (sellSol60 / total) * 100 : 0;
  const below = peak >= MIN_PEAK && now < peak * (c.collapsePct / 100);
  return {
    newBuyersPerMin: now,
    peakNewBuyersPerMin: peak,
    peakAtMs: peakAt,
    belowSinceMs: below ? (prev?.belowSinceMs ?? nowMs) : null,
    sellerSharePct60: Math.round(sellerShare * 10) / 10,
  };
}

export interface HolderGrowthVerdict {
  action: 'none' | 'sell';
  detail: string;
}

/** Pure: what the arrival rate says now. */
export function holderGrowthVerdict(s: HolderGrowthState | null | undefined, nowMs: number, multiple: number, alreadySold: boolean, c: HolderGrowthConfig): HolderGrowthVerdict {
  const none = (detail: string): HolderGrowthVerdict => ({ action: 'none', detail });
  if (!c.enabled || !s) return none('off');
  if (s.peakNewBuyersPerMin < MIN_PEAK) return none('too few new buyers to judge');
  if (alreadySold) return none('already sold into the collapse');
  if (multiple < c.minMultiple) return none(`under ${c.minMultiple}x`);
  if (s.belowSinceMs === null) return none(`new buyers ${s.newBuyersPerMin}/min vs peak ${s.peakNewBuyersPerMin}/min`);
  const belowSec = (nowMs - s.belowSinceMs) / 1000;
  if (belowSec < c.holdSec) return none(`new buyers collapsing for ${Math.round(belowSec)} s (needs ${c.holdSec})`);
  if (s.sellerSharePct60 < c.minSellerSharePct) return none(`new buyers collapsed but sellers only ${s.sellerSharePct60}% of the last minute`);
  return {
    action: 'sell',
    detail: `holder growth: new buyers ${s.newBuyersPerMin}/min, down from ${s.peakNewBuyersPerMin}/min for ${Math.round(belowSec)} s, sellers ${s.sellerSharePct60}% — sold ${c.sellPct}% at ${multiple.toFixed(2)}x, trail tightened`,
  };
}
