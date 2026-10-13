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
  cascade: { enabled: boolean; windowSec: number; dropPct: number; sellBuyRatio: number; minSellers: number; maxMultiple: number; soloDropPct?: number; crashWindowSec?: number; crashDropPct?: number; crashSellBuyRatio?: number };
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

/** One window of trades: drop from its high, sell vs buy SOL, distinct sellers. */
function windowStats(trades: readonly CrowdTrade[], now: number, sec: number) {
  const win = trades.filter((x) => now - x.t <= sec * 1000 && x.px > 0);
  if (win.length < 3) return null;
  const px = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
  const high = win.reduce((m, x) => Math.max(m, px(x)), 0);
  const last = px(win[win.length - 1]!);
  const sellSol = win.filter((x) => !x.buy).reduce((s, x) => s + x.sol, 0);
  const buySol = win.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0);
  const sellers = new Set(win.filter((x) => !x.buy).map((x) => x.w)).size;
  return { dropPct: high > 0 ? (1 - last / high) * 100 : 0, sellSol, buySol, sellers };
}

/**
 * Pure: is a rug happening right now? Three shapes (owner: "obvious rugs are the main issue"):
 *  - cascade: ≥dropPct under the windowSec high, sells ≥ratio× buys, ≥minSellers sellers;
 *  - solo dump: ONE wallet (dev / insider) crashes it ≥soloDropPct in the same window (the classic rug);
 *  - crash: ≥crashDropPct under the crashWindowSec high with sells ≥crashSellBuyRatio× buys (a rug sold in slices).
 */
