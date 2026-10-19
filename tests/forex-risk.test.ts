import { describe, expect, it } from 'vitest';
import { buildCorrBook, corrAt, HEAT, heatPct, maxRiskUnder, roundedMatrix, topCorrelated, type CorrBook } from '../src/forex/risk';
import type { Bar } from '../src/forex/types';

const H = 3_600_000;
const DAY = 86_400_000;
/** Monday 2025-01-06 00:00 UTC */
const T0 = Date.UTC(2025, 0, 6);

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** n bar open times on the FX clock: closed Fri 22:00 → Sun 22:00 UTC. */
function fxTimes(n: number, start = T0): number[] {
  const out: number[] = [];
  for (let t = start; out.length < n; t += H) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const h = d.getUTCHours();
    if ((dow === 5 && h >= 22) || dow === 6 || (dow === 0 && h < 22)) continue;
    out.push(t);
  }
  return out;
}

const barsOf = (times: number[], logPx: number[]): Bar[] =>
  times.map((t, i) => {
    const c = Math.exp(logPx[i]!);
    return { t, o: c, h: c, l: c, c };
  });

function walk(n: number, sd: number, seed: number): number[] {
  const g = rng(seed);
  const w: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    x += sd * g();
    w.push(x);
  }
  return w;
}
const plusNoise = (w: number[], sd: number, seed: number, sign = 1) => {
  const g = rng(seed);
  return w.map((x) => sign * x + sd * g());
};

const rhoIn = (book: CorrBook, m: Float32Array | null, a: string, b: string) => {
  const K = book.ids.length;
  return m ? m[book.idx[a]! * K + book.idx[b]!]! : NaN;
};

