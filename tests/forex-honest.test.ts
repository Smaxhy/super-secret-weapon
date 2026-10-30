/** v18: the lab's "how much is luck?" — deflated Sharpe per row, PBO and SPA over every row, the Edge downgrade. */
import { describe, expect, it } from 'vitest';
import { dsrDowngrade, HONEST, honestStats, type StatInput } from '../src/forex/honest';
import { rng } from '../src/forex/stats';
import type { Trade } from '../src/forex/types';

const DAY = 86_400_000;
const FROM = Date.UTC(2023, 9, 1);
const TO = FROM + 3 * 365 * DAY;
const OOS = FROM + 0.7 * (TO - FROM);

/** n trades spread over the history with results ~ N(mean, 1) */
function row(key: string, n: number, mean: number, seed: number, sd = 1): StatInput {
  const r = rng(seed);
  const done: Trade[] = [];
  for (let k = 0; k < n; k++) {
    const u = Math.max(1e-12, r());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    const t = FROM + Math.floor(((k + 0.5) / n) * (TO - FROM));
    done.push({ strategy: key.split(':')[0]!, tf: '1h', pair: 'EURUSD', side: 1, entryT: t, exitT: t + 6 * 3_600_000, entry: 1, exit: 1, r: mean + sd * z, stopPct: 0.3, reason: 'target', bars: 6, stop: 0.99, stop0: 0.99, target: 1.02 });
  }
  return { key, isRandom: key.startsWith('random'), done };
}

describe('v18 honest statistics over the lab rows', () => {
  const noise = Array.from({ length: 40 }, (_, k) => row(`n${k}:1h`, 160, 0, 1000 + k));
  const edge = row('edge:1h', 160, 0.6, 7);
  const random = row('random:1h', 400, -0.02, 99);
  const h = honestStats([edge, ...noise, random], { from: FROM, to: TO, oosFrom: OOS });

  it('counts the trials, deflates every row, and keeps the real edge while most noise rows look weak', () => {
    expect(h.report.trials).toBe(41); // every row has 30+ unseen trades; random is not a trial
    expect(h.rows.has('random:1h')).toBe(false);
    const e = h.rows.get('edge:1h')!;
    expect(e.n).toBeGreaterThanOrEqual(HONEST.minOut);
    expect(e.sr).toBeGreaterThan(0.3);
    expect(e.dsr).toBeGreaterThan(0.6);
    expect(e.minTrl).not.toBeNull();
    const dsrs = noise.map((x) => h.rows.get(x.key)!.dsr).sort((a, b) => a - b);
    expect(dsrs.filter((d) => d < HONEST.minDsr).length).toBeGreaterThan(30);
    // the real edge is clearly above the noise rows' deflated Sharpes
    expect(e.dsr).toBeGreaterThan(dsrs[Math.floor(dsrs.length * 0.9)]!);
    expect(h.report.expectedMaxSr).toBeGreaterThan(0.1);
  });

  it('PBO is low with a real edge in the pool and the SPA picks it as the best row', () => {
    expect(h.report.pbo).not.toBeNull();
    expect(h.report.pbo!.pbo).toBeLessThan(0.2);
    expect(h.report.spa).not.toBeNull();
    expect(h.report.spa!.bestKey).toBe('edge:1h');
    expect(h.report.spa!.pSpa).toBeLessThan(0.1);
    expect(h.report.benchmark).toBe('random');
    expect(h.report.rowsInMatrix).toBe(41);
    expect(h.report.note).toMatch(/PBO \d+%/);
  });

  it('pure noise selection → PBO near a half and the best row does not beat random', () => {
    const g = honestStats([...noise, random], { from: FROM, to: TO, oosFrom: OOS });
    // with ~1 trade a week per row the block Sharpes are noisy: PBO lands well away from the "real edge" case
    expect(g.report.pbo!.pbo).toBeGreaterThan(0.15);
    expect(g.report.pbo!.pbo).toBeLessThan(0.85);
    expect(g.report.spa!.pSpa).toBeGreaterThan(0.1);
  });

  it('the downgrade: Edge with a low deflated Sharpe → Maybe, with the reason; Maybe / No untouched', () => {
    const weak = { sr: 0.12, srStar: 0.2, psr0: 0.9, dsr: 0.2, minTrl: null, n: 40 };
    const d = dsrDowngrade('edge', weak, 300);
    expect(d.verdict).toBe('maybe');
    expect(d.why).toMatch(/one of 300 rows.*deflated Sharpe 20%/);
    expect(dsrDowngrade('edge', { ...weak, dsr: 0.7 }, 300).verdict).toBe('edge');
    expect(dsrDowngrade('maybe', weak, 300)).toEqual({ verdict: 'maybe', why: null });
    expect(dsrDowngrade('edge', undefined, 300).verdict).toBe('edge');
  });

  it('too little history → no PBO, the per-row numbers still come', () => {
    const short = honestStats([edge, noise[0]!], { from: TO - 30 * DAY, to: TO, oosFrom: TO - 10 * DAY });
    expect(short.report.pbo).toBeNull();
  });

  it('v28.13: a busy row with a small steady edge is not graded "luck" because thin rows have noisy Sharpes', () => {
    // 60 thin no-edge rows (110 trades, ~33 unseen each) + one row with 4,500 trades at +0.11R (sd 0.45): per trade its Sharpe is
    // only ~0.24, below what the thin rows reach by chance, but over the same unseen weeks it is far above them
    const thin = Array.from({ length: 60 }, (_, k) => row(`t${k}:1h`, 110, 0, 2000 + k));
    const busy = row('busy:4h', 4500, 0.11, 77, 0.45);
    const g = honestStats([busy, ...thin, random], { from: FROM, to: TO, oosFrom: OOS });
    const b = g.rows.get('busy:4h')!;
    expect(b.dsr).toBeGreaterThan(0.95);
    const thinOk = thin.filter((x) => (g.rows.get(x.key)?.dsr ?? 0) >= HONEST.minDsr).length;
    expect(thinOk).toBeLessThan(6);
  });
});
