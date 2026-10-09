/**
 * Insider clusters & hidden dev wallets — "who really controls this token?"
 *
 * A rugging dev rarely keeps their bag in the creator wallet. They spread it
 * over fresh wallets (bundled into the launch, or funded right before it), so
 * the plain "dev holds X%" check looks clean. This module finds those wallets
 * and makes them count:
 *
 *   1. Free signals from the trade stream (no RPC) — InsiderTracker:
 *        bundle    bought within `bundleWindowSec` of the create (same / next slots)
 *        burst     ≥3 wallets buying near-identical SOL sizes within a couple of seconds
 *        transfer  holds / sells tokens it never bought (received by transfer)
 *        devsync   sold in the same second (≈ slot) as the dev
 *   2. Funding graph (RPC, frugal) — only for tokens that already passed the
 *      market gates, ≤ `fundingMaxWallets` wallets per token, every lookup
 *      cached 24h: who sent each wallet its first SOL.
 *        funded by the creator / funded the creator / same fresh funder as the
 *        creator  → hidden dev wallet
 *        several fresh holders sharing one funder → one insider cluster
 *   3. Effective numbers: dev + hidden dev wallets, cluster % (counts as
 *      bundlers), biggest funding cluster (counts as one wallet), plus a
 *      serial-rugger memory (creator / funder whose past tokens dumped).
 *   4. insiderDumpSignal(): while we hold, did the insiders just dump?
 *
 * Redis keys (token keys expire with the live state, ~26h):
 *   tok:<mint>:ins:bundle|burst|xfer|devsync  SET   flagged wallets
 *   tok:<mint>:ins:net      HASH  wallet → raw tokens bought − sold (seen on stream)
 *   tok:<mint>:ins:cluster  SET   every insider wallet we know (incl. hidden dev wallets)
 *   tok:<mint>:ins:fundlock STRING  set while the funding graph is fresh (limits RPC)
 *   tok:<mint>:ins:dump     LIST  "ms:rawTotal" snapshots of the insiders' bag
 *   wfund:<wallet>          STRING JSON FunderInfo (24h)
 *   wfund:kids:<funder>     SET   wallets this funder bankrolled (hub / exchange detection)
 *   rugger:<address>        SET   mints this creator / funder rugged (30d)
 *   rugger:<address>:last   STRING JSON RuggerRecord
 */
import type { ConfirmedSignatureInfo, ParsedInstruction, ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG, LIVE_STATE_TTL_SECONDS, type BotConfigShape } from '../config/default';

const INSIDER_TTL_SECONDS = 6 * 3600;
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getConnection } from '../lib/solana';

const log = moduleLogger('insider-cluster');

type Widen<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends boolean ? boolean : T[K] };
export type AntiRugConfig = Widen<BotConfigShape['antiRug']>;

/** Current anti-rug settings (defaults filled in for configs stored before this section existed). */
export function antiRugConfig(): AntiRugConfig {
  const stored = (getConfig() as Partial<BotConfigShape>).antiRug;
  return { ...DEFAULT_CONFIG.antiRug, ...(stored ?? {}) };
}

/** The existing entry limits hidden wallets are fed into. */
export interface EntryLimits {
  maxDevHoldingPct: number;
  maxBundlePct: number;
  maxSingleHolderPct: number;
  riskyEntry?: { enabled: boolean; maxBundlePct: number; maxSingleHolderPct: number };
}

export const insKey = {
  bundle: (m: string) => `tok:${m}:ins:bundle`,
  burst: (m: string) => `tok:${m}:ins:burst`,
  xfer: (m: string) => `tok:${m}:ins:xfer`,
  devsync: (m: string) => `tok:${m}:ins:devsync`,
  net: (m: string) => `tok:${m}:ins:net`,
  cluster: (m: string) => `tok:${m}:ins:cluster`,
  fundlock: (m: string) => `tok:${m}:ins:fundlock`,
  dump: (m: string) => `tok:${m}:ins:dump`,
  funder: (w: string) => `wfund:${w}`,
  hubKids: (f: string) => `wfund:kids:${f}`,
  rugger: (a: string) => `rugger:${a}`,
  ruggerLast: (a: string) => `rugger:${a}:last`,
};
/** Live-state keys we read (same names as src/scanner/live-state.ts). */
const liveKey = (m: string) => `tok:${m}:live`;
const balKey = (m: string) => `tok:${m}:bal`;
const earlyKey = (m: string) => `tok:${m}:early`;

