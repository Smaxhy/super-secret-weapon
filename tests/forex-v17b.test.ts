import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { buildCorrBook, gradeHeat } from '../src/forex/risk';
import { simulatePortfolio, type PTrade } from '../src/forex/portfolio';
import { newAccount, Practice, recordTrade, type PracticeAccount, type PracticePosition, type Quote } from '../src/forex/practice';
import { ForexLab } from '../src/forex/lab';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const M = 60_000;
const WED = Date.UTC(2026, 9, 14, 14, 0, 30);

class R {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
}
const asRedis = (r: R) => r as unknown as Redis;
afterEach(() => vi.useRealTimers());

/** two markets that move as one (same random walk) + one that doesn't */
function walks(n: number): Map<string, Bar[]> {
  let s = 11;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5);
  const t0 = Date.UTC(2025, 0, 6);
  const a: Bar[] = [];
  const b: Bar[] = [];
  const c: Bar[] = [];
  let pa = 1.1;
  let pc = 150;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * H;
    const ra = rnd() * 0.002;
    pa *= Math.exp(ra);
    pc *= Math.exp(rnd() * 0.002);
    a.push({ t, o: pa, h: pa, l: pa, c: pa });
    b.push({ t, o: pa * 1.2, h: pa * 1.2, l: pa * 1.2, c: pa * 1.2 * Math.exp(rnd() * 0.0001) });
    c.push({ t, o: pc, h: pc, l: pc, c: pc });
  }
  return new Map([['EURUSD', a], ['GBPUSD', b], ['USDJPY', c]]);
}

