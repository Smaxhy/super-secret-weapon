/**
 * The owner's own terminal filters (Oct 15: "ONLY buy coins with these things, not below — they'd be a rug; these are
 * the best anti-rug filters"). Every buy, whatever strategy found it (incl. KOL follow / copies / runners), must match
 * the filter set for the coin's stage:
 *   migrated  — MC ≥ $25k, ≥ 50 holders, liquidity ≥ $2k, ≥ 9 SOL total fees
 *   soon      — on the curve, ≤ 70 min old, volume ≥ $12k, MC ≥ $12k, ≥ 1 SOL total fees
 *   new pair  — on the curve, ≤ 1.5 min old, volume ≥ $200, MC ≤ $100k, ≥ 2 holders, no "test" / "fuck", no Mayhem
 * (The terminal labels the age field "seconds"; read as minutes — 1.5 s would be impossible. Editable.)
 * The bot's own, stricter rules still apply on top. Plus two reads the owner asked for:
 *   - narrative: a clearly weak one (copycat, junk description, blocked word) → no buy;
 *   - pressure: sellers taking over in the last 30 s → not now (it's checked again at the next checkpoint).
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';

export interface OwnerFilterConfig {
  enabled: boolean;
  migrated: { minMarketCapUsd: number; minHolders: number; minLiquidityUsd: number; minTotalFeesSol: number };
  soon: { maxAgeMin: number; minVolumeUsd: number; minMarketCapUsd: number; minTotalFeesSol: number };
  newPair: { maxAgeMin: number; minVolumeUsd: number; maxMarketCapUsd: number; minHolders: number; excludeKeywords: string[]; hideMayhem: boolean };
  /** Narrative score 0–1 (0.5 = neutral). Below this = weak story → no buy. 0 = off. */
  minNarrative: number;
}

export type OwnerProfile = 'migrated' | 'soon' | 'newPair';

export interface OwnerFilterInput {
  complete: boolean;
  onAmm?: boolean;
  ageSec: number;
  marketCapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  holders: number;
  totalFeesSol: number;
  supplyStandard?: boolean;
  name: string;
  symbol: string;
  /** We started following the coin late: its fee / volume / holder totals only cover trades since then. */
  lateJoin: boolean;
  narrative: number | null;
}

