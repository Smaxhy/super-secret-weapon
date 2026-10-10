/**
 * Paper P&L must never come from bad pricing. Each test reproduces one way a
 * paper SELL could be filled at an absurd price (the "+30 SOL on a 0.5 SOL
 * position" bug) and checks it can't happen any more — while a REAL 10x still pays.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: Array<{ type: string; level?: string; mint?: string }> = [];
vi.mock('../src/lib/bot-events', () => ({ recordEvent: vi.fn(async (e: { type: string; level?: string; mint?: string }) => void events.push(e)) }));

import type { Redis } from 'ioredis';
import { getConfig } from '../src/config/runtime-config';
import { PaperExecutor } from '../src/executor/paper-trader';
import { PUMP_MIGRATION_POOL_TOKENS, WSOL_MINT } from '../src/lib/pumpfun';
import { deriveMetrics, LiveState } from '../src/scanner/live-state';
import { FakeRedis } from './profit-fake-redis';

const SOL = 1_000_000_000n;
const nowSec = () => Math.floor(Date.now() / 1000);

let redis: FakeRedis;
let ls: LiveState;
let paper: PaperExecutor;
const curve = { vSol: 30n * SOL, vTok: 1_073_000_000_000_000n };

async function launch(mint: string): Promise<void> {
  curve.vSol = 30n * SOL;
  curve.vTok = 1_073_000_000_000_000n;
  await ls.onCreate(
    {
      kind: 'create', name: 'T', symbol: 'T', uri: '', mint, bondingCurve: 'BC', user: 'DEV', creator: 'DEV', timestamp: nowSec() - 600,
      virtualTokenReserves: curve.vTok, virtualSolReserves: curve.vSol, realTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n,
    },
    Date.now(),
  );
}

async function curveBuy(mint: string, lamports: bigint, user = 'U'): Promise<void> {
  const out = (curve.vTok * lamports) / (curve.vSol + lamports);
  curve.vSol += lamports;
  curve.vTok -= out;
  await ls.onTrade({ kind: 'trade', mint, solAmount: lamports, tokenAmount: out, isBuy: true, user, timestamp: nowSec(), virtualSolReserves: curve.vSol, virtualTokenReserves: curve.vTok });
}

/** Fill the curve to ~115 SOL (completion) and migrate. */
async function completeCurve(mint: string): Promise<void> {
  while (curve.vSol < 115n * SOL) await curveBuy(mint, 5n * SOL, `W${curve.vSol}`);
  await ls.onComplete({ kind: 'complete', user: 'X', mint, bondingCurve: 'BC', timestamp: nowSec() });
}

/** A real PumpSwap trade (event-style, reserves after the trade) on a pool we model exactly. */
function poolTrade(pool: { id: string; base: bigint; quote: bigint }, isBuy: boolean, amount: bigint) {
  let baseAmount: bigint;
  let quoteAmount: bigint;
  if (isBuy) {
    quoteAmount = amount;
    baseAmount = (pool.base * amount) / (pool.quote + amount);
    pool.base -= baseAmount;
    pool.quote += quoteAmount;
  } else {
    baseAmount = amount;
    quoteAmount = (pool.quote * amount) / (pool.base + amount);
    pool.base += baseAmount;
    pool.quote -= quoteAmount;
  }
  return {
    kind: 'ammTrade' as const, pool: pool.id, user: 'T', isBuy, baseAmount, quoteAmount,
    baseReserve: pool.base, quoteReserve: pool.quote, feeLamports: 0n, timestamp: nowSec(),
  };
}

async function priceOf(mint: string): Promise<number> {
  return deriveMetrics((await ls.read(mint))!).priceSol;
}

beforeEach(() => {
  const p = getConfig().paper;
  p.latencyMinMs = 0;
  p.latencyMaxMs = 0;
  redis = new FakeRedis();
  ls = new LiveState(redis as unknown as Redis);
  paper = new PaperExecutor(ls);
  events.length = 0;
});

