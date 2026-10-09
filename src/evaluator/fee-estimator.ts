/**
 * Total fees paid — the "Total Fees Paid" number trading terminals show.
 *
 * It's everything traders spent to trade the token:
 *   Pump.fun trading fee (protocol + creator)   ← exact, from every TradeEvent
 * + network fee (base + priority)               ← not in the log stream
 * + Jito tips                                   ← not in the log stream
 *
 * The last two are estimated by sampling the token's most recent transactions
 * (one getSignaturesForAddress + one batched getTransaction call, ~25 credits),
 * averaging them per trade, and multiplying by the total trade count.
 * Only called for tokens that already pass every other entry rule, and
 * cached for a minute, so it costs little.
 *
 * Tips paid to other block-engine services (not Jito) aren't counted, so the
 * result is a slight under-estimate — i.e. the 1 SOL rule stays conservative.
 */
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { getConnection } from '../lib/solana';

const log = moduleLogger('fee-estimator');

const SAMPLE_SIZE = 25;
const CACHE_SECONDS = 60;

/** Jito's published tip accounts. */
export const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

/** Network fee + Jito tips in one transaction, in lamports. Pure — exported for tests. */
export function extraFeeLamports(tx: VersionedTransactionResponse): number {
  const meta = tx.meta;
  if (!meta) return 0;
  let total = meta.fee;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  for (let i = 0; i < keys.length; i++) {
    const k = keys.get(i)?.toBase58();
    if (k && JITO_TIP_ACCOUNTS.has(k)) {
      const gained = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
      if (gained > 0) total += gained;
    }
  }
  return total;
}

export interface FeeEstimate {
  totalFeesSol: number;
  protocolFeesSol: number;
  extraPerTradeSol: number;
  sampled: number;
}

export class FeeEstimator {
  constructor(private readonly redis: Redis) {}

  /**
   * @param bondingCurve the token's curve account (every trade touches it)
   * @param trades total buys + sells so far
   * @param protocolFeesSol exact Pump.fun fees from the event stream
   */
  async estimate(mint: string, bondingCurve: string, trades: number, protocolFeesSol: number): Promise<FeeEstimate> {
    const cacheKey = `fees:extra:${mint}`;
    let perTrade: { extra: number; sampled: number } | null = null;
    const cached = await this.redis.get(cacheKey);
    if (cached) perTrade = JSON.parse(cached);

    if (!perTrade) {
      try {
        const conn = getConnection();
        const sigs = (await conn.getSignaturesForAddress(new PublicKey(bondingCurve), { limit: SAMPLE_SIZE })).filter((s) => !s.err).map((s) => s.signature);
        const txs = sigs.length ? await conn.getTransactions(sigs, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }) : [];
        const ok = txs.filter((t): t is VersionedTransactionResponse => !!t?.meta);
        const avg = ok.length ? ok.reduce((s, t) => s + extraFeeLamports(t), 0) / ok.length / 1e9 : 0;
        perTrade = { extra: avg, sampled: ok.length };
        await this.redis.set(cacheKey, JSON.stringify(perTrade), 'EX', CACHE_SECONDS);
      } catch (err) {
        log.debug({ mint, err: (err as Error).message }, 'fee sampling failed — using protocol fees only');
        perTrade = { extra: 0, sampled: 0 };
      }
    }

    return {
      totalFeesSol: protocolFeesSol + perTrade.extra * trades,
      protocolFeesSol,
      extraPerTradeSol: perTrade.extra,
      sampled: perTrade.sampled,
    };
  }
}
