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
    description: 'Early entries on the Pump.fun bonding curve for tokens that pass safety + early-traction checks.',
    minHolders: 15,
    entryWindowMinutes: { min: 0, max: 30 },
    // Upper bound is high because the $12k market-cap rule is only met once
    // the curve is ~55-70% full (depends on SOL price). Completed curves are
    // still excluded by their own rule.
    curveProgressRange: { min: 5, max: 95 },
    staleExitMinutes: 30,
    maxSlippageBps: 1500,
  },
  SOON: {
    name: 'SOON',
    description: 'Coins about to graduate (curve 70%+, the "Soon" tab): real crowd, strong behaviour, swing traded.',
    minHolders: 50,
    entryWindowMinutes: { min: 0, max: 24 * 60 },
    curveProgressRange: { min: 70, max: 99.5 },
    staleExitMinutes: 20,
    maxSlippageBps: 1500,
  },
  MIGRATION_MOMENTUM: {
    name: 'MIGRATION_MOMENTUM',
    description: 'Buys tokens right after they complete the curve and migrate, riding post-migration momentum.',
    minHolders: 40,
    entryWindowMinutes: { min: 0, max: 24 * 60 },
    curveProgressRange: { min: 100, max: 100 },
    staleExitMinutes: 120,
    maxSlippageBps: 1000,
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
};