describe('paper sells cannot be priced against a hijacked / fake pool', () => {
  it('ignores a PumpSwap pool someone created for a token still on the curve', async () => {
    await launch('M1');
    for (let i = 0; i < 6; i++) await curveBuy('M1', 5n * SOL);
    const buy = await paper.buy({ mint: 'M1', solAmount: 0.5, maxSlippageBps: 2500 });
    expect(buy.ok).toBe(true);
    // A random user pool: 1 token vs 50 SOL — an absurd price.
    await ls.onAmmPool({ kind: 'ammPool', pool: 'FAKE', baseMint: 'M1', quoteMint: WSOL_MINT, baseReserve: 1_000_000n, quoteReserve: 50n * SOL, timestamp: nowSec() });
    const sell = await paper.sell({ mint: 'M1', tokenAmountRaw: buy.tokenAmountRaw, maxSlippageBps: 2500 });
    expect(sell.ok).toBe(true);
    expect(sell.solAmount).toBeLessThan(0.6); // was ~50 SOL before the fix
    expect((await ls.read('M1'))!.complete).toBe(false);
  });

  it('ignores a pool whose opening price is far from the final curve price', async () => {
    await launch('M2');
    for (let i = 0; i < 6; i++) await curveBuy('M2', 5n * SOL);
    const buy = await paper.buy({ mint: 'M2', solAmount: 0.5, maxSlippageBps: 2500 });
    await completeCurve('M2');
    await ls.onAmmPool({ kind: 'ammPool', pool: 'FAKE', baseMint: 'M2', quoteMint: WSOL_MINT, baseReserve: 1_000_000_000n, quoteReserve: 40n * SOL, timestamp: nowSec() });
    const sell = await paper.sell({ mint: 'M2', tokenAmountRaw: buy.tokenAmountRaw, maxSlippageBps: 2500 });
    // Fair: price rose ~4x from 60 → 115 SOL on the curve. Never 40 SOL.
    expect(sell.solAmount).toBeLessThan(3);
  });

  it('keeps the first real pool; a second pool and its trades do not touch the reserves', async () => {
    await launch('M3');
    await completeCurve('M3');
    const real = { id: 'REAL', base: PUMP_MIGRATION_POOL_TOKENS, quote: curve.vSol - 30n * SOL };
    expect(await ls.onAmmPool({ kind: 'ammPool', pool: 'REAL', baseMint: 'M3', quoteMint: WSOL_MINT, baseReserve: real.base, quoteReserve: real.quote, timestamp: nowSec() })).toBe('M3');
    const other = { id: 'OTHER', base: 1_000_000_000_000n, quote: SOL / 2n }; // same-ish price, tiny pool
    expect(await ls.onAmmPool({ kind: 'ammPool', pool: 'OTHER', baseMint: 'M3', quoteMint: WSOL_MINT, baseReserve: other.base, quoteReserve: other.quote, timestamp: nowSec() })).toBeNull();
    // Someone pumps the tiny pool 30x.
    for (let i = 0; i < 20; i++) await ls.onAmmTrade(poolTrade(other, true, SOL / 2n));
    const v = (await ls.read('M3'))!;
    expect(v.ammBaseReserve).toBe(real.base);
    expect(v.ammQuoteReserve).toBe(real.quote);
  });

  it('a real pool replaces the PumpPortal placeholder pool', async () => {
    await launch('M4');
    await completeCurve('M4');
    await ls.onAmmPool({ kind: 'ammPool', pool: 'amm:M4', baseMint: 'M4', quoteMint: WSOL_MINT, baseReserve: 0n, quoteReserve: 0n, timestamp: nowSec() });
    const real = { id: 'REAL4', base: PUMP_MIGRATION_POOL_TOKENS, quote: 84n * SOL };
    expect(await ls.onAmmPool({ kind: 'ammPool', pool: 'REAL4', baseMint: 'M4', quoteMint: WSOL_MINT, baseReserve: real.base, quoteReserve: real.quote, timestamp: nowSec() })).toBe('M4');
    // The placeholder arriving again later must not overwrite the real reserves.
    await ls.onAmmPool({ kind: 'ammPool', pool: 'amm:M4', baseMint: 'M4', quoteMint: WSOL_MINT, baseReserve: 0n, quoteReserve: 0n, timestamp: nowSec() });
    expect((await ls.read('M4'))!.ammQuoteReserve).toBe(84n * SOL);
  });
});

