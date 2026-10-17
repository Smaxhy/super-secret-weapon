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
  /** the biggest bag a dumper still holds, % of supply */
  dumperHoldPct: number;
  crewPct: number;
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
    dumperHoldPct: Math.round(dumperHold * 100) / 100,
    crewPct: r1(crewPct),
    points: 0,
    fails: [],
    note: '',
  };
  if (!c.enabled) return q;
  if (c.fails) {
    if (dumpersInside >= 1 && dumperHold >= c.dumperHoldPct) q.fails.push(`dump crew inside: ${dumpersInside} known dumper${dumpersInside > 1 ? 's' : ''} still holding ${q.dumperHoldPct}% of the supply`);
    if (q.dumperSolPct >= c.maxDumperSolPct) q.fails.push(`known dumpers are ${q.dumperSolPct}% of the buying`);
  }
  if (q.provenSolPct >= c.minProvenSolPct && provenCount >= c.minProvenCount) {
    const span = Math.max(1, c.fullPointsProvenSolPct - c.minProvenSolPct);
    const frac = Math.min(1, (q.provenSolPct - c.minProvenSolPct) / span);
    q.points = Math.round((c.points * (2 / 3) + c.points * (1 / 3) * frac) * 10) / 10;
  }
  if (q.loserSolPct >= c.loserSolPct) q.points -= c.loserPoints;
  q.note = `crowd: ${q.provenSolPct}% of buying from proven wallets (${provenCount}), ${dumpersInside} dump crew${dumpersInside === 1 ? '' : 's'} inside${q.loserSolPct >= c.loserSolPct ? `, ${q.loserSolPct}% from losing wallets` : ''}${q.crewPct > 0 ? `, ${q.crewPct}% of buyers share one funder` : ''}`;
  return q;
}
