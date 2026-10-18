import { describe, expect, it } from 'vitest';
import { buildReport, DEFAULT_COHORT, simulateBoost, simulateSurvivor, survivorAt, type Sim } from '../src/learner/cohort-test';
import type { TapeRow } from '../src/learner/replay';

const T0 = 1_700_000_000_000;
const row = (sec: number, px: number, w = `w${sec}`, buy = true): TapeRow => ({ mint: 'm', t: T0 + sec * 1000, w, buy, sol: 0.3, tok: 0.3 / px, px, pp: px, amm: true, curvePct: null });
const meta = { mint: 'm', symbol: 'M' };

describe('cohort test — BOOST and survivor trades', () => {
  it('BOOST: buys after the delay, takes profit or sells at BOOST end', () => {
    const up: TapeRow[] = [];
    for (let s = 0; s < 400; s += 5) up.push(row(s, 1e-6 * (1 + s / 200)));
    const tp = simulateBoost(meta, up, T0, 10, 1.3, DEFAULT_COHORT);
    expect(tp.reason).toBe('take profit');
    expect(tp.pnlPct).toBeGreaterThan(20);
    const end = simulateBoost(meta, up, T0, 10, 5, DEFAULT_COHORT);
    expect(end.reason).toBe('BOOST end');
    expect(end.holdSec).toBeGreaterThanOrEqual(280);
    const dump: TapeRow[] = [row(5, 1e-6), row(20, 1e-6), row(40, 0.6e-6)];
    expect(simulateBoost(meta, dump, T0, 10, 1.3, DEFAULT_COHORT).reason).toBe('hard stop');
    expect(simulateBoost(meta, [row(5, 1e-6), row(20, 1e-6)], T0, 10, 1.3, DEFAULT_COHORT).reason).toMatch(/dead/);
    expect(simulateBoost(meta, [], T0, 10, 1.3, DEFAULT_COHORT).reason).toBe('no entry');
  });
  it('survivor: needs buyers in the last hour; trails after 1.3×', () => {
    const tape: TapeRow[] = [];
    // active for 3 h: 30 distinct buyers an hour, price grinds up 2× then falls back
    for (let s = 0; s < 3 * 3600; s += 60) tape.push(row(s, 1e-6 * (s < 7200 ? 1 + s / 7200 : 2 - (s - 7200) / 4500), `b${s % 1800}`));
    expect(survivorAt(tape, T0 + 3_600_000, 20)).toBe(true);
    expect(survivorAt(tape, T0 + 3_600_000, 60)).toBe(false);
    const s = simulateSurvivor(meta, tape, T0, 1, 6, DEFAULT_COHORT)!;
    expect(s).not.toBeNull();
    expect(s.reason).toBe('trailing stop');
    expect(s.peakX).toBeGreaterThan(1.3);
    expect(s.pnlPct).toBeGreaterThan(-10); // bought ~1.5e-6, peaked 2e-6, trailed out ~1.5e-6: about flat after costs
    expect(simulateSurvivor(meta, tape.slice(0, 10), T0, 1, 6, DEFAULT_COHORT)).toBeNull();
  });
  it('report: rules ranked, best needs 30 trades, verdict needs PF 1.5', () => {
    const sims = Array.from({ length: 40 }, (_, i) => simulateBoost({ mint: `m${i}`, symbol: 'X' }, Array.from({ length: 80 }, (_, s) => ({ ...row(s * 5, 1e-6 * (1 + (i % 2 ? s / 100 : -s / 400))), mint: `m${i}` })), T0, 10, 1.3, DEFAULT_COHORT));
    const rep = buildReport(sims, DEFAULT_COHORT, { from: T0, to: T0 + 1, graduates: 40, withTape: 40, survivors: 0, startedAt: Date.now() });
    expect(rep.rows.length).toBe(1);
    expect(rep.rows[0]!.n).toBe(40);
    expect(rep.best).not.toBeNull();
    expect(rep.verdict).toMatch(/It pays|Not an edge/);
    const few = buildReport(sims.slice(0, 10), DEFAULT_COHORT, { from: T0, to: T0 + 1, graduates: 10, withTape: 10, survivors: 0, startedAt: Date.now() });
    expect(few.best).toBeNull();
  });
});

describe('cohort test — broken prints cannot make a verdict', () => {
  it('a 1,000× print is dropped, averages are capped, and "It pays" needs a positive median', () => {
    const T0 = 1_700_000_000_000;
    const row = (sec: number, px: number, mint: string): TapeRow => ({ mint, t: T0 + sec * 1000, w: `w${sec}`, buy: true, sol: 0.3, tok: 0.3 / px, px, pp: px, amm: true, curvePct: null });
    const sims: Sim[] = [];
    for (let i = 0; i < 40; i++) {
      const m = `m${i}`;
      // 39 slow bleeders, 1 coin with a fake 1,000× print
      const tape = i === 0 ? [row(0, 1e-6, m), row(20, 1e-6, m), row(100, 1e-3, m)] : Array.from({ length: 80 }, (_, s) => row(s * 5, 1e-6 * (1 - s / 400), m));
      sims.push(simulateBoost({ mint: m, symbol: 'X' }, tape, T0, 10, 5, DEFAULT_COHORT));
    }
    const rep = buildReport(sims, DEFAULT_COHORT, { from: T0, to: T0 + 1, graduates: 40, withTape: 40, survivors: 0, startedAt: Date.now() });
    expect(rep.dropped).toBe(1);
    expect(rep.rows[0]!.n).toBe(39);
    expect(rep.rows[0]!.totalSol).toBeLessThan(0);
    expect(rep.verdict).toMatch(/Not an edge/);
  });
});
