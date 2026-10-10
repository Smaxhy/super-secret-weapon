import { describe, expect, it } from 'vitest';
import { analyzeSwaps, coinTrades, simulateCopy, swapFromTx, toSwaps } from '../src/learner/wallet-report';
import type { SolscanSwap } from '../src/lib/solscan';

const SOL = 'So11111111111111111111111111111111111111112';
const T0 = 1_760_000_000; // seconds
const row = (sec: number, mint: string, buy: boolean, sol: number, tokens: number): SolscanSwap => ({
  block_time: T0 + sec,
  trans_id: `${mint}-${sec}`,
  activity_type: 'ACTIVITY_TOKEN_SWAP',
  routers: buy
    ? { token1: SOL, token1_decimals: 9, amount1: sol * 1e9, token2: mint, token2_decimals: 6, amount2: tokens * 1e6 }
    : { token1: mint, token1_decimals: 6, amount1: tokens * 1e6, token2: SOL, token2_decimals: 9, amount2: sol * 1e9 },
});

describe('wallet analyzer (Solscan)', () => {
  it('reads SOL↔token swaps, skips token↔token', () => {
    const s = toSwaps([row(0, 'A', true, 1, 1000), row(60, 'A', false, 1.5, 1000), { block_time: T0, trans_id: 'x', activity_type: 'ACTIVITY_TOKEN_SWAP', routers: { token1: 'A', token1_decimals: 6, amount1: 1, token2: 'B', token2_decimals: 6, amount2: 1 } }]);
    expect(s.map((x) => [x.mint, x.buy, x.sol])).toEqual([['A', true, 1], ['A', false, 1.5]]);
  });
  it('builds round trips: profit on the sold part, scaling out, hold time', () => {
    const coins = coinTrades(toSwaps([row(0, 'A', true, 1, 1000), row(30, 'A', false, 0.8, 500), row(90, 'A', false, 1, 500), row(100, 'B', true, 2, 100), row(200, 'B', false, 1, 100), row(300, 'C', false, 5, 10)]));
    const a = coins.find((c) => c.mint === 'A')!;
    expect(a).toMatchObject({ closed: true, scaledOut: true, pnlSol: 0.8, firstSellAfterSec: 30, holdSec: 90, exitMultiple: 1.8 });
    expect(coins.find((c) => c.mint === 'B')).toMatchObject({ closed: true, pnlSol: -1, pnlPct: -50 });
    expect(coins.find((c) => c.mint === 'C')).toBeUndefined(); // sold without a buy we saw
  });
  it('copy simulation: delay and costs eat thin edges', () => {
    const coins = coinTrades(toSwaps(Array.from({ length: 20 }, (_, i) => [row(i * 600, `M${i}`, true, 1, 1000), row(i * 600 + 20, `M${i}`, false, 1.06, 1000)]).flat()));
    const instant = simulateCopy(coins, { sizeSol: 1, entrySlipPct: 0, exitSlipPct: 0, costPct: 0, bankrollSol: 10 });
    const late = simulateCopy(coins, { sizeSol: 1, entrySlipPct: 6, exitSlipPct: 4, costPct: 2.8, bankrollSol: 10 });
    expect(instant.pnlSol).toBeCloseTo(1.2, 1);
    expect(late.pnlSol).toBeLessThan(0);
    const r = analyzeSwaps('W', toSwaps(Array.from({ length: 20 }, (_, i) => [row(i * 600, `M${i}`, true, 1, 1000), row(i * 600 + 20, `M${i}`, false, 1.06, 1000)]).flat()), {});
    expect(r.winRatePct).toBe(100);
    expect(r.verdict).toMatch(/Not copyable|Only works/);
    expect(r.style[0]).toMatch(/very fast/);
  });
});

describe('wallet history from RPC (balance changes)', () => {
  const W = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';
  const OTHER = '11111111111111111111111111111111';
  const tx = (solDeltaLamports: number, tokDelta: number, opts: { wsol?: number; fee?: number; err?: unknown } = {}) =>
    ({
      blockTime: T0,
      meta: {
        err: opts.err ?? null,
        fee: opts.fee ?? 5000,
        preBalances: [10e9, 0],
        postBalances: [10e9 + solDeltaLamports - (opts.fee ?? 5000), 0],
        preTokenBalances: [{ accountIndex: 2, mint: 'MINT', owner: W, uiTokenAmount: { uiAmount: 100 } }, ...(opts.wsol ? [{ accountIndex: 3, mint: SOL, owner: W, uiTokenAmount: { uiAmount: 0 } }] : [])],
        postTokenBalances: [{ accountIndex: 2, mint: 'MINT', owner: W, uiTokenAmount: { uiAmount: 100 + tokDelta } }, ...(opts.wsol ? [{ accountIndex: 3, mint: SOL, owner: W, uiTokenAmount: { uiAmount: opts.wsol } }] : [])],
      },
      transaction: { signatures: ['sig1'], message: { staticAccountKeys: [{ toBase58: () => W }, { toBase58: () => OTHER }] } },
    }) as never;
  it('turns balance changes into a buy / sell, ignoring the network fee', () => {
    expect(swapFromTx(tx(-1e9, 5000), W)).toMatchObject({ buy: true, sol: 1, tokens: 5000, mint: 'MINT' });
    expect(swapFromTx(tx(0, -100, { wsol: 2.5 }), W)).toMatchObject({ buy: false, sol: 2.5, tokens: 100 });
    expect(swapFromTx(tx(-1e9, 0), W)).toBeNull(); // a plain SOL transfer
    expect(swapFromTx(tx(-1e9, 5000, { err: { x: 1 } }), W)).toBeNull(); // failed tx
    expect(swapFromTx(tx(-1e9, 5000), OTHER.replace(/1/g, '2'))).toBeNull(); // not our wallet
  });
});