/** Which of the owner's three filter sets applies to this coin. */
export function ownerProfile(i: Pick<OwnerFilterInput, 'complete' | 'onAmm' | 'ageSec'>, c: OwnerFilterConfig): OwnerProfile {
  if (i.complete || i.onAmm) return 'migrated';
  return i.ageSec <= c.newPair.maxAgeMin * 60 ? 'newPair' : 'soon';
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Words to keep out, matched as whole words in the name or ticker ("test, fuck" from the terminal = two words). */
export function excludedWord(name: string, symbol: string, words: readonly string[]): string | null {
  const text = ` ${name} ${symbol} `.toLowerCase();
  for (const raw of words.flatMap((w) => w.split(','))) {
    const w = raw.trim().toLowerCase();
    if (w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) return w;
  }
  return null;
}

/** Pure: the owner's filters this coin fails (empty = it matches its stage's filter set). */
export function ownerFilterFails(i: OwnerFilterInput, c: OwnerFilterConfig): { profile: OwnerProfile; fails: string[] } {
  const profile = ownerProfile(i, c);
  if (!c.enabled) return { profile, fails: [] };
  const tag = profile === 'migrated' ? 'migrated' : profile === 'soon' ? 'soon' : 'new pair';
  const fails: string[] = [];
  const f = (why: string) => fails.push(`your ${tag} filter: ${why}`);
  const mc = i.marketCapUsd;
  if (profile === 'migrated') {
    const p = c.migrated;
    if (mc === null || mc < p.minMarketCapUsd) f(`MC ${mc === null ? 'unknown' : usd(mc)} < ${usd(p.minMarketCapUsd)}`);
    if (i.liquidityUsd !== null && i.liquidityUsd < p.minLiquidityUsd) f(`liquidity ${usd(i.liquidityUsd)} < ${usd(p.minLiquidityUsd)}`);
    if (!i.lateJoin && i.holders < p.minHolders) f(`${i.holders} holders < ${p.minHolders}`);
    if (!i.lateJoin && i.totalFeesSol < p.minTotalFeesSol) f(`fees ${i.totalFeesSol.toFixed(1)} SOL < ${p.minTotalFeesSol}`);
  } else if (profile === 'soon') {
    const p = c.soon;
    if (i.ageSec > p.maxAgeMin * 60) f(`${Math.round(i.ageSec / 60)} min old > ${p.maxAgeMin} min`);
    if (mc === null || mc < p.minMarketCapUsd) f(`MC ${mc === null ? 'unknown' : usd(mc)} < ${usd(p.minMarketCapUsd)}`);
    if (!i.lateJoin && (i.volumeUsd ?? 0) < p.minVolumeUsd) f(`volume ${usd(i.volumeUsd ?? 0)} < ${usd(p.minVolumeUsd)}`);
    if (!i.lateJoin && i.totalFeesSol < p.minTotalFeesSol) f(`fees ${i.totalFeesSol.toFixed(1)} SOL < ${p.minTotalFeesSol}`);
  } else {
    const p = c.newPair;
    if (mc !== null && mc > p.maxMarketCapUsd) f(`MC ${usd(mc)} > ${usd(p.maxMarketCapUsd)}`);
    if (!i.lateJoin && (i.volumeUsd ?? 0) < p.minVolumeUsd) f(`volume ${usd(i.volumeUsd ?? 0)} < ${usd(p.minVolumeUsd)}`);
    if (!i.lateJoin && i.holders < p.minHolders) f(`${i.holders} holders < ${p.minHolders}`);
    if (p.hideMayhem && i.supplyStandard === false) f('Mayhem mode');
    const bad = excludedWord(i.name, i.symbol, p.excludeKeywords);
    if (bad) f(`excluded word "${bad}"`);
  }
  if (c.minNarrative > 0 && i.narrative !== null && i.narrative < c.minNarrative) fails.push(`weak narrative (${i.narrative.toFixed(2)} < ${c.minNarrative})`);
  return { profile, fails };
}

export interface PressureConfig {
  enabled: boolean;
  /** Recent window (s) and the window before it (s) it's compared with. */
  windowSec: number;
  prevWindowSec: number;
  /** Sellers' share of the SOL traded in the recent window above this → not now. */
  maxSellSharePct: number;
  /** Ignore quiet windows (fewer trades than this). */
  minTrades: number;
}

export interface Pressure {
  buySharePct: number;
  prevBuySharePct: number | null;
  buySol: number;
  sellSol: number;
  trades: number;
  /** Buyers' share rose / fell by ≥ 10 points vs the window before. */
  trend: 'buyers_rising' | 'sellers_rising' | 'steady';
}

/** Pure: who is in control right now — buyers' share of the SOL in the last `windowSec` vs the window before (dust ignored). */
export function flowPressure(trades: readonly CrowdTrade[], now: number, c: Pick<PressureConfig, 'windowSec' | 'prevWindowSec'>): Pressure | null {
  const sum = (from: number, to: number) => {
    let b = 0;
    let s = 0;
    let n = 0;
    for (const x of trades) {
      if (x.t <= from || x.t > to || x.sol < 0.01) continue;
      n++;
      if (x.buy) b += x.sol;
      else s += x.sol;
    }
    return { b, s, n };
  };
  const cur = sum(now - c.windowSec * 1000, now);
  if (cur.n === 0) return null;
  const prev = sum(now - (c.windowSec + c.prevWindowSec) * 1000, now - c.windowSec * 1000);
  const share = (b: number, s: number) => (b + s > 0 ? Math.round((b / (b + s)) * 100) : 50);
  const buySharePct = share(cur.b, cur.s);
  const prevBuySharePct = prev.n ? share(prev.b, prev.s) : null;
  const d = prevBuySharePct === null ? 0 : buySharePct - prevBuySharePct;
  const r1 = (x: number) => Math.round(x * 100) / 100;
  return { buySharePct, prevBuySharePct, buySol: r1(cur.b), sellSol: r1(cur.s), trades: cur.n, trend: d >= 10 ? 'buyers_rising' : d <= -10 ? 'sellers_rising' : 'steady' };
}

/** Sellers taking over right now → the reason (not now), else null. */
export function pressureFail(p: Pressure | null, c: PressureConfig): string | null {
  if (!c.enabled || !p || p.trades < c.minTrades) return null;
  const sellShare = 100 - p.buySharePct;
  if (sellShare > c.maxSellSharePct) return `sellers in control: ${sellShare}% of the last ${c.windowSec}s was selling (${p.sellSol} vs ${p.buySol} SOL)`;
  return null;
}
