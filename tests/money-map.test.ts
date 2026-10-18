import { describe, expect, it } from 'vitest';
import { band, buildMoneyMap, saneRow, splitBy, statsOf, verdictFor, DIMENSIONS, type MoneyRow } from '../src/learner/money-map';
import { altVariantsFor, outcomeOf, type OutcomeSignal } from '../src/learner/outcome-tracker';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const T0 = 1_700_000_000_000;
const row = (o: Partial<MoneyRow> & { flat?: Record<string, number> } = {}): MoneyRow => ({
  mint: 'M', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', atMs: T0, pnlPct: -5, peakX: 1.05, source: 'outcome', score: 60, bar: 70, why: 'score under the bar', flat: {}, ...o,
});

describe('money map — where is the money', () => {
  it('bands values by edges', () => {
    expect(band(5e3, [10e3, 25e3], ['a', 'b', 'c'])).toBe('a');
    expect(band(10e3, [10e3, 25e3], ['a', 'b', 'c'])).toBe('b');
    expect(band(1e6, [10e3, 25e3], ['a', 'b', 'c'])).toBe('c');
  });
  it('group stats: win rate, median, SOL at 1 SOL each, reach %, perfect exit', () => {
    const s = statsOf('g', [row({ pnlPct: 20, peakX: 2.1 }), row({ pnlPct: -10, peakX: 1.2 }), row({ pnlPct: -5, peakX: 1.0 })]);
    expect(s.n).toBe(3);
    expect(s.winPct).toBe(33);
    expect(s.medianPct).toBe(-5);
    expect(s.sol).toBe(0.05);
    expect(s.reach115Pct).toBe(67);
    expect(s.reach200Pct).toBe(33);
    // (1.1 + 0.2 + 0) * 100 / 3 − 7 costs
    expect(s.perfectPct).toBeCloseTo(36.3, 1);
  });
  it('splits a dimension in display order and counts unknowns', () => {
    const mc = DIMENSIONS.find((d) => d.key === 'mc')!;
    const d = splitBy(mc, [row({ flat: { 'entry.mcUsd': 60e3 } }), row({ flat: { 'entry.mcUsd': 8e3 } }), row({ flat: { 'entry.mcUsd': 12e3 } }), row()]);
    expect(d.groups.map((g) => g.label)).toEqual(['< $10k', '$10–25k', '$50–150k']);
    expect(d.unknown).toBe(1);
  });
  it('verdict: picks are the problem when most coins never reach break-even', () => {
    const v = verdictFor('SOON', Array.from({ length: 40 }, () => row({ strategy: 'SOON', pnlPct: -6, peakX: 1.03 })));
    expect(v.verdict).toBe('picks');
  });
  it('verdict: exits are the problem when coins ran but the exits lost', () => {
    const rs = Array.from({ length: 40 }, (_, i) => row({ pnlPct: -4, peakX: i % 2 ? 1.8 : 1.3 }));
    expect(verdictFor('MIGRATION_MOMENTUM', rs).verdict).toBe('exits');
  });
  it('verdict: working when the average is positive; unclear when too few', () => {
    expect(verdictFor('X', Array.from({ length: 30 }, () => row({ pnlPct: 8, peakX: 1.5 }))).verdict).toBe('working');
    expect(verdictFor('X', [row(), row()]).verdict).toBe('unclear');
  });
  it('ranks the best groups with small-n shrinkage, builds combos, exits and got-away', () => {
    const rows: MoneyRow[] = [];
    for (let i = 0; i < 40; i++) {
      // $25–50k coins with buyers in control pay; the rest bleed
      rows.push(row({ mint: `a${i}`, symbol: `A${i}`, pnlPct: 12, peakX: 1.6, flat: { 'entry.mcUsd': 30e3, 'pressure.buySharePct': 70, 'entry.hourUtc': 14, 'entry.dowUtc': 2 }, alt: { S: 15, R: 5 } }));
      rows.push(row({ mint: `b${i}`, pnlPct: -8, peakX: 1.02, flat: { 'entry.mcUsd': 5e3, 'pressure.buySharePct': 40, 'entry.hourUtc': 2, 'entry.dowUtc': 6 }, alt: { S: -7, R: -9 } }));
    }
    rows.push(row({ source: 'real', why: 'bought', pnlPct: -3, peakX: 1.1 }));
    const m = buildMoneyMap(rows, { hours: 48, exitNames: { S: 'Scalp', R: 'Runner' } });
    expect(m.rows).toBe(81);
    expect(m.bySource.real).toBe(1);
    expect(m.best[0]!.avgPct).toBe(12);
    expect(m.best[0]!.rank).toBeLessThan(12); // shrunk
    expect(m.worst[0]!.avgPct).toBe(-8);
    expect(m.combos[0]!.n).toBe(40);
    expect(m.combos[0]!.a.dim).not.toBe(m.combos[0]!.b.dim);
    expect(m.exits[0]).toMatchObject({ strategy: 'MIGRATION_MOMENTUM', n: 80 });
    expect(m.exits[0]!.alt.S).toBe(4); // (15 − 7) / 2
    expect(m.week.find((c) => c.dow === 2 && c.hour === 14)?.avgPct).toBe(12);
    expect(m.gotAway.length).toBe(12);
    expect(m.gotAway.every((g) => g.source !== 'real')).toBe(true);
    // score dimension: bought coins count as over the bar
    const score = m.dimensions.find((d) => d.key === 'score')!;
    expect(score.groups.find((g) => g.label === 'over the bar')?.n).toBe(1);
    expect(score.groups.find((g) => g.label === '10–20 under')?.n).toBe(80); // exactly 10 under = the 10–20 band
  });
  it('drops impossible results (beyond the peak / past 10×) and caps freak coins in rankings', () => {
    expect(saneRow({ pnlPct: 80_000, peakX: 801 })).toBe(false); // past 10×
    expect(saneRow({ pnlPct: 50, peakX: 1.2 })).toBe(false); // can't beat its own peak
    expect(saneRow({ pnlPct: 18, peakX: 1.2 })).toBe(true);
    expect(saneRow({ pnlPct: -8, peakX: 1.0 })).toBe(true);
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row({ mint: `m${i}`, pnlPct: -6, peakX: 1.02, flat: { 'entry.mcUsd': 30e3 } })),
      row({ mint: 'freak', pnlPct: 850, peakX: 9.9, flat: { 'entry.mcUsd': 30e3 } }), // a real 9.5× — counts, capped at +300
      row({ mint: 'broken', pnlPct: 80_000, peakX: 900, flat: { 'entry.mcUsd': 30e3 } }), // a fake print — dropped
    ];
    const m = buildMoneyMap(rows, { hours: 48 });
    expect(m.dropped).toBe(1);
    expect(m.rows).toBe(21);
    const mc = m.dimensions.find((d) => d.key === 'mc')!.groups[0]!;
    expect(mc.avgPct).toBeCloseTo((-6 * 20 + 850) / 21, 0);
    expect(mc.robustPct).toBeCloseTo((-6 * 20 + 300) / 21, 0);
    expect(m.verdicts[0]!.verdict).not.toBe('working'); // 1 of 21 reached break-even
  });
  it('filters by strategy and source', () => {
    const rows = [row({ strategy: 'SOON' }), row({ strategy: 'SOON', source: 'shadow' }), row({ strategy: 'SOON', source: 'real', why: 'bought' }), row()];
    expect(buildMoneyMap(rows, { hours: 1, strategy: 'SOON' }).rows).toBe(3);
    expect(buildMoneyMap(rows, { hours: 1, source: 'real' }).rows).toBe(1);
    expect(buildMoneyMap(rows, { hours: 1, source: 'skipped' }).rows).toBe(3);
    expect(buildMoneyMap(rows, { hours: 1, strategy: 'SOON' }).dimensions.some((d) => d.key === 'strategy')).toBe(false);
  });
});

