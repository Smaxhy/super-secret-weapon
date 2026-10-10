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
  buyReason: string | null;
  /** A learning trade: a near-miss bought small so the bot learns from it. */
  learning?: boolean;
  targets: { stopLossPrice: number; takeProfits: Array<{ multiple: number; sellPct: number; hit: boolean }>; trailingStopPrice: number | null };
  health: { holders: number; devHoldingPct: number; top10HolderPct: number; curvePct: number } | null;
  /** Market cap in SOL at the moment we bought. */
  entryMarketCapSol: number;
  /** Same in USD at buy time (null for positions opened before this was recorded). */
  entryMarketCapUsd: number | null;
  /** Market cap now, in SOL and USD (USD uses the current SOL price). */
  currentMarketCapSol: number | null;
  currentMarketCapUsd: number | null;
  /** Current SOL/USD price used for the conversions above. */
  solUsd: number | null;
  /** Whole tokens in supply (normally 1 billion): market cap = priceSol × totalSupplyTokens. */
  totalSupplyTokens: number;
}

/** GET /api/positions/:id/chart — price history for one position. */
export interface PositionChartData {
  positionId: string;
  symbol: string;
  openedAt: string;
  closedAt: string | null;
  entryPriceSol: number;
  entryMarketCapSol: number;
  /** Oldest → newest; the first point is the entry. t = unix ms. */
  points: Array<{ t: number; priceSol: number; marketCapSol: number }>;
  takeProfits: Array<{ multiple: number; sellPct: number; hit: boolean }>;
  stopLossPriceSol: number;
  trailingStopPriceSol: number | null;
  peakPriceSol: number;
}

/** One entry of the WebSocket 'positions' event (sent every ~2s). */
export interface LivePositionUpdate {
  id: string;
  priceSol: number;
  /** Highest real trade since the previous update (a spike), if above priceSol. */
  highSol?: number;
  multiple: number;
  peakMultiple: number;
  unrealizedPnlSol: number;
  risk: number;
  holders: number;
  ownSupplyPct: number;
  exitImpactPct: number;
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
  peakMultiple: number;
  maxProfitSol: number;
  bestWithin1hMultiple: number | null;
  buyReason: string | null;
  sellReasons: string[];
  /** Trade coach's review (~30 min after the close). */
  lesson?: { verdict: string; lesson: string } | null;
  swing?: boolean;
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
  hotKeywords: string[];
}
