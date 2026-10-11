/**
 * Named market scenarios used by the scenario backtest. Each is a realistic
 * shape a Pump.fun launch takes; the suite checks the new rules do the right
 * thing on each AND beat the legacy rules in aggregate.
 */
import type { TapeTrade } from '../src/scanner/live-state';
import type { TokenMeta } from '../src/learner/backtester';
import { makeCurveTape, makeTape, meta, noisy, path } from './tape-helpers';

export interface Scenario {
  name: string;
  tape: TapeTrade[];
  meta: TokenMeta;
}

/** Price multiples relative to launch. 3x ≈ 65% curve, MC ≈ 90 SOL. */
export const SCENARIOS: Scenario[] = [
  {
    // Steady organic runner: 1x → 7x over 12 minutes, then a slow 50% fade over 10 more.
    name: 'runner-then-fade',
    tape: makeTape({ price: noisy(path([[0, 1], [60, 1.8], [240, 3], [480, 5], [720, 7], [900, 6], [1320, 3.5]]), 2.5, 3), durationSec: 1320, tradeEverySec: 1.2, wallets: 120, avgSizeSol: 0.5, seed: 11 }),
    meta: meta({ mint: 'RUNNER', symbol: 'RUN' }),
  },
  {
    // Pump and rug: 1x → 4x in 2 minutes with a few wallets, then a cliff to 0.3x.
    name: 'pump-and-rug',
    tape: makeTape({
      price: path([[0, 1], [40, 2], [120, 4], [135, 2.2], [160, 0.9], [200, 0.3], [600, 0.25]]),
      durationSec: 600,
      tradeEverySec: 1,
      wallets: 70,
      avgSizeSol: 0.6,
      buyProbDown: 0.1,
      seed: 5,
      size: (t, r, isBuy) => (!isBuy && t > 120 && t < 140 ? 4 + r * 4 : undefined),
    }),
    meta: meta({ mint: 'RUG', symbol: 'RUG' }),
  },
  {
    // Good start, then chops below entry for 25 minutes: capital dead.
    name: 'failing-chop',
    tape: makeTape({ price: noisy(path([[0, 1], [90, 2.4], [150, 2.5], [200, 2.1], [1600, 1.9]]), 2, 9), durationSec: 1600, tradeEverySec: 2.5, wallets: 60, avgSizeSol: 0.5, seed: 21 }),
    meta: meta({ mint: 'CHOP', symbol: 'CHOP' }),
  },
  {
    // Strong trend with healthy pullbacks all the way to 10x — the one you must not sell early.
    name: 'strong-trend-10x',
    tape: makeTape({
      price: noisy(path([[0, 1], [60, 1.7], [120, 2.6], [150, 2.2], [240, 3.8], [280, 3.2], [400, 5.5], [450, 4.7], [600, 7.5], [660, 6.5], [840, 10], [900, 9.6], [1100, 9.8]]), 2, 4),
      durationSec: 1100,
      tradeEverySec: 1,
      wallets: 150,
      avgSizeSol: 0.6,
      buyProbDown: 0.45,
      seed: 31,
    }),
    meta: meta({ mint: 'TREND', symbol: 'TREND' }),
  },
  {
    // Vertical bot pump exactly at a checkpoint, then it bleeds — buying the top.
    name: 'vertical-top',
    tape: makeTape({
      price: path([[0, 1], [120, 1.6], [150, 1.7], [180, 4.2], [210, 3.5], [300, 2.4], [600, 1.5], [900, 1.2]]),
      durationSec: 900,
      tradeEverySec: 1,
      wallets: 50,
      avgSizeSol: 0.7,
      buyProbUp: 0.95,
      buyProbDown: 0.3,
      seed: 41,
    }),
    meta: meta({ mint: 'TOP', symbol: 'TOP' }),
  },
  {
    // Slow grinder: 1x → 3.2x over 15 minutes, holds — a modest winner.
    name: 'slow-grinder',
    tape: makeTape({ price: noisy(path([[0, 1], [300, 1.9], [600, 2.6], [900, 3.2], [1500, 3.3]]), 2, 8), durationSec: 1500, tradeEverySec: 2, wallets: 90, avgSizeSol: 0.45, seed: 51 }),
    meta: meta({ mint: 'GRIND', symbol: 'GRIND' }),
  },
  {
    // Breakout then dev dumps 60% of their bag at 3x.
    name: 'dev-dump',
    tape: (() => {
      const t = makeTape({ price: path([[0, 1], [120, 2.2], [240, 3.1], [250, 2.3], [300, 1.6], [700, 1.1]]), durationSec: 700, tradeEverySec: 1, wallets: 80, avgSizeSol: 0.5, seed: 61, devBuySol: 2 });
      t.push({ tsMs: t[0]!.tsMs + 242_000, isBuy: false, solAmount: 5, priceSol: path([[0, 1], [240, 3.1], [250, 2.3]])(242), user: 'DEV' });
      return t.sort((a, b) => a.tsMs - b.tsMs);
    })(),
    meta: meta({ mint: 'DEVDUMP', symbol: 'DVD' }),
  },
  {
    // Launch that goes nowhere: slow bleed from the start. Should never be bought.
    name: 'dead-on-arrival',
    tape: makeTape({ price: noisy(path([[0, 1], [60, 1.3], [300, 0.9], [900, 0.6]]), 2, 12), durationSec: 900, tradeEverySec: 4, wallets: 30, avgSizeSol: 0.3, seed: 71 }),
    meta: meta({ mint: 'DOA', symbol: 'DOA' }),
  },
];

