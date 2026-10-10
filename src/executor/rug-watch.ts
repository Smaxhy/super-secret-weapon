/**
 * Rug guard v2 (owner: "it still gets rugged WAY too much").
 *
 * Before a buy (rug-screen):
 *   - dump risk: how far the price would fall if the biggest holders sold everything right
 *     now (constant-product maths on the curve / pool reserves). A coin where three wallets can
 *     crash it 45% is a coin waiting to be rugged, whatever its holder %.
 *   - rugger memory: wallets that dumped on us before (and the devs of coins that rugged us).
 *     When the creator or ≥2 of the biggest holders are on that list → no buy.
 * While we hold (sell manager):
 *   - holder dump: the biggest holders at the time we bought (snapshot kept in Redis per
 *     position) selling a big slice of the supply → out, before the stop loss would fire.
 *   - sell cascade: price ≥20% under its 20-second high with sells ≥3× buys from several
 *     wallets → out at once (the stop loss waits 2 s for confirmation; rugs don't).
 * After a rug: the wallets that dumped + the dev go on the rugger list (14 days).
 */
import type { Redis } from 'ioredis';
import type { CrowdTrade } from '../scanner/crowd-tracker';

export interface RugGuardConfig {
  enabled: boolean;
  /** Entry: top-3 holders selling everything would drop the price more than this % → no buy. */
  maxTop3DumpImpactPct: number;
  /** Entry: the single biggest holder alone would drop it more than this % → no buy. */
  maxTopDumpImpactPct: number;
  /** Entry: this many of the top-20 holders / early buyers on the rugger list → no buy (the dev alone counts as 2). */
  ruggerWalletMin: number;
  ruggerMemoryDays: number;
  /** Exit: the top holders at entry sold this % of the whole supply since → out. */
  holderDumpPct: number;
  holderDumpTop: number;
  /** Exit: one holder with ≥ this % of supply sold ≥ bigSellerSoldPct % of it → out. */
  bigSellerMinSupplyPct: number;
  bigSellerSoldPct: number;
  cascade: { enabled: boolean; windowSec: number; dropPct: number; sellBuyRatio: number; minSellers: number; maxMultiple: number };
}

export interface Holder {
  w: string;
  /** Raw token balance (string so it survives JSON). */
  raw: string;
}

/** Pure: the biggest holders (wallet ledger), biggest first. */
export function topHolders(balances: ReadonlyMap<string, bigint>, n: number, exclude: ReadonlySet<string> = new Set()): Holder[] {
  return [...balances.entries()]
    .filter(([w, b]) => b > 0n && !exclude.has(w))
    .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
    .slice(0, n)
    .map(([w, b]) => ({ w, raw: b.toString() }));
}

/** Pure: % the price falls if `tokens` (raw) are sold into a constant-product pool with `tokenReserve` (raw). */
export function dumpImpactPct(tokens: bigint, tokenReserve: bigint): number {
  if (tokens <= 0n || tokenReserve <= 0n) return 0;
  const r = Number(tokenReserve) / (Number(tokenReserve) + Number(tokens));
  return (1 - r * r) * 100;
}

/** Pure: dump risk of the biggest holders (excluding `exclude`, e.g. our own wallet). */
export function dumpRisk(balances: ReadonlyMap<string, bigint>, tokenReserve: bigint, exclude: ReadonlySet<string> = new Set()): { top1Pct: number; top3Pct: number } {
  const top = topHolders(balances, 3, exclude).map((h) => BigInt(h.raw));
  return { top1Pct: dumpImpactPct(top[0] ?? 0n, tokenReserve), top3Pct: dumpImpactPct(top.reduce((s, b) => s + b, 0n), tokenReserve) };
}

