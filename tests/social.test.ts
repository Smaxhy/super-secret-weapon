import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { STRATEGIES } from '../src/config/strategies';
import { checkEntryRules } from '../src/evaluator/scorer';
import { keywordCheck, parseMetadata, socialsScore, twitterInfo } from '../src/evaluator/social-analyzer';

describe('metadata parsing', () => {
  it('reads Pump.fun metadata', () => {
    const s = parseMetadata({ name: 'X', description: 'A coin about frogs and friends', twitter: 'https://x.com/frogcoin', telegram: 'https://t.me/frogcoin', website: 'https://frog.xyz' });
    expect(s).toEqual({ description: 'A coin about frogs and friends', twitter: 'https://x.com/frogcoin', telegram: 'https://t.me/frogcoin', website: 'https://frog.xyz' });
  });
  it('handles missing / junk fields', () => {
    expect(parseMetadata({ twitter: 42, website: '  ' })).toEqual({ description: null, twitter: null, telegram: null, website: null });
    expect(parseMetadata(null).twitter).toBeNull();
  });
  it('recognises profile, post and community links', () => {
    expect(twitterInfo('https://x.com/FrogCoin')).toEqual({ handle: 'frogcoin', isPost: false, isCommunity: false });
    expect(twitterInfo('https://twitter.com/elon/status/123')).toMatchObject({ handle: 'elon', isPost: true });
    expect(twitterInfo('https://x.com/i/communities/1789')).toMatchObject({ handle: null, isCommunity: true });
    expect(twitterInfo('https://example.com')).toMatchObject({ handle: null });
  });
});

describe('socials score', () => {
  const full = { description: 'A coin about frogs and friends', twitter: 'https://x.com/frogcoin', telegram: 'https://t.me/frogcoin', website: 'https://frog.xyz' };
  it('full set of fresh links = 1', () => expect(socialsScore(full, { twitter: 0, website: 0 })).toBeCloseTo(1));
  it('nothing = 0', () => expect(socialsScore({ description: null, twitter: null, telegram: null, website: null }, { twitter: 0, website: 0 })).toBe(0));
  it('copied links are heavily discounted', () => expect(socialsScore(full, { twitter: 5, website: 0 })).toBeCloseTo(0.3));
  it('a website pointing at pump.fun does not count', () => expect(socialsScore({ ...full, website: 'https://pump.fun/coin/abc' }, { twitter: 0, website: 0 })).toBeCloseTo(0.7));
});

describe('keywords', () => {
  it('matches whole words only, case-insensitive', () => {
    expect(keywordCheck('Frog TEST coin', [], ['test']).blocked).toBe('test');
    expect(keywordCheck('Contest coin', [], ['test']).blocked).toBeNull();
    expect(keywordCheck('AI agent', ['ai'], []).boosted).toBe('ai');
  });
});

describe('social entry rules', () => {
  const market = { ageSec: 120, holders: 70, uniqueWallets: 80, buys: 120, sells: 30, buySellRatio: 4, volumeSol: 40, liquiditySol: 12, bondingCurvePct: 25, curveVelocity: 5, priceSol: 5e-8, marketCapSol: 50, devHoldingPct: 2, devSoldFraction: 0, top10HolderPct: 14, earlyBuyerPct: 1, retention: 0.875, complete: false, totalFeesSol: 1.2, volumeUsd: 15_000, marketCapUsd: 13_000 };
  const base = { safetyScore: 100, safetyHardFail: false, market, strategy: STRATEGIES.CURVE_SNIPE, entry: DEFAULT_CONFIG.entry };
  it('blocks a blocked keyword', () => expect(checkEntryRules({ ...base, social: { hasTwitter: true, blockedKeyword: 'rug' } })).toEqual(['blocked keyword "rug"']));
  it('requireTwitter needs an X link', () => {
    const entry = { ...DEFAULT_CONFIG.entry, requireTwitter: true };
    expect(checkEntryRules({ ...base, entry, social: { hasTwitter: false, blockedKeyword: null } })).toEqual(['no X link']);
    expect(checkEntryRules({ ...base, entry, social: { hasTwitter: true, blockedKeyword: null } })).toEqual([]);
  });
});