describe('v17 correlated-risk cap', () => {
  const book = buildCorrBook(walks(1500), ['EURUSD', 'GBPUSD', 'USDJPY']);
  const t = Date.UTC(2025, 2, 1);
  const tr = (pair: string, entryT: number, r: number): PTrade => ({ pair, side: 1, entryT, exitT: entryT + 10 * H, r, stopPct: 0.3, strategy: pair, tf: '1h', sizeF: 1 });
  const base = { maxOpen: 8, leverage: 30, marginShare: 0.25, baseRiskPct: 1, maxPerStrategy: 3, prioritise: true, ccyCapPct: null, ddSizing: false, flatSizing: true, mc: false };

  it('in the honest test: a second trade on a market that moves with an open one is cut, an unrelated one is not', () => {
    const plain = simulatePortfolio([tr('EURUSD', t, -1), tr('GBPUSD', t + H, -1)], { ...base, label: 'plain' });
    const capped = simulatePortfolio([tr('EURUSD', t, -1), tr('GBPUSD', t + H, -1)], { ...base, label: 'cap', heat: { capPct: 1.5, book, minScale: 0.4 } });
    expect(plain.totalPct).toBeCloseTo(-2, 0);
    // EURUSD 1% + GBPUSD only ~0.5% (ρ≈1, cap 1.5%)
    expect(capped.totalPct).toBeGreaterThan(-1.6);
    expect(capped.skipped.heat).toBe(0);
    // an unrelated market (ρ≈0) still gets its full 1%: √(1.5² − 1²) ≈ 1.12
    const other = simulatePortfolio([tr('EURUSD', t, -1), tr('USDJPY', t + H, -1)], { ...base, label: 'cap', heat: { capPct: 1.5, book, minScale: 0.4 } });
    expect(other.totalPct).toBeCloseTo(-2, 0);
    const tight = simulatePortfolio([tr('EURUSD', t, -1), tr('GBPUSD', t + H, -1)], { ...base, label: 'cap', heat: { capPct: 1.1, book, minScale: 0.4 } });
    expect(tight.skipped.heat).toBe(1); // only ~0.1% room left → skipped, not taken tiny
  });

  it('goes live only if it cut the biggest drop by 15%+ without costing too much return', () => {
    expect(gradeHeat({ totalPct: 20, maxDdPct: 8 }, { totalPct: 22, maxDdPct: 12 }).active).toBe(true);
    expect(gradeHeat({ totalPct: 20, maxDdPct: 11 }, { totalPct: 22, maxDdPct: 12 }).active).toBe(false);
    expect(gradeHeat({ totalPct: 5, maxDdPct: 8 }, { totalPct: 22, maxDdPct: 12 }).active).toBe(false);
    expect(gradeHeat({ totalPct: 5, maxDdPct: 2 }, { totalPct: 6, maxDdPct: 3 }).why).toMatch(/already small/);
  });

  it('live: after the currency cap, a trade that moves with an open one is sized down (pairs with no shared currency)', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new R();
    // an open EUR/GBP long that risked 2.5% when it opened; AUD/NZD moves with it here (ρ 0.95) but shares no currency
    const open: PracticePosition = { id: 'p1', pair: 'EURGBP', side: 1, units: 8_000, entry: 0.866, marginUsd: 200, leverage: 30, stop: 0.8638, target: 0.87, openedAt: WED - 10 * M, checkedT: WED - M, ref: `a:1h:EURGBP:${WED - H}`, strategy: 'a', tf: '1h', riskPct: 2.5 };
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [open] }));
    const p = new Practice(asRedis(r));
    const q = (id: string, mid: number): Quote => ({ id, mid, bid: mid - 0.00005, ask: mid + 0.00005, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED });
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURGBP: q('EURGBP', 0.866), AUDNZD: q('AUDNZD', 1.1), GBPUSD: q('GBPUSD', 1.27), NZDUSD: q('NZDUSD', 0.6), AUDUSD: q('AUDUSD', 0.66), EURUSD: q('EURUSD', 1.1) });
    const m = new Float32Array([1, 0.95, 0.95, 1]);
    const heat = { active: true, book: { idx: { EURGBP: 0, AUDNZD: 1 } }, m };
    const held = { ref: open.ref!, strategy: 'a', tf: '1h', pair: 'EURGBP', side: 1 as const, entryT: WED - H, stop: 0.8638, target: 0.87, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const lab = { ref: `b:1h:AUDNZD:${WED}`, strategy: 'b', tf: '1h', pair: 'AUDNZD', side: 1 as const, entryT: WED - 30_000, stop: 1.098, target: 1.104, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const ev = await p.syncBot([held, lab], () => null, {}, { scope: ['1h', '4h'], heat });
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    const nz = a.open.find((x) => x.pair === 'AUDNZD')!;
    // room = −0.95·2.5 + √(0.95²·2.5² + 3² − 2.5²) ≈ 0.52% instead of the normal 1%
    expect(nz.riskPct!).toBeGreaterThan(0.4);
    expect(nz.riskPct!).toBeLessThan(0.65);
    expect(ev.join(' ')).toMatch(/smaller: it moves with your open EURGBP trade \(ρ 0.95\)/);
    // with the cap off: the normal size
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [open] }));
    await p.syncBot([held, lab], () => null, {}, { scope: ['1h', '4h'], heat: { ...heat, active: false } });
    expect((JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount).open.find((x) => x.pair === 'AUDNZD')!.riskPct!).toBeCloseTo(1, 1);
  });
});

describe('v17 restricted learner in the bot record', () => {
  it('a strategy losing in R on the bot account is dropped; a doubtful one is halved and never sized up', async () => {
    const r = new R();
    const a = newAccount(1000);
    for (let k = 0; k < 12; k++) recordTrade(a, 'bad:1h', Date.now() - k * H, -10, { ref: `bad:1h:EURUSD:${k}`, riskUsd0: 10, why: 'stop' });
    for (let k = 0; k < 7; k++) recordTrade(a, 'meh:1h', Date.now() - k * H, k % 4 === 0 ? 10 : -10, { ref: `meh:1h:EURUSD:${k}`, riskUsd0: 10, why: 'stop' });
    r.m.set('fx:practice:bot', JSON.stringify(a));
    const lab = new ForexLab(asRedis(r));
    lab.practice = new Practice(asRedis(r));
    const rec = await lab.botRecord();
    expect(rec.dropped).toContain('bad:1h');
    expect(rec.down['meh:1h']).toBe(0.5);
    expect(rec.learned['bad:1h']!.state).toBe('off');
    expect(JSON.parse(r.m.get('fx:learn')!).keys['bad:1h'].state).toBe('off');
  });
});