/** Pure: how much the holders we saw at entry have sold since (as % of the whole supply). */
export function holderDump(
  atEntry: readonly Holder[],
  balances: ReadonlyMap<string, bigint>,
  totalSupply: bigint,
): { soldSupplyPct: number; sellers: string[]; biggest: { w: string; supplyPct: number; soldPct: number } | null } {
  const supply = Number(totalSupply) || 1;
  let sold = 0;
  const sellers: string[] = [];
  let biggest: { w: string; supplyPct: number; soldPct: number } | null = null;
  for (const h of atEntry) {
    const before = Number(h.raw);
    if (!(before > 0)) continue;
    const now = Number(balances.get(h.w) ?? 0n);
    const gone = Math.max(0, before - now);
    if (gone <= 0) continue;
    sold += gone;
    const soldPct = (gone / before) * 100;
    const supplyPct = (before / supply) * 100;
    // Dust holders aren't dumpers (and must never land on the rugger list).
    if (soldPct >= 50 && supplyPct >= 0.1) sellers.push(h.w);
    if (!biggest || supplyPct * soldPct > biggest.supplyPct * biggest.soldPct) biggest = { w: h.w, supplyPct, soldPct };
  }
  return { soldSupplyPct: (sold / supply) * 100, sellers, biggest };
}

/** Pure: is a sell cascade (the start of a rug) happening right now? */
export function sellCascade(trades: readonly CrowdTrade[], now: number, c: RugGuardConfig['cascade']): { hit: boolean; dropPct: number; sellSol: number; buySol: number; sellers: number } {
  const win = trades.filter((x) => now - x.t <= c.windowSec * 1000 && x.px > 0);
  const none = { hit: false, dropPct: 0, sellSol: 0, buySol: 0, sellers: 0 };
  if (win.length < 3) return none;
  const px = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
  const high = win.reduce((m, x) => Math.max(m, px(x)), 0);
  const last = px(win[win.length - 1]!);
  const sellSol = win.filter((x) => !x.buy).reduce((s, x) => s + x.sol, 0);
  const buySol = win.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0);
  const sellers = new Set(win.filter((x) => !x.buy).map((x) => x.w)).size;
  const dropPct = high > 0 ? (1 - last / high) * 100 : 0;
  const hit = c.enabled && dropPct >= c.dropPct && sellSol >= c.sellBuyRatio * Math.max(buySol, 0.01) && sellers >= c.minSellers;
  return { hit, dropPct, sellSol, buySol, sellers };
}

const RUGGERS = 'rug:wallets';
const holdersKey = (positionId: string) => `rug:holders:${positionId}`;

/** Wallets that dumped on us (and devs of coins that rugged us). */
export class RuggerMemory {
  constructor(private readonly redis: Redis) {}

  async record(wallets: readonly string[], days: number, now = Date.now()): Promise<void> {
    const list = [...new Set(wallets.filter((w) => w && !w.startsWith('(')))];
    if (!list.length) return;
    const p = this.redis.pipeline();
    for (const w of list) p.zadd(RUGGERS, now, w);
    p.zremrangebyscore(RUGGERS, '-inf', String(now - days * 86_400_000));
    await p.exec();
  }

  /** Which of these wallets are on the list (still within `days`). */
  async flagged(wallets: readonly string[], days: number, now = Date.now()): Promise<Set<string>> {
    const list = [...new Set(wallets)];
    if (!list.length) return new Set();
    const scores = await this.redis.zmscore(RUGGERS, ...list);
    const cutoff = now - days * 86_400_000;
    return new Set(list.filter((_, i) => scores[i] !== null && Number(scores[i]) >= cutoff));
  }

  async size(): Promise<number> {
    return this.redis.zcard(RUGGERS);
  }

  /** The biggest holders when we bought — read back on every exit check. */
  async saveEntryHolders(positionId: string, holders: readonly Holder[]): Promise<void> {
    await this.redis.set(holdersKey(positionId), JSON.stringify(holders), 'EX', 3 * 86_400);
  }

  async entryHolders(positionId: string): Promise<Holder[] | null> {
    const raw = await this.redis.get(holdersKey(positionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Holder[];
    } catch {
      return null;
    }
  }
}

/** Pure: rugger-list verdict for a coin. The creator counts double. */
export function ruggerVerdict(flagged: ReadonlySet<string>, creator: string, holders: readonly string[], min: number): string | null {
  const hits = holders.filter((w) => w !== creator && flagged.has(w));
  const score = hits.length + (flagged.has(creator) ? 2 : 0);
  if (score < min) return null;
  return flagged.has(creator) ? `dev rugged us before${hits.length ? ` (+${hits.length} known dumper${hits.length > 1 ? 's' : ''} holding)` : ''}` : `${hits.length} wallets that dumped on us before are top holders`;
}
