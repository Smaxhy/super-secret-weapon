import { describe, expect, it } from 'vitest';
import { agg, CopyReplay, DEFAULT_COPY_CFG, qualify } from '../src/learner/copy-replay';
import type { TapeRow } from '../src/learner/replay';

const T0 = 1_700_000_000_000;
const cfg = { ...DEFAULT_COPY_CFG, sizeSol: 0.5, minSells: 3, minRealizedSol: 0.1 };

/** A wallet W buys a coin at price p0, the coin moves to p1 over `secs`, W sells all. Other wallets fill the tape. */
function round(mint: string, start: number, p0: number, p1: number, secs: number, w = 'WINNER'): TapeRow[] {
  const rows: TapeRow[] = [];
  // the coin exists for 60 s before W shows up (so W isn't a sniper)
  for (let s = 0; s < 60; s += 5) rows.push({ mint, t: start + s * 1000, w: `x${s}`, buy: s % 2 === 0, sol: 0.3, tok: 0.3 / p0, px: p0, pp: p0, amm: false, curvePct: 50 });
  const tb = start + 60_000;
  rows.push({ mint, t: tb, w, buy: true, sol: 1, tok: 1 / p0, px: p0, pp: p0, amm: false, curvePct: 50 });
  for (let s = 1; s < secs; s += 5) {
    const p = p0 + ((p1 - p0) * s) / secs;
    rows.push({ mint, t: tb + s * 1000, w: `y${s}`, buy: true, sol: 0.3, tok: 0.3 / p, px: p, pp: p, amm: false, curvePct: 50 });
  }
  const ts = tb + secs * 1000;
  rows.push({ mint, t: ts, w, buy: false, sol: p1 * (1 / p0), tok: 1 / p0, px: p1, pp: p1, amm: false, curvePct: 50 });
  rows.push({ mint, t: ts + 1000, w: 'z', buy: false, sol: 0.1, tok: 0.1 / p1, px: p1 * 0.98, pp: p1 * 0.98, amm: false, curvePct: 50 });
  return rows;
}

describe('copy replay — who is actually making money', () => {
  it('qualify: needs sells, win rate, PF, realised SOL and no bot pattern', () => {
    const base = { sells: 6, wins: 4, grossWin: 3, grossLoss: 1, realized: 2, buys: 8, repeats: 1 };
    expect(qualify(base, DEFAULT_COPY_CFG)).toBe(true);
    expect(qualify({ ...base, sells: 5 }, DEFAULT_COPY_CFG)).toBe(false);
    expect(qualify({ ...base, wins: 3 }, DEFAULT_COPY_CFG)).toBe(false);
    expect(qualify({ ...base, grossLoss: 2.5 }, DEFAULT_COPY_CFG)).toBe(false);
    expect(qualify({ ...base, realized: 0.2 }, DEFAULT_COPY_CFG)).toBe(false);
    expect(qualify({ ...base, buys: 20, repeats: 15 }, DEFAULT_COPY_CFG)).toBe(false); // bot
  });

  it('copies a wallet only AFTER it has proven itself, and mirrors its sells', () => {
    const eng = new CopyReplay(cfg);
    // three winning rounds → qualifies at the 3rd sell; the 4th + 5th rounds get copied
    let t = T0;
    for (let i = 0; i < 5; i++) {
      eng.feed(round(`c${i}`, t, 1e-6, 1.6e-6, 300));
      t += 600_000;
    }
    const rep = eng.finish('t', T0, t, Date.now());
    expect(rep.qualified).toBe(1);
    expect(rep.overall.n).toBe(2); // rounds 4 and 5 only
    expect(rep.overall.winPct).toBe(100);
    expect(rep.byExit[0]!.reason).toBe('mirror sell');
    // +60% move minus ~5% costs
    expect(rep.overall.avgPct).toBeGreaterThan(40);
    expect(rep.overall.avgPct).toBeLessThan(60);
    expect(rep.wallets_[0]!.wallet).toBe('WINNER');
    expect(rep.wallets_[0]!.qualifiedAt).not.toBeNull();
  });

  it('a winner who then sells into us loses us money (honest out-of-sample)', () => {
    const eng = new CopyReplay(cfg);
    let t = T0;
    for (let i = 0; i < 3; i++) { eng.feed(round(`w${i}`, t, 1e-6, 1.5e-6, 300)); t += 600_000; }
    // now its buy is the top: price falls 40% before it sells
    eng.feed(round('dump', t, 1e-6, 0.6e-6, 300));
    const rep = eng.finish('t', T0, t + 600_000, Date.now());
    expect(rep.overall.n).toBe(1);
    expect(rep.overall.totalSol).toBeLessThan(0);
    // hard stop at −35% fires before the mirror sell
    expect(rep.byExit[0]!.reason).toBe('hard stop');
  });

  it('tracked wallets are copied from their first buy, as their own kind', () => {
    const eng = new CopyReplay(cfg, new Map([['KOL1', 'Cupsey']]));
    eng.feed(round('k', T0, 1e-6, 1.3e-6, 200, 'KOL1'));
    const rep = eng.finish('t', T0, T0 + 600_000, Date.now());
    expect(rep.byKind).toEqual([expect.objectContaining({ kind: 'tracked', n: 1 })]);
    expect(rep.wallets_[0]!.label).toBe('Cupsey');
  });

  it('sniper buys (first 15 s of a coin) are neither learned from nor copied', () => {
    const eng = new CopyReplay(cfg, new Map([['S', null]]));
    const rows: TapeRow[] = [
      { mint: 'n', t: T0, w: 'S', buy: true, sol: 1, tok: 1e6, px: 1e-6, pp: 1e-6, amm: false, curvePct: 10 },
      { mint: 'n', t: T0 + 5_000, w: 'q', buy: true, sol: 0.5, tok: 4e5, px: 1.2e-6, pp: 1.2e-6, amm: false, curvePct: 12 },
      { mint: 'n', t: T0 + 20_000, w: 'S', buy: false, sol: 2, tok: 1e6, px: 2e-6, pp: 2e-6, amm: false, curvePct: 12 },
    ];
    eng.feed(rows);
    const rep = eng.finish('t', T0, T0 + 60_000, Date.now());
    expect(rep.overall.n).toBe(0);
    expect(eng.stats.get('S')!.sells).toBe(0);
  });

  it('agg + consistency: a wallet is copyable only when both halves of its copies paid', () => {
    expect(agg([]).n).toBe(0);
    const eng = new CopyReplay(cfg);
    let t = T0;
    for (let i = 0; i < 3; i++) { eng.feed(round(`p${i}`, t, 1e-6, 1.5e-6, 300)); t += 600_000; }
    for (let i = 0; i < 6; i++) { eng.feed(round(`g${i}`, t, 1e-6, 1.4e-6, 300)); t += 600_000; }
    const rep = eng.finish('t', T0, t, Date.now());
    expect(rep.wallets_[0]!.n).toBe(6);
    expect(rep.wallets_[0]!.consistent).toBe(true);
    expect(rep.copyable.length).toBe(1);
    expect(rep.byDay.length).toBeGreaterThan(0);
    expect(rep.verdict).toMatch(/1 wallet paid to copy/);
  });
});
