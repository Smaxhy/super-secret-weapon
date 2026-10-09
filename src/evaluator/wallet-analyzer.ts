/**
 * Wallet analyzer — "who is the dev, and have we seen them before?"
 *
 * Two sources:
 *   1. Our own database (free): how many tokens this creator launched in the
 *      last 24h, and how many of their past tokens ever completed the curve.
 *      Serial launchers who never complete are almost always farming rugs.
 *   2. On-chain (3 rate-limited RPC calls, cached 6h per creator):
 *      - SOL balance
 *      - wallet age + activity (oldest of the last 1000 signatures)
 *      - funding source: who sent the wallet its first SOL. If one funder has
 *        bankrolled several creators we've seen, that's a rug farm (cluster).
 *
 *   3. Hidden dev wallets / insider clusters (insider-cluster.ts): the dev and
 *      the biggest holders' first funders (≤10 wallets, cached 24h). Hidden
 *      wallets count toward the dev / bundler / single-wallet limits, and a
 *      creator or funder that rugged before is a hard fail ("serial rugger").
 *
 * Only called for tokens that already look promising, to save RPC credits.
 */
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import type { FeatureName } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getConfig } from '../config/runtime-config';
import { getConnection } from '../lib/solana';
import { analyzeInsiders, antiRugConfig, findFunder, insiderRuleFails, serialRuggerCheck, type InsiderSummary } from './insider-cluster';

const log = moduleLogger('wallet-analyzer');

const PROFILE_TTL_SECONDS = 6 * 60 * 60;
const FUNDER_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface CreatorProfile {
  creator: string;
  balanceSol: number | null;
  /** Hours since the oldest signature we could see. null = unknown. */
  walletAgeHours: number | null;
  /** True if the wallet has ≥1000 transactions (age is then a lower bound). */
  veryActive: boolean;
  funder: string | null;
  funderBlacklisted: boolean;
  /** Distinct creators (incl. this one) we've seen funded by the same wallet. */
  funderCreatorCount: number;
  launches24h: number;
  priorLaunches: number;
  priorCompleted: number;
  /** Hidden dev wallets + insider cluster (null = token state gone / not checked). */
  insider?: InsiderSummary | null;
  /** Entry-rule failures caused by hidden / insider wallets (same wording as checkEntryRules). */
  insiderFails?: string[];
  /** Set when the creator or their funder rugged tokens before. */
  serialRugger?: string | null;
  /** Hard reasons that mark the token as a safety hard fail. */
  rugBlock?: string[];
}

/**
 * Thrown by WalletAnalyzer.analyze when hidden insiders / a serial rugger make the
 * token a definite no. The token is already marked safetyHardFail in the DB, so the
 * evaluator's automatic retry (a few seconds later) records a clean REJECT.
 */
export class InsiderRugBlock extends Error {
  constructor(readonly mint: string, readonly reasons: string[]) {
    super(`insider rug check: ${reasons.join('; ')} (token marked hard-fail)`);
    this.name = 'InsiderRugBlock';
  }
}

export type WalletFeatures = Pick<Record<FeatureName, number>, 'creatorLaunches' | 'creatorSuccess' | 'funderReuse' | 'walletAge'>;