const pct = (raw: bigint | number, supply: number) => (Number(raw) / (supply || 1)) * 100;
const f1 = (x: number) => x.toFixed(1);
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// ---------------------------------------------------------------------------
// 1. Free on-stream signals
// ---------------------------------------------------------------------------

/** One trade, from the curve or PumpSwap. */
export interface InsiderTrade {
  mint: string;
  user: string;
  isBuy: boolean;
  /** SOL in/out, lamports. */
  lamports: bigint;
  /** Raw token amount. */
  tokens: bigint;
  /** Block time, seconds. */
  timestamp: number;
  /** Trader's exact token balance after the trade, when the source reports it. */
  balanceAfter?: bigint;
  /** Price after the trade (SOL per whole token) — feeds the serial-rugger memory. */
  priceSol?: number;
}

interface TokMem {
  creator: string | null;
  createdSec: number;
  /** We saw the create, so every buy since launch went through the tracker. */
  seenCreate: boolean;
  recentBuys: Array<{ w: string; sol: number; sec: number }>;
  recentSells: Array<{ w: string; sec: number }>;
  lastDevSellSec: number | null;
  devSold: boolean;
  launchPx: number | null;
  peakPx: number;
  rugRecorded: boolean;
  touchedSec: number;
}

/**
 * Wallets in a "same-size burst": at least `minWallets` distinct wallets whose
 * buys (within the window) are all within `tolerancePct` of each other. Pure.
 */
export function findSizeBurst(buys: ReadonlyArray<{ w: string; sol: number; sec: number }>, c: Pick<AntiRugConfig, 'burstMinWallets' | 'burstWindowSec' | 'burstSizeTolerancePct' | 'burstMinSol'>): string[] {
  const eligible = buys.filter((b) => b.sol >= c.burstMinSol);
  const out = new Set<string>();
  for (const anchor of eligible) {
    const group = eligible.filter((b) => Math.abs(b.sec - anchor.sec) <= c.burstWindowSec && Math.abs(b.sol - anchor.sol) / anchor.sol <= c.burstSizeTolerancePct / 100);
    const wallets = new Set(group.map((b) => b.w));
    if (wallets.size >= c.burstMinWallets) wallets.forEach((w) => out.add(w));
  }
  return [...out];
}

/**
 * Feeds every trade into the insider sets. Needs two hooks in the scanner
 * (token registry): `onCreate(createEvent)` and `onTrade(...)` after the live
 * state applied the trade. Keeps only a few seconds of trades in memory.
 */
