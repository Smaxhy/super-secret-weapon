/**
 * Position price history — feeds the per-position price chart on the dashboard.
 *
 * The sell manager already publishes a 'positions' event on the in-process bus
 * every ~2 seconds with each open position's live price. We listen to that and
 * save at most one point per position every 5 seconds into Redis:
 *
 *   key  pos:hist:<positionId>   (a Redis list, oldest → newest)
 *   item {"t":1700000000000,"p":0.000000031}   (unix ms + price in SOL)
 *
 * Each list is capped at ~2000 points (≈ 2.8 hours at one point per 5s; older
 * points drop off the front) and expires 3 days after the last write, so closed
 * positions can still be charted for a while and then clean themselves up.
 */
import { bus, type BusEvent } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { redis } from '../lib/redis';

const log = moduleLogger('position-history');

/** Minimum gap between two stored points for the same position. */
export const HISTORY_MIN_GAP_MS = 1_000;
/** Max points kept per position (oldest are dropped). */
export const HISTORY_MAX_POINTS = 6_000;
/** History lives this long after the last write. */
export const HISTORY_TTL_SEC = 3 * 24 * 60 * 60;

export interface HistoryPoint {
  /** Unix time in milliseconds. */
  t: number;
  /** Price of one whole token in SOL. */
  priceSol: number;
}

export function historyKey(positionId: string): string {
  return `pos:hist:${positionId}`;
}

/** Compact JSON for Redis: {"t":…, "p":…}. */
export function serializePoint(pt: HistoryPoint): string {
  return JSON.stringify({ t: Math.round(pt.t), p: pt.priceSol });
}

/** Reverse of serializePoint. Returns null for anything broken or nonsensical. */
export function parsePoint(raw: string): HistoryPoint | null {
  try {
    const o = JSON.parse(raw) as { t?: unknown; p?: unknown };
    if (typeof o.t !== 'number' || typeof o.p !== 'number') return null;
    if (!Number.isFinite(o.t) || !Number.isFinite(o.p) || o.p <= 0) return null;
    return { t: o.t, priceSol: o.p };
  } catch {
    return null;
  }
}

/**
 * Throttle: remembers when each position last got a point and says whether a
 * new one is allowed now. Pure (no timers, no I/O) so it's easy to test.
 */
export class PointThrottle {
  private last = new Map<string, number>();

  constructor(private readonly minGapMs = HISTORY_MIN_GAP_MS) {}

  /** True (and records `now`) if this position may store a point now. */
  allow(id: string, now: number): boolean {
    const prev = this.last.get(id);
    if (prev !== undefined && now - prev < this.minGapMs) return false;
    this.last.set(id, now);
    return true;
  }

  /** Forget positions we haven't seen for a while (they've closed). */
  prune(now: number, olderThanMs = 10 * 60_000): void {
    for (const [id, t] of this.last) if (now - t > olderThanMs) this.last.delete(id);
  }

  get size(): number {
    return this.last.size;
  }
}

/** Which updates from one 'positions' event should be stored now. Pure. */
export function pickPoints(e: BusEvent, throttle: PointThrottle, now: number): Array<{ id: string; point: HistoryPoint }> {
  if (e.type !== 'positions') return [];
  const out: Array<{ id: string; point: HistoryPoint }> = [];
  for (const u of e.data.updates) {
    if (!(u.priceSol > 0) || !Number.isFinite(u.priceSol)) continue;
    const high = u.highSol;
    // A spike between checks always gets drawn (even inside the throttle gap).
    if (high && high > u.priceSol && Number.isFinite(high)) out.push({ id: u.id, point: { t: now - 1, priceSol: high } });
    else if (!throttle.allow(u.id, now)) continue;
    out.push({ id: u.id, point: { t: now, priceSol: u.priceSol } });
  }
  return out;
}

/**
 * Thin a long history for the chart: at most `max` points, keeping each bucket's
 * highest and lowest price (so spikes and dips survive) plus the first and last. Pure.
 */
export function downsample(points: readonly HistoryPoint[], max = 1_500): HistoryPoint[] {
  if (points.length <= max) return [...points];
  const buckets = Math.max(1, Math.floor((max - 2) / 2));
  const size = (points.length - 2) / buckets;
  const out: HistoryPoint[] = [points[0]!];
  for (let b = 0; b < buckets; b++) {
    const slice = points.slice(1 + Math.floor(b * size), 1 + Math.floor((b + 1) * size));
    if (!slice.length) continue;
    let lo = slice[0]!;
    let hi = slice[0]!;
    for (const p of slice) {
      if (p.priceSol < lo.priceSol) lo = p;
      if (p.priceSol > hi.priceSol) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t <= hi.t ? [lo, hi] : [hi, lo]));
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Read a position's stored history (oldest → newest). Empty if none / Redis down. */
export async function readHistory(positionId: string): Promise<HistoryPoint[]> {
  const raw = await redis.lrange(historyKey(positionId), 0, -1).catch(() => [] as string[]);
  const pts: HistoryPoint[] = [];
  for (const r of raw) {
    const p = parsePoint(r);
    if (p) pts.push(p);
  }
  return pts;
}

let listener: ((e: BusEvent) => void) | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

/** Start recording. Safe to call twice (second call does nothing). */
export function startPositionHistory(): void {
  if (listener) return;
  const throttle = new PointThrottle();
  listener = (e: BusEvent) => {
    const picked = pickPoints(e, throttle, Date.now());
    if (!picked.length) return;
    const multi = redis.multi();
    for (const { id, point } of picked) {
      const key = historyKey(id);
      multi.rpush(key, serializePoint(point));
      multi.ltrim(key, -HISTORY_MAX_POINTS, -1);
      multi.expire(key, HISTORY_TTL_SEC);
    }
    multi.exec().catch((err: Error) => log.debug({ err: err.message }, 'history write failed'));
  };
  bus.on('event', listener);
  pruneTimer = setInterval(() => throttle.prune(Date.now()), 5 * 60_000);
  pruneTimer.unref();
  log.info('position price history recorder started');
}

export function stopPositionHistory(): void {
  if (listener) bus.off('event', listener);
  listener = null;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}
