/**
 * Strategy-specific parameters.
 *
 * Each strategy has its own idea of "a good entry". The scorer (Phase 2) and
 * the executors (Phase 4+) read from here. Values are defaults — the
 * dashboard can override them at runtime via the BotConfig table.
 */
import type { StrategyName } from './types';

export interface StrategyParams {
  name: StrategyName;
  description: string;
  /** Minimum unique holders before this strategy will consider a token. */
  minHolders: number;
  /** Window (minutes after launch) in which this strategy is allowed to enter. */
  entryWindowMinutes: { min: number; max: number };
  /** Bonding-curve progress (0-100) range this strategy targets. */
  curveProgressRange: { min: number; max: number };
  /** Close the position if price hasn't moved for this long. */
  staleExitMinutes: number;
  /** Max slippage tolerated on entry, in basis points (100 bps = 1%). */
  maxSlippageBps: number;
}

export const STRATEGIES: Record<StrategyName, StrategyParams> = {
  CURVE_SNIPE: {
    name: 'CURVE_SNIPE',
    description: 'New pairs: fresh coins (45 s – 12 min old) bought once the launch snipers are absorbed and real new buyers keep arriving (focus.newPair).',
    minHolders: 15,
    entryWindowMinutes: { min: 0.75, max: 12 },
    // The new-pair rules (focus.newPair) set the real zone: ≥ 8 SOL in the curve, market cap under $15k.
    curveProgressRange: { min: 0, max: 85 },
    staleExitMinutes: 20,
    // A fill more than 6% worse than the price we decided on = we were late → no trade (paper too).
    maxSlippageBps: 600,
  },
  SOON: {
    name: 'SOON',
    description: 'Coins about to graduate (curve 70%+, the "Soon" tab): real crowd, strong behaviour, swing traded.',
    minHolders: 50,
    entryWindowMinutes: { min: 0, max: 24 * 60 },
    curveProgressRange: { min: 70, max: 90 },
    staleExitMinutes: 20,
    maxSlippageBps: 800,
  },
  MIGRATION_MOMENTUM: {
    name: 'MIGRATION_MOMENTUM',
    description: 'Buys tokens right after they complete the curve and migrate, riding post-migration momentum.',
    minHolders: 40,
    entryWindowMinutes: { min: 0, max: 24 * 60 },
    curveProgressRange: { min: 100, max: 100 },
    staleExitMinutes: 60,
    maxSlippageBps: 600,
  },
  SMART_MONEY_COPY: {
    name: 'SMART_MONEY_COPY',
    description: 'Follows buys from tracked wallets with strong rolling performance scores.',
    minHolders: 10,
    entryWindowMinutes: { min: 0, max: 24 * 60 },
    curveProgressRange: { min: 0, max: 100 },
    staleExitMinutes: 120,
    maxSlippageBps: 1500,
  },
  SWING: {
    name: 'SWING',
    description: 'Bigger, established migrated coins (watchlist, trending tabs, our own grown coins) bought on a confirmed dip-and-bounce when they have shown bounce-back power (src/evaluator/swing.ts).',
    minHolders: 0,
    entryWindowMinutes: { min: 60, max: 365 * 24 * 60 },
    curveProgressRange: { min: 100, max: 100 },
    staleExitMinutes: 120,
    // Deep pools: a fill more than 4% worse than the decision price = something moved → no trade.
    maxSlippageBps: 400,
  },
};