import { JUDGE_FEATURES, judgeView, presenceMasks, trainJudge, type JudgeRow } from '../src/forex/judge';

describe('v17 judge: quant inputs with a presence mask', () => {
  const F = JUDGE_FEATURES.length;
  const idx = (f: (typeof JUDGE_FEATURES)[number]) => JUDGE_FEATURES.indexOf(f);
  const row = (k: number, cot: boolean): JudgeRow => {
    const x = new Float64Array(F).fill(0);
    x[idx('tf')] = 1;
    x[idx('metal')] = 0;
    x[idx('side')] = k % 2 ? 1 : -1;
    x[idx('hurst')] = (k % 7) / 7;
    x[idx('cot')] = cot ? ((k * 37) % 11) / 5 - 1 : NaN;
    return { x, r: (k % 7) / 7 > 0.5 ? 1 : -1, t: k * 3_600_000, exitT: k * 3_600_000 + 1 };
  };
  it('a reading known in < 90% of training trades is blanked; one known ≥ 90% is required live (missing → wait)', async () => {
    // cot known in only the newer half of history: it must not be used (it would stand for "the newer period")
    const rows = Array.from({ length: 1200 }, (_, k) => row(k, k > 500));
    const m = presenceMasks(rows.slice(0, 840));
    expect(m.masked['1:0']).toContain(idx('cot'));
    expect(m.required['1:0']).toContain(idx('hurst'));
    const { model } = await trainJudge(rows, 840 * 3_600_000);
    expect(model).not.toBeNull();
    const live = Float64Array.from(rows[1000]!.x);
    expect(judgeView(model!, live).p).not.toBeNull();
    live[idx('hurst')] = NaN; // a required reading is missing now
    const v = judgeView(model!, live);
    expect(v.p).toBeNull();
    expect(v.missing).toMatch(/snap back/);
    // a blanked one missing doesn't matter
    const live2 = Float64Array.from(rows[1000]!.x);
    live2[idx('cot')] = NaN;
    expect(judgeView(model!, live2).p).not.toBeNull();
  });
});

import { filterCoverage, missingInput, type FilterEnv } from '../src/forex/filters';

describe('v17 missing filter inputs (live guard)', () => {
  const env = (mood: number[], cot: number[]): FilterEnv => ({ tf: '1h', gap: new Float64Array(mood.length).fill(0.5), h4: new Int8Array(mood.length), d1: new Int8Array(mood.length), mood: Float64Array.from(mood), riskLong: 0.5, cot: Float64Array.from(cot) });
  it('waits when a filter input that was there in the tested history is missing now; never for one that was rarely there', () => {
    const n = 100;
    const e = env(
      Array.from({ length: n }, (_, i) => (i === 99 ? NaN : 0.3)),
      Array.from({ length: n }, () => NaN),
    );
    const cov = filterCoverage(e, 70);
    expect(cov.mood).toBe(1);
    expect(cov.cot).toBe(0);
    expect(missingInput('mood', e, 99, cov)).toMatch(/market mood/);
    expect(missingInput('all', e, 99, cov)).toMatch(/market mood/);
    expect(missingInput('mood', e, 98, cov)).toBeNull();
    expect(missingInput('crowd', e, 99, cov)).toBeNull(); // positioning was never there (e.g. metals): never blocks
    expect(missingInput('none', e, 99, cov)).toBeNull();
  });
});
