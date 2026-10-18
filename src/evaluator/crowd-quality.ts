/**
 * Crowd quality (v11.6) — WHO is buying this coin, from the wallet book (learner/wallet-book.ts): share of the last
 * minutes' buying that came from proven wallets / dumpers / losers / bots, dump crews still holding, buyers sharing
 * one funder (from the funding-graph cache only — never a new RPC call). Pure: rule fails + points for the evaluator,
 * the swing trader and the replay.
 */
import type { CrowdTrade } from '../scanner/crowd-tracker';
import { classify, type WalletBookConfig, type WalletClass, type WalletRec } from '../learner/wallet-book';

export interface CrowdQualityConfig {
  enabled: boolean;
  /** max points for a proven-wallet-led crowd */
  points: number;
  minProvenSolPct: number;
  minProvenCount: number;
  fullPointsProvenSolPct: number;
  /** a dumper still holding ≥ this % of the supply → no buy */
  dumperHoldPct: number;
  /** dumpers' share of the buying ≥ this → no buy */
  maxDumperSolPct: number;
  /** losers' share of the buying ≥ this → points off */
  loserSolPct: number;
  loserPoints: number;
  fails: boolean;
  /** v11.19: ≥ this many known dumpers among the first 20 buyers → no buy (0 = off). */
  maxDumpersInFirst20?: number;
  /** v11.8: a deployer-funded launch-block buyer still holding ≥ this % of the supply → no buy. */
  deployerSniperHoldPct?: number;
  /** v11.11: launch buyers (first 15 s) still holding more than this % of what they bought → no buy (0 = off). */
  maxFirstBuyersHoldingPct?: number;
  /** …only when those bags are at least this % of the supply. */
  firstBuyersMinBagPct?: number;
}

export interface CrowdQuality {
  buyers: number;
  buySol: number;
  provenSolPct: number;
  dumperSolPct: number;
  loserSolPct: number;
  botSolPct: number;
  provenCount: number;
  dumpersInside: number;
  /** v11.19: known dumper wallets among the coin's first 20 distinct buyers (creator excluded). */
  dumpersInFirst20: number;
  /** the biggest bag a dumper still holds, % of supply */
  dumperHoldPct: number;
  crewPct: number;
  /**
   * v11.8 "exit-liquidity machines" (Pine Analytics): wallets funded by the deployer (directly or one hop away) that
   * bought in the launch window. Counted whenever the launch time + creator are known; `deployerSniperHoldPct` = the
   * biggest bag one of them still holds (% of supply).
   */
  deployerSnipers: number;
  deployerSniperWallets: string[];
  deployerSniperHoldPct: number;
  /**
   * v11.11: of the SOL spent by wallets whose first buy came in the first 15 s of trading (creator excluded), the share
   * still held now; `firstBuyersBagPct` = those bags as % of the supply. null = the crowd log doesn't reach the launch.
   */
  firstBuyersHoldingPct: number | null;
  firstBuyersBagPct: number | null;
  points: number;
  fails: string[];
  note: string;
}

export interface CrowdQualityInput {
  trades: readonly CrowdTrade[];
  now: number;
  windowMs?: number;
  dustSol?: number;
  supply?: number;
  /** Launch time (ms) + creator → deployer-funded launch snipers can be found; absent = not checked. */
  launchMs?: number | null;
  creator?: string | null;
  launchWindowMs?: number;
}

const DEFAULT_LAUNCH_WINDOW_MS = 4_000;
const FIRST_BUYERS_WINDOW_MS = 15_000;