export class InsiderTracker {
  private readonly mem = new Map<string, TokMem>();
  private creates = 0;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: () => AntiRugConfig = antiRugConfig,
  ) {}

  async onCreate(ev: { mint: string; creator: string; timestamp: number }): Promise<void> {
    const sec = ev.timestamp || Math.floor(Date.now() / 1000);
    this.mem.set(ev.mint, this.blank(ev.creator || null, sec, true));
    if (++this.creates % 1000 === 0) this.prune();
  }

  /** Forget a token (optional — entries also age out on their own). */
  forget(mint: string): void {
    this.mem.delete(mint);
  }

  async onTrade(t: InsiderTrade): Promise<void> {
    const tok = await this.tokenFor(t.mint);
    if (!tok?.creator) return;
    const c = this.cfg();
    const r = this.redis;
    // Insider signals only matter for a few hours (entry + holding) — keep Redis small.
    const ttl = INSIDER_TTL_SECONDS;
    tok.touchedSec = t.timestamp;
    const flag = async (k: string, wallets: string[]) => {
      if (!wallets.length) return;
      await r.sadd(k, ...wallets);
      await r.expire(k, ttl);
    };

    const net = BigInt(await r.hincrby(insKey.net(t.mint), t.user, (t.isBuy ? t.tokens : -t.tokens).toString()));
    await r.expire(insKey.net(t.mint), ttl);
    const isDev = t.user === tok.creator;

    if (!isDev) {
      if (t.isBuy && t.timestamp - tok.createdSec <= c.bundleWindowSec) await flag(insKey.bundle(t.mint), [t.user]);
      // Tokens the wallet never bought: sold more than it bought, or a balance bigger than its buys.
      if (tok.seenCreate) {
        const sellTooBig = !t.isBuy && net < -(t.tokens / 50n) - 1n;
        const balTooBig = t.isBuy && t.balanceAfter !== undefined && t.balanceAfter > net + net / 50n + 1_000_000n;
        if (sellTooBig || balTooBig) await flag(insKey.xfer(t.mint), [t.user]);
      }
      if (t.isBuy) {
        tok.recentBuys.push({ w: t.user, sol: Number(t.lamports) / 1e9, sec: t.timestamp });
        tok.recentBuys = tok.recentBuys.filter((b) => t.timestamp - b.sec <= c.burstWindowSec);
        await flag(insKey.burst(t.mint), findSizeBurst(tok.recentBuys, c));
      } else {
        tok.recentSells.push({ w: t.user, sec: t.timestamp });
        tok.recentSells = tok.recentSells.filter((s) => t.timestamp - s.sec <= c.devSellWindowSec + 3);
        if (tok.lastDevSellSec !== null && Math.abs(t.timestamp - tok.lastDevSellSec) <= c.devSellWindowSec) await flag(insKey.devsync(t.mint), [t.user]);
      }
    } else if (!t.isBuy) {
      tok.lastDevSellSec = t.timestamp;
      tok.devSold = true;
      // Sells that landed just before the dev's in the same slot.
      await flag(insKey.devsync(t.mint), [...new Set(tok.recentSells.filter((s) => Math.abs(t.timestamp - s.sec) <= c.devSellWindowSec).map((s) => s.w))]);
    }

    if (t.priceSol && t.priceSol > 0 && tok.seenCreate && c.serialRuggerEnabled) await this.watchRug(t.mint, tok, t, c);
  }

  /** Remember the creator as a rugger if the token dumps ≥ serialRugDropPct within the window after a dev sell. */
  private async watchRug(mint: string, tok: TokMem, t: InsiderTrade, c: AntiRugConfig): Promise<void> {
    if (tok.rugRecorded || t.timestamp - tok.createdSec > c.serialRugWindowMin * 60) return;
    const px = t.priceSol!;
    if (tok.launchPx === null) tok.launchPx = px;
    tok.peakPx = Math.max(tok.peakPx, px);
    const dropPct = (1 - px / tok.peakPx) * 100;
    if (tok.peakPx >= tok.launchPx * 1.5 && dropPct >= c.serialRugDropPct && tok.devSold) {
      tok.rugRecorded = true;
      await rememberRugger(this.redis, tok.creator!, { mint, dropPct: Math.round(dropPct), via: 'stream' }, c.serialRugMemoryDays);
      log.info({ mint, creator: tok.creator, dropPct: Math.round(dropPct) }, 'serial-rugger memory: creator dumped a token');
    }
  }

  private blank(creator: string | null, createdSec: number, seenCreate: boolean): TokMem {
    return { creator, createdSec, seenCreate, recentBuys: [], recentSells: [], lastDevSellSec: null, devSold: false, launchPx: null, peakPx: 0, rugRecorded: false, touchedSec: createdSec };
  }

  /** In-memory token info; after a restart it is rebuilt from the live-state hash once. */
  private async tokenFor(mint: string): Promise<TokMem | null> {
    const hit = this.mem.get(mint);
    if (hit) return hit;
    const [creator, createdAt] = await this.redis.hmget(liveKey(mint), 'creator', 'createdAt');
    const tok = this.blank(creator || null, Math.floor(Number(createdAt ?? 0) / 1000), false);
    this.mem.set(mint, tok);
    return tok;
  }

  private prune(): void {
    const cutoff = Date.now() / 1000 - LIVE_STATE_TTL_SECONDS;
    for (const [m, t] of this.mem) if (t.touchedSec < cutoff) this.mem.delete(m);
  }
}

export interface StreamFlags {
  bundle: string[];
  burst: string[];
  transfer: string[];
  devSync: string[];
}

export async function readStreamFlags(redis: Redis, mint: string): Promise<StreamFlags> {
  const [bundle, burst, transfer, devSync] = await Promise.all([
    redis.smembers(insKey.bundle(mint)),
    redis.smembers(insKey.burst(mint)),
    redis.smembers(insKey.xfer(mint)),
    redis.smembers(insKey.devsync(mint)),
  ]);
  return { bundle, burst, transfer, devSync };
}

// ---------------------------------------------------------------------------
// 2. Funding graph
// ---------------------------------------------------------------------------

export interface FunderInfo {
  /** Who sent the wallet its first SOL. null = unknown. */
  funder: string | null;
  ageHours: number | null;
  /** ≥1000 transactions: an old, busy wallet (age is a lower bound, funder unknown). */
  veryActive: boolean;
}