export function sellCascade(trades: readonly CrowdTrade[], now: number, c: RugGuardConfig['cascade']): { hit: boolean; dropPct: number; sellSol: number; buySol: number; sellers: number; kind?: 'cascade' | 'solo' | 'crash'; windowSec?: number } {
  const none = { hit: false, dropPct: 0, sellSol: 0, buySol: 0, sellers: 0 };
  if (!c.enabled) return none;
  const w = windowStats(trades, now, c.windowSec);
  if (w) {
    const dumping = w.sellSol >= c.sellBuyRatio * Math.max(w.buySol, 0.01);
    if (dumping && w.dropPct >= c.dropPct && w.sellers >= c.minSellers) return { hit: true, ...w, kind: 'cascade', windowSec: c.windowSec };
    if (dumping && c.soloDropPct && w.sellers >= 1 && w.dropPct >= c.soloDropPct) return { hit: true, ...w, kind: 'solo', windowSec: c.windowSec };
  }
  if (c.crashWindowSec && c.crashDropPct) {
    const k = windowStats(trades, now, c.crashWindowSec);
    if (k && k.dropPct >= c.crashDropPct && k.sellSol >= (c.crashSellBuyRatio ?? 2) * Math.max(k.buySol, 0.01)) return { hit: true, ...k, kind: 'crash', windowSec: c.crashWindowSec };
  }
  return w ? { hit: false, ...w } : none;
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

/**
 * Launch-whale pump (owner: "a dev or someone buys A LOT at the start, it spikes, then a bunch of
 * new wallets pile in" — the classic set-up: the whale's bag becomes the exit for the swarm).
 */
export interface LaunchPumpConfig {
  enabled: boolean;
  /** Buys within this many seconds of the first trade count as launch buys. */
  windowSec: number;
  /** A wallet that bought ≥ this % of the supply at launch is a launch whale… */
  whaleSupplyPct: number;
  /** …and blocks the buy while it still holds ≥ this % of the supply. */
  maxWhaleHoldPct: number;
  /** Spike: the price ≥ this × the first trade's within the window, the whale paying ≥ whaleBuySharePct of the buys. */
  spikeMultiple: number;
  whaleBuySharePct: number;
  /** Swarm: ≥ swarmMinBuyers different wallets bought in the 3 min after, ≥ swarmFreshPct % never seen trading elsewhere. */
  swarmMinBuyers: number;
  swarmFreshPct: number;
}

export interface LaunchPump {
  whale: { w: string; isDev: boolean; boughtSupplyPct: number; holdsSupplyPct: number; sol: number } | null;
  spikeMultiple: number;
  whaleBuySharePct: number;
  /** Buyers in the 3 minutes after the launch window (excluding the whale and the dev). */
  swarm: string[];
}

/** Pure: read the launch from the trade log. null when the log doesn't reach back to the launch. */
export function launchPump(
  trades: readonly CrowdTrade[],
  ctx: { creator: string; createdAtMs: number; balances: ReadonlyMap<string, bigint>; supplyRaw: bigint },
  c: Pick<LaunchPumpConfig, 'windowSec' | 'whaleSupplyPct'>,
): LaunchPump | null {
  const first = trades[0];
  // The log must start at the launch (older coins' first trades were pruned).
  if (!first || first.t - ctx.createdAtMs > 15_000) return null;
  const cut = first.t + c.windowSec * 1000;
  const supplyTok = Number(ctx.supplyRaw) / 1e6 || 1e9;
  const early = trades.filter((x) => x.t <= cut);
  const bought = new Map<string, { tok: number; sol: number }>();
  let buySol = 0;
  for (const x of early) {
    if (!x.buy) continue;
    buySol += x.sol;
    const b = bought.get(x.w) ?? { tok: 0, sol: 0 };
    b.tok += x.tok;
    b.sol += x.sol;
    bought.set(x.w, b);
  }
  let whale: LaunchPump['whale'] = null;
  for (const [w, b] of bought) {
    const pct = (b.tok / supplyTok) * 100;
    if (pct >= c.whaleSupplyPct && (!whale || pct > whale.boughtSupplyPct)) {
      whale = { w, isDev: w === ctx.creator, boughtSupplyPct: pct, holdsSupplyPct: (Number(ctx.balances.get(w) ?? 0n) / Number(ctx.supplyRaw || 1n)) * 100, sol: b.sol };
    }
  }
  const px = (x: CrowdTrade) => (x.pp && x.pp > 0 ? x.pp : x.px);
  const firstPx = early.find((x) => x.px > 0) ? px(early.find((x) => x.px > 0)!) : 0;
  const highPx = early.reduce((m, x) => Math.max(m, px(x)), 0);
  const swarm = [...new Set(trades.filter((x) => x.buy && x.t > cut && x.t <= cut + 180_000 && x.w !== ctx.creator && x.w !== whale?.w).map((x) => x.w))];
  return {
    whale,
    spikeMultiple: firstPx > 0 ? highPx / firstPx : 1,
    whaleBuySharePct: whale && buySol > 0 ? (whale.sol / buySol) * 100 : 0,
    swarm,
  };
}

/** Pure: the reason to refuse, or null. `freshPct` = share of the swarm never seen trading elsewhere (null = unknown). */
export function launchPumpVerdict(lp: LaunchPump | null, freshPct: number | null, c: LaunchPumpConfig): string | null {
  if (!c.enabled || !lp?.whale) return null;
  const who = lp.whale.isDev ? 'the dev' : 'one wallet';
  const w = lp.whale;
  if (w.holdsSupplyPct >= c.maxWhaleHoldPct) {
    return `${who} bought ${w.boughtSupplyPct.toFixed(0)}% at launch and still holds ${w.holdsSupplyPct.toFixed(1)}%`;
  }
  const spiked = lp.spikeMultiple >= c.spikeMultiple && lp.whaleBuySharePct >= c.whaleBuySharePct;
  const swarmed = lp.swarm.length >= c.swarmMinBuyers && freshPct !== null && freshPct >= c.swarmFreshPct;
  if (spiked && swarmed) {
    return `pump set-up: ${who} bought ${w.boughtSupplyPct.toFixed(0)}% at launch (${lp.spikeMultiple.toFixed(1)}x spike), then ${lp.swarm.length} mostly brand-new wallets (${freshPct!.toFixed(0)}%) piled in`;
  }
  return null;
}

/**
 * Spread-out bundle (owner: "all the top holders held 0.5%, wallets made on the same day 5 months ago, bought
 * the exact same — an incredibly big bundle"). One operator splits the supply over many aged wallets so no
 * single-wallet / top-10 limit fires. Two tells, either is enough:
 *  - same size: many of the biggest holders hold (almost) exactly the same amount;
 *  - same birthday: many of the biggest holders' wallets were created within one day of each other
 *    (aged wallets — fresh ones are the funding graph's job), or a few same-size wallets share a birthday.
 */
export interface BundleGuardConfig {
  enabled: boolean;
  /** Biggest holders compared (dev excluded). */
  topHolders: number;
  /** Holders under this % of supply don't count (dust isn't a bundle). */
  minHolderPct: number;
  /** "Same size" = the biggest and smallest wallet of the group within this % of each other. */
  sameSizeTolerancePct: number;
  sameSizeMinWallets: number;
  /** A flagged group must hold at least this % of the supply together (tiny bundles are normal). */
  minGroupPct: number;
  /** Wallet ages (first transaction; cached 24 h, shared with the funding graph) of this many top holders. */
  ageWallets: number;
  sameDayHours: number;
  sameDayMinWallets: number;
  /** Wallets younger than this don't count for the birthday check. */
  sameDayMinAgeDays: number;
  /** Same size AND same birthday: this many wallets is already a bundle. */
  comboMinWallets: number;
  /** Look up missing wallet ages over RPC right before a buy (≤ ageWallets × 2 calls, cached 24 h). */
  rpcLookups: boolean;
  lookupTimeoutMs: number;
}

export interface BundleHolder {
  w: string;
  /** Token amount (any unit, same for every holder and the supply). */
  amt: number;
}

export interface WalletBirth {
  w: string;
  /** Unix seconds of the wallet's first transaction. */
  bornSec: number;
}

/** Pure: the biggest group of holders whose balances are within `tolerancePct` of each other. */
export function sameSizeGroup(holders: readonly BundleHolder[], supply: number, c: Pick<BundleGuardConfig, 'minHolderPct' | 'sameSizeTolerancePct'>): { wallets: string[]; eachPct: number; totalPct: number } | null {
  if (!(supply > 0)) return null;
  const s = holders.filter((h) => (h.amt / supply) * 100 >= c.minHolderPct).sort((a, b) => a.amt - b.amt);
  let bi = 0;
  let bj = -1;
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (j < i) j = i;
    while (j + 1 < s.length && s[j + 1]!.amt <= s[i]!.amt * (1 + c.sameSizeTolerancePct / 100)) j++;
    if (j - i > bj - bi) {
      bi = i;
      bj = j;
    }
  }
  if (bj - bi + 1 < 2) return null;
  const g = s.slice(bi, bj + 1);
  const total = g.reduce((t, h) => t + h.amt, 0);
  return { wallets: g.map((h) => h.w), eachPct: (g[Math.floor(g.length / 2)]!.amt / supply) * 100, totalPct: (total / supply) * 100 };
}

