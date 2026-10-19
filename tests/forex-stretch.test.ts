import { describe, expect, it } from 'vitest';
import { buildStretch, crowdPxSeries, STRETCH } from '../src/forex/stretch';
import { blockReason, type FilterEnv } from '../src/forex/filters';
import { extraVotes } from '../src/forex/sniper';
import { strategyById } from '../src/forex/strategies';
import { buildCtx } from '../src/forex/ta';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const DAY = 86_400_000;
// day boundaries are 22:00 UTC; start the series on one
const T0 = Date.UTC(2024, 0, 1, 22);

/** Hourly pairs from four currency "values" (log space): a seeded random walk each, JPY falls hard over the last 80 days. */
function market(days: number, crashJpy = true): Record<string, Bar[]> {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  const ccys = ['EUR', 'USD', 'GBP', 'JPY'] as const;
  const v: Record<string, number> = { EUR: 0, USD: 0, GBP: 0, JPY: 0 };
  const pairs = ['EURUSD', 'USDJPY', 'GBPUSD', 'EURJPY', 'GBPJPY', 'EURGBP'];
  const out: Record<string, Bar[]> = Object.fromEntries(pairs.map((p) => [p, []]));
  const n = days * 24;
  for (let i = 0; i < n; i++) {
    for (const c of ccys) v[c]! += rnd() * 0.002;
    if (crashJpy && i >= n - 80 * 24) v.JPY! -= 0.0004;
    for (const p of pairs) {
      const px = Math.exp(v[p.slice(0, 3)]! - v[p.slice(3, 6)]!);
      out[p]!.push({ t: T0 + i * H, o: px, h: px * 1.0002, l: px * 0.9998, c: px });
    }
  }
  return out;
}