/** The two RPC calls we need — injectable for tests. */
export interface FundingRpc {
  getSignaturesForAddress(address: PublicKey, opts: { limit: number }): Promise<ConfirmedSignatureInfo[]>;
  getParsedTransaction(sig: string, opts: { maxSupportedTransactionVersion: number; commitment: 'confirmed' }): Promise<ParsedTransactionWithMeta | null>;
}

/** Find who sent SOL to `wallet` in a parsed transaction (system transfer). */
export function findFunder(tx: ParsedTransactionWithMeta | null, wallet: string): string | null {
  if (!tx) return null;
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  for (const ix of all) {
    const p = (ix as ParsedInstruction).parsed as { type?: string; info?: { source?: string; destination?: string } } | undefined;
    if ((ix as ParsedInstruction).program === 'system' && p?.type === 'transfer' && p.info?.destination === wallet && p.info.source) {
      return p.info.source;
    }
  }
  return null;
}

/**
 * First funder of a wallet, cached `cacheHours`. rpc = null → cache only (no
 * credits spent). Never throws: unknown comes back as null.
 */
export async function lookupFunder(redis: Redis, wallet: string, rpc: FundingRpc | null, cacheHours: number): Promise<FunderInfo | null> {
  const cached = await redis.get(insKey.funder(wallet));
  if (cached) return JSON.parse(cached) as FunderInfo;
  if (!rpc) return null;
  const info: FunderInfo = { funder: null, ageHours: null, veryActive: false };
  try {
    const sigs = await rpc.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000 });
    const oldest = sigs[sigs.length - 1];
    info.veryActive = sigs.length >= 1000;
    if (oldest?.blockTime) info.ageHours = (Date.now() / 1000 - oldest.blockTime) / 3600;
    if (oldest && !info.veryActive) {
      const tx = await rpc.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      info.funder = findFunder(tx, wallet);
    }
  } catch (err) {
    log.debug({ wallet, err: (err as Error).message }, 'funder lookup failed');
    // Short negative cache so a flaky RPC doesn't eat credits on every checkpoint.
    await redis.set(insKey.funder(wallet), JSON.stringify(info), 'EX', 600);
    return info;
  }
  const ttl = Math.round(cacheHours * 3600);
  await redis.set(insKey.funder(wallet), JSON.stringify(info), 'EX', ttl);
  if (info.funder) {
    await redis.sadd(insKey.hubKids(info.funder), wallet);
    await redis.expire(insKey.hubKids(info.funder), ttl);
  }
  return info;
}

export interface FundingGraph {
  creatorFunder: string | null;
  hiddenDev: Array<{ wallet: string; why: string }>;
  /** Fresh wallets sharing one funder (not the dev's) — treated as one holder. */
  clusters: Array<{ funder: string; wallets: string[] }>;
  /** Wallets we had funding info for. */
  looked: number;
}

/** Build hidden-dev wallets and funding clusters from funder info. Pure. */
export function buildFundingGraph(creator: string, info: ReadonlyMap<string, FunderInfo>, hubs: ReadonlySet<string>, freshWalletHours: number): FundingGraph {
  const fresh = (fi: FunderInfo | undefined) => !!fi && !fi.veryActive && fi.ageHours !== null && fi.ageHours <= freshWalletHours;
  const cf = info.get(creator)?.funder ?? null;
  const hidden = new Map<string, string>();
  for (const [w, fi] of info) {
    if (w === creator) continue;
    if (fi.funder === creator) hidden.set(w, 'funded by creator');
    else if (cf && w === cf) hidden.set(w, 'funded the creator');
    else if (cf && fi.funder === cf && !hubs.has(cf) && fresh(fi)) hidden.set(w, "same funder as creator");
  }
  // One more hop: wallets funded by a hidden dev wallet.
  for (const [w, fi] of info) {
    if (w !== creator && !hidden.has(w) && fi.funder && hidden.has(fi.funder)) hidden.set(w, 'funded by hidden dev wallet');
  }

  const groups = new Map<string, Set<string>>();
  for (const [w, fi] of info) {
    if (w === creator || hidden.has(w) || !fi.funder || hubs.has(fi.funder) || !fresh(fi)) continue;
    const g = groups.get(fi.funder) ?? new Set<string>();
    g.add(w);
    // The funder holds the token too → same group.
    if (info.has(fi.funder) && fi.funder !== creator && !hidden.has(fi.funder)) g.add(fi.funder);
    groups.set(fi.funder, g);
  }
  const clusters = [...groups.entries()].filter(([, g]) => g.size >= 2).map(([funder, g]) => ({ funder, wallets: [...g] }));
  return { creatorFunder: cf, hiddenDev: [...hidden.entries()].map(([wallet, why]) => ({ wallet, why })), clusters, looked: info.size };
}

