import { describe, expect, it } from 'vitest';
import { WSOL_MINT } from '../src/lib/pumpfun';
import { translatePortalMessage } from '../src/scanner/pumpportal-listener';

describe('PumpPortal translation', () => {
  it('create → create event + the dev launch buy', () => {
    const evs = translatePortalMessage({ signature: 's', mint: 'M', traderPublicKey: 'DEV', txType: 'create', initialBuy: 34_612_903.2, solAmount: 1, bondingCurveKey: 'BC', vTokensInBondingCurve: 1_038_387_096.8, vSolInBondingCurve: 31, name: 'Frog', symbol: 'FROG', uri: 'https://ipfs.io/ipfs/x' });
    expect(evs[0]).toMatchObject({ kind: 'create', mint: 'M', creator: 'DEV', symbol: 'FROG', virtualSolReserves: 30_000_000_000n });
    expect(evs[1]).toMatchObject({ kind: 'trade', isBuy: true, user: 'DEV', solAmount: 1_000_000_000n, tokenAmount: 34_612_903_200_000n, virtualSolReserves: 31_000_000_000n, balanceAfter: 34_612_903_200_000n });
  });
  it('curve buy/sell carries reserves and the exact balance after', () => {
    const [ev] = translatePortalMessage({ mint: 'M', traderPublicKey: 'U', txType: 'sell', tokenAmount: 1000, solAmount: 0.01, newTokenBalance: 0, vTokensInBondingCurve: 900_000_000, vSolInBondingCurve: 35.7, pool: 'pump' });
    expect(ev).toMatchObject({ kind: 'trade', isBuy: false, tokenAmount: 1_000_000_000n, solAmount: 10_000_000n, balanceAfter: 0n, virtualTokenReserves: 900_000_000_000_000n });
  });
  it('PumpSwap trades become pool trades', () => {
    const [ev] = translatePortalMessage({ mint: 'M', traderPublicKey: 'U', txType: 'buy', tokenAmount: 500, solAmount: 2, newTokenBalance: 500, pool: 'pump-amm' });
    expect(ev).toMatchObject({ kind: 'ammTrade', pool: 'amm:M', isBuy: true, baseAmount: 500_000_000n, quoteAmount: 2_000_000_000n, balanceAfter: 500_000_000n });
    expect((ev as { baseReserve?: bigint }).baseReserve).toBeUndefined();
  });
  it('migration → complete + pool with reserves to derive', () => {
    const evs = translatePortalMessage({ mint: 'M', txType: 'migrate', pool: 'pump-amm' });
    expect(evs.map((e) => e.kind)).toEqual(['complete', 'ammPool']);
    expect(evs[1]).toMatchObject({ pool: 'amm:M', baseMint: 'M', quoteMint: WSOL_MINT, baseReserve: 0n });
  });
  it('ignores confirmations and junk', () => {
    expect(translatePortalMessage({ message: 'Successfully subscribed' })).toEqual([]);
    expect(translatePortalMessage({ mint: 'M', txType: 'weird' })).toEqual([]);
  });
});
