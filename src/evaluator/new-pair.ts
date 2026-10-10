/**
 * New pairs — reading a fresh pump.fun coin (minutes old, low market cap) the way it has to be
 * read to NOT be the snipers' exit liquidity.
 *
 * Research (Oct 2026): at 0.3–0.5 s latency the first minutes belong to launch snipers / bundles
 * (87% of dev-funded snipes are profitable, 85% exit within 5 min). Buying while they still hold
 * their bags is why the bot's entries dropped right after it bought. What works for a bot this
 * fast is waiting until their supply is ABSORBED and REAL new buyers are still arriving:
 *
 *  absorption  the early wallets (first `sniperWindowSec` of trading) hold little or have sold most
 *              of what they bought; the dev hasn't sold and holds ≤ 10%; the top 10 hold ≤ 30% and
 *              aren't mostly first-25 buyers; the price kept ≥ 80% of its post-launch high
 *  demand      last 60 s, dev / snipers / fixed-size repeat bots left out: many different wallets,
 *              most of them first-timers, more than the 30 s before, net SOL coming in, buys beat
 *              sells by SOL and by count, varied (human) sizes, no dead gaps, little wash volume
 *  trigger     at / near its recent high (breaking out, no dip wait), not a vertical candle, no
 *              holder dumping ≥ 1% of supply in the last 5 s; standard 1B supply (no Mayhem mode)
 *
 * `newPairCheck` is pure: it reads the per-trade log + the live balances and returns the failed
 * rules (any failure = no buy), notes for the explanation and a few bonus points for a strong one.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';
import { settledHigh } from '../lib/settled-price';

export interface NewPairRules {
  sniperWindowSec: number;
  maxSniperHoldPct: number;
  minSniperSoldPct: number;
  maxDevSoldFraction: number;
  maxDevHoldingPct: number;
  maxTop10Pct: number;
  maxTop10EarlyShare: number;
  minOfHighPct: number;
  minBuyers60s: number;
  minNewBuyers60s: number;
  minNetFlowSol60s: number;
  minBuyRatioSol: number;
  minBuyRatioCount: number;
  requireAcceleration: boolean;
  minSizeCv: number;
  maxSameSizePct: number;
  minMedianBuySol: number;
  maxGapSec: number;
  maxBotVolumePct: number;
  nearHighPct: number;
  maxRun30sPct: number;
  maxHolderDumpPct: number;
}

export interface EarlyFlow {
  trades60s: number;
  /** Different organic wallets that bought in the last 60 s. */
  buyers60s: number;
  /** …of which this was their FIRST trade on the coin (fresh demand). */
  newBuyers60s: number;
  /** Organic buyers in the last 30 s vs the 30 s before. */
  buyersLast30s: number;
  buyersPrev30s: number;
  /** Organic buy SOL − all sell SOL, last 60 s. */
  netFlowSol60s: number;
  /** Organic buy SOL ÷ sell SOL (5 = no sells), last 60 s. */
  buyRatioSol: number;
  /** Organic buy count ÷ sell count (5 = no sells), last 60 s. */
  buyRatioCount: number;
  /** Coefficient of variation of organic buy sizes (last 2 min; null = too few buys). */
  sizeCv: number | null;
  /** Largest share of buys within ±2% of one size, % (last 2 min) — bots repeat one size. */
  sameSizePct: number | null;
  medianBuySol: number | null;
  /** Longest stretch without any trade in the last 90 s (incl. up to now), seconds. */
  maxGapSec: number;
  /** Early (sniper) wallets: % of supply still held, and % of what they bought already sold. */
  sniperHoldPct: number;
  sniperSoldPct: number | null;
  /** Share of the top-10 holders that were among the first 25 buyers (0–1). */
  top10EarlyShare: number | null;
  /** Price now vs the highest level it held since launch, %. */
  ofHighPct: number | null;
  /** Price now vs the high of the last 2 min, % below it. */
  belowRecentHighPct: number | null;
  /** Price change over the last 30 s, %. */
  run30sPct: number | null;
  /** Biggest single sell in the last 5 s, % of supply. */
  biggestSell5sPct: number;
}

const priceOf = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : 0;
};

/**
 * Pure: the order flow + absorption picture of a fresh coin.
 * `balances` = live token balances (raw units) per wallet, `supplyRaw` = total supply (raw).
 */