// ---------------------------------------------------------------------------
// 3. Effective holdings
// ---------------------------------------------------------------------------

export interface InsiderSummary {
  devPct: number;
  hiddenDevWallets: string[];
  hiddenDevPct: number;
  /** Dev + hidden dev wallets, % of supply. */
  effectiveDevPct: number;
  /** % held by early (≤1s) buyers, as the plain bundle check sees it. */
  earlyPct: number;
  /** Every insider wallet we know (dev excluded): bundles, bursts, transfers, dev-sync sellers, funding clusters. */
  clusterWallets: number;
  clusterPct: number;
  /** max(early %, cluster %) — what the bundler limit should see. */
  effectiveBundlePct: number;
  /** Biggest single wallet (dev excluded), plain. */
  maxHolderPct: number;
  /** Biggest funding cluster held together, % of supply. */
  biggestClusterPct: number;
  /** max(single wallet, biggest funding cluster) — what the single-wallet limit should see. */
  effectiveMaxHolderPct: number;
  flags: { bundle: number; burst: number; transfer: number; devSync: number; fundingClusters: number };
  /** Did the funding graph run (with any wallet info)? */
  fundingChecked: boolean;
  reasons: string[];
}

export interface InsiderInputs {
  creator: string;
  supply: number;
  balances: ReadonlyMap<string, bigint>;
  early: readonly string[];
  flags: StreamFlags;
  funding: FundingGraph | null;
}

/** Turn wallets + balances into effective dev / bundle / single-wallet numbers with reasons. Pure. */
export function summarizeInsiders(i: InsiderInputs): { summary: InsiderSummary; members: string[] } {
  const bal = (w: string) => i.balances.get(w) ?? 0n;
  const sumPct = (ws: Iterable<string>) => pct([...new Set(ws)].reduce((s, w) => s + bal(w), 0n), i.supply);
  const notDev = (ws: readonly string[]) => ws.filter((w) => w !== i.creator);
  const reasons: string[] = [];

  const hidden = (i.funding?.hiddenDev ?? []).filter((h) => h.wallet !== i.creator);
  const hiddenWallets = hidden.map((h) => h.wallet);
  const devPct = pct(bal(i.creator), i.supply);
  const hiddenDevPct = sumPct(hiddenWallets);
  if (hidden.length) {
    const why = [...new Set(hidden.map((h) => h.why))].join(' / ');
    reasons.push(`${hidden.length} hidden dev wallet${hidden.length > 1 ? 's' : ''} (${why}) hold ${f1(hiddenDevPct)}% → dev effectively ${f1(devPct + hiddenDevPct)}%`);
  }

  const clusters = i.funding?.clusters ?? [];
  const members = new Set<string>([...notDev(i.early), ...notDev(i.flags.bundle), ...notDev(i.flags.burst), ...notDev(i.flags.transfer), ...notDev(i.flags.devSync), ...clusters.flatMap((c) => notDev(c.wallets)), ...hiddenWallets]);
  const holding = (ws: readonly string[]) => notDev(ws).filter((w) => bal(w) > 0n);
  const describe = (ws: readonly string[], what: string) => {
    const h = holding(ws);
    if (h.length) reasons.push(`${h.length} wallet${h.length > 1 ? 's' : ''} ${what} hold ${f1(sumPct(h))}%`);
  };
  describe(i.flags.burst, 'bought near-identical sizes in a burst');
  describe(i.flags.transfer, 'got tokens by transfer (never bought)');
  describe(i.flags.devSync, 'sold in the same slot as the dev and');
  let biggestClusterPct = 0;
  for (const c of clusters) {
    const p = sumPct(notDev(c.wallets));
    biggestClusterPct = Math.max(biggestClusterPct, p);
    reasons.push(`${c.wallets.length} fresh wallets funded by ${short(c.funder)} hold ${f1(p)}% (counts as one holder)`);
  }

  const earlyPct = sumPct(notDev(i.early));
  const clusterPct = sumPct(members);
  if (clusterPct > earlyPct + 0.05) reasons.push(`insider cluster (${members.size} wallets) holds ${f1(clusterPct)}% vs ${f1(earlyPct)}% seen as bundlers`);
  let maxHolder = 0n;
  for (const [w, b] of i.balances) if (w !== i.creator && b > maxHolder) maxHolder = b;
  const maxHolderPct = pct(maxHolder, i.supply);

  return {
    members: [...members],
    summary: {
      devPct,
      hiddenDevWallets: hiddenWallets,
      hiddenDevPct,
      effectiveDevPct: devPct + hiddenDevPct,
      earlyPct,
      clusterWallets: members.size,
      clusterPct,
      effectiveBundlePct: Math.max(earlyPct, clusterPct),
      maxHolderPct,
      biggestClusterPct,
      effectiveMaxHolderPct: Math.max(maxHolderPct, biggestClusterPct),
      flags: { bundle: i.flags.bundle.length, burst: i.flags.burst.length, transfer: i.flags.transfer.length, devSync: i.flags.devSync.length, fundingClusters: clusters.length },
      fundingChecked: !!i.funding && i.funding.looked > 0,
      reasons,
    },
  };
}

