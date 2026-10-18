/** What the API routes need from the running bot. */
import type { SellManager } from '../executor/sell-manager';
import type { Executor } from '../executor/types';
import type { LiveState } from '../scanner/live-state';
import type { ListenerStats } from '../scanner/pumpfun-listener';
import type { DexScreener } from '../scanner/dexscreener';
import type { MarketLeaders } from '../scanner/market-leaders';
import type { WalletPnl } from '../learner/wallet-pnl';
import type { DipWatcher } from '../executor/dip-watcher';
import type { CrowdTracker } from '../scanner/crowd-tracker';
import type { StrategyLab } from '../learner/strategy-lab';
import type { Tournament } from '../learner/tournament';
import type { ForexLab } from '../forex/lab';
import type { Practice } from '../forex/practice';
import type { MemeReader } from '../evaluator/meme-reader';
import type { TaLab } from '../learner/ta-lab';
import type { TrendingHub } from '../scanner/trending-hub';
import type { SwingUniverse } from '../scanner/swing-universe';
import type { SwingTrader } from '../executor/swing-trader';
import type { LossAutopsy } from '../learner/loss-autopsy';
import type { TimingLearner } from '../learner/timing';
import type { ShadowTrades } from '../learner/shadow-trades';
import type { Brain } from '../learner/brain';
import type { AiCoach } from '../learner/ai-coach';
import type { TapeRecorder } from '../learner/tape-recorder';
import type { WalletBook } from '../learner/wallet-book';
import type { DeployerBook } from '../learner/deployer-book';
import type { SelfLoop } from '../learner/self-loop';

export interface ApiDeps {
  liveState: LiveState;
  executor: Executor;
  listenerStats: () => ListenerStats | null;
  startedAt: number;
  sellManager: SellManager;
  dex?: DexScreener | null;
  leaders?: MarketLeaders | null;
  walletPnl?: WalletPnl | null;
  dips?: DipWatcher | null;
  crowd?: CrowdTracker | null;
  lab?: StrategyLab | null;
  taLab?: TaLab | null;
  trending?: TrendingHub | null;
  swing?: { universe: SwingUniverse; trader: SwingTrader } | null;
  autopsy?: LossAutopsy | null;
  aiCoach?: AiCoach | null;
  timing?: TimingLearner | null;
  shadow?: ShadowTrades | null;
  brain?: Brain | null;
  /** v11.5: the tape recorder (replay engine recording). */
  tape?: TapeRecorder | null;
  /** v11.6: the wallet book (Wallets page card). */
  walletBook?: WalletBook | null;
  /** v11.10: the deployer book (GET /api/deployers). */
  deployers?: DeployerBook | null;
  /** v11.13: the self-improving loop (Brain page card). */
  selfLoop?: SelfLoop | null;
  /** v11.15: the policy tournament (Performance → Tests card). */
  tournament?: Tournament | null;
  /** v11.16: AI meme reader (today's reads, spend, recent verdicts). */
  meme?: MemeReader | null;
  /** v12: forex lab (backtest + paper of every forex strategy). */
  forex?: ForexLab | null;
  /** v12.1: forex practice account (manual trades, fake money, leverage). */
  practice?: Practice | null;
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
