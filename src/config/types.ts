/**
 * Shared TypeScript types used across the whole bot.
 *
 * Convention: anything called `...Lamports` or `...Raw` is a bigint in the
 * smallest on-chain unit. Anything called `...Sol` / `...Tokens` is a plain
 * human-readable number. Convert at the edges, never in the middle.
 */

// ---------------------------------------------------------------------------
// Bot-wide enums
// ---------------------------------------------------------------------------

export type TradingMode = 'PAPER' | 'LIVE';

export type StrategyName = 'CURVE_SNIPE' | 'MIGRATION_MOMENTUM' | 'SMART_MONEY_COPY';

export type MarketRegime = 'HOT' | 'NORMAL' | 'COLD' | 'RUG_HEAVY';

/** The fixed points in a token's life where we take an observation snapshot. */
export type SnapshotInterval = 'CREATION' | 'M1' | 'M5' | 'M15' | 'H1' | 'H6' | 'H24';

// ---------------------------------------------------------------------------
// Pump.fun on-chain events (decoded from program logs)
// ---------------------------------------------------------------------------

/** Emitted once when a new token is launched on Pump.fun. */
export interface PumpCreateEvent {
  kind: 'create';
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  /** Wallet that signed the create transaction (the "dev"). */
  user: string;
  /** Creator recorded on the curve (normally the same as `user`). */
  creator: string;
  timestamp: number; // unix seconds
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** SPL Token or Token-2022 program that owns the mint (newer launches only). */
  tokenProgram?: string;
}

/** Emitted on every buy or sell against a bonding curve. */
export interface PumpTradeEvent {
  kind: 'trade';
  mint: string;
  solAmount: bigint; // lamports
  tokenAmount: bigint; // raw token units (6 decimals)
  isBuy: boolean;
  user: string;
  timestamp: number;
  /** Curve reserves AFTER this trade — gives us price without any RPC call. */
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** Only present on newer program versions. */
  realSolReserves?: bigint;
  realTokenReserves?: bigint;
  /** Protocol + creator fee paid on this trade (lamports). Newer program versions only. */
  feeLamports?: bigint;
}

/** Emitted when a bonding curve fills up (token is about to migrate). */
export interface PumpCompleteEvent {
  kind: 'complete';
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
}

export type PumpEvent = PumpCreateEvent | PumpTradeEvent | PumpCompleteEvent;

/** One decoded event plus the transaction it came from. */
export interface PumpEventEnvelope {
  signature: string;
  slot: number;
  event: PumpEvent;
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

export type CheckSeverity = 'PASS' | 'WARN' | 'FAIL';

export interface SafetyCheckItem {
  /** Machine-readable id, e.g. "mint_authority". */
  id: string;
  label: string;
  severity: CheckSeverity;
  /** Points removed from 100 for this item. */
  penalty: number;
  detail: string;
}

export interface SafetyReport {
  mint: string;
  /** 0-100, higher is safer. */
  score: number;
  /** True if any check is a hard FAIL (auto-reject regardless of score). */
  hardFail: boolean;
  checks: SafetyCheckItem[];
  checkedAt: Date;
  /** Raw facts we learned, stored for later analysis / ML features. */
  facts: {
    tokenProgram: string;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    decimals: number;
    supplyRaw: string;
    extensions: string[];
    devInitialBuyPct: number | null;
  };
}

// ---------------------------------------------------------------------------
// Observation snapshots
// ---------------------------------------------------------------------------

/** Live per-token stats kept in Redis and updated on every trade. */
export interface LiveTokenState {
  mint: string;
  creator: string;
  createdAt: number; // unix ms
  buys: number;
  sells: number;
  buyVolumeLamports: bigint;
  sellVolumeLamports: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint | null;
  complete: boolean;
  lastTradeAt: number | null; // unix ms
}

export interface ObservationSnapshot {
  mint: string;
  interval: SnapshotInterval;
  takenAt: Date;
  ageSeconds: number;
  holderCount: number;
  uniqueWallets: number;
  bondingCurvePct: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  buySellRatio: number;
  devHoldingPct: number;
  top10HolderPct: number;
  priceSol: number;
  marketCapSol: number;
  isComplete: boolean;
}