describe('PumpSwap price must be backed by the trades themselves', () => {
  it('derived reserves (PumpPortal) do not drift away from the price trades actually happen at', async () => {
    await launch('D1');
    await completeCurve('D1');
    await ls.onAmmPool({ kind: 'ammPool', pool: 'amm:D1', baseMint: 'D1', quoteMint: WSOL_MINT, baseReserve: 0n, quoteReserve: 0n, timestamp: nowSec() });
    const start = await priceOf('D1');
    const buy = await paper.buy({ mint: 'D1', solAmount: 0.5, maxSlippageBps: 2500 });
    expect(buy.ok).toBe(true);
    // 200 buys reported at a FLAT market price (we miss the matching sells): the
    // real price didn't move, so our model must not walk it up 50x step by step.
    const tokens = 1_000_000_000_000n; // 1M tokens
    const lamports = BigInt(Math.round(start * 1e6 * 1e9));
    for (let i = 0; i < 200; i++) {
      await ls.onAmmTrade({ kind: 'ammTrade', pool: 'amm:D1', user: `B${i}`, isBuy: true, baseAmount: tokens, quoteAmount: lamports, feeLamports: 0n, timestamp: nowSec() });
    }
    expect((await priceOf('D1')) / start).toBeLessThan(2);
    const sell = await paper.sell({ mint: 'D1', tokenAmountRaw: buy.tokenAmountRaw, maxSlippageBps: 2500 });
    expect(sell.solAmount).toBeLessThan(1); // was ~25+ SOL before the fix
  });

  it('rejects a chain of mis-decoded events whose reserves disagree with their own amounts', async () => {
    await launch('E1');
    await completeCurve('E1');
    const pool = { id: 'POOL', base: PUMP_MIGRATION_POOL_TOKENS, quote: 85n * SOL };
    await ls.onAmmPool({ kind: 'ammPool', pool: 'POOL', baseMint: 'E1', quoteMint: WSOL_MINT, baseReserve: pool.base, quoteReserve: pool.quote, timestamp: nowSec() });
    const start = await priceOf('E1');
    // Each event: a small real trade, but reserves that claim the price rose 2.2x (under the old 2.5x limit).
    let fakeBase = pool.base;
    for (let i = 0; i < 6; i++) {
      const t = poolTrade(pool, true, SOL / 10n);
      fakeBase = fakeBase / 2n;
      const fakeQuote = (pool.quote * 11n) / 10n;
      await ls.onAmmTrade({ ...t, baseReserve: fakeBase, quoteReserve: fakeQuote });
    }
    expect((await priceOf('E1')) / start).toBeLessThan(1.5);
  });

  it('BOOST pools: the price follows the trades (virtual quote reserves), not the raw vault balance', async () => {
    await launch('V1');
    await completeCurve('V1');
    // The program trades on vault + 20 SOL of virtual quote reserves; events only show the vault.
    const VIRTUAL = 20n * SOL;
    const eff = { id: 'VPOOL', base: PUMP_MIGRATION_POOL_TOKENS, quote: 85n * SOL + VIRTUAL };
    await ls.onAmmPool({ kind: 'ammPool', pool: 'VPOOL', baseMint: 'V1', quoteMint: WSOL_MINT, baseReserve: eff.base, quoteReserve: eff.quote - VIRTUAL, timestamp: nowSec() });
    for (let i = 0; i < 6; i++) {
      const t = poolTrade(eff, i % 3 !== 2, i % 3 !== 2 ? SOL : 10_000_000_000_000n);
      await ls.onAmmTrade({ ...t, quoteReserve: t.quoteReserve - VIRTUAL }); // raw vault in the event
    }
    const real = Number(eff.quote) / 1e9 / (Number(eff.base) / 1e6);
    expect((await priceOf('V1')) / real).toBeGreaterThan(0.99);
    expect((await priceOf('V1')) / real).toBeLessThan(1.01);
    // A dust trade (no price of its own) must not drop the price back to the raw vault ratio.
    const dust = poolTrade(eff, true, 500_000n);
    await ls.onAmmTrade({ ...dust, quoteReserve: dust.quoteReserve - VIRTUAL });
    expect((await priceOf('V1')) / real).toBeGreaterThan(0.98);
  });

  it('a real 10x run on the pool still pays out (big single moves are not frozen out)', async () => {
    await launch('R1');
    await completeCurve('R1');
    const pool = { id: 'RPOOL', base: PUMP_MIGRATION_POOL_TOKENS, quote: 85n * SOL };
    await ls.onAmmPool({ kind: 'ammPool', pool: 'RPOOL', baseMint: 'R1', quoteMint: WSOL_MINT, baseReserve: pool.base, quoteReserve: pool.quote, timestamp: nowSec() });
    const buy = await paper.buy({ mint: 'R1', solAmount: 0.5, maxSlippageBps: 2500 });
    const start = await priceOf('R1');
    // One whale buy moves the price ~3x in a single trade (old code rejected it forever).
    await ls.onAmmTrade(poolTrade(pool, true, 63n * SOL));
    expect((await priceOf('R1')) / start).toBeGreaterThan(2.7);
    // Then steady buying to ~10x.
    while ((await priceOf('R1')) / start < 10) await ls.onAmmTrade(poolTrade(pool, true, 5n * SOL));
    const sell = await paper.sell({ mint: 'R1', tokenAmountRaw: buy.tokenAmountRaw, maxSlippageBps: 2500 });
    expect(sell.solAmount).toBeGreaterThan(4.5);
    expect(events.filter((e) => e.type === 'suspicious_fill')).toHaveLength(0);
  });
});