/**
 * Bonding-curve-consistent versions of the same shapes (see makeCurveTape):
 * volume, liquidity, holders and curve % agree with price, and price can't go
 * below launch. These are what the scenario backtest asserts on. Multiples are
 * targets relative to launch; the buyable band is roughly 2.2x-3.2x (MC ≥ $12k
 * at $200/SOL, curve ≤ 60%).
 */
/**
 * Every scenario gets the same ordinary creator (first launch, fresh funder, week-old wallet) —
 * including the rugs — so the chart and rug rules have to do the work, not a convenient profile.
 */
const ORDINARY_CREATOR = { creatorLaunches: 1, creatorSuccess: 0.5, funderReuse: 0.8, walletAge: 0.46 };

const curve = (name: string, spec: Parameters<typeof makeCurveTape>[0], extra: Partial<TokenMeta> = {}): Scenario => {
  const { tape, complete } = makeCurveTape(spec);
  return { name, tape, meta: meta({ mint: name, symbol: name.slice(0, 6).toUpperCase(), complete, walletFeatures: ORDINARY_CREATOR, ...extra }) };
};

export const CURVE_SCENARIOS: Scenario[] = [
  // Organic runner: through the band by ~6 min, 8x by 13 min, then a slow fade.
  curve('runner-then-fade', { price: noisy(path([[0, 1], [60, 1.6], [180, 2.4], [360, 3.5], [600, 6], [780, 8], [960, 7], [1400, 4.5]]), 2, 3), durationSec: 1400, tradeEverySec: 1.1, wallets: 160, avgSizeSol: 0.5, seed: 11 }),
  // Pump into the band, then a handful of wallets dump everything back to launch.
  curve('pump-and-rug', {
    price: path([[0, 1], [60, 2], [150, 2.9], [168, 1.3], [200, 1.05], [600, 1.02]]),
    durationSec: 600,
    tradeEverySec: 0.9,
    wallets: 90,
    avgSizeSol: 0.6,
    follow: 0.92,
    seed: 5,
  }),
  // Gets into the band, then chops sideways for 25 minutes: dead capital.
  curve('failing-chop', { price: noisy(path([[0, 1], [90, 2.4], [150, 2.6], [220, 2.35], [1600, 2.2]]), 2, 9), durationSec: 1600, tradeEverySec: 1.5, wallets: 110, avgSizeSol: 0.5, seed: 21 }),
  // Strong trend with healthy pullbacks to 10x — the one you must not sell early.
  curve('strong-trend-10x', {
    price: noisy(path([[0, 1], [60, 1.7], [150, 2.5], [190, 2.2], [280, 3.4], [320, 3], [450, 5], [500, 4.4], [650, 7], [700, 6.2], [880, 10], [940, 9.4], [1100, 9.8]]), 2, 4),
    durationSec: 1100,
    tradeEverySec: 0.9,
    wallets: 200,
    avgSizeSol: 0.6,
    seed: 31,
  }),
  // Few wallets ramp it vertically through the band, then it bleeds out.
  curve('vertical-top', { price: path([[0, 1], [120, 1.8], [150, 1.9], [178, 3.1], [205, 2.6], [300, 1.9], [900, 1.3]]), durationSec: 900, tradeEverySec: 0.8, wallets: 35, avgSizeSol: 0.8, follow: 0.95, seed: 41 }),
  // Slow grinder: band reached around 6-12 minutes, holds ~3.3x.
  curve('slow-grinder', { price: noisy(path([[0, 1], [300, 2], [600, 2.7], [900, 3.3], [1500, 3.5]]), 2, 8), durationSec: 1500, tradeEverySec: 1.4, wallets: 130, avgSizeSol: 0.45, seed: 51 }),
  // Dev buys big at launch, rides it to ~3x, then dumps the whole bag.
  curve(
    'dev-dump',
    {
      price: path([[0, 1], [120, 2.2], [240, 3], [246, 3], [260, 2], [320, 1.5], [700, 1.2]]),
      durationSec: 700,
      tradeEverySec: 1,
      wallets: 100,
      avgSizeSol: 0.5,
      devBuySol: 3,
      seed: 61,
      wallet: (t, _r, isBuy) => (!isBuy && t >= 244 && t < 250 ? 'DEV' : undefined),
      size: (t, _r, isBuy) => (!isBuy && t >= 244 && t < 250 ? 50 : undefined),
    },
  ),
  // Goes nowhere: never reaches the band. Must never be bought.
  curve('dead-on-arrival', { price: noisy(path([[0, 1], [60, 1.4], [300, 1.15], [900, 1.05]]), 2, 12), durationSec: 900, tradeEverySec: 3, wallets: 40, avgSizeSol: 0.3, seed: 71 }),
  // Three bots flipping uniform sizes walk it into the band. Fake demand — must not be bought.
  curve('wash-pump', {
    price: path([[0, 1], [240, 2.8], [600, 2.9]]),
    durationSec: 600,
    tradeEverySec: 0.6,
    wallets: 3,
    avgSizeSol: 0.4,
    seed: 81,
    size: () => 0.5,
    wallet: (_t, r, isBuy) => (isBuy ? ['B1', 'B2', 'B3'][Math.floor(r * 3)] : undefined),
  }),
];