/**
 * Entry-rule failures caused by hidden / insider wallets, in the same wording as
 * checkEntryRules (so "bundlers hold" / "one wallet holds" stay soft limits).
 * Only reported when the insider wallets are what pushes a number over the limit.
 * `hard` = beyond even the risky-entry caps (or dev limit broken via hidden wallets).
 */
export function insiderRuleFails(s: InsiderSummary, e: EntryLimits): { fails: string[]; hard: string[] } {
  const fails: string[] = [];
  const hard: string[] = [];
  const risky = e.riskyEntry?.enabled ? e.riskyEntry : null;
  if (s.hiddenDevPct > 0 && s.effectiveDevPct > e.maxDevHoldingPct && s.devPct <= e.maxDevHoldingPct) {
    const f = `dev holds ${f1(s.effectiveDevPct)}% > ${e.maxDevHoldingPct}% (incl. ${s.hiddenDevWallets.length} hidden wallet${s.hiddenDevWallets.length > 1 ? 's' : ''})`;
    fails.push(f);
    hard.push(f);
  }
  if (s.effectiveBundlePct > e.maxBundlePct && s.earlyPct <= e.maxBundlePct) {
    const f = `bundlers hold ${f1(s.effectiveBundlePct)}% > ${e.maxBundlePct}% (insider cluster)`;
    fails.push(f);
    if (s.effectiveBundlePct > (risky?.maxBundlePct ?? e.maxBundlePct)) hard.push(f);
  }
  if (s.effectiveMaxHolderPct > e.maxSingleHolderPct && s.maxHolderPct <= e.maxSingleHolderPct) {
    const f = `one wallet holds ${f1(s.effectiveMaxHolderPct)}% > ${e.maxSingleHolderPct}% (funding cluster)`;
    fails.push(f);
    if (s.effectiveMaxHolderPct > (risky?.maxSingleHolderPct ?? e.maxSingleHolderPct)) hard.push(f);
  }
  return { fails, hard };
}

export interface AnalyzeOptions {
  /** 'off' = stream only, 'cache' = cached funders only (free), 'rpc' = look up missing funders (credits). */
  funding: 'off' | 'cache' | 'rpc';
  rpc?: FundingRpc;
  cfg?: AntiRugConfig;
  /** Already-known creator facts (wallet analyzer) — saves 2 RPC calls. */
  creatorInfo?: FunderInfo | null;
}

/**
 * Full insider analysis for one token from Redis (+ RPC when allowed).
 * Also records every insider wallet in `tok:<mint>:ins:cluster` for the live dump watch.
 * Returns null if the token's live state has expired.
 */
