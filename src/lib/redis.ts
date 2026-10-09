/**
 * Redis connections.
 *
 * BullMQ needs `maxRetriesPerRequest: null` so its blocking commands never
 * time out, so we give it its own connection factory.
 */
import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { moduleLogger } from './logger';

const log = moduleLogger('redis');

const baseOptions: RedisOptions = {
  // Keep retrying forever with a capped backoff — a Redis blip must not crash the bot.
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

/** General-purpose connection used for live token state. */
export const redis = new Redis(env.REDIS_URL, { ...baseOptions, maxRetriesPerRequest: 3 });
redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));
redis.on('reconnecting', () => log.warn('redis reconnecting'));

const bullConnections: Redis[] = [];

/** Fresh connection for BullMQ queues / workers. */
export function bullConnection(): Redis {
  const conn = new Redis(env.REDIS_URL, { ...baseOptions, maxRetriesPerRequest: null });
  conn.on('error', (err) => log.error({ err: err.message }, 'bullmq redis error'));
  bullConnections.push(conn);
  return conn;
}

/**
 * BullMQ doesn't close connections it was handed, so we do it on shutdown
 * (otherwise the process can't exit cleanly).
 */
export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), ...bullConnections.map((c) => c.quit())]);
}
