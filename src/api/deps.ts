/** What the API routes need from the running bot. */
import type { SellManager } from '../executor/sell-manager';
import type { Executor } from '../executor/types';
import type { LiveState } from '../scanner/live-state';
import type { ListenerStats } from '../scanner/pumpfun-listener';
import type { DexScreener } from '../scanner/dexscreener';
import type { MarketLeaders } from '../scanner/market-leaders';
import type { WalletPnl } from '../learner/wallet-pnl';

export interface ApiDeps {
  liveState: LiveState;
  executor: Executor;
  listenerStats: () => ListenerStats | null;
  startedAt: number;
  sellManager: SellManager;
  dex?: DexScreener | null;
  leaders?: MarketLeaders | null;
  walletPnl?: WalletPnl | null;
}

/** Classify a token for the live feed colour code. */
export type DetectionStatus = 'bought' | 'flagged' | 'interesting' | 'skipped' | 'pending';

export function detectionStatus(t: { safetyHardFail: boolean | null; combinedScore: number | null; hasPosition: boolean; createdAt: Date }): DetectionStatus {
  if (t.hasPosition) return 'bought';
  if (t.safetyHardFail) return 'flagged';
  if (t.combinedScore !== null && t.combinedScore >= 60) return 'interesting';
  // Young tokens are still being watched; older unchecked ones never got enough holders.
  if (t.safetyHardFail === null && Date.now() - t.createdAt.getTime() < 90_000) return 'pending';
  return 'skipped';
}

export const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
