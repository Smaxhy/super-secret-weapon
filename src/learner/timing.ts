/**
 * Best times to trade (owner: "check at what hours during the day it's best to trade — most motion,
 * most active — and what days").
 *
 * Two things per UTC hour of the day and per day of the week:
 *   1. MOTION — how busy pump.fun is: trades / launches / migrations per minute, recorded every minute
 *      from the live stream into Redis (`timing:d:<YYYY-MM-DD>`, kept 35 days). Minutes with no trades at
 *      all are skipped (that's our stream being down, not a quiet market).
 *   2. RESULTS — how the bot's own closed PAPER trades did when they were opened in that hour / on that day
 *      (avg result, win rate), shrunk towards the overall average so 3 lucky trades don't count as an edge.
 *
 * → for the current hour + day: a size factor (busier + better hours trade bigger, quiet + bad ones smaller)
 *   and a small buy-bar shift. It never blocks trading on its own (owner: trade more, not less).
 * Pure parts are exported for tests; the class does the Redis / DB work.
 */
import type { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('timing');

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface TimingConfig {
  enabled: boolean;
  /** Days of activity an hour needs before its motion counts. */
  minDays: number;
  /** Closed trades an hour / day needs before its results count at all. */
  minTrades: number;
  /** Shrinkage: an hour's edge counts n / (n + shrinkTrades) of its raw difference to the overall average. */
  shrinkTrades: number;
  /** Activity ratio (vs the average hour) below this = quiet, above busyRatio = busy. */
  quietRatio: number;
  busyRatio: number;
  sizeMin: number;
  sizeMax: number;
  barMin: number;
  barMax: number;
}

/** One day of minute counters: per UTC hour → minutes recorded, trades, PumpSwap trades, launches, migrations. */
export type DayCounts = Record<number, { m: number; t: number; a: number; l: number; c: number }>;

export interface SlotStats {
  /** Activity (trades per minute, launches per minute, migrations per hour). null = not enough days. */
  tradesPerMin: number | null;
  launchesPerMin: number | null;
  migrationsPerHour: number | null;
  /** Activity vs the average hour / day (1 = normal). */
  activity: number | null;
  days: number;
  /** Our closed trades opened in this slot. */
  trades: number;
  avgPct: number | null;
  winRatePct: number | null;
  /** Avg result vs the overall average, shrunk (percentage points). */
  edgePct: number;
}

export interface TimingProfile {
  at: string;
  hours: SlotStats[];
  days: SlotStats[];
  overall: { tradesPerMin: number | null; trades: number; avgPct: number | null; winRatePct: number | null; daysRecorded: number };
  /** Busiest / best hours (UTC), best first. */
  busiestHours: number[];
  bestHours: number[];
  worstHours: number[];
  bestDays: number[];
}

export interface TimingVerdict {
  sizeFactor: number;
  barDelta: number;
  why: string;
}

const NEUTRAL: TimingVerdict = { sizeFactor: 1, barDelta: 0, why: 'not enough data yet' };
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: build the profile from daily counters + closed trades. */
export function buildProfile(
  days: ReadonlyArray<{ date: string; counts: DayCounts }>,
  /** Closed trades; `w` = weight (shadow trades count less than real ones, default 1). */
  trades: ReadonlyArray<{ openedAtMs: number; pnlPct: number; w?: number }>,
  c: Pick<TimingConfig, 'minDays' | 'minTrades' | 'shrinkTrades'>,
  now = Date.now(),
): TimingProfile {
  // Motion per hour of the day and per day of the week.
  const hourAgg = Array.from({ length: 24 }, () => ({ m: 0, t: 0, l: 0, c: 0, days: new Set<string>() }));
  const dayAgg = Array.from({ length: 7 }, () => ({ m: 0, t: 0, l: 0, c: 0, days: new Set<string>() }));
  let allM = 0;
  let allT = 0;
  for (const d of days) {
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    for (const [hs, v] of Object.entries(d.counts)) {
      const h = Number(hs);
      if (!(h >= 0 && h < 24) || !(v.m > 0)) continue;
      for (const a of [hourAgg[h]!, dayAgg[dow]!]) {
        a.m += v.m;
        a.t += v.t;
        a.l += v.l;
        a.c += v.c;
      }
      // An hour needs a decent part of it recorded to count as a "day" for that hour.
      if (v.m >= 20) hourAgg[h]!.days.add(d.date);
      if (v.m >= 20) dayAgg[dow]!.days.add(d.date);
      allM += v.m;
      allT += v.t;
    }
  }
  const avgTpm = allM > 0 ? allT / allM : null;

  // Results per slot.
  const all = trades.filter((t) => Number.isFinite(t.pnlPct)).map((t) => ({ ...t, w: t.w ?? 1 }));
  const wsum = (xs: ReadonlyArray<{ w: number }>) => xs.reduce((s, x) => s + x.w, 0);
  const wavg = (xs: ReadonlyArray<{ p: number; w: number }>) => (wsum(xs) > 0 ? xs.reduce((s, x) => s + x.p * x.w, 0) / wsum(xs) : null);
  const overallAvg = wavg(all.map((t) => ({ p: t.pnlPct, w: t.w })));
  const results = (pick: (d: Date) => number, n: number) => {
    const out = Array.from({ length: n }, () => [] as Array<{ p: number; w: number }>);
    for (const t of all) out[pick(new Date(t.openedAtMs))]!.push({ p: t.pnlPct, w: t.w });
    return out;
  };
  const byHour = results((d) => d.getUTCHours(), 24);
  const byDay = results((d) => d.getUTCDay(), 7);

  const slot = (a: (typeof hourAgg)[number], res: Array<{ p: number; w: number }>, minDays: number): SlotStats => {
    const enough = a.days.size >= minDays && a.m > 0;
    const tpm = enough ? a.t / a.m : null;
    const avg = wavg(res);
    // Effective number of trades (a half-weight shadow trade counts half).
    const nEff = wsum(res);
    const edge = avg !== null && overallAvg !== null && nEff >= c.minTrades ? ((avg - overallAvg) * nEff) / (nEff + c.shrinkTrades) : 0;
    return {
      tradesPerMin: tpm === null ? null : r1(tpm),
      launchesPerMin: enough ? r2(a.l / a.m) : null,
      migrationsPerHour: enough ? r1((a.c / a.m) * 60) : null,
      activity: tpm !== null && avgTpm ? r2(tpm / avgTpm) : null,
      days: a.days.size,
      trades: res.length,
      avgPct: avg === null ? null : r1(avg),
      winRatePct: nEff > 0 ? Math.round((wsum(res.filter((x) => x.p > 0)) / nEff) * 100) : null,
      edgePct: r1(edge),
    };
  };
  const hours = hourAgg.map((a, h) => slot(a, byHour[h]!, c.minDays));
  // A weekday is seen once a week → 2 of them is already a fair read.
  const dayStats = dayAgg.map((a, d) => slot(a, byDay[d]!, Math.min(2, c.minDays)));
  const rank = (xs: SlotStats[], key: (s: SlotStats) => number | null, take: number, dir = -1) =>
    xs
      .map((s, i) => ({ i, v: key(s) }))
      .filter((x): x is { i: number; v: number } => x.v !== null)
      .sort((a, b) => dir * (a.v - b.v))
      .slice(0, take)
      .map((x) => x.i);
  return {
    at: new Date(now).toISOString(),
    hours,
    days: dayStats,
    overall: {
      tradesPerMin: avgTpm === null ? null : r1(avgTpm),
      trades: all.length,
      avgPct: overallAvg === null ? null : r1(overallAvg),
      winRatePct: wsum(all) > 0 ? Math.round((wsum(all.filter((t) => t.pnlPct > 0)) / wsum(all)) * 100) : null,
      daysRecorded: days.filter((d) => Object.values(d.counts).some((v) => v.m > 0)).length,
    },
    busiestHours: rank(hours, (s) => s.activity, 4),
    bestHours: rank(hours.map((s) => (s.trades >= c.minTrades ? s : { ...s, edgePct: NaN })), (s) => (Number.isFinite(s.edgePct) && s.edgePct > 0 ? s.edgePct : null), 4),
    worstHours: rank(hours.map((s) => (s.trades >= c.minTrades ? s : { ...s, edgePct: NaN })), (s) => (Number.isFinite(s.edgePct) && s.edgePct < 0 ? s.edgePct : null), 4, 1),
    bestDays: rank(dayStats, (s) => (s.trades >= c.minTrades && s.edgePct > 0 ? s.edgePct : null), 3),
  };
}

/** Pure: size factor + bar shift for a moment, from the profile. */
export function timingVerdict(p: TimingProfile | null, atMs: number, c: TimingConfig): TimingVerdict {
  if (!c.enabled || !p) return NEUTRAL;
  const d = new Date(atMs);
  const h = p.hours[d.getUTCHours()];
  const day = p.days[d.getUTCDay()];
  if (!h || !day) return NEUTRAL;
  const act = (h.activity ?? 1) * (day.activity ?? 1);
  const edge = h.edgePct + 0.5 * day.edgePct;
  const why: string[] = [];
  let size = 1;
  // Motion: a busier market means more real buyers and more room to get out (±15%).
  if (h.activity !== null || day.activity !== null) {
    size += Math.max(-0.15, Math.min(0.15, 0.25 * (act - 1)));
    if (act >= c.busyRatio) why.push(`busy time (${act.toFixed(1)}× the usual trading)`);
    else if (act <= c.quietRatio) why.push(`quiet time (${act.toFixed(1)}× the usual trading)`);
  }
  // Results: our own trades at this hour / on this day.
  size += Math.max(-0.15, Math.min(0.15, edge * 0.015));
  if (Math.abs(h.edgePct) >= 2 && h.trades >= c.minTrades) why.push(`${d.getUTCHours()}:00 UTC trades ${h.edgePct > 0 ? 'better' : 'worse'} than average (${h.avgPct}% avg over ${h.trades})`);
  if (Math.abs(day.edgePct) >= 2 && day.trades >= c.minTrades) why.push(`${DAY_NAMES[d.getUTCDay()]}s ${day.edgePct > 0 ? 'better' : 'worse'} than average (${day.avgPct}% avg over ${day.trades})`);
  let bar = Math.round(-edge / 3) || 0;
  if (act <= c.quietRatio) bar += 1;
  else if (act >= c.busyRatio) bar -= 1;
  return {
    sizeFactor: r2(Math.max(c.sizeMin, Math.min(c.sizeMax, size))),
    barDelta: Math.max(c.barMin, Math.min(c.barMax, bar)) || 0,
    why: why.length ? why.join('; ') : 'normal time',
  };
}

let profile: TimingProfile | null = null;
let cfgRef: (() => TimingConfig) | null = null;
/** What the current hour + day mean for size and the buy bar (neutral until there is data). */
export function timingNow(atMs = Date.now()): TimingVerdict {
  return cfgRef ? timingVerdict(profile, atMs, cfgRef()) : NEUTRAL;
}

const dayKey = (ms: number) => `timing:d:${new Date(ms).toISOString().slice(0, 10)}`;

export class TimingLearner {
  private timer: NodeJS.Timeout | null = null;
  /** Shadow trades the bot would have taken, with their weight (set in index.ts). */
  shadowSource: ((sinceMs: number) => Promise<Array<{ openedAtMs: number; pnlPct: number; w: number }>>) | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: () => TimingConfig,
  ) {
    cfgRef = cfg;
  }

  /** One minute of market activity from the live stream (called every minute). */
  async recordMinute(m: { trades: number; ammTrades: number; launches: number; migrations: number }, atMs = Date.now()): Promise<void> {
    // No trades at all = our stream was down, not a quiet market.
    if (!(m.trades > 0)) return;
    const h = new Date(atMs).getUTCHours();
    const k = dayKey(atMs);
    await this.redis
      .multi()
      .hincrby(k, `${h}:m`, 1)
      .hincrby(k, `${h}:t`, Math.max(0, Math.round(m.trades)))
      .hincrby(k, `${h}:a`, Math.max(0, Math.round(m.ammTrades)))
      .hincrby(k, `${h}:l`, Math.max(0, Math.round(m.launches)))
      .hincrby(k, `${h}:c`, Math.max(0, Math.round(m.migrations)))
      .expire(k, 35 * 86_400)
      .exec();
  }

  async refresh(now = Date.now()): Promise<TimingProfile> {
    const c = this.cfg();
    const days: Array<{ date: string; counts: DayCounts }> = [];
    const keys = Array.from({ length: 28 }, (_, i) => dayKey(now - i * 86_400_000));
    const raws = await Promise.all(keys.map((k) => this.redis.hgetall(k)));
    raws.forEach((raw, i) => {
      const counts: DayCounts = {};
      for (const [f, v] of Object.entries(raw)) {
        const [hs, kind] = f.split(':');
        const h = Number(hs);
        if (!Number.isInteger(h) || !kind) continue;
        const slot = (counts[h] ??= { m: 0, t: 0, a: 0, l: 0, c: 0 });
        if (kind in slot) slot[kind as keyof typeof slot] = Number(v) || 0;
      }
      days.push({ date: keys[i]!.slice('timing:d:'.length), counts });
    });
    // Time-of-day effects are market-wide, so 30 days of trades (not just since the last reset).
    const rows = await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: new Date(now - 30 * 86_400_000) } },
      select: { openedAt: true, sizeSol: true, realizedPnlSol: true },
    });
    const trades: Array<{ openedAtMs: number; pnlPct: number; w?: number }> = rows.filter((r) => r.sizeSol > 0).map((r) => ({ openedAtMs: r.openedAt.getTime(), pnlPct: (r.realizedPnlSol / r.sizeSol) * 100 }));
    if (this.shadowSource) trades.push(...(await this.shadowSource(now - 30 * 86_400_000).catch(() => [])));
    profile = buildProfile(days, trades, c, now);
    await this.redis.set('timing:last', JSON.stringify(profile), 'EX', 7 * 86_400);
    return profile;
  }

  snapshot(): (TimingProfile & { now: TimingVerdict }) | null {
    return profile ? { ...profile, now: timingNow() } : null;
  }

  start(): void {
    void this.redis
      .get('timing:last')
      .then((raw) => {
        if (raw && !profile) profile = JSON.parse(raw) as TimingProfile;
      })
      .catch(() => undefined);
    const tick = () => void this.refresh().catch((err: Error) => log.warn({ err: err.message }, 'timing refresh failed'));
    setTimeout(tick, 60_000);
    this.timer = setInterval(tick, 15 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
