import { describe, expect, it } from 'vitest';
import { gradeRolling, picksFor, randomPickerNull, ROLL, rollingPool, rollingVerdict, rollRow, rollWeeks, trailing, type RollTrade } from '../src/forex/rolling';
import { weekOf, weekStart, type PortfolioResult } from '../src/forex/portfolio';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const sim = { maxOpen: 8, leverage: 30, marginShare: 0.25, baseRiskPct: 1, maxPerStrategy: 3, prioritise: true, ccyCapPct: 2.2, ddSizing: true, flatSizing: false };

/** a row's trades: one every `every` days from t0 to t1, R from `rOf(t)` */
function trades(key: string, t0: number, t1: number, every: number, rOf: (t: number, k: number) => number, pair = 'EURUSD'): RollTrade[] {
  const [strategy, tf] = key.split(':') as [string, string];
  const out: RollTrade[] = [];
  let k = 0;
  for (let t = t0; t < t1; t += every * DAY) out.push({ pair, side: 1, entryT: t, exitT: t + DAY, r: rOf(t, k++), stopPct: 0.3, strategy, tf, sizeF: 1, vf: 1 });
  return out;
}

describe('v17 rolling picker', () => {
  const T0 = Date.UTC(2024, 0, 7);
  const T1 = Date.UTC(2026, 9, 18);

  it('only trades that closed before the week starts count (no look-ahead)', () => {
    const ts = trades('a:1h', T0, T1, 2, () => 1);
    const row = rollRow('a:1h', ts, false);
    const w = weekOf(Date.UTC(2025, 5, 1));
    const full = trailing(row, weekStart(w) - 26 * WEEK, weekStart(w));
    expect(full.n).toBeGreaterThan(80);
    expect(full.shrunkR).toBeCloseTo(full.n / (full.n + ROLL.shrinkK), 6);
    // changing results AFTER the week start can't change that week's pick
    const ts2 = ts.map((t) => (t.exitT >= weekStart(w) ? { ...t, r: -5 } : t));
    expect(picksFor([rollRow('a:1h', ts2, false)], w)).toEqual(picksFor([row], w));
  });

  it('picks rows that made money lately, rests the ones that stopped, keeps the always-on ones', () => {
    const turn = Date.UTC(2025, 6, 1);
    const good = rollRow('good:1h', trades('good:1h', T0, T1, 2, () => 0.4), false);
    const faded = rollRow('faded:1h', trades('faded:1h', T0, T1, 2, (t) => (t < turn ? 0.5 : -0.4)), false);
    const thin = rollRow('thin:1h', trades('thin:1h', T0, T1, 40, () => 2), false);
    const always = rollRow('tsmom:1h', trades('tsmom:1h', T0, T1, 3, () => -0.2), true);
    const before = picksFor([good, faded, thin, always], weekOf(turn)).map((p) => p.key);
    expect(before).toEqual(['good:1h', 'faded:1h', 'tsmom:1h']);
    const after = picksFor([good, faded, thin, always], weekOf(turn + 20 * WEEK)).map((p) => p.key);
    expect(after).toEqual(['good:1h', 'tsmom:1h']);
  });

  it('the weekly pool holds only the picked rows\' trades of that week', () => {
    const turn = Date.UTC(2025, 6, 1);
    const ta = trades('good:1h', T0, T1, 2, () => 0.4);
    const tb = trades('faded:1h', T0, T1, 2, (t) => (t < turn ? 0.5 : -0.4), 'GBPUSD');
    const rows = [rollRow('good:1h', ta, false), rollRow('faded:1h', tb, false)];
    const oos = new Map([['good:1h', ta.filter((t) => t.entryT >= turn)], ['faded:1h', tb.filter((t) => t.entryT >= turn)]]);
    const { pool, weeks } = rollingPool(rows, oos, weekOf(turn), weekOf(T1) - 1);
    expect(weeks.length).toBeGreaterThan(50);
    // the faded row is traded only until its 26-week record turns
    const lastFaded = Math.max(...pool.filter((t) => t.strategy === 'faded').map((t) => t.entryT));
    expect(lastFaded).toBeLessThan(turn + 26 * WEEK);
    expect(pool.filter((t) => t.strategy === 'good').length).toBeGreaterThan(100);
  });

  it('beats random pickers when its pick has an edge; the verdict needs 26 weeks, money made and 80% of random beaten', async () => {
    const oosFrom = Date.UTC(2025, 9, 1);
    const keys = Array.from({ length: 12 }, (_, k) => `s${k}:1h`);
    // two real edges (persistent), ten noise rows whose sign flips every quarter
    const all = keys.map((key, k) =>
      trades(key, T0, T1, 2, (t, j) => (k < 2 ? (j % 3 === 0 ? -1 : 0.8) : Math.floor(t / (91 * DAY)) % 2 === k % 2 ? 0.6 : -0.9), ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD'][k % 6]!),
    );
    const rows = keys.map((key, k) => rollRow(key, all[k]!, false));
    const oos = new Map(keys.map((key, k) => [key, all[k]!.filter((t) => t.entryT >= oosFrom + ROLL.embargoDays * DAY)]));
    const { w0, w1 } = rollWeeks(oosFrom, T1);
    const nul = await randomPickerNull(rows, oos, w0, w1, sim, 40, 3);
    expect(nul.totals).toHaveLength(40);
    const rep = gradeRolling(rows, oos, { oosFrom, to: T1, now: T1, sim, staticPool: [], nul, wasActive: false, prevKeys: null });
    expect(rep.weeksGraded).toBeGreaterThanOrEqual(ROLL.minGradedWeeks);
    expect(rep.result!.totalPct).toBeGreaterThan(nul.p50);
    expect(rep.null!.beatPct!).toBeGreaterThanOrEqual(50);
    expect(rep.thisWeek.picks.map((p) => p.key)).toContain('s0:1h');
  });

  it('verdict rules and hysteresis', () => {
    const res = (totalPct: number, maxDdPct = 5) => ({ totalPct, maxDdPct }) as PortfolioResult;
    const base = { weeksGraded: 30, pfR: 1.3, staticSame: res(2, 6) };
    expect(rollingVerdict({ ...base, weeksGraded: 10, result: res(5), beatPct: 99 }, false).active).toBe(false);
    expect(rollingVerdict({ ...base, result: res(5), beatPct: 85 }, false).active).toBe(true);
    expect(rollingVerdict({ ...base, result: res(5), beatPct: 70 }, false).active).toBe(false);
    expect(rollingVerdict({ ...base, result: res(5), beatPct: 70 }, true).active).toBe(true); // stays on
    expect(rollingVerdict({ ...base, result: res(-1), beatPct: 99 }, true).active).toBe(false);
    expect(rollingVerdict({ ...base, result: res(5, 30), beatPct: 99 }, false).active).toBe(false); // drop too big
    expect(rollingVerdict({ ...base, pfR: 1.0, result: res(5), beatPct: 99 }, false).why).toMatch(/profit factor/);
  });
});