export function computeEarlyFlow(
  trades: readonly CrowdTrade[],
  now: number,
  ctx: { balances?: ReadonlyMap<string, bigint>; creator?: string | null; supplyRaw?: bigint; sniperWindowSec?: number } = {},
): EarlyFlow {
  const supplyTok = ctx.supplyRaw && ctx.supplyRaw > 0n ? Number(ctx.supplyRaw) / 1e6 : 1e9;
  const first = trades[0];
  const sniperCut = first ? first.t + (ctx.sniperWindowSec ?? 4) * 1000 : -Infinity;

  // Who is who: snipers (bought in the first seconds of trading), first-25 buyers, repeat-size bots.
  const firstSeen = new Map<string, CrowdTrade>();
  const snipers = new Set<string>();
  const first25: string[] = [];
  const sizesByWallet = new Map<string, number[]>();
  for (const x of trades) {
    if (!firstSeen.has(x.w)) firstSeen.set(x.w, x);
    if (x.buy) {
      if (x.t <= sniperCut && x.w !== ctx.creator) snipers.add(x.w);
      if (first25.length < 25 && !first25.includes(x.w)) first25.push(x.w);
      const a = sizesByWallet.get(x.w) ?? [];
      a.push(x.sol);
      sizesByWallet.set(x.w, a);
    }
  }
  const repeatBot = (w: string) => {
    const a = sizesByWallet.get(w) ?? [];
    if (a.length < 3) return false;
    const m = median(a);
    return m > 0 && a.filter((v) => Math.abs(v - m) / m <= 0.02).length >= 3;
  };
  const organic = (x: CrowdTrade) => x.w !== ctx.creator && !snipers.has(x.w) && !repeatBot(x.w);

  const in60 = trades.filter((x) => x.t <= now && now - x.t <= 60_000);
  const in120 = trades.filter((x) => x.t <= now && now - x.t <= 120_000);
  const orgBuys60 = in60.filter((x) => x.buy && organic(x));
  const sells60 = in60.filter((x) => !x.buy);
  const buyers = (xs: CrowdTrade[]) => new Set(xs.map((x) => x.w)).size;
  const buySol = orgBuys60.reduce((s, x) => s + x.sol, 0);
  const sellSol = sells60.reduce((s, x) => s + x.sol, 0);
  let newBuyers60s = 0;
  for (const w of new Set(orgBuys60.map((x) => x.w))) {
    const f = firstSeen.get(w);
    if (f && f.buy && now - f.t <= 60_000) newBuyers60s++;
  }

  const orgBuys120 = in120.filter((x) => x.buy && organic(x) && x.sol >= 0.005).map((x) => x.sol);
  let sizeCv: number | null = null;
  let sameSizePct: number | null = null;
  if (orgBuys120.length >= 6) {
    const mean = orgBuys120.reduce((a, b) => a + b, 0) / orgBuys120.length;
    const sd = Math.sqrt(orgBuys120.reduce((a, b) => a + (b - mean) ** 2, 0) / orgBuys120.length);
    sizeCv = mean > 0 ? Math.round((sd / mean) * 100) / 100 : 0;
    let most = 0;
    for (const c of orgBuys120) most = Math.max(most, orgBuys120.filter((v) => Math.abs(v - c) / c <= 0.02).length);
    sameSizePct = Math.round((most / orgBuys120.length) * 1000) / 10;
  }

  // Dead air: the longest gap between trades in the last 90 s (the stretch up to now counts too;
  // the time before the coin's first trade doesn't — a 40 s old coin wasn't "quiet" before it existed).
  const startW = now - 90_000;
  let prevT: number | null = null;
  let maxGap = 0;
  for (const x of trades) {
    if (x.t > now) break;
    if (prevT !== null && x.t > startW) maxGap = Math.max(maxGap, x.t - Math.max(prevT, startW));
    prevT = x.t;
  }
  if (prevT !== null) maxGap = Math.max(maxGap, now - Math.max(prevT, startW));

  // Snipers: what they still hold (live balances) and how much of what they bought they sold.
  let sniperBought = 0;
  let sniperSoldTok = 0;
  for (const x of trades) {
    if (!snipers.has(x.w)) continue;
    if (x.buy) sniperBought += x.tok;
    else sniperSoldTok += x.tok;
  }
  let sniperHeld = 0;
  if (ctx.balances) for (const w of snipers) sniperHeld += Number(ctx.balances.get(w) ?? 0n) / 1e6;
  else sniperHeld = Math.max(0, sniperBought - sniperSoldTok);

  // Top-10 holders that were among the first 25 buyers (insider bags parked at the top). Only
  // meaningful once plenty of wallets have bought (on a very fresh coin the first 25 ARE the crowd).
  let top10EarlyShare: number | null = null;
  const distinctBuyers = new Set(trades.filter((x) => x.buy).map((x) => x.w)).size;
  if (ctx.balances && ctx.balances.size >= 10 && distinctBuyers >= 50) {
    const top = [...ctx.balances.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)).slice(0, 10).map(([w]) => w);
    top10EarlyShare = top.filter((w) => first25.includes(w)).length / top.length;
  }

  const pxNow = trades.length ? priceOf(trades[trades.length - 1]!) : 0;
  // Highest level the price HELD (≥ 2 s) since launch — a single print can't set it.
  const held = first ? (settledHigh(trades, first.t, now, 2_000) ?? 0) : 0;
  const recentHigh = in120.reduce((m, x) => Math.max(m, priceOf(x)), 0);
  const before30 = [...trades].reverse().find((x) => now - x.t >= 30_000);
  const biggestSell5s = trades.filter((x) => !x.buy && x.t <= now && now - x.t <= 5_000).reduce((m, x) => Math.max(m, x.tok), 0);

  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    trades60s: in60.length,
    buyers60s: buyers(orgBuys60),
    newBuyers60s,
    buyersLast30s: buyers(orgBuys60.filter((x) => now - x.t <= 30_000)),
    buyersPrev30s: buyers(orgBuys60.filter((x) => now - x.t > 30_000)),
    netFlowSol60s: Math.round((buySol - sellSol) * 1000) / 1000,
    buyRatioSol: sellSol > 0 ? Math.min(5, buySol / sellSol) : buySol > 0 ? 5 : 0,
    buyRatioCount: sells60.length > 0 ? Math.min(5, orgBuys60.length / sells60.length) : orgBuys60.length > 0 ? 5 : 0,
    sizeCv,
    sameSizePct,
    medianBuySol: orgBuys120.length ? Math.round(median(orgBuys120) * 1000) / 1000 : null,
    maxGapSec: r1(maxGap / 1000),
    sniperHoldPct: r1((sniperHeld / supplyTok) * 100),
    sniperSoldPct: sniperBought > 0 ? r1(Math.min(100, (sniperSoldTok / sniperBought) * 100)) : null,
    top10EarlyShare: top10EarlyShare === null ? null : Math.round(top10EarlyShare * 100) / 100,
    ofHighPct: held > 0 && pxNow > 0 ? r1((pxNow / held) * 100) : null,
    belowRecentHighPct: recentHigh > 0 && pxNow > 0 ? r1((1 - pxNow / recentHigh) * 100) : null,
    run30sPct: before30 && priceOf(before30) > 0 && pxNow > 0 ? r1((pxNow / priceOf(before30) - 1) * 100) : null,
    biggestSell5sPct: Math.round((biggestSell5s / supplyTok) * 10_000) / 100,
  };
}