/** Pure: how much of their launch buys the first-15-s buyers still hold (SOL-weighted) and their bags as % of supply. */
export function firstBuyersHolding(trades: readonly CrowdTrade[], launchMs: number | null, creator: string | null, supply: number, windowMs = FIRST_BUYERS_WINDOW_MS): { holdingPct: number; bagPct: number; wallets: number } | null {
  if (launchMs === null || !(launchMs > 0) || !trades.length) return null;
  if (trades[0]!.t > launchMs + windowMs) return null;
  const first = new Map<string, number>();
  const bought = new Map<string, { tok: number; sol: number }>();
  const net = new Map<string, number>();
  for (const t of trades) {
    net.set(t.w, (net.get(t.w) ?? 0) + (t.buy ? t.tok : -t.tok));
    if (!t.buy) continue;
    if (!first.has(t.w)) first.set(t.w, t.t);
    const b = bought.get(t.w) ?? { tok: 0, sol: 0 };
    b.tok += t.tok;
    b.sol += t.sol;
    bought.set(t.w, b);
  }
  let sol = 0, heldSol = 0, heldTok = 0, n = 0;
  for (const [w, at] of first) {
    if (w === creator || at < launchMs - 1_000 || at - launchMs > windowMs) continue;
    const b = bought.get(w)!;
    if (!(b.tok > 0)) continue;
    const held = Math.min(b.tok, Math.max(0, net.get(w) ?? 0));
    sol += b.sol;
    heldSol += b.sol * (held / b.tok);
    heldTok += held;
    n++;
  }
  if (!n || !(sol > 0)) return null;
  return { holdingPct: Math.round((heldSol / sol) * 1000) / 10, bagPct: Math.round((heldTok / supply) * 10000) / 100, wallets: n };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function crowdQuality(
  i: CrowdQualityInput,
  lookup: (wallet: string) => WalletRec | undefined,
  funderOf: (wallet: string) => string | null | undefined,
  book: Pick<WalletBookConfig, 'minSells' | 'provenWinRate' | 'provenPf' | 'dumperMinEvents'>,
  c: CrowdQualityConfig,
): CrowdQuality | null {
  const window = i.windowMs ?? 300_000;
  const dust = i.dustSol ?? 0.01;
  const supply = i.supply ?? 1e9;
  const net = new Map<string, number>();
  for (const t of i.trades) net.set(t.w, (net.get(t.w) ?? 0) + (t.buy ? t.tok : -t.tok));
  const buySol = new Map<string, number>();
  for (const t of i.trades) if (t.buy && t.sol >= dust && i.now - t.t <= window) buySol.set(t.w, (buySol.get(t.w) ?? 0) + t.sol);
  if (!buySol.size) return null;
  const cls = new Map<string, WalletClass>();
  const kindOf = (w: string): WalletClass => {
    let k = cls.get(w);
    if (!k) {
      k = classify(lookup(w), book);
      cls.set(w, k);
    }
    return k;
  };
  let total = 0, proven = 0, dumper = 0, loser = 0, bot = 0, provenCount = 0;
  for (const [w, s] of buySol) {
    total += s;
    const k = kindOf(w);
    if (k === 'proven') {
      proven += s;
      provenCount++;
    } else if (k === 'dumper') dumper += s;
    else if (k === 'loser') loser += s;
    else if (k === 'bot') bot += s;
  }
  let dumpersInside = 0, dumperHold = 0;
  for (const [w, tok] of net) {
    if (tok <= 0 || kindOf(w) !== 'dumper') continue;
    dumpersInside++;
    dumperHold = Math.max(dumperHold, (tok / supply) * 100);
  }
  const funders = new Map<string, number>();
  let crewKnown = 0;
  for (const w of buySol.keys()) {
    const f = funderOf(w);
    if (!f) continue;
    crewKnown++;
    funders.set(f, (funders.get(f) ?? 0) + 1);
  }
  const biggestCrew = Math.max(0, ...funders.values());
  const crewPct = crewKnown >= 3 && biggestCrew >= 2 ? (biggestCrew / buySol.size) * 100 : 0;
  // Deployer-funded launch snipers: bought within the launch window, funded by the creator (or by a creator-funded wallet).
  const launchMs = i.launchMs ?? null;
  const creator = i.creator ?? null;
  const launchKnown = launchMs !== null && launchMs > 0 && !!creator;
  const deployerFunded = (w: string): boolean => {
    const f = funderOf(w);
    if (!f) return false;
    if (f === creator) return true;
    const f2 = funderOf(f);
    return !!f2 && f2 === creator;
  };
  const sniperWallets: string[] = [];
  let sniperHold = 0;
  if (launchKnown) {
    const lw = i.launchWindowMs ?? DEFAULT_LAUNCH_WINDOW_MS;
    const seen = new Set<string>();
    for (const t of i.trades) {
      if (!t.buy || t.w === creator || seen.has(t.w) || t.t < launchMs! - 1_000 || t.t - launchMs! > lw) continue;
      seen.add(t.w);
      if (deployerFunded(t.w)) {
        sniperWallets.push(t.w);
        const held = ((net.get(t.w) ?? 0) / supply) * 100;
        if (held > sniperHold) sniperHold = held;
      }
    }
  }
  // The first 20 distinct buyers (creator excluded) — a dump crew shows up at the start.
  let dumpersInFirst20 = 0;
  {
    const seen = new Set<string>();
    for (const t of i.trades) {
      if (!t.buy || t.w === creator || seen.has(t.w)) continue;
      seen.add(t.w);
      if (kindOf(t.w) === 'dumper') dumpersInFirst20++;
      if (seen.size >= 20) break;
    }
  }
  const pct = (x: number) => (total > 0 ? (x / total) * 100 : 0);
  const q: CrowdQuality = {
    buyers: buySol.size,
    buySol: r1(total),
    provenSolPct: r1(pct(proven)),
    dumperSolPct: r1(pct(dumper)),
    loserSolPct: r1(pct(loser)),
    botSolPct: r1(pct(bot)),
    provenCount,
    dumpersInside,
    dumpersInFirst20,
    dumperHoldPct: Math.round(dumperHold * 100) / 100,
    crewPct: r1(crewPct),
    deployerSnipers: sniperWallets.length,
    deployerSniperWallets: sniperWallets,
    deployerSniperHoldPct: Math.round(sniperHold * 100) / 100,
    firstBuyersHoldingPct: null,
    firstBuyersBagPct: null,
    points: 0,
    fails: [],
    note: '',
  };
  const fb = firstBuyersHolding(i.trades, launchMs, creator, supply);
  if (fb) {
    q.firstBuyersHoldingPct = fb.holdingPct;
    q.firstBuyersBagPct = fb.bagPct;
  }
  if (!c.enabled) return q;
  if (c.fails) {
    const maxFb = c.maxFirstBuyersHoldingPct ?? 0;
    if (fb && maxFb > 0 && fb.holdingPct > maxFb && fb.bagPct >= (c.firstBuyersMinBagPct ?? 5)) q.fails.push(`launch buyers still hold ${fb.holdingPct}% of their bags (${fb.bagPct}% of the supply)`);
    if (dumpersInside >= 1 && dumperHold >= c.dumperHoldPct) q.fails.push(`dump crew inside: ${dumpersInside} known dumper${dumpersInside > 1 ? 's' : ''} still holding ${q.dumperHoldPct}% of the supply`);
    if (q.dumperSolPct >= c.maxDumperSolPct) q.fails.push(`known dumpers are ${q.dumperSolPct}% of the buying`);
    const maxD20 = c.maxDumpersInFirst20 ?? 0;
    if (maxD20 > 0 && dumpersInFirst20 >= maxD20) q.fails.push(`dump crew at the start: ${dumpersInFirst20} of the first 20 buyers are known dumpers`);
    const minHold = c.deployerSniperHoldPct ?? 1;
    const inside = sniperWallets.filter((w) => ((net.get(w) ?? 0) / supply) * 100 >= minHold).length;
    if (inside > 0) q.fails.push(`deployer-funded launch sniper inside (exit-liquidity machine): ${inside} wallet${inside > 1 ? 's' : ''} funded by the dev bought at launch and still hold${inside > 1 ? '' : 's'} ${q.deployerSniperHoldPct}% of the supply`);
  }
  if (q.provenSolPct >= c.minProvenSolPct && provenCount >= c.minProvenCount) {
    const span = Math.max(1, c.fullPointsProvenSolPct - c.minProvenSolPct);
    const frac = Math.min(1, (q.provenSolPct - c.minProvenSolPct) / span);
    q.points = Math.round((c.points * (2 / 3) + c.points * (1 / 3) * frac) * 10) / 10;
  }
  if (q.loserSolPct >= c.loserSolPct) q.points -= c.loserPoints;
  q.note = `crowd: ${q.provenSolPct}% of buying from proven wallets (${provenCount}), ${dumpersInside} dump crew${dumpersInside === 1 ? '' : 's'} inside${q.loserSolPct >= c.loserSolPct ? `, ${q.loserSolPct}% from losing wallets` : ''}${q.crewPct > 0 ? `, ${q.crewPct}% of buyers share one funder` : ''}${launchKnown ? `, ${sniperWallets.length} deployer-funded sniper${sniperWallets.length === 1 ? '' : 's'}` : ''}`;
  return q;
}