/** Used before (or instead of) the wallet analysis: neither good nor bad. */
export const NEUTRAL_WALLET_FEATURES: WalletFeatures = { creatorLaunches: 0.5, creatorSuccess: 0.5, funderReuse: 0.5, walletAge: 0.5 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function walletFeatures(p: CreatorProfile): WalletFeatures {
  // Launches in the last 24h *before* this one.
  const l = p.launches24h;
  const creatorLaunches = l === 0 ? 1 : l <= 2 ? 0.6 : l <= 9 ? 0.2 : 0;
  // Unknown history = neutral. Otherwise: share of past tokens that completed, boosted (completing is rare).
  const creatorSuccess = p.priorLaunches === 0 ? 0.5 : clamp01((p.priorCompleted / p.priorLaunches) * 3);
  const funderReuse = p.funderBlacklisted ? 0 : p.funderCreatorCount <= 1 ? 0.8 : p.funderCreatorCount === 2 ? 0.4 : 0;
  const walletAge = p.walletAgeHours === null ? 0.5 : p.veryActive ? 1 : 0.3 + 0.7 * clamp01(p.walletAgeHours / (24 * 30));
  if (p.serialRugger) return { creatorLaunches, creatorSuccess: 0, funderReuse: 0, walletAge };
  // Hidden dev wallets = the funding looks like a rug setup.
  if (p.insider && p.insider.hiddenDevWallets.length > 0) return { creatorLaunches, creatorSuccess, funderReuse: 0, walletAge };
  return { creatorLaunches, creatorSuccess, funderReuse, walletAge };
}

export class WalletAnalyzer {
  /**
   * blockByThrow: until the evaluator appends `profile.insiderFails` to its rule
   * failures itself, a definite insider rug is stopped by throwing InsiderRugBlock
   * (after marking the token hard-fail). Pass false once that hook exists.
   */
  constructor(
    private readonly redis: Redis,
    private readonly opts: { blockByThrow?: boolean } = {},
  ) {}

  async analyze(creator: string, excludeMint: string): Promise<CreatorProfile> {
    const history = await this.dbHistory(creator, excludeMint);
    const chain = await this.chainProfile(creator);

    // Cluster detection: remember which creators each funder has bankrolled.
    let funderCreatorCount = 1;
    let funderBlacklisted = false;
    if (chain.funder) {
      const k = `funder:${chain.funder}`;
      const [, count] = (await this.redis.multi().sadd(k, creator).expire(k, FUNDER_TTL_SECONDS).scard(k).exec()) ?? [];
      funderCreatorCount = Number(count?.[1] ?? 1);
      funderBlacklisted = (await prisma.blacklist.count({ where: { address: chain.funder } })) > 0;
    }

    const profile: CreatorProfile = { creator, ...chain, ...history, funderCreatorCount, funderBlacklisted };
    await this.insiderCheck(profile, excludeMint);
    return profile;
  }

  /** Hidden dev wallets, insider clusters and serial-rugger memory. Never throws except InsiderRugBlock. */
  private async insiderCheck(p: CreatorProfile, mint: string): Promise<void> {
    const c = antiRugConfig();
    const hard: string[] = [];
    try {
      const rugger = await serialRuggerCheck(this.redis, mint, p.creator, p.funder, c);
      p.serialRugger = rugger?.detail ?? null;
      if (rugger) hard.push(`serial rugger: ${rugger.detail}`);
      const res = await analyzeInsiders(this.redis, mint, {
        funding: 'rpc',
        cfg: c,
        creatorInfo: p.walletAgeHours !== null || p.funder ? { funder: p.funder, ageHours: p.walletAgeHours, veryActive: p.veryActive } : null,
      });
      p.insider = res?.summary ?? null;
      if (res) {
        const r = insiderRuleFails(res.summary, getConfig().entry);
        p.insiderFails = r.fails;
        hard.push(...r.hard);
        if (res.summary.reasons.length) log.info({ mint, creator: p.creator, reasons: res.summary.reasons, fails: r.fails }, 'insider check');
      }
    } catch (err) {
      log.warn({ mint, err: (err as Error).message }, 'insider check failed');
      return;
    }
    p.rugBlock = hard;
    if (!hard.length) return;
    await markInsiderHardFail(mint, hard, p.insider?.reasons ?? []);
    if (this.opts.blockByThrow !== false) throw new InsiderRugBlock(mint, hard);
  }

  private async dbHistory(creator: string, excludeMint: string) {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [launches24h, priorLaunches, priorCompleted] = await Promise.all([
      prisma.token.count({ where: { creator, mint: { not: excludeMint }, createdAt: { gte: since } } }),
      prisma.token.count({ where: { creator, mint: { not: excludeMint } } }),
      prisma.token.count({ where: { creator, mint: { not: excludeMint }, status: 'COMPLETED' } }),
    ]);
    return { launches24h, priorLaunches, priorCompleted };
  }

  /** On-chain facts, cached per creator. Never throws — unknowns come back as null. */
  private async chainProfile(creator: string): Promise<Pick<CreatorProfile, 'balanceSol' | 'walletAgeHours' | 'veryActive' | 'funder'>> {
    const cacheKey = `creator:${creator}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = { balanceSol: null as number | null, walletAgeHours: null as number | null, veryActive: false, funder: null as string | null };
    try {
      const conn = getConnection();
      const key = new PublicKey(creator);
      result.balanceSol = (await conn.getBalance(key)) / 1e9;
      const sigs = await conn.getSignaturesForAddress(key, { limit: 1000 });
      const oldest = sigs[sigs.length - 1];
      result.veryActive = sigs.length >= 1000;
      if (oldest?.blockTime) result.walletAgeHours = (Date.now() / 1000 - oldest.blockTime) / 3600;
      // Funding source = sender of the first SOL transfer in the wallet's oldest transaction.
      if (oldest && !result.veryActive) {
        const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        result.funder = findFunder(tx, creator);
      }
    } catch (err) {
      log.debug({ creator, err: (err as Error).message }, 'chain profile partially failed');
    }
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', PROFILE_TTL_SECONDS);
    return result;
  }
}

/** Persist an insider hard fail: a FAIL safety row + token flag, so every later checkpoint REJECTs. */
async function markInsiderHardFail(mint: string, hard: string[], reasons: string[]): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.safetyCheck.create({
        data: {
          mint,
          score: 0,
          hardFail: true,
          checks: [{ id: 'insiders', label: 'No hidden dev / insider rug setup', severity: 'FAIL', penalty: 100, detail: [...hard, ...reasons].join('; ') }] as unknown as object,
          facts: { insiderReasons: reasons } as unknown as object,
          checkedAt: new Date(),
        },
      }),
      prisma.token.update({ where: { mint }, data: { safetyScore: 0, safetyHardFail: true } }),
    ]);
  } catch (err) {
    log.warn({ mint, err: (err as Error).message }, 'could not store insider hard fail');
  }
}

/** Moved to insider-cluster.ts (shared with the funding graph); re-exported for existing imports. */
export { findFunder };