export async function analyzeInsiders(redis: Redis, mint: string, opts: AnalyzeOptions): Promise<{ summary: InsiderSummary; members: string[]; funding: FundingGraph | null } | null> {
  const c = opts.cfg ?? antiRugConfig();
  const [creator, supplyS] = await redis.hmget(liveKey(mint), 'creator', 'supply');
  if (!creator) return null;
  const supply = Number(supplyS ?? 0) || 1e15;
  const [balRaw, early, flags] = await Promise.all([redis.hgetall(balKey(mint)), redis.smembers(earlyKey(mint)), readStreamFlags(redis, mint)]);
  const balances = new Map<string, bigint>(Object.entries(balRaw ?? {}).map(([w, b]) => [w, BigInt(b)]));

  let funding: FundingGraph | null = null;
  if (opts.funding !== 'off' && c.fundingGraphEnabled) {
    let rpc: FundingRpc | null = null;
    if (opts.funding === 'rpc') {
      // One RPC round per token per `fundingRecheckMinutes`; in between, cached funders only.
      const fresh = await redis.set(insKey.fundlock(mint), '1', 'EX', Math.max(60, Math.round(c.fundingRecheckMinutes * 60)), 'NX');
      if (fresh === 'OK') rpc = opts.rpc ?? (getConnection() as unknown as FundingRpc);
    }
    const holders = [...balances.entries()].filter(([w]) => w !== creator).sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)).map(([w]) => w);
    const wallets = [creator, ...holders].slice(0, Math.max(1, c.fundingMaxWallets));
    const info = new Map<string, FunderInfo>();
    const looked = await Promise.all(wallets.map((w) => (w === creator && opts.creatorInfo ? Promise.resolve(opts.creatorInfo) : lookupFunder(redis, w, rpc, c.fundingCacheHours))));
    wallets.forEach((w, k) => looked[k] && info.set(w, looked[k]!));
    const hubs = new Set<string>();
    for (const f of new Set([...info.values()].map((x) => x.funder).filter((x): x is string => !!x))) {
      if (f !== creator && (await redis.scard(insKey.hubKids(f))) >= c.hubFunderMinWallets) hubs.add(f);
    }
    funding = buildFundingGraph(creator, info, hubs, c.freshWalletHours);
  }

  const { summary, members } = summarizeInsiders({ creator, supply, balances, early, flags, funding });
  const watch = [creator, ...members];
  await redis.sadd(insKey.cluster(mint), ...watch);
  await redis.expire(insKey.cluster(mint), LIVE_STATE_TTL_SECONDS);
  return { summary, members, funding };
}

// ---------------------------------------------------------------------------
// Serial ruggers
// ---------------------------------------------------------------------------

export interface RuggerRecord {
  mint: string;
  dropPct: number;
  via: 'stream' | 'db' | 'exit';
}

/** Remember that `address` (a creator or their funder) rugged `rec.mint`. */
export async function rememberRugger(redis: Redis, address: string, rec: RuggerRecord, days: number): Promise<void> {
  if (!address) return;
  const ttl = Math.round(days * 86_400);
  await redis.sadd(insKey.rugger(address), rec.mint);
  await redis.expire(insKey.rugger(address), ttl);
  await redis.set(insKey.ruggerLast(address), JSON.stringify({ ...rec, at: Date.now() }), 'EX', ttl);
}

/** First of `addresses` with at least `minRugs` rugs on record (excluding `excludeMint`). */
export async function findRugger(redis: Redis, addresses: ReadonlyArray<string | null | undefined>, minRugs: number, excludeMint?: string): Promise<{ address: string; rugs: number; detail: string } | null> {
  for (const a of addresses) {
    if (!a) continue;
    const mints = (await redis.smembers(insKey.rugger(a))).filter((m) => m !== excludeMint);
    if (mints.length >= minRugs && mints.length > 0) {
      const last = await redis.get(insKey.ruggerLast(a));
      const l = last ? (JSON.parse(last) as RuggerRecord) : null;
      return { address: a, rugs: mints.length, detail: `${short(a)} rugged ${mints.length} token${mints.length > 1 ? 's' : ''} before${l ? ` (last fell ${l.dropPct}%)` : ''}` };
    }
  }
  return null;
}

/**
 * Did a past token dump? Snapshots in time order (CREATION, M1, M5, M15, H1).
 * Rug = ran ≥1.5× above launch, then fell ≥ dropPct from that peak by the hour
 * mark while the dev cut their holding by at least half. Pure.
 */
export function isRugOutcome(points: ReadonlyArray<{ marketCapSol: number; devHoldingPct: number }>, dropPct: number): number | null {
  if (points.length < 3) return null;
  const launch = points[0]!;
  let peak = 0;
  let peakIdx = 0;
  points.forEach((p, k) => {
    if (k > 0 && p.marketCapSol > peak) [peak, peakIdx] = [p.marketCapSol, k];
  });
  const after = points.slice(peakIdx + 1);
  if (!after.length || peak < launch.marketCapSol * 1.5) return null;
  const low = Math.min(...after.map((p) => p.marketCapSol));
  const drop = (1 - low / peak) * 100;
  const devDumped = launch.devHoldingPct > 0.5 && points[points.length - 1]!.devHoldingPct <= launch.devHoldingPct / 2;
  return drop >= dropPct && devDumped ? Math.round(drop) : null;
}

const RUG_INTERVALS = ['CREATION', 'M1', 'M5', 'M15', 'H1'] as const;

