/**
 * Regime detector — "what kind of market is this right now?"
 *
 * Experienced traders size down when nothing is working and lean in when the
 * tape is hot. We measure that two ways, every few minutes, from our own data:
 *
 *   market:  share of launches in the last 6h that completed the curve,
 *            compared with the trailing 7-day baseline (HOT / COLD),
 *   us:      our last closed trades — win rate and how many ended as rugs /
 *            hard stops (RUG_HEAVY, COLD).
 *
 * The result feeds `regimeAdjustments` in config: a size multiplier for the
 * trader and a threshold delta for the evaluator. A snapshot is stored in
 * RegimeSnapshot whenever the regime changes (and at least hourly).
 */
import type { MarketRegime } from '@prisma/client';
import { getConfig } from '../config/runtime-config';
import { bus } from '../lib/bus';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('regime');

const WINDOW_MS = 6 * 60 * 60_000;
const BASELINE_MS = 7 * 24 * 60 * 60_000;
const RECENT_TRADES = 20;
const REFRESH_MS = 5 * 60_000;
const SNAPSHOT_AT_LEAST_MS = 60 * 60_000;

export interface RegimeStats {
  launches6h: number;
  completed6h: number;
  completionRate6h: number;
  baselineCompletionRate: number;
  recentTrades: number;
  recentWinRate: number | null;
  recentRugRate: number | null;
  recentPnlSol: number;
}

/** Pure classification — exported for tests and the backtester. */
export function classifyRegime(s: RegimeStats): MarketRegime {
  const enoughTrades = s.recentTrades >= 8;
  if (enoughTrades && (s.recentRugRate ?? 0) >= 0.5) return 'RUG_HEAVY';
  const enoughLaunches = s.launches6h >= 50 && s.baselineCompletionRate > 0;
  const ratio = enoughLaunches ? s.completionRate6h / s.baselineCompletionRate : 1;
  if (enoughTrades && (s.recentWinRate ?? 1) < 0.25 && s.recentPnlSol < 0) return 'COLD';
  if (enoughLaunches && ratio < 0.5) return 'COLD';
  if (ratio > 1.5 && (!enoughTrades || (s.recentWinRate ?? 0) >= 0.45)) return 'HOT';
  return 'NORMAL';
}

let current: MarketRegime = 'NORMAL';
let lastStats: RegimeStats | null = null;

export function getRegime(): MarketRegime {
  return current;
}

export function getRegimeStats(): RegimeStats | null {
  return lastStats;
}

/** Size multiplier and score-threshold delta for the current regime (or NORMAL if disabled). */
export function regimeAdjustment(): { regime: MarketRegime; sizeMultiplier: number; scoreThresholdDelta: number } {
  const cfg = getConfig();
  const regime = cfg.scoring.useRegime ? current : 'NORMAL';
  const adj = cfg.regimeAdjustments[regime];
  return { regime, sizeMultiplier: adj.sizeMultiplier, scoreThresholdDelta: adj.scoreThresholdDelta };
}

export class RegimeDetector {
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;

  constructor(private readonly mode: 'PAPER' | 'LIVE') {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const stats = await this.collect();
      const regime = classifyRegime(stats);
      const prev = current;
      const changed = regime !== prev;
      current = regime;
      lastStats = stats;
      if (changed || Date.now() - this.lastSnapshotAt >= SNAPSHOT_AT_LEAST_MS) {
        this.lastSnapshotAt = Date.now();
        await prisma.regimeSnapshot.create({ data: { regime, stats: JSON.parse(JSON.stringify(stats)) } });
        if (changed) {
          log.info({ regime, ...stats }, `🌡️  market regime → ${regime}`);
          bus.publish({ type: 'regime_change', data: { from: prev, to: regime, stats: JSON.parse(JSON.stringify(stats)) } });
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'regime refresh failed — keeping previous regime');
    }
  }

  private async collect(): Promise<RegimeStats> {
    const now = Date.now();
    const since6h = new Date(now - WINDOW_MS);
    const since7d = new Date(now - BASELINE_MS);
    const [launches6h, completed6h, launches7d, completed7d, recent] = await Promise.all([
      prisma.token.count({ where: { createdAt: { gte: since6h } } }),
      prisma.token.count({ where: { createdAt: { gte: since6h }, status: 'COMPLETED' } }),
      prisma.token.count({ where: { createdAt: { gte: since7d, lt: since6h } } }),
      prisma.token.count({ where: { createdAt: { gte: since7d, lt: since6h }, status: 'COMPLETED' } }),
      prisma.position.findMany({
        where: { mode: this.mode, status: 'CLOSED' },
        orderBy: { closedAt: 'desc' },
        take: RECENT_TRADES,
        select: { realizedPnlSol: true, exitReason: true },
      }),
    ]);
    const wins = recent.filter((p) => p.realizedPnlSol > 0).length;
    const rugs = recent.filter((p) => p.exitReason === 'RUG_DETECTED' || p.exitReason === 'STOP_LOSS').length;
    return {
      launches6h,
      completed6h,
      completionRate6h: launches6h ? completed6h / launches6h : 0,
      baselineCompletionRate: launches7d ? completed7d / launches7d : 0,
      recentTrades: recent.length,
      recentWinRate: recent.length ? wins / recent.length : null,
      recentRugRate: recent.length ? rugs / recent.length : null,
      recentPnlSol: recent.reduce((s, p) => s + p.realizedPnlSol, 0),
    };
  }
}
