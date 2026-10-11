/**
 * Scenario backtest: bonding-curve-consistent tapes replayed through the
 * current rules (and the legacy rules for comparison). Each scenario asserts
 * the behaviour a careful trader would want; the aggregate asserts the rules
 * make money on this set without a large drawdown.
 *
 * Set BACKTEST_PRINT=1 to print every simulated trade.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { currentPolicy, legacyPolicy, simulateToken, summarisePolicy, type SimResult, type SimTrade } from '../src/learner/backtester';
import { AFTER_ENTRY_SCENARIOS, CURVE_SCENARIOS } from './scenarios';
import { curvePctAt, makeCurveTape, path } from './tape-helpers';

const ALL = [...CURVE_SCENARIOS, ...AFTER_ENTRY_SCENARIOS];
const current = currentPolicy();
const results = new Map<string, SimResult>(ALL.map((s) => [s.name, simulateToken(s.tape, s.meta, current)]));
const legacyResults = ALL.map((s) => simulateToken(s.tape, s.meta, legacyPolicy()));
const get = (name: string) => results.get(name)!;
const trade = (name: string): SimTrade => {
  const r = get(name);
  if (!r.entered) throw new Error(`${name} was not entered: ${r.reasons.join('; ')}`);
  return r;
};

if (process.env.BACKTEST_PRINT) {
  for (const [name, r] of results) {
    if (r.entered) console.log(`${name.padEnd(22)} ENTER t+${r.entryAtSec}s ${r.setup} pnl ${r.pnlSol.toFixed(4)} peak ${r.peakMultiple.toFixed(2)}x exit ${r.exitMultiple.toFixed(2)}x ${r.exitReason} | ${r.sells.map((s) => `${s.reason}@${s.atSec}s ${s.pct.toFixed(0)}%`).join(', ')}`);
    else console.log(`${name.padEnd(22)} SKIP best ${r.bestScore.toFixed(1)} | ${r.reasons.slice(0, 3).join('; ')}`);
  }
}

describe('curve-consistent tapes', () => {
  it('price follows the reserves: curve % matches the launch multiple', () => {
    expect(curvePctAt(1)).toBeCloseTo(0, 5);
    expect(curvePctAt(2)).toBeGreaterThan(35);
    expect(curvePctAt(3.2)).toBeGreaterThan(55);
    expect(curvePctAt(3.2)).toBeLessThan(62);
  });
  it('price never drops below launch, even when the target does', () => {
    const { tape } = makeCurveTape({ price: path([[0, 1], [60, 2], [120, 0.2]]), durationSec: 200, tradeEverySec: 0.5, wallets: 50, seed: 3 });
    const launch = 30 / 1_073_000_000;
    expect(Math.min(...tape.map((t) => t.priceSol))).toBeGreaterThanOrEqual(launch * 0.999);
  });
});

describe('scenario backtest — entries', () => {
  it.each(['dead-on-arrival', 'wash-pump', 'vertical-top', 'pump-and-rug'])('never buys %s', (name) => {
    expect(get(name).entered).toBe(false);
  });
  it('buys the organic runner and the 10x trend, and both make money', () => {
    for (const name of ['runner-then-fade', 'strong-trend-10x']) {
      const t = trade(name);
      expect(t.pnlSol).toBeGreaterThan(0);
      expect(t.exitMultiple).toBeGreaterThan(2);
    }
  });
});

describe('scenario backtest — exits', () => {
  const hardStop = 1 - DEFAULT_CONFIG.exit.hardStopLossPct / 100;
  it('a late rug is exited by the rug rules before the disaster stop', () => {
    const t = trade('late-rug');
    expect(['RUG_DETECTED', 'STRUCTURE_BREAK']).toContain(t.exitReason);
    expect(t.exitMultiple).toBeGreaterThan(hardStop);
  });
  it('a dev dump after entry is exited immediately, near break-even', () => {
    const t = trade('dev-dump-after-entry');
    expect(t.exitReason).toBe('RUG_DETECTED');
    expect(t.pnlSol / t.sizeSol).toBeGreaterThan(-0.1);
  });
  it('a trade that never works is cut by the time stop, long before the stale exit', () => {
    const t = trade('dies-after-entry');
    expect(t.exitReason).toBe('TIME_STOP');
    expect(t.heldSec).toBeLessThan(DEFAULT_CONFIG.exit.staleMinutes.CURVE_SNIPE * 60);
    expect(t.pnlSol / t.sizeSol).toBeGreaterThan(-0.15);
  });
  it('winners give back less than half of the peak', () => {
    for (const name of ['runner-then-fade', 'strong-trend-10x']) {
      const t = trade(name);
      expect((t.exitMultiple - 1) / (t.peakMultiple - 1)).toBeGreaterThan(0.5);
    }
  });
});

describe('scenario backtest — aggregate', () => {
  const cur = summarisePolicy('current', [...results.values()]);
  const leg = summarisePolicy('legacy', legacyResults);
  it('is profitable with a profit factor above 2 and drawdown below one position', () => {
    expect(cur.pnlSol).toBeGreaterThan(0);
    expect(cur.profitFactor ?? 0).toBeGreaterThan(2);
    expect(cur.maxDrawdownSol).toBeLessThan(current.sizeSol);
  });
  it('does at least as well as the legacy rules', () => {
    expect(cur.pnlSol).toBeGreaterThanOrEqual(leg.pnlSol);
  });
  it('every simulation terminates and is deterministic', () => {
    const again = ALL.map((s) => simulateToken(s.tape, s.meta, current));
    expect(again.map((r) => (r.entered ? r.pnlSol : r.bestScore))).toEqual([...results.values()].map((r) => (r.entered ? r.pnlSol : r.bestScore)));
  });
});
