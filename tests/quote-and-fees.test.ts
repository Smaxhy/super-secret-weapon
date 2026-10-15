import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { DISCRIMINATORS, TOKEN_2022_PROGRAM_ID, decodeEventBytes, isSolQuote } from '../src/lib/pumpfun';
import { evaluateSafety, type SafetyInputs } from '../src/evaluator/safety-checker';
import { encodeCreate, randomKey } from './helpers';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ZERO = '11111111111111111111111111111111';
const base = () => ({ name: 'A', symbol: 'A', uri: 'u', mint: randomKey(), bondingCurve: randomKey(), user: randomKey(), creator: randomKey(), timestamp: 1_760_000_000 });
/** Newest create event: … token_program, is_mayhem_mode, is_cashback_enabled, quote_mint, … */
const withQuote = (quote: string) => {
  const old = encodeCreate(base()); // ends with is_mayhem_mode = false
  return Buffer.concat([old, Buffer.from([0]), Buffer.from(bs58.decode(quote)), Buffer.alloc(8), Buffer.alloc(8), Buffer.from([0])]);
};

describe('quote asset of a curve (pump.fun now pairs coins with USDC and other tokens)', () => {
  it('reads the quote mint from the newest create events', () => {
    const ev = decodeEventBytes(withQuote(USDC));
    expect(ev?.kind).toBe('create');
    expect(ev && 'quoteMint' in ev ? ev.quoteMint : null).toBe(USDC);
    expect(isSolQuote(USDC)).toBe(false);
  });
  it('SOL-paired (all zeros / wrapped SOL / older events without the field) counts as SOL', () => {
    const ev = decodeEventBytes(withQuote(ZERO));
    expect(isSolQuote(ev && 'quoteMint' in ev ? ev.quoteMint : undefined)).toBe(true);
    const old = decodeEventBytes(encodeCreate(base()));
    expect(old && 'quoteMint' in old ? old.quoteMint : undefined).toBeUndefined();
    expect(isSolQuote(undefined)).toBe(true);
    expect(DISCRIMINATORS.create.length).toBe(8);
  });
});

describe('Token-2022 transfer fee ("reward" coins take 1–3% on every buy and sell)', () => {
  const clean: SafetyInputs = {
    mint: 'm', owner: TOKEN_2022_PROGRAM_ID, mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1_000_000_000_000_000n,
    extensions: [], name: 'Good', symbol: 'GOOD', uri: 'https://x', devInitialBuyPct: 2, creatorBlacklisted: false,
  };
  it('a real fee → hard fail (never bought)', () => {
    const r = evaluateSafety({ ...clean, extensions: ['TransferFeeConfig'], transferFeeBps: 300 });
    expect(r.hardFail).toBe(true);
    expect(r.checks.find((c) => c.id === 'transfer_fee')?.detail).toMatch(/3\.00%/);
  });
  it('a 0% fee extension costs nothing → no penalty', () => {
    const r = evaluateSafety({ ...clean, extensions: ['TransferFeeConfig'], transferFeeBps: 0 });
    expect(r.hardFail).toBe(false);
    expect(r.score).toBe(evaluateSafety(clean).score);
  });
});
