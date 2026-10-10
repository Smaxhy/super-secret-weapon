import { describe, expect, it } from 'vitest';
import { runningCandidates } from '../src/scanner/running-coins';

describe('running coins feeder', () => {
  it('merges the lists, keeps pump.fun coins, knows which ones migrated', () => {
    const c = runningCandidates(
      [
        { mint: 'Apump', symbol: 'A', name: 'a', complete: false, usdMarketCap: 30_000, banned: false, mayhem: false },
        { mint: 'Bpump', symbol: 'B', name: 'b', complete: null, dex: 'pumpswap', usdMarketCap: 90_000, banned: false, mayhem: false },
        { mint: 'Cpump', symbol: 'C', name: 'c', complete: true, usdMarketCap: 50_000, banned: true, mayhem: false },
        { mint: 'NotPumpCoin', symbol: 'N', name: 'n', complete: true, usdMarketCap: 50_000, banned: false, mayhem: false },
      ],
      [
        { mint: 'Dpump', symbol: 'D', name: 'd', dexId: 'pumpswap', marketCapUsd: 200_000, pump: true },
        { mint: 'Epump', symbol: 'E', name: 'e', dexId: 'pumpfun', marketCapUsd: 20_000, pump: true },
        { mint: 'Apump', symbol: 'A', name: 'a', dexId: 'pumpswap', marketCapUsd: 31_000, pump: true },
      ],
    );
    expect(c.map((x) => [x.mint, x.migrated])).toEqual([['Apump', false], ['Bpump', true], ['Dpump', true], ['Epump', false]]);
  });
});
