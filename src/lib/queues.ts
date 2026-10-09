/**
 * Job queues (BullMQ, stored in Redis).
 *
 * Why queues instead of just calling functions?
 *   - Delayed jobs survive restarts: a "take the 6h snapshot" job scheduled
 *     before a crash still runs after the bot comes back.
 *   - Failed jobs retry automatically with backoff (RPC hiccups).
 *   - Concurrency limits stop a launch burst from flooding the RPC.
 */
import { Queue } from 'bullmq';
import type { SnapshotInterval } from '../config/types';
import { bullConnection } from './redis';

export const QUEUE_NAMES = {
  safety: 'safety-check',
  observations: 'observations',
} as const;

export interface SafetyJob {
  mint: string;
}

export interface ObservationJob {
  mint: string;
  interval: SnapshotInterval;
}

const defaultJobOptions = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 3_000 },
  // Keep a little history for debugging, but don't let Redis fill up.
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

export const safetyQueue = new Queue<SafetyJob>(QUEUE_NAMES.safety, {
  connection: bullConnection(),
  defaultJobOptions,
});

export const observationQueue = new Queue<ObservationJob>(QUEUE_NAMES.observations, {
  connection: bullConnection(),
  defaultJobOptions,
});

export async function closeQueues(): Promise<void> {
  await Promise.all([safetyQueue.close(), observationQueue.close()]);
}
