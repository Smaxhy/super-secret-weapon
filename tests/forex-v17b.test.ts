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

  it('live: the bot sizes down (or skips) a trade that moves with an open one, only while the cap is on', async () => {
    vi.useFakeTimers({ now: WED });
    const r = new R();
    const open: PracticePosition = { id: 'p1', pair: 'EURUSD', side: 1, units: 50_000, entry: 1.1, marginUsd: 200, leverage: 30, stop: 1.0978, target: 1.11, openedAt: WED - 10 * M, checkedT: WED - M, ref: `a:1h:EURUSD:${WED - H}`, strategy: 'a', tf: '1h' };
    r.m.set('fx:practice:bot', JSON.stringify({ ...newAccount(1000), open: [open] }));
    const p = new Practice(asRedis(r));
    const q = (id: string, mid: number): Quote => ({ id, mid, bid: mid - 0.00005, ask: mid + 0.00005, t: WED, bars: [[WED - M, mid, mid, mid]], dayChangePct: 0, source: 'yahoo', priceT: WED });
    (p as unknown as { quotes: () => Promise<Record<string, Quote>> }).quotes = async () => ({ EURUSD: q('EURUSD', 1.1), GBPUSD: q('GBPUSD', 1.27) });
    const lab = { ref: `b:1h:GBPUSD:${WED}`, strategy: 'b', tf: '1h', pair: 'GBPUSD', side: 1 as const, entryT: WED - 30_000, stop: 1.268, target: 1.274, chosen: true, sizeF: 1, prio: 0.2, judge: null };
    const held = { ...lab, ref: open.ref!, strategy: 'a', pair: 'EURUSD', entryT: WED - H, stop: 1.0978, target: 1.11 };
    const ev = await p.syncBot([held, lab], () => null, {}, { scope: ['1h', '4h'], heat: { active: true, book, m: book.now } });
    const a = JSON.parse(r.m.get('fx:practice:bot')!) as PracticeAccount;
    const gbp = a.open.find((x) => x.pair === 'GBPUSD');
    // EURUSD already risks ~1.1% (50k units × 22 pips); cap 3% with ρ≈1 → GBPUSD gets what's left, not its full 1%
    if (gbp) {
      expect(gbp.riskPct!).toBeLessThanOrEqual(1);
      expect(ev.join(' ')).toMatch(/smaller: it moves with your open EURUSD/);
    } else expect(ev.join(' ')).toMatch(/correlated risk is full/);
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