describe('outcome tracker — other exits on the same coin', () => {
  const sig = (): OutcomeSignal => ({ mint: 'M', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', atMs: T0, onAmm: true, marketCapSol: 300, score: 60, bar: 70, why: 'score under the bar', flat: {} });
  function path(f: (s: number) => number, secs = 2400): CrowdTrade[] {
    const out: CrowdTrade[] = [];
    for (let s = 0; s < secs; s += 3) out.push({ t: T0 + s * 1000, w: `w${s % 30}`, buy: s % 2 === 0, sol: 0.3, tok: 0, px: f(s), pp: f(s) });
    return out;
  }
  const lab = [
    { id: 'L', exit: {} },
    { id: 'S', exit: { takeProfitTiers: [{ multiple: 1.25, sellPct: 50 }] } },
    { id: 'W', exit: { stopLoss: { minPct: 25, maxPct: 30 } } },
  ];
  it('builds alt variants from the lab (never L, chart exits off)', () => {
    const v = altVariantsFor(['S', 'L', 'nope', 'W'], lab);
    expect(v.map((x) => x.id)).toEqual(['S', 'W']);
    expect(v[0]!.exit).toMatchObject({ priceAction: { enabled: false }, takeProfitTiers: [{ multiple: 1.25, sellPct: 50 }] });
  });
  it('replays every alt variant on the same tape and stores their results', () => {
    const o = outcomeOf(sig(), path((s) => 1e-6 * (1 + Math.min(1, s / 600))), 45 * 60_000, 5, altVariantsFor(['S', 'W'], lab));
    expect(o.alt).toBeDefined();
    expect(Object.keys(o.alt!).sort()).toEqual(['S', 'W']);
    expect(Number.isFinite(o.alt!.S)).toBe(true);
  });
  it('a dead coin costs every variant the round trip', () => {
    const o = outcomeOf(sig(), [], 45 * 60_000, 5.5, altVariantsFor(['S'], lab));
    expect(o.alt).toEqual({ S: -5.5 });
  });
  it('no alt variants → no alt field (old shape kept)', () => {
    expect(outcomeOf(sig(), [], 45 * 60_000, 5.5)).not.toHaveProperty('alt');
  });
});