describe('v17 price stretch (positioning stand-in without outside data)', () => {
  it('ranks each currency against its own past: a hard 3-month fall reads near −1, its pairs near the top', () => {
    const book = buildStretch(market(420));
    const last = book.ends.length - 1;
    expect(book.crowd.JPY![last]!).toBeLessThan(-0.8);
    for (const c of ['EUR', 'USD', 'GBP']) expect(book.crowd[c]![last]!).toBeGreaterThan(-0.5);
    // early days have no rank (63 days of momentum + 120 ranked days needed)
    expect(Number.isNaN(book.crowd.EUR![100]!)).toBe(true);
    const h1 = market(420).EURJPY!;
    const s = crowdPxSeries(book, 'EURJPY', h1, 60);
    expect(s[s.length - 1]!).toBeGreaterThan(0.5);
    // the mirror pair reads the other way
    const r = crowdPxSeries(book, 'USDJPY', h1, 60);
    expect(r[r.length - 1]!).toBeGreaterThan(0);
  });

  it('is causal: a reading never changes when later days are added', () => {
    const full = market(420);
    const cut = 380 * 24; // a day boundary
    const part = Object.fromEntries(Object.entries(full).map(([k, b]) => [k, b.slice(0, cut)]));
    const a = buildStretch(full);
    const b = buildStretch(part);
    let compared = 0;
    for (let k = 0; k < b.ends.length - 1; k++) {
      expect(a.ends[k]).toBe(b.ends[k]);
      for (const c of ['EUR', 'USD', 'GBP', 'JPY']) {
        const x = a.crowd[c]![k]!;
        const y = b.crowd[c]![k]!;
        if (Number.isNaN(y)) expect(Number.isNaN(x)).toBe(true);
        else {
          expect(x).toBeCloseTo(y, 12);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
    // a bar only sees days that ended by its close
    const bars = full.EURJPY!;
    const s = crowdPxSeries(a, 'EURJPY', bars, 60);
    const i = 300 * 24 + 5; // 05:00 into a day: uses the day that ended at 22:00 before
    const close = bars[i]!.t + H;
    const k = a.ends.findIndex((e) => e > close) - 1;
    expect(s[i]).toBeCloseTo(a.crowd.EUR![k]! - a.crowd.JPY![k]!, 12);
  });

  it('nothing for metals, unknown pairs, before the first day or when the reading is over 4 days old', () => {
    const book = buildStretch(market(420));
    const bars = market(420).EURUSD!;
    expect(crowdPxSeries(book, 'XAUUSD', bars, 60).every(Number.isNaN)).toBe(true);
    expect(crowdPxSeries(book, 'AUDUSD', bars, 60).every(Number.isNaN)).toBe(true);
    expect(crowdPxSeries(null, 'EURUSD', bars, 60).every(Number.isNaN)).toBe(true);
    const lastEnd = book.ends[book.ends.length - 1]!;
    const later: Bar[] = [{ t: lastEnd + (STRETCH.maxAgeDays + 1) * DAY, o: 1, h: 1, l: 1, c: 1 }];
    expect(Number.isNaN(crowdPxSeries(book, 'EURUSD', later, 60)[0]!)).toBe(true);
    // too little history → the pair is skipped entirely
    const short = Object.fromEntries(Object.entries(market(60, false)).map(([k, b]) => [k, b]));
    expect(Object.keys(buildStretch(short).crowd)).toHaveLength(0);
  });

  it('stretch_squeeze buys the turn after a record fall, once; nothing when not stretched', () => {
    const vee = Array.from({ length: 1300 }, (_, i) => {
      const px = 1.2 + (i < 500 ? -i : -1000 + i) * 0.0002;
      return { t: T0 + i * H, o: px, h: px + 0.0003, l: px - 0.0003, c: px };
    });
    const s = strategyById('stretch_squeeze')!;
    expect(s.slow).toBe(true);
    const c = buildCtx(vee, 60, 'EURUSD');
    c.ext = { crowdPx: new Float64Array(vee.length).fill(-1.8) } as unknown as typeof c.ext;
    const fires = vee.map((_, i) => s.signal(c, i)).filter(Boolean);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.side).toBe(1);
    c.ext = { crowdPx: new Float64Array(vee.length).fill(0.4) } as unknown as typeof c.ext;
    expect(vee.map((_, i) => s.signal(c, i)).filter(Boolean)).toHaveLength(0);
    c.ext = { crowdPx: new Float64Array(vee.length).fill(NaN) } as unknown as typeof c.ext;
    expect(vee.map((_, i) => s.signal(c, i)).filter(Boolean)).toHaveLength(0);
  });

  it('the filter blocks the overstretched side only; the sniper uses it only when the CFTC reading is missing', () => {
    const n = 600;
    const bars = Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, o: 1 + i * 0.0001, h: 1 + i * 0.0001 + 0.0003, l: 1 + i * 0.0001 - 0.0003, c: 1.00005 + i * 0.0001 }));
    const c = buildCtx(bars, 60, 'EURUSD');
    const e: FilterEnv = { tf: '1h', gap: new Float64Array(n).fill(NaN), h4: new Int8Array(n), d1: new Int8Array(n), mood: new Float64Array(n).fill(NaN), riskLong: 0, crowdPx: new Float64Array(n).fill(1.5) };
    expect(blockReason('stretch', e, n - 1, 1)).toMatch(/run up unusually hard/);
    expect(blockReason('stretch', e, n - 1, -1)).toBeNull();
    expect(blockReason('stretch', { ...e, crowdPx: new Float64Array(n).fill(NaN) }, n - 1, 1)).toBeNull();
    // no CFTC → the price stretch votes
    const priced = extraVotes(c, { ...e, crowdPx: new Float64Array(n).fill(-1.2) }, n - 1, 1, 'trend');
    expect(priced.yes.join(' ')).toMatch(/snap-back fuel/);
    // CFTC present → it alone votes (the same idea is never counted twice)
    const both = extraVotes(c, { ...e, cot: new Float64Array(n).fill(-1.2), crowdPx: new Float64Array(n).fill(-1.2) }, n - 1, 1, 'trend');
    expect(both.yes.join(' ')).toMatch(/squeeze fuel/);
    expect(both.yes.join(' ')).not.toMatch(/snap-back/);
    expect(both.of).toBe(priced.of);
  });
});
