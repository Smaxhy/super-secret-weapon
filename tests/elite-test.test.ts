import { describe, expect, it } from 'vitest';
import { buildReport, DEFAULT_ELITE_TEST, eliteLaunches, simulate, type EliteLaunch } from '../src/learner/elite-test';
import type { TapeRow } from '../src/learner/replay';

const T0 = 1_700_000_000_000;
const D = 86_400_000;

describe('elite launch test', () => {
  it('finds launches whose creator was elite at that moment, no peeking', () => {
    const all = [
      { mint: 'a1', symbol: 'A1', creator: 'A', createdAtMs: T0, graduated: true },
      { mint: 'a2', symbol: 'A2', creator: 'A', createdAtMs: T0 + D, graduated: true },
      { mint: 'a3', symbol: 'A3', creator: 'A', createdAtMs: T0 + 2.5 * D, graduated: false }, // judged with 2 prior grads → elite (36 h after a2)
      { mint: 'a4', symbol: 'A4', creator: 'A', createdAtMs: T0 + 2.5 * D + 3_600_000, graduated: true }, // 2/3 = 67% → elite, repeat
      { mint: 'b1', symbol: 'B1', creator: 'B', createdAtMs: T0 + 2 * D, graduated: true },
    ];
    const el = eliteLaunches(all, T0 + 1.5 * D, T0 + 3 * D, { minGraduated: 2, minBondRatePct: 20 });
    expect(el.map((l) => l.mint)).toEqual(['a3', 'a4']);
    expect(el[0]!.repeat24h).toBe(false);
    expect(el[1]!.repeat24h).toBe(true);
    expect(el[1]!.priorGraduated).toBe(2);
  });

  const launch: EliteLaunch = { mint: 'm', symbol: 'M', creator: 'A', createdAtMs: T0, graduated: true, priorLaunches: 3, priorGraduated: 2, repeat24h: false };
  const row = (sec: number, px: number, extra: Partial<TapeRow> = {}): TapeRow => ({ mint: 'm', t: T0 + sec * 1000, w: `w${sec}`, buy: true, sol: 0.5, tok: 0.5 / px, px, pp: px, amm: false, curvePct: 20, ...extra });

  it('buys after the delay and sells into graduation with costs', () => {
    const tape: TapeRow[] = [];
    for (let s = 0; s < 600; s += 5) tape.push(row(s, 1e-6 * (1 + s / 100), { curvePct: Math.min(100, 20 + s / 7) }));
    tape.push(row(600, 7e-6, { amm: true, curvePct: null }));
    const r = simulate(launch, tape, 15, 0, DEFAULT_ELITE_TEST);
    expect(r.reason).toBe('graduation');
    expect(r.pnlPct).toBeGreaterThan(300); // ~1.15e-6 → ~6.9e-6 minus costs
    expect(r.holdSec).toBeGreaterThan(500);
  });
  it('take-profit sells earlier; the stop catches a dump; a dead coin costs the round trip', () => {
    const tape: TapeRow[] = [];
    for (let s = 0; s < 600; s += 5) tape.push(row(s, 1e-6 * (1 + s / 100)));
    expect(simulate(launch, tape, 15, 3, DEFAULT_ELITE_TEST).reason).toBe('take profit');
    const dump: TapeRow[] = [row(10, 1e-6), row(20, 1e-6), row(40, 0.4e-6)];
    const d = simulate(launch, dump, 15, 0, DEFAULT_ELITE_TEST);
    expect(d.reason).toBe('hard stop');
    expect(d.pnlPct).toBeLessThan(-50);
    expect(simulate(launch, [row(1, 1e-6)], 15, 0, DEFAULT_ELITE_TEST).reason).toBe('dead');
    expect(simulate(launch, [], 15, 0, DEFAULT_ELITE_TEST).pnlPct).toBeCloseTo(-5.5, 0);
  });
  it('report: a grid per delay × rule, best rule, splits and a verdict', () => {
    const res = [];
    for (let i = 0; i < 12; i++) {
      const tape: TapeRow[] = [];
      const win = i % 3 !== 0;
      for (let s = 0; s < 300; s += 5) tape.push(row(s, win ? 1e-6 * (1 + s / 60) : 1e-6 * Math.max(0.3, 1 - s / 100)));
      if (win) tape.push(row(300, 6e-6, { amm: true, curvePct: null }));
      const l = { ...launch, mint: `m${i}`, repeat24h: i % 2 === 0, graduated: win };
      for (const d of DEFAULT_ELITE_TEST.entryDelaysSec) for (const tp of DEFAULT_ELITE_TEST.takeProfitX) res.push(simulate(l, tape.map((t) => ({ ...t, mint: l.mint })), d, tp, DEFAULT_ELITE_TEST));
    }
    const rep = buildReport(Array.from({ length: 12 }, (_, i) => ({ ...launch, mint: `m${i}` })), res, DEFAULT_ELITE_TEST, { from: T0, to: T0 + D, withTape: 12 });
    expect(rep.grid.length).toBe(9);
    expect(rep.best).not.toBeNull();
    expect(rep.grid.find((g) => g.delaySec === rep.best!.delaySec && g.tpX === rep.best!.tpX)!.totalSol).toBeGreaterThan(0);
    expect(rep.splits.length).toBe(5);
    expect(rep.verdict).toMatch(/It pays on our tape/);
  });
});