describe('sanity guard: fills are checked against the last real trade price', () => {
  it('clamps a sell quoted far above the last trade price and logs suspicious_fill', async () => {
    await launch('G1');
    await completeCurve('G1');
    const pool = { id: 'GPOOL', base: PUMP_MIGRATION_POOL_TOKENS, quote: 85n * SOL };
    await ls.onAmmPool({ kind: 'ammPool', pool: 'GPOOL', baseMint: 'G1', quoteMint: WSOL_MINT, baseReserve: pool.base, quoteReserve: pool.quote, timestamp: nowSec() });
    await ls.onAmmTrade(poolTrade(pool, true, SOL));
    const buy = await paper.buy({ mint: 'G1', solAmount: 0.5, maxSlippageBps: 2500 });
    // Corrupt the stored reserves directly (whatever the cause) → 50x price.
    await redis.hset('tok:G1:live', { ammBase: (pool.base / 50n).toString() });
    const sell = await paper.sell({ mint: 'G1', tokenAmountRaw: buy.tokenAmountRaw, maxSlippageBps: 2500 });
    expect(sell.solAmount).toBeLessThan(0.55);
    expect(sell.solAmount).toBeGreaterThan(0.4);
    expect(events.some((e) => e.type === 'suspicious_fill' && e.level === 'WARN')).toBe(true);
  });

  it('clamps a buy that would get far too many tokens (cheap fill) to the reference price', async () => {
    await launch('G2');
    for (let i = 0; i < 6; i++) await curveBuy('G2', 5n * SOL);
    const fair = await paper.buy({ mint: 'G2', solAmount: 0.5, maxSlippageBps: 2500 });
    await redis.hset('tok:G2:live', { vTok: (curve.vTok * 20n).toString() }); // 20x too cheap
    const cheap = await paper.buy({ mint: 'G2', solAmount: 0.5, maxSlippageBps: 2500 });
    expect(Number(cheap.tokenAmountRaw) / Number(fair.tokenAmountRaw)).toBeLessThan(1.2);
    expect(events.some((e) => e.type === 'suspicious_fill')).toBe(true);
  });

  it('on-chain curve poll with a completed / empty curve does not overwrite reserves', async () => {
    await launch('C1');
    for (let i = 0; i < 6; i++) await curveBuy('C1', 5n * SOL);
    const before = await priceOf('C1');
    await ls.applyCurveState('C1', { virtualSolReserves: 115n * SOL, virtualTokenReserves: 0n, complete: true });
    expect(await priceOf('C1')).toBeCloseTo(before, 15);
    expect((await ls.read('C1'))!.complete).toBe(true);
  });
});