/** Pure: the new-pair rules. Any failure = no buy. */
export function newPairCheck(
  f: EarlyFlow,
  m: { devHoldingPct: number; devSoldFraction: number; top10HolderPct: number; supplyStandard: boolean; botVolumePct: number },
  r: NewPairRules,
): { fails: string[]; notes: string[]; points: number } {
  const fails: string[] = [];
  if (!m.supplyStandard) fails.push('non-standard supply (Mayhem mode / not a normal pump.fun coin)');
  // 1. Absorption — the launch wallets mustn't still be sitting on bags they're about to dump.
  const absorbed = f.sniperHoldPct <= r.maxSniperHoldPct || (f.sniperSoldPct !== null && f.sniperSoldPct >= r.minSniperSoldPct);
  if (!absorbed) fails.push(`snipers still hold ${f.sniperHoldPct.toFixed(1)}% (sold ${f.sniperSoldPct?.toFixed(0) ?? 0}% of their buys)`);
  if (m.devSoldFraction > r.maxDevSoldFraction) fails.push(`dev sold ${(m.devSoldFraction * 100).toFixed(0)}% of their bag`);
  if (m.devHoldingPct > r.maxDevHoldingPct) fails.push(`dev holds ${m.devHoldingPct.toFixed(1)}%`);
  if (m.top10HolderPct > r.maxTop10Pct) fails.push(`top-10 holders own ${m.top10HolderPct.toFixed(0)}% (> ${r.maxTop10Pct}% on a new pair)`);
  if (f.top10EarlyShare !== null && f.top10EarlyShare >= r.maxTop10EarlyShare) fails.push(`${Math.round(f.top10EarlyShare * 10)}/10 top holders were first-25 buyers (insider bags)`);
  if (f.ofHighPct !== null && f.ofHighPct < r.minOfHighPct) fails.push(`only ${f.ofHighPct.toFixed(0)}% of its post-launch high (sold off)`);
  // 2. Real new buyers, right now.
  if (f.buyers60s < r.minBuyers60s) fails.push(`${f.buyers60s} organic buyers in 60s (< ${r.minBuyers60s})`);
  if (f.newBuyers60s < r.minNewBuyers60s) fails.push(`${f.newBuyers60s} first-time buyers in 60s (< ${r.minNewBuyers60s})`);
  if (r.requireAcceleration && f.buyersLast30s < f.buyersPrev30s) fails.push(`buying slowing (${f.buyersLast30s} buyers last 30s vs ${f.buyersPrev30s} before)`);
  if (f.netFlowSol60s < r.minNetFlowSol60s) fails.push(`net flow ${f.netFlowSol60s.toFixed(2)} SOL in 60s (< ${r.minNetFlowSol60s})`);
  if (f.buyRatioSol < r.minBuyRatioSol) fails.push(`buy/sell ${f.buyRatioSol.toFixed(2)} by SOL (< ${r.minBuyRatioSol})`);
  if (f.buyRatioCount < r.minBuyRatioCount) fails.push(`buy/sell ${f.buyRatioCount.toFixed(2)} by count (< ${r.minBuyRatioCount})`);
  if (f.sizeCv !== null && f.sizeCv < r.minSizeCv) fails.push(`buy sizes too uniform (CV ${f.sizeCv.toFixed(2)} — bots)`);
  if (f.sameSizePct !== null && f.sameSizePct > r.maxSameSizePct) fails.push(`${f.sameSizePct.toFixed(0)}% of buys the same size (bots)`);
  if (f.medianBuySol !== null && f.medianBuySol < r.minMedianBuySol) fails.push(`median buy ${f.medianBuySol.toFixed(3)} SOL (dust)`);
  if (f.maxGapSec > r.maxGapSec) fails.push(`trading went quiet for ${f.maxGapSec.toFixed(0)}s`);
  if (m.botVolumePct > r.maxBotVolumePct) fails.push(`~${m.botVolumePct.toFixed(0)}% bot / wash volume`);
  // 3. Trigger: breaking out, not chasing a vertical candle, nobody dumping right now.
  if (f.belowRecentHighPct !== null && f.belowRecentHighPct > r.nearHighPct) fails.push(`${f.belowRecentHighPct.toFixed(0)}% under its 2-min high (not breaking out)`);
  if (f.run30sPct !== null && f.run30sPct > r.maxRun30sPct) fails.push(`up ${f.run30sPct.toFixed(0)}% in 30s (vertical candle — not chasing)`);
  if (f.biggestSell5sPct >= r.maxHolderDumpPct) fails.push(`a holder just dumped ${f.biggestSell5sPct.toFixed(1)}% of supply`);

  const notes = [
    `${f.buyers60s} organic buyers/min (${f.newBuyers60s} new)`,
    `net +${f.netFlowSol60s.toFixed(2)} SOL/min`,
    `snipers hold ${f.sniperHoldPct.toFixed(1)}%`,
    ...(f.sniperSoldPct !== null ? [`snipers sold ${f.sniperSoldPct.toFixed(0)}%`] : []),
  ];
  // Bonus for a clearly strong one (well past the minimums).
  let points = 0;
  if (f.buyers60s >= r.minBuyers60s * 2) points += 2;
  if (f.newBuyers60s >= r.minNewBuyers60s * 2) points += 1;
  if (f.netFlowSol60s >= r.minNetFlowSol60s * 2.5) points += 2;
  if (f.sniperHoldPct <= r.maxSniperHoldPct / 2) points += 1;
  return { fails, notes, points };
}
