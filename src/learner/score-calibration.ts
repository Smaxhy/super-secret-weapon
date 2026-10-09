/**
 * Score calibration — "do high scores actually win?"
 *
 * Every 15 minutes, takes the labelled evaluations of the last week (since the
 * last paper reset, bad data excluded) and measures the real win rate per
 * strategy per 5-point score band. If a band wins less than the strategy
 * overall (e.g. 85–90 scores keep failing because those coins are pumped and
 * faked), coins landing in that band lose points and get smaller size; bands
 * that beat the average get a small bonus. The raw score stays visible; the
 * correction is shown in the buy explanation.
 */
import type { Redis } from 'ioredis';
import { getConfig } from '../config/runtime-config';
import { DEFAULT_CONFIG } from '../config/default';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis as defaultRedis } from '../lib/redis';
import { resolveLabel, type PriceOutcome, type TradeOutcome } from './labels';
import { labelOptions, syncResetMarker } from './learning-data';

const log = moduleLogger('score-calibration');
export const BAND_WIDTH = 5;
const REFRESH_MS = 15 * 60_000;

export interface Band {
  strategy: string;
  lo: number;
  hi: number;
  n: number;
  winRate: number;
}

export interface Calibration {
  bands: Band[];
  base: Record<string, { n: number; winRate: number }>;
  at: number;
}

export interface CalibrationAdjust {
  points: number;
  /** Size multiplier from the band's real win rate (1 = no data / average). */
  factor: number;
  note: string | null;
}

/** Pure: win rate per strategy per score band. */
export function buildCalibration(rows: ReadonlyArray<{ strategy: string; score: number; win: boolean }>, now = Date.now()): Calibration {
  const bands = new Map<string, Band & { w: number }>();
  const base = new Map<string, { n: number; w: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.score)) continue;
    const lo = Math.floor(r.score / BAND_WIDTH) * BAND_WIDTH;
    const k = `${r.strategy}:${lo}`;
    const b = bands.get(k) ?? { strategy: r.strategy, lo, hi: lo + BAND_WIDTH, n: 0, winRate: 0, w: 0 };
    b.n++;
    if (r.win) b.w++;
    bands.set(k, b);
    const s = base.get(r.strategy) ?? { n: 0, w: 0 };
    s.n++;
    if (r.win) s.w++;
    base.set(r.strategy, s);
  }
  return {
    bands: [...bands.values()].map(({ w, ...b }) => ({ ...b, winRate: b.n ? w / b.n : 0 })).sort((a, b) => a.strategy.localeCompare(b.strategy) || a.lo - b.lo),
    base: Object.fromEntries([...base.entries()].map(([k, v]) => [k, { n: v.n, winRate: v.n ? v.w / v.n : 0 }])),
    at: now,
  };
}

/** Pure: points + size factor for a score, from its band's real record. */
export function calibrationAdjust(cal: Calibration | null, strategy: string, score: number, o = { minN: 15, maxPenalty: 10, maxBonus: 4 }): CalibrationAdjust {
  const none = { points: 0, factor: 1, note: null };
  if (!cal) return none;
  const lo = Math.floor(score / BAND_WIDTH) * BAND_WIDTH;
  const band = cal.bands.find((b) => b.strategy === strategy && b.lo === lo);
  const base = cal.base[strategy];
  if (!band || !base || band.n < o.minN || base.n < 30) return none;
  const rel = (band.winRate - base.winRate) / Math.max(base.winRate, 0.05);
  const points = Math.round(Math.max(-o.maxPenalty, Math.min(o.maxBonus, rel * 8)) * 10) / 10;
  const factor = Math.round(Math.max(0.7, Math.min(1.3, 1 + rel * 0.5)) * 100) / 100;
  if (Math.abs(points) < 0.5) return { points: 0, factor, note: null };
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return { points, factor, note: `scores ${band.lo}–${band.hi} won ${pct(band.winRate)} (n=${band.n}) vs ${pct(base.winRate)} overall → ${points > 0 ? '+' : ''}${points} pts` };
}

let current: Calibration | null = null;
let timer: NodeJS.Timeout | null = null;

export function calibration(): Calibration | null {
  return current;
}

interface Row {
  mint: string;
  strategy: string;
  score: number;
  createdAt: Date;
  outcomeMax: number | null;
  outcomeMin: number | null;
  o: Partial<PriceOutcome> | null;
  t: Partial<TradeOutcome> | null;
}

export async function refreshCalibration(r: Redis = defaultRedis): Promise<Calibration | null> {
  try {
    const l = getConfig().learning ?? DEFAULT_CONFIG.learning;
    const resetAt = await syncResetMarker(r);
    const windowStart = new Date(Date.now() - l.lookbackDays * 24 * 3600_000);
    const since = resetAt && resetAt > windowStart ? resetAt : windowStart;
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT mint, strategy::text AS strategy, COALESCE((features->>'preCalibrationScore')::float, "combinedScore") AS score, "createdAt", "outcomeMax", "outcomeMin",
             features->'outcome' AS o, features->'tradeResult' AS t
      FROM "Evaluation"
      WHERE "outcomeLabeledAt" IS NOT NULL AND "createdAt" >= ${since}
      ORDER BY "createdAt" DESC LIMIT 20000`;
    const suspicious = await prisma.botEvent.findMany({ where: { type: 'suspicious_fill', createdAt: { gte: since }, mint: { not: null } }, select: { mint: true }, distinct: ['mint'] });
    const ctx = { ...labelOptions(), since: resetAt, suspiciousMints: new Set(suspicious.map((s) => s.mint!)) };
    const labelled: Array<{ strategy: string; score: number; win: boolean }> = [];
    for (const row of rows) {
      const res = resolveLabel({ outcome: row.o, tradeResult: row.t, outcomeMax: row.outcomeMax, outcomeMin: row.outcomeMin, createdAt: new Date(row.createdAt), mint: row.mint }, ctx);
      if (!('excluded' in res)) labelled.push({ strategy: row.strategy, score: Number(row.score), win: res.win });
    }
    current = buildCalibration(labelled);
    log.debug({ labelled: labelled.length, bands: current.bands.length }, 'score calibration refreshed');
    return current;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'score calibration refresh failed');
    return current;
  }
}

export function startCalibration(): void {
  void refreshCalibration();
  timer = setInterval(() => void refreshCalibration(), REFRESH_MS);
}

export function stopCalibration(): void {
  if (timer) clearInterval(timer);
}