/**
 * Serial-rugger check: Redis memory first (free), then the creator's previous
 * tokens in our own database (snapshots + RUGGED status). DB finds are
 * remembered in Redis. Never throws.
 */
export async function serialRuggerCheck(redis: Redis, mint: string, creator: string, funder: string | null, c: AntiRugConfig = antiRugConfig()): Promise<{ address: string; rugs: number; detail: string } | null> {
  if (!c.serialRuggerEnabled) return null;
  try {
    const mem = await findRugger(redis, [creator, funder], c.serialRugMinRugs, mint);
    if (mem) return mem;
    const prior = await prisma.token.findMany({ where: { creator, mint: { not: mint } }, select: { mint: true, status: true }, orderBy: { createdAt: 'desc' }, take: 20 });
    if (!prior.length) return null;
    const snaps = await prisma.tokenSnapshot.findMany({
      where: { mint: { in: prior.map((p) => p.mint) }, interval: { in: [...RUG_INTERVALS] } },
      select: { mint: true, interval: true, marketCapSol: true, devHoldingPct: true },
    });
    let rugs = 0;
    for (const p of prior) {
      const pts = RUG_INTERVALS.map((iv) => snaps.find((s) => s.mint === p.mint && s.interval === iv)).filter((s): s is NonNullable<typeof s> => !!s);
      const drop = p.status === 'RUGGED' ? 100 : isRugOutcome(pts, c.serialRugDropPct);
      if (drop !== null) {
        rugs++;
        await rememberRugger(redis, creator, { mint: p.mint, dropPct: drop, via: 'db' }, c.serialRugMemoryDays);
      }
    }
    return rugs >= c.serialRugMinRugs && rugs > 0 ? await findRugger(redis, [creator], c.serialRugMinRugs, mint) : null;
  } catch (err) {
    log.debug({ mint, err: (err as Error).message }, 'serial-rugger check failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Live rug watch while holding
// ---------------------------------------------------------------------------

/**
 * Did the insiders (dev + hidden dev wallets + cluster) sell more than
 * `insiderDumpPct` of their bag within the last `insiderDumpWindowSec`?
 * Call it on every position check (it records a snapshot each time); cheap —
 * Redis only. Uses the cluster saved by the last analysis, else the stream flags.
 */
export async function insiderDumpSignal(redis: Redis, mint: string, opts: { cfg?: AntiRugConfig; now?: number } = {}): Promise<{ dumping: boolean; reason: string }> {
  const c = opts.cfg ?? antiRugConfig();
  const now = opts.now ?? Date.now();
  const [creator, supplyS] = await redis.hmget(liveKey(mint), 'creator', 'supply');
  if (!creator) return { dumping: false, reason: 'no live state' };
  const supply = Number(supplyS ?? 0) || 1e15;
  let members = await redis.smembers(insKey.cluster(mint));
  if (!members.length) {
    const f = await readStreamFlags(redis, mint);
    members = [creator, ...(await redis.smembers(earlyKey(mint))), ...f.bundle, ...f.burst, ...f.transfer, ...f.devSync];
  }
  members = [...new Set(members)];
  if (!members.length) return { dumping: false, reason: 'no insiders known' };

  const bals = await redis.hmget(balKey(mint), ...members);
  const total = bals.reduce((s, b) => s + (b ? BigInt(b) : 0n), 0n);
  const key = insKey.dump(mint);
  const prev = (await redis.lrange(key, 0, -1))
    .map((s) => s.split(':'))
    .map(([t, v]) => ({ t: Number(t), v: BigInt(v ?? '0') }))
    .filter((p) => Number.isFinite(p.t) && now - p.t <= c.insiderDumpWindowSec * 1000);
  await redis.lpush(key, `${now}:${total}`);
  await redis.ltrim(key, 0, 199);
  await redis.expire(key, LIVE_STATE_TTL_SECONDS);

  const base = prev.reduce((m, p) => (p.v > m ? p.v : m), total);
  const basePct = pct(base, supply);
  if (basePct < c.insiderDumpMinClusterPct) return { dumping: false, reason: `insiders hold only ${f1(basePct)}%` };
  const soldPct = base > 0n ? (Number(base - total) / Number(base)) * 100 : 0;
  const reason = `insiders (${members.length} wallets) sold ${soldPct.toFixed(0)}% of their bag in ${c.insiderDumpWindowSec}s (${f1(basePct)}% → ${f1(pct(total, supply))}% of supply)`;
  return { dumping: soldPct >= c.insiderDumpPct, reason };
}
