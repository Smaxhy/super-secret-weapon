import { describe, expect, it } from 'vitest';
import { evaluateSafety, type SafetyInputs } from '../src/evaluator/safety-checker';
import { TOKEN_2022_PROGRAM_ID } from '../src/lib/pumpfun';

const clean: SafetyInputs = {
  mint: 'm',
  owner: TOKEN_2022_PROGRAM_ID,
  mintAuthority: null,
  freezeAuthority: null,
  decimals: 6,
  supply: 1_000_000_000_000_000n,
  extensions: ['MetadataPointer', 'TokenMetadata'],
  name: 'Good Coin',
  symbol: 'GOOD',
  uri: 'https://ipfs.io/ipfs/x',
  devInitialBuyPct: 2,
  creatorBlacklisted: false,
};

describe('evaluateSafety', () => {
  it('scores a standard Pump.fun token 100', () => {
    const r = evaluateSafety(clean);
    expect(r.score).toBe(100);
    expect(r.hardFail).toBe(false);
  });
  it('hard-fails on a live mint authority', () => {
    const r = evaluateSafety({ ...clean, mintAuthority: 'someone' });
    expect(r.hardFail).toBe(true);
    expect(r.score).toBe(0);
  });
  it('hard-fails on freeze authority, transfer hooks and blacklisted creators', () => {
    expect(evaluateSafety({ ...clean, freezeAuthority: 'x' }).hardFail).toBe(true);
    expect(evaluateSafety({ ...clean, extensions: ['TransferHook'] }).hardFail).toBe(true);
    expect(evaluateSafety({ ...clean, creatorBlacklisted: true }).hardFail).toBe(true);
    expect(evaluateSafety({ ...clean, owner: 'SomethingElse111' }).hardFail).toBe(true);
  });
  it('penalises (but does not hard-fail) a big dev buy', () => {
    const r = evaluateSafety({ ...clean, devInitialBuyPct: 25 });
    expect(r.hardFail).toBe(false);
    expect(r.score).toBe(75);
  });
});
