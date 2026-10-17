/**
 * Holder clock (v11.6) — "sell before the big holders' usual hold time runs out". The big holders we SAW buy
 * (crowd log / tape, ≥ minHolderPct of the supply still held) each get an expected sell time = their first buy +
 * their usual hold (wallet book). Once holders representing ≥ expiryShare of that watched supply are past it and the
 * position is in profit, part of what's left is sold (once) and the trail tightens. A known dumper selling half its
 * bag while we hold = rug. Pure; the sell manager, the virtual book and the replay all use it.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';
import { classify, type WalletBookConfig, type WalletRec } from '../learner/wallet-book';

export interface HolderClockConfig {
  enabled: boolean;
  minHolderPct: number;
  expiryShare: number;
  tightenTrailFactor: number;
  sellPct: number;
  minMultiple: number;
}

export interface WatchedHolder {
  wallet: string;
  pctSupply: number;
  boughtAtMs: number;
  holdSecMedian: number | null;
  dumper: boolean;
  /** share (0–1) of the bag it had while we hold that it has sold since we bought */
  soldPctOfBag: number;
}

export interface HolderClockVerdict {
  action: 'none' | 'sell' | 'rug';
  detail: string;
  expiredShare: number;
  watched: number;
}

/** Pure: the holders worth watching for an open position, from the coin's trade log and the wallet book. */
export function watchedHolders(
  trades: readonly CrowdTrade[],
  openedAtMs: number,
  lookup: (wallet: string) => WalletRec | undefined,
  book: Pick<WalletBookConfig, 'minSells' | 'provenWinRate' | 'provenPf' | 'dumperMinEvents'>,
  c: Pick<HolderClockConfig, 'minHolderPct'>,
  supply = 1e9,
): WatchedHolder[] {
  const st = new Map<string, { net: number; bagAtOpen: number; boughtAfter: number; soldAfter: number; firstBuy: number }>();
  for (const t of trades) {
    let s = st.get(t.w);
    if (!s) {
      s = { net: 0, bagAtOpen: 0, boughtAfter: 0, soldAfter: 0, firstBuy: 0 };
      st.set(t.w, s);
    }
    if (t.buy) {
      s.net += t.tok;
      if (s.firstBuy === 0) s.firstBuy = t.t;
      if (t.t >= openedAtMs) s.boughtAfter += t.tok;
    } else {
      s.net -= t.tok;
      if (t.t >= openedAtMs) s.soldAfter += t.tok;
    }
    if (t.t < openedAtMs) s.bagAtOpen = s.net;
  }
  const out: WatchedHolder[] = [];
  for (const [w, s] of st) {
    const had = Math.max(0, s.bagAtOpen) + s.boughtAfter;
    const pctHad = (had / supply) * 100;
    const pctNow = (Math.max(0, s.net) / supply) * 100;
    if (pctHad < c.minHolderPct && pctNow < c.minHolderPct) continue;
    const r = lookup(w);
    out.push({
      wallet: w,
      pctSupply: Math.round(pctNow * 1000) / 1000,
      boughtAtMs: s.firstBuy,
      holdSecMedian: r && r.hold > 0 && r.holdN >= 2 ? r.hold : null,
      dumper: classify(r, book) === 'dumper',
      soldPctOfBag: had > 0 ? Math.min(1, s.soldAfter / had) : 0,
    });
  }
  return out;
}

/** Pure: what the clock says now. */
export function holderClock(holders: readonly WatchedHolder[], nowMs: number, multiple: number, alreadySold: boolean, c: HolderClockConfig): HolderClockVerdict {
  const none = (detail: string, expiredShare = 0, watched = 0): HolderClockVerdict => ({ action: 'none', detail, expiredShare, watched });
  if (!c.enabled || !holders.length) return none('off');
  const dumper = holders.find((h) => h.dumper && h.soldPctOfBag >= 0.5);
  if (dumper) return { action: 'rug', detail: `known dumper ${dumper.wallet.slice(0, 6)}… sold ${Math.round(dumper.soldPctOfBag * 100)}% of its bag`, expiredShare: 0, watched: holders.length };
  const watched = holders.filter((h) => h.holdSecMedian !== null && h.pctSupply >= c.minHolderPct);
  const total = watched.reduce((a, h) => a + h.pctSupply, 0);
  if (!(total > 0)) return none('no holders with a known hold time', 0, watched.length);
  const expired = watched.filter((h) => nowMs >= h.boughtAtMs + (h.holdSecMedian ?? 0) * 1000).reduce((a, h) => a + h.pctSupply, 0);
  const share = expired / total;
  if (alreadySold) return none('already sold into the clock', share, watched.length);
  if (share >= c.expiryShare && multiple >= c.minMultiple) {
    return { action: 'sell', detail: `holder clock: ${Math.round(share * 100)}% of the big holders (${watched.length}, ${total.toFixed(1)}% of supply) are past their usual hold time — sold ${c.sellPct}% at ${multiple.toFixed(2)}x, trail tightened`, expiredShare: share, watched: watched.length };
  }
  return none(share > 0 ? `${Math.round(share * 100)}% of watched supply past its usual hold` : 'holders still inside their usual hold', share, watched.length);
}
