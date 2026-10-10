import { describe, expect, it } from 'vitest';
import { parseXLink, xVerdict } from '../src/evaluator/x-check';

describe('X check', () => {
  it('reads the kind of X link', () => {
    expect(parseXLink('https://x.com/i/communities/1789012345678')).toEqual({ kind: 'community', handle: null, id: '1789012345678' });
    expect(parseXLink('https://twitter.com/SomeDev/status/1801234567890?s=20')).toEqual({ kind: 'post', handle: 'somedev', id: '1801234567890' });
    expect(parseXLink('https://x.com/coolcoin')).toEqual({ kind: 'profile', handle: 'coolcoin', id: null });
    expect(parseXLink('x.com/@coolcoin/')).toMatchObject({ kind: 'profile', handle: 'coolcoin' });
    expect(parseXLink(null).kind).toBe('none');
    expect(parseXLink('https://x.com/search?q=abc').kind).toBe('none');
  });
  it('scores copy-paste links down and real traction up', () => {
    const com = parseXLink('https://x.com/i/communities/1');
    expect(xVerdict(com, 4, null).points).toBe(-4);
    const strong = xVerdict(com, 0, { community: { members: 900, ageDays: 2 }, mentions: { posts: 10, accounts: 7, biggestFollowers: 25_000, reach: 60_000 } });
    expect(strong.points).toBe(8);
    expect(strong.notes.join(' ')).toMatch(/900 members/);
    expect(strong.features.mentionAccounts).toBe(7);
    const fake = xVerdict(parseXLink('https://x.com/newacc'), 0, { profile: { followers: 12, ageDays: 1, posts: 3 } });
    expect(fake.points).toBe(-2);
    expect(xVerdict(parseXLink('https://x.com/gone'), 0, { profile: { followers: 0, ageDays: 0, posts: 0, missing: true } }).points).toBe(-4);
  });
});
