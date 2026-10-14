import { describe, expect, it } from 'vitest';
import { hasXLink, twitterInfo, xLinkOf } from '../src/evaluator/social-analyzer';
import { parseXLink } from '../src/evaluator/x-check';

const t = (x: Partial<{ twitter: string; website: string; telegram: string; description: string }>) => ({ twitter: null, website: null, telegram: null, description: null, ...x });

describe('X links in every shape and every field', () => {
  it('accounts, posts, communities (X groups) and handle-less posts', () => {
    expect(twitterInfo('https://x.com/coolcoin')).toMatchObject({ handle: 'coolcoin', isPost: false });
    expect(twitterInfo('https://twitter.com/dev/status/123')).toMatchObject({ handle: 'dev', isPost: true });
    expect(twitterInfo('https://x.com/i/communities/1789')).toMatchObject({ isCommunity: true });
    expect(twitterInfo('https://x.com/i/status/555')).toMatchObject({ isPost: true, handle: null });
    expect(twitterInfo('https://x.com/i/web/status/555')).toMatchObject({ isPost: true });
    expect(twitterInfo('https://x.com/search?q=pump')).toMatchObject({ handle: null, isPost: false, isCommunity: false });
    expect(parseXLink('https://x.com/i/status/555')).toEqual({ kind: 'post', handle: null, id: '555' });
    expect(parseXLink('https://x.com/i/communities/1789')).toEqual({ kind: 'community', handle: null, id: '1789' });
  });
  it('finds the X link pasted into the website / Telegram field or the description, and bare @handles', () => {
    expect(xLinkOf(t({ website: 'https://x.com/i/communities/1789' }))).toBe('https://x.com/i/communities/1789');
    expect(xLinkOf(t({ telegram: 'x.com/coolcoin' }))).toBe('https://x.com/coolcoin');
    expect(xLinkOf(t({ description: 'join us: https://twitter.com/coolcoin/status/9 !!' }))).toBe('https://twitter.com/coolcoin/status/9');
    expect(xLinkOf(t({ twitter: '@coolcoin' }))).toBe('https://x.com/coolcoin');
    expect(hasXLink(t({ website: 'https://coolcoin.fun', telegram: 'https://t.me/coolcoin' }))).toBe(false);
    expect(hasXLink(t({}))).toBe(false);
  });
});