describe('buildCorrBook', () => {
  const n = 800;
  const times = fxTimes(n);
  const w = walk(n, 0.001, 1);
  const h1 = new Map<string, Bar[]>([
    ['AAA', barsOf(times, plusNoise(w, 0.00005, 2))],
    ['BBB', barsOf(times, plusNoise(w, 0.00005, 3))],
    ['CCC', barsOf(times, walk(n, 0.001, 4))],
    ['DDD', barsOf(times, plusNoise(w, 0.00005, 5, -1))],
  ]);
  const book = buildCorrBook(h1, ['AAA', 'BBB', 'CCC', 'DDD']);

  it('same walk → ρ ≈ 1, independent → small, mirrored → ≈ −1', () => {
    expect(rhoIn(book, book.now, 'AAA', 'BBB')).toBeGreaterThan(0.95);
    expect(Math.abs(rhoIn(book, book.now, 'AAA', 'CCC'))).toBeLessThan(0.15);
    expect(rhoIn(book, book.now, 'AAA', 'DDD')).toBeLessThan(-0.95);
    // symmetric, diagonal 1, inside [−1, 1]
    const K = book.ids.length;
    for (let j = 0; j < K; j++) {
      expect(book.now![j * K + j]).toBe(1);
      for (let k = 0; k < K; k++) {
        expect(book.now![j * K + k]).toBe(book.now![k * K + j]);
        expect(Math.abs(book.now![j * K + k]!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('one snapshot per trading day, stamped at the 22:00 UTC close; corrAt picks the last one ≤ t', () => {
    expect(book.t.length).toBe(book.mats.length);
    expect(book.t.length).toBeGreaterThan(25);
    for (let i = 0; i < book.t.length; i++) {
      expect(((book.t[i]! % DAY) + DAY) % DAY).toBe(22 * H);
      if (i) expect(book.t[i]!).toBeGreaterThan(book.t[i - 1]!);
    }
    expect(corrAt(book, book.t[0]! - 1)).toBeNull();
    expect(corrAt(book, book.t[0]!)).toBe(book.mats[0]);
    expect(corrAt(book, book.t[5]! + 3 * H)).toBe(book.mats[5]);
    expect(corrAt(book, book.t[book.t.length - 1]! + 10 * DAY)).toBe(book.mats[book.mats.length - 1]);
    // early snapshots (under minObs joint returns) are all zero off the diagonal
    expect(rhoIn(book, book.mats[0]!, 'AAA', 'BBB')).toBe(0);
  });

  it('causal: changing bars that close after T does not change corrAt(book, T)', () => {
    const T = book.t[20]!;
    const g = rng(99);
    const changed = new Map<string, Bar[]>();
    for (const [id, bars] of h1) changed.set(id, bars.map((b) => (b.t + H > T ? { ...b, c: b.c * Math.exp(0.01 * g()) } : b)));
    const book2 = buildCorrBook(changed, ['AAA', 'BBB', 'CCC', 'DDD']);
    expect(Array.from(corrAt(book2, T)!)).toEqual(Array.from(corrAt(book, T)!));
    expect(Array.from(book2.now!)).not.toEqual(Array.from(book.now!));
    // a shorter history gives the same snapshots as far as it goes
    const cut = T + 30 * H;
    const short = new Map<string, Bar[]>();
    for (const [id, bars] of h1) short.set(id, bars.filter((b) => b.t + H <= cut));
    const book3 = buildCorrBook(short, ['AAA', 'BBB', 'CCC', 'DDD']);
    expect(book3.t.length).toBeGreaterThan(20);
    for (let i = 0; i < book3.t.length; i++) {
      expect(book3.t[i]).toBe(book.t[i]);
      expect(Array.from(book3.mats[i]!)).toEqual(Array.from(book.mats[i]!));
    }
  });

  it('weekend / missing-bar gaps never make a return', () => {
    const m = 2400;
    const ts = fxTimes(m).filter((_, i) => i % 97 !== 50); // plus a missing bar now and then mid-week
    const a = walk(ts.length, 0.001, 11);
    const b = walk(ts.length, 0.001, 12);
    const gapped = (x: number[], jumpAt: (i: number) => boolean) => {
      let shift = 0;
      return x.map((v, i) => {
        if (i > 0 && jumpAt(i)) shift += 0.05;
        return v + shift;
      });
    };
    const atGap = (i: number) => ts[i]! - ts[i - 1]! !== H;
    const g1 = new Map([
      ['AAA', barsOf(ts, gapped(a, atGap))],
      ['BBB', barsOf(ts, gapped(b, atGap))],
    ]);
    const bk = buildCorrBook(g1, ['AAA', 'BBB']);
    expect(Math.abs(rhoIn(bk, bk.now, 'AAA', 'BBB'))).toBeLessThan(0.2);
    // control: the same jumps on normal hourly bars DO show up as one shared move
    const atNormal = (i: number) => !atGap(i) && i % 120 === 7;
    const g2 = new Map([
      ['AAA', barsOf(ts, gapped(a, atNormal))],
      ['BBB', barsOf(ts, gapped(b, atNormal))],
    ]);
    const ctl = buildCorrBook(g2, ['AAA', 'BBB']);
    expect(rhoIn(ctl, ctl.now, 'AAA', 'BBB')).toBeGreaterThan(0.5);
  });

  it('ρ = 0 below minObs joint returns, counted exactly', () => {
    const mk = (nBars: number) => {
      const ts = Array.from({ length: nBars }, (_, i) => T0 + i * H);
      const ww = walk(nBars, 0.001, 21);
      return buildCorrBook(
        new Map([
          ['AAA', barsOf(ts, plusNoise(ww, 0.0001, 22))],
          ['BBB', barsOf(ts, plusNoise(ww, 0.0001, 23))],
        ]),
        ['AAA', 'BBB'],
      );
    };
    const under = mk(HEAT.minObs); // minObs − 1 returns
    const enough = mk(HEAT.minObs + 1); // minObs returns
    expect(rhoIn(under, under.now, 'AAA', 'BBB')).toBe(0);
    expect(rhoIn(under, under.now, 'AAA', 'AAA')).toBe(1);
    expect(rhoIn(enough, enough.now, 'AAA', 'BBB')).toBeGreaterThan(0.9);
  });

  it('a pair with no bars stays at ρ 0; no bars at all → now null', () => {
    const bk = buildCorrBook(h1, ['AAA', 'ZZZ']);
    expect(rhoIn(bk, bk.now, 'AAA', 'ZZZ')).toBe(0);
    expect(rhoIn(bk, bk.now, 'ZZZ', 'ZZZ')).toBe(1);
    const empty = buildCorrBook(new Map(), ['AAA']);
    expect(empty.now).toBeNull();
    expect(empty.t.length).toBe(0);
    expect(roundedMatrix(empty)).toBeNull();
  });

  it('roundedMatrix rounds to 2 dp', () => {
    const r = roundedMatrix(book)!;
    expect(r.ids).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(r.rho[0]![0]).toBe(1);
    for (const row of r.rho) for (const v of row) expect(Math.round(v * 100) / 100).toBe(v);
    expect(r.rho[0]![1]).toBeCloseTo(rhoIn(book, book.now, 'AAA', 'BBB'), 2);
  });

  it('is fast: 14 pairs × 6k bars well under 1 s', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `P${String(i).padStart(2, '0')}XXX`);
    const ts = fxTimes(6000);
    const common = walk(ts.length, 0.001, 31);
    const big = new Map<string, Bar[]>();
    ids.forEach((id, i) => big.set(id, barsOf(ts, plusNoise(common, 0.001, 40 + i))));
    const t0 = performance.now();
    const bk = buildCorrBook(big, ids);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(bk.mats.length).toBeGreaterThan(200);
  });
});

describe('heat', () => {
  const book = { idx: { AAA: 0, BBB: 1, CCC: 2 } as Record<string, number> };
  const mat = (ab: number, ac = 0, bc = 0) => Float32Array.from([1, ab, ac, ab, 1, bc, ac, bc, 1]);

  it('adds risk by correlation: ρ 1 → sum, ρ 0 → root of squares, opposite sides → difference', () => {
    const two = (s2: 1 | -1) => [
      { pair: 'AAA', side: 1 as const, riskPct: 1 },
      { pair: 'BBB', side: s2, riskPct: 2 },
    ];
    expect(heatPct(two(1), book, mat(1))).toBeCloseTo(3, 9);
    expect(heatPct(two(1), book, mat(0))).toBeCloseTo(Math.sqrt(5), 9);
    expect(heatPct(two(-1), book, mat(1))).toBeCloseTo(1, 9);
    // same pair always counts as ρ 1, even with no matrix; an unknown pair or no matrix → ρ 0
    const same = [
      { pair: 'AAA', side: 1 as const, riskPct: 1 },
      { pair: 'AAA', side: 1 as const, riskPct: 2 },
    ];
    expect(heatPct(same, book, null)).toBeCloseTo(3, 9);
    expect(heatPct(two(1), book, null)).toBeCloseTo(Math.sqrt(5), 9);
    expect(heatPct([{ pair: 'AAA', side: 1, riskPct: 1 }, { pair: 'QQQ', side: 1, riskPct: 2 }], book, mat(1))).toBeCloseTo(Math.sqrt(5), 9);
    expect(heatPct([], book, mat(1))).toBe(0);
  });

  it('never NaN on a matrix that is not a valid joint correlation', () => {
    const bad = mat(0.9, 0.9, -0.9);
    const pos = [
      { pair: 'AAA', side: -1 as const, riskPct: 1 },
      { pair: 'BBB', side: 1 as const, riskPct: 1 },
      { pair: 'CCC', side: 1 as const, riskPct: 1 },
    ];
    expect(heatPct(pos, book, bad)).toBe(0);
    expect(heatPct([{ pair: 'AAA', side: 1, riskPct: NaN }], book, bad)).toBe(0);
  });

  it('maxRiskUnder gives exactly the size that reaches the cap', () => {
    const m = mat(0.6, 0.3, 0.2);
    const pos = [
      { pair: 'AAA', side: 1 as const, riskPct: 0.8 },
      { pair: 'BBB', side: -1 as const, riskPct: 0.5 },
    ];
    for (const cand of [
      { pair: 'CCC', side: 1 as const },
      { pair: 'CCC', side: -1 as const },
      { pair: 'AAA', side: 1 as const },
      { pair: 'BBB', side: 1 as const },
      { pair: 'QQQ', side: 1 as const },
    ]) {
      const x = maxRiskUnder(pos, cand, 2, book, m);
      expect(x).toBeGreaterThan(0);
      expect(heatPct([...pos, { ...cand, riskPct: x }], book, m)).toBeCloseTo(2, 9);
      expect(heatPct([...pos, { ...cand, riskPct: x * 1.01 }], book, m)).toBeGreaterThan(2);
    }
    expect(maxRiskUnder([], { pair: 'AAA', side: 1 }, 3, book, m)).toBeCloseTo(3, 12);
    expect(maxRiskUnder(pos, { pair: 'AAA', side: 1 }, 0, book, m)).toBe(0);
  });

  it('0 when already over the cap; a hedge gets more room', () => {
    const m = mat(0.6);
    const heavy = [
      { pair: 'AAA', side: 1 as const, riskPct: 2 },
      { pair: 'BBB', side: 1 as const, riskPct: 2 },
    ];
    expect(heatPct(heavy, book, m)).toBeGreaterThan(2);
    expect(maxRiskUnder(heavy, { pair: 'BBB', side: 1 }, 2, book, m)).toBe(0);
    expect(maxRiskUnder(heavy, { pair: 'CCC', side: 1 }, 2, book, m)).toBe(0);
    const one = [{ pair: 'AAA', side: 1 as const, riskPct: 1 }];
    const withIt = maxRiskUnder(one, { pair: 'BBB', side: 1 }, 2, book, m);
    const hedge = maxRiskUnder(one, { pair: 'BBB', side: -1 }, 2, book, m);
    const unrelated = maxRiskUnder(one, { pair: 'CCC', side: 1 }, 2, book, m);
    expect(hedge).toBeGreaterThan(unrelated);
    expect(unrelated).toBeGreaterThan(withIt);
    expect(unrelated).toBeCloseTo(Math.sqrt(3), 9);
  });

  it('topCorrelated names the open trade that moves the same way', () => {
    const book4 = { idx: { EURUSD: 0, USDCHF: 1, GBPUSD: 2 } as Record<string, number> };
    const m = Float32Array.from([1, -0.9, 0.4, -0.9, 1, -0.3, 0.4, -0.3, 1]);
    const cand = { pair: 'EURUSD', side: 1 as const };
    expect(topCorrelated([{ pair: 'USDCHF', side: -1, riskPct: 1 }], cand, book4, m)).toEqual({ pair: 'USDCHF', rho: 0.9 });
    expect(topCorrelated([{ pair: 'USDCHF', side: 1, riskPct: 1 }], cand, book4, m)).toBeNull();
    expect(topCorrelated([{ pair: 'GBPUSD', side: 1, riskPct: 1 }], cand, book4, m)).toBeNull();
    expect(
      topCorrelated(
        [
          { pair: 'GBPUSD', side: 1, riskPct: 1 },
          { pair: 'USDCHF', side: -1, riskPct: 1 },
          { pair: 'EURUSD', side: 1, riskPct: 1 },
        ],
        cand,
        book4,
        m,
      ),
    ).toEqual({ pair: 'EURUSD', rho: 1 });
    expect(topCorrelated([{ pair: 'USDCHF', side: -1, riskPct: 1 }], cand, book4, null)).toBeNull();
  });
});
