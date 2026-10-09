/** Shapes returned by the bot API. */
import type { FeedStatus } from '../components/StatusBadge';

export interface Overview {
  mode: 'PAPER' | 'LIVE';
  configuredMode: 'PAPER' | 'LIVE';
  paused: boolean;
  killSwitch: boolean;
  scannerConnected: boolean;
  uptimeSec: number;
  balanceSol: number;
  startingBalanceSol: number;
  openPositions: number;
  maxPositions: number;
  totalPnlSol: number;
  todayPnlSol: number;
  trades: number;
  winRate: number | null;
  launchesToday: number;
  cumulative: Array<{ t: string; pnl: number; symbol: string }>;
}

export interface Detection {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: string;
  status: string;
  safetyScore: number | null;
  safetyHardFail: boolean | null;
  combinedScore: number | null;
  feedStatus: FeedStatus;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  live: { holders: number; marketCapSol: number; curvePct: number; volumeSol: number; buys: number; sells: number; devHoldingPct: number } | null;
}

export interface OpenPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  strategy: string;
  openedAt: string;
  sizeSol: number;
  remainingPct: number;
  entryPriceSol: number;
  currentPriceSol: number | null;
  peakPriceSol: number;
  multiple: number | null;
  unrealizedPnlSol: number | null;
  realizedPnlSol: number;
  scoreAtEntry: number | null;
  trailingActive: boolean;
  targets: { stopLossPrice: number; takeProfits: Array<{ multiple: number; sellPct: number; hit: boolean }>; trailingStopPrice: number | null };
  health: { holders: number; devHoldingPct: number; top10HolderPct: number; curvePct: number } | null;
}

export interface TradeRowData {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  strategy: string;
  entryPriceSol: number;
  exitPriceSol: number | null;
  sizeSol: number;
  pnlSol: number;
  pnlPct: number;
  holdSeconds: number | null;
  exitReason: string | null;
  scoreAtEntry: number | null;
  openedAt: string;
  closedAt: string | null;
}

export interface PerformanceData {
  mode: string;
  startingBalanceSol: number;
  totalPnlSol: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  maxDrawdownSol: number;
  maxDrawdownPct: number;
  consistency: number | null;
  best: { symbol: string; pnlSol: number; mint: string } | null;
  worst: { symbol: string; pnlSol: number; mint: string } | null;
  cumulative: Array<{ t: string; pnl: number; symbol: string }>;
  daily: Array<{ day: string; pnl: number; trades: number }>;
  byStrategy: Array<{ strategy: string; trades: number; winRate: number | null; pnlSol: number }>;
  byExitReason: Array<{ reason: string; trades: number; pnlSol: number }>;
}

export interface ScannerStatsData {
  launches24h: number;
  launches7d: number;
  completionRate7d: number | null;
  flaggedRate7d: number | null;
  rugRate7d: number | null;
  scoreHistogram: Array<{ range: string; count: number }>;
  launchesPerHour: Array<{ hour: string; count: number }>;
  regime: string | null;
  scanner: { connected: boolean; reconnects: number; creates: number; trades: number; decodeErrors: number } | null;
  rpc: { today: number; byMethodToday: Record<string, number>; estMonth: number };
  skipReasons: Array<{ reason: string; tokens: number }>;
}
