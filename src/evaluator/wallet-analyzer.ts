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
 * Only called for tokens that already look promising, to save RPC credits.
 */
import type { ParsedInstruction, ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import type { FeatureName } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getConnection } from '../lib/solana';

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
  return { creatorLaunches, creatorSuccess, funderReuse, walletAge };
}

export class WalletAnalyzer {
  constructor(private readonly redis: Redis) {}

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

    return { creator, ...chain, ...history, funderCreatorCount, funderBlacklisted };
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

/** Find who sent SOL to `wallet` in a parsed transaction (system transfer). */
export function findFunder(tx: ParsedTransactionWithMeta | null, wallet: string): string | null {
  if (!tx) return null;
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  for (const ix of all) {
    const p = (ix as ParsedInstruction).parsed as { type?: string; info?: { source?: string; destination?: string } } | undefined;
    if ((ix as ParsedInstruction).program === 'system' && p?.type === 'transfer' && p.info?.destination === wallet && p.info.source) {
      return p.info.source;
    }
  }
  return null;
}