/** Pure: the biggest group of wallets (≥ minAgeDays old) created within `sameDayHours` of each other. */
export function sameDayGroup(births: readonly WalletBirth[], nowSec: number, c: Pick<BundleGuardConfig, 'sameDayHours' | 'sameDayMinAgeDays'>): { wallets: string[]; ageDays: number } | null {
  const s = births.filter((b) => b.bornSec > 0 && nowSec - b.bornSec >= c.sameDayMinAgeDays * 86_400).sort((a, b) => a.bornSec - b.bornSec);
  const span = c.sameDayHours * 3600;
  let bi = 0;
  let bj = -1;
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (j < i) j = i;
    while (j + 1 < s.length && s[j + 1]!.bornSec - s[i]!.bornSec <= span) j++;
    if (j - i > bj - bi) {
      bi = i;
      bj = j;
    }
  }
  if (bj - bi + 1 < 2) return null;
  const g = s.slice(bi, bj + 1);
  return { wallets: g.map((b) => b.w), ageDays: Math.round((nowSec - g[Math.floor(g.length / 2)]!.bornSec) / 86_400) };
}

/** Pure: is this a spread-out bundle? Returns the refusal reason or null. */
export function holderBundleVerdict(holders: readonly BundleHolder[], supply: number, births: readonly WalletBirth[], nowSec: number, c: BundleGuardConfig): string | null {
  if (!c.enabled || !(supply > 0)) return null;
  const top = [...holders].sort((a, b) => b.amt - a.amt).slice(0, c.topHolders);
  const amt = new Map(top.map((h) => [h.w, h.amt]));
  const heldPct = (ws: readonly string[]) => (ws.reduce((t, w) => t + (amt.get(w) ?? 0), 0) / supply) * 100;
  const size = sameSizeGroup(top, supply, c);
  const f = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2));
  if (size && size.wallets.length >= c.sameSizeMinWallets && size.totalPct >= c.minGroupPct) {
    return `bundle: ${size.wallets.length} wallets hold the same ~${f(size.eachPct)}% each (${f(size.totalPct)}% together)`;
  }
  const inTop = births.filter((b) => amt.has(b.w));
  const day = sameDayGroup(inTop, nowSec, c);
  if (day && day.wallets.length >= c.sameDayMinWallets && heldPct(day.wallets) >= c.minGroupPct) {
    return `bundle: ${day.wallets.length} top holders' wallets were made the same day (${day.ageDays} days ago) and hold ${f(heldPct(day.wallets))}%`;
  }
  if (size && size.wallets.length >= c.comboMinWallets) {
    const inSize = new Set(size.wallets);
    const both = sameDayGroup(inTop.filter((b) => inSize.has(b.w)), nowSec, c);
    if (both && both.wallets.length >= c.comboMinWallets && heldPct(both.wallets) >= c.minGroupPct) {
      return `bundle: ${both.wallets.length} wallets made the same day (${both.ageDays} days ago) hold the same ~${f(size.eachPct)}% each (${f(heldPct(both.wallets))}% together)`;
    }
  }
  return null;
}
