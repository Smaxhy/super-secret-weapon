/**
 * The chart-strategy lab end to end: real trades → live state + crowd log → 15 s candles →
 * every strategy runs → a golden-pocket setup opens a virtual trade; junk coins are skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config/runtime-config';
import type { Redis } from 'ioredis';
import { TaLab } from '../src/learner/ta-lab';
import { CrowdTracker } from '../src/scanner/crowd-tracker';
import { LiveState } from '../src/scanner/live-state';
import { FakeRedis } from './profit-fake-redis';

const SOL = 1_000_000_000n;

async function coinWithChart(path: number[], opts: { whale?: boolean } = {}) {
  const redis = new FakeRedis();
  const ls = new LiveState(redis as unknown as Redis);
  const crowd = new CrowdTracker();
  const mint = `MINT${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const start = now - path.length * 5_000 - 5_000;
  let vSol = 30n * SOL;
  let vTok = 1_073_000_000_000_000n;
  await ls.onCreate({ kind: 'create', name: 'T', symbol: 'T', uri: '', mint, bondingCurve: 'BC', user: 'DEV', creator: 'DEV', timestamp: Math.floor(start / 1000) - 40 * 60, virtualTokenReserves: vTok, virtualSolReserves: vSol, realTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n }, start);
  const held = new Map<string, bigint>();
  let slot = 1;
  const trade = async (user: string, isBuy: boolean, lamports: bigint, t: number) => {
    let sol = lamports;
    let tok: bigint;
    if (isBuy) {
      tok = (vTok * sol) / (vSol + sol);
      vSol += sol;
      vTok -= tok;
      held.set(user, (held.get(user) ?? 0n) + tok);
    } else {
      tok = ((held.get(user) ?? 0n) * 6n) / 10n;
      if (tok <= 0n) return;
      sol = (vSol * tok) / (vTok + tok);
      vSol -= sol;
      vTok += tok;
      held.set(user, (held.get(user) ?? 0n) - tok);
    }
    const ev = { kind: 'trade' as const, mint, solAmount: sol, tokenAmount: tok, isBuy, user, timestamp: Math.floor(t / 1000), virtualSolReserves: vSol, virtualTokenReserves: vTok, feeLamports: (sol * 125n) / 10_000n };
    await ls.onTrade(ev);
    crowd.onCurveTrade(ev, slot++, t);
  };
  // Seed the curve so the market cap clears the lab's minimum.
  // Earlier action: a first pump and a 30% dump (the previous leg), then the chart below starts.
  for (let i = 0; i < 25; i++) await trade(`SEED${i}`, true, SOL / 2n, start - 5 * 60_000 + i * 2_000);
  for (let i = 0; i < 10; i++) await trade(`SEED${i}`, false, 0n, start - 3 * 60_000 + i * 4_000);
  if (opts.whale) await trade('WHALE', true, 60n * SOL, start - 30_000);
  const price = () => Number(vSol) / Number(vTok) * 1e-3;
  const p0 = price();
  let w = 0;
  // Walk the price along `path` (multiples of the starting price), one trade every 5 s.
  for (let k = 0; k < path.length; k++) {
    const target = p0 * path[k]!;
    const t = start + k * 5_000;
    if (price() < target) await trade(`B${w++}`, true, SOL / 4n + BigInt(Math.floor(Math.random() * 1e8)), t);
    else {
      // Next holder with tokens sells 60% of them (sellers rotate, like a real crowd).
      const sellers = [...held.entries()].filter(([u, b]) => u.startsWith('B') && b > 0n);
      if (sellers.length) await trade(sellers[k % sellers.length]![0], false, 0n, t);
    }
  }
  return { redis, ls, crowd, mint, now };
}

const leg = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);

describe('chart-strategy lab (live wiring)', () => {
  // Force the random baseline on every look, so the wiring is tested deterministically.
  let saved = 40;
  beforeEach(() => {
    saved = getConfig().ta.baselineOneIn;
    (getConfig().ta as { baselineOneIn: number }).baselineOneIn = 1;
  });
  afterEach(() => {
    (getConfig().ta as { baselineOneIn: number }).baselineOneIn = saved;
  });
  it('runs every strategy on a real chart and opens virtual trades for the setups that fire', async () => {
    // Flat, +60% run, ~62% pullback, bounce — trades every 5 s (3 per 15 s candle).
    const path = [...leg(1, 1, 30), ...leg(1, 1.6, 60), ...leg(1.6, 1.23, 24), ...leg(1.23, 1.32, 6)];
    const { redis, ls, crowd, mint, now } = await coinWithChart(path);
    expect(crowd.candles(mint).length).toBeGreaterThan(20);
    const lab = new TaLab(redis as unknown as Redis, crowd, ls);
    await lab.tick(now);
    const tr = crowd.trades(mint);
    expect(tr.length).toBeGreaterThan(50);
    expect(lab.stats.coinsLooked).toBe(1);
    expect(lab.stats.signals).toBeGreaterThan(0);
    expect(lab.openCount).toBeGreaterThan(0);
    const rep = await lab.report();
    expect(rep.strategies.length).toBeGreaterThanOrEqual(24);
    expect(rep.strategies.every((s) => !s.proven)).toBe(true); // nothing is proven until it earns it
  });
  it('skips junk: one wallet holding most of the supply never gets lab trades (not even random ones)', async () => {
    const path = [...leg(1, 1, 30), ...leg(1, 1.6, 60), ...leg(1.6, 1.23, 24), ...leg(1.23, 1.32, 6)];
    const { redis, ls, crowd, now } = await coinWithChart(path, { whale: true });
    const lab = new TaLab(redis as unknown as Redis, crowd, ls);
    await lab.tick(now);
    expect(lab.openCount).toBe(0);
  });
});