/**
 * Tokens that look healthy at entry and THEN go wrong — these are what actually
 * exercise the rug exits, time stop and structure stop. (The bad shapes above
 * mostly never pass the holder / fee minimums, so they only test entries.)
 */
export const AFTER_ENTRY_SCENARIOS: Scenario[] = [
  // Organic climb into the band, then holders dump it back to ~1.2x within 30s.
  curve('late-rug', { price: noisy(path([[0, 1], [60, 1.6], [180, 2.5], [300, 3], [310, 3], [340, 1.3], [380, 1.15], [900, 1.1]]), 2, 13), durationSec: 900, tradeEverySec: 0.9, wallets: 160, avgSizeSol: 0.55, follow: 0.97, seed: 91 }),
  // Dev holds ~3.5% from a launch buy, the chart looks fine, then they sell the lot at 320s.
  curve('dev-dump-after-entry', {
    price: noisy(path([[0, 1], [60, 1.6], [180, 2.5], [320, 2.9], [330, 2.4], [400, 1.6], [900, 1.3]]), 2, 17),
    durationSec: 900,
    tradeEverySec: 0.9,
    wallets: 160,
    avgSizeSol: 0.55,
    devBuySol: 1,
    seed: 63,
    wallet: (t, _r, isBuy) => (!isBuy && t >= 320 && t < 322 ? 'DEV' : undefined),
    size: (t, _r, isBuy) => (!isBuy && t >= 320 && t < 322 ? 50 : undefined),
  }),
  // Enters fine, then drifts just under entry for 25 minutes — capital stuck in a dead trade.
  curve('dies-after-entry', { price: noisy(path([[0, 1], [60, 1.6], [180, 2.5], [240, 2.45], [330, 2.25], [1600, 2.2]]), 1.5, 19), durationSec: 1600, tradeEverySec: 1, wallets: 160, avgSizeSol: 0.5, seed: 27 }),
];
