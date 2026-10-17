/**
 * Edge gate — reject trades where expected edge < round-trip cost.
 *
 * Uses the strategy's recent win rate and average win/loss to compute
 * expected value. A trade is blocked when the math says it'll lose money
 * after costs. Learning/probe trades bypass the gate.
 */

export interface EdgeGateConfig {
  enabled: boolean;
  /** Minimum expected edge after costs (%) — below this the trade is refused. */
  minEdgePct: number;
  /** Assumed round-trip cost (%) — pool fees + slippage + tx fees both ways. */
  costPct: number;
  /** Minimum trades for the strategy card to be trusted. */
  minTrades: number;
}

export const DEFAULT_EDGE_GATE: EdgeGateConfig = {
  enabled: true,
  minEdgePct: 2,
  costPct: 7,
  minTrades: 30,
};

export interface StrategyStats {
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  n: number;
}

export interface EdgeGateVerdict {
  pass: boolean;
  reason: string;
  expectedEdgePct: number;
}

/**
 * Pure: should this trade go through based on expected edge?
 * `scoreMargin` = score − threshold (higher = stronger conviction → better expected edge).
 */
export function edgeGateVerdict(
  stats: StrategyStats | null,
  scoreMargin: number,
  cfg: EdgeGateConfig,
): EdgeGateVerdict {
  if (!cfg.enabled) return { pass: true, reason: 'edge gate off', expectedEdgePct: 0 };
  if (!stats || stats.n < cfg.minTrades) return { pass: true, reason: `not enough data (${stats?.n ?? 0}/${cfg.minTrades} trades)`, expectedEdgePct: 0 };

  // Score margin adjusts expected win rate: every 10 points above the bar ≈ +5% to win rate (capped).
  const wr = Math.min(0.95, Math.max(0.05, stats.winRate + (scoreMargin / 10) * 0.05));
  // Expected value = winRate × avgWin − (1−winRate) × |avgLoss| − costs
  const ev = wr * stats.avgWinPct - (1 - wr) * Math.abs(stats.avgLossPct) - cfg.costPct;

  if (ev < cfg.minEdgePct) {
    return {
      pass: false,
      reason: `expected edge ${ev.toFixed(1)}% < ${cfg.minEdgePct}% (WR ${(wr * 100).toFixed(0)}%, avg win +${stats.avgWinPct.toFixed(1)}%, avg loss −${Math.abs(stats.avgLossPct).toFixed(1)}%, costs ${cfg.costPct}%)`,
      expectedEdgePct: ev,
    };
  }
  return { pass: true, reason: `expected edge +${ev.toFixed(1)}%`, expectedEdgePct: ev };
}
