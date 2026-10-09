import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma', () => ({ prisma: {} }));

import { recordKeywordOutcome } from '../src/learner/keyword-learner';
import {
  descriptionQuality,
  nameSymbolConsistency,
  narrativeScore,
  normalizeId,
  SocialAnalyzer,
  type NarrativeInput,
} from '../src/evaluator/social-analyzer';
import { NarrativeFakeRedis } from './narrative-fake-redis';

const base: NarrativeInput = {
  blocked: null,
  boosted: null,
  hot: null,
  learned: null,
  metadata: null,
  name: 'Frog King',
  symbol: 'FROG',
  copycats: 0,
  firstOfTrend: false,
  trending: [],
};

describe('narrative pieces', () => {
  it('description quality', () => {
    expect(descriptionQuality(null)).toBeLessThan(0.3);
    expect(descriptionQuality('🚀🚀🚀')).toBeLessThan(0.3);
    expect(descriptionQuality('asdkjqwkjzxcmnbqwrtpl')).toBeLessThan(0.3);
    expect(descriptionQuality('xkcdqwrt bnmzxcvl')).toBeLessThan(0.3);
    expect(descriptionQuality('A frog who became king of the pond and now rules every lily pad with his friends')).toBeGreaterThan(0.8);
  });
  it('name / ticker consistency', () => {
    expect(nameSymbolConsistency('Frog King', 'FROG')).toBe(1);
    expect(nameSymbolConsistency('Dog Wif Hat', 'DWH')).toBe(1);
    expect(nameSymbolConsistency('Dogwifhat', 'WIF')).toBe(1);
    expect(nameSymbolConsistency('Bonk Inu', 'BNK')).toBe(0.8);
    expect(nameSymbolConsistency('Frog King', 'ZZQ')).toBeLessThan(0.5);
  });
  it('normalizeId', () => expect(normalizeId('Baby $DOGE!!')).toBe('babydoge'));
});

describe('narrativeScore', () => {
  it('nothing special is neutral', () => {
    expect(narrativeScore(base)).toEqual({ score: 0.5, reason: 'neutral narrative' });
  });
  it('blocked keyword is a hard 0', () => {
    expect(narrativeScore({ ...base, blocked: 'rug', hot: 'grok' }).score).toBe(0);
  });
  it('hot X keyword + boost raise the score and explain why', () => {
    const r = narrativeScore({ ...base, hot: 'grok', boosted: 'pepe' });
    expect(r.score).toBeCloseTo(0.9);
    expect(r.reason).toContain('hot on X: "grok"');
  });
  it('learned words: good raises, bad lowers, more data counts more', () => {
    const good = narrativeScore({ ...base, learned: { score: 0.4, n: 60, baseRate: 0.2, top: [{ word: 'frog', winRate: 0.4, n: 60 }] } });
    const goodFew = narrativeScore({ ...base, learned: { score: 0.4, n: 10, baseRate: 0.2, top: [] } });
    const bad = narrativeScore({ ...base, learned: { score: 0.05, n: 60, baseRate: 0.2, top: [] } });
    expect(good.score).toBeGreaterThan(goodFew.score);
    expect(goodFew.score).toBeGreaterThan(0.5);
    expect(bad.score).toBeLessThan(0.5);
    expect(good.reason).toContain('"frog"');
  });
  it('copycats are penalised, the first of a trend is rewarded', () => {
    expect(narrativeScore({ ...base, copycats: 8 }).score).toBeCloseTo(0.25);
    expect(narrativeScore({ ...base, copycats: 2 }).score).toBeCloseTo(0.38);
    const first = narrativeScore({ ...base, copycats: 8, firstOfTrend: true });
    expect(first.score).toBeCloseTo(0.6);
    expect(first.reason).toContain('first of a trend');
  });
  it('junk metadata lowers, good metadata raises', () => {
    const junk = narrativeScore({ ...base, metadata: { description: null, socials: 0 } });
    const good = narrativeScore({ ...base, metadata: { description: 'A frog who became king of the pond and now rules every lily pad', socials: 1 } });
    expect(junk.score).toBeLessThan(0.45);
    expect(good.score).toBeGreaterThan(0.55);
  });
  it('trend momentum uses learned win rates', () => {
    const up = narrativeScore({ ...base, learned: { score: 0.2, n: 0, baseRate: 0.2, top: [] }, trending: [{ word: 'frog', launches: 6, winRate: 0.4 }] });
    const down = narrativeScore({ ...base, learned: { score: 0.2, n: 0, baseRate: 0.2, top: [] }, trending: [{ word: 'frog', launches: 6, winRate: 0.1 }] });
    const quiet = narrativeScore({ ...base, trending: [{ word: 'frog', launches: 1, winRate: 0.9 }] });
    expect(up.score).toBeCloseTo(0.6);
    expect(down.score).toBeCloseTo(0.44);
    expect(quiet.score).toBe(0.5);
  });
  it('score always stays within 0..1', () => {
    const r = narrativeScore({ ...base, hot: 'a', boosted: 'b', learned: { score: 1, n: 999, baseRate: 0.1, top: [] }, metadata: { description: 'A frog who became king of the pond and now rules every lily pad', socials: 1 }, copycats: 3, firstOfTrend: true, trending: [{ word: 'frog', launches: 9, winRate: 0.9 }] });
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.reason.split('; ').length).toBeLessThanOrEqual(3);
  });
});

describe('SocialAnalyzer.narrative (with fake Redis)', () => {
  const tok = (mint: string, name: string, symbol: string) => ({ mint, name, symbol, description: null, twitter: null, telegram: null, website: null, metadataFetchedAt: null });

  it('detects copycats and the original', async () => {
    const r = new NarrativeFakeRedis();
    const sa = new SocialAnalyzer(r as unknown as Redis);
    const now = Date.now();
    await sa.recordLaunch('m0', 'Moo Deng', 'MOODENG', now - 50 * 60_000);
    for (let i = 1; i <= 6; i++) await sa.recordLaunch(`m${i}`, 'Moo Deng', 'MOODENG', now - (50 - i) * 60_000);
    await sa.recordLaunch('old', 'Moo Deng', 'MOODENG', now - 3 * 3600_000); // outside the window

    const original = await sa.copycats('m0', 'Moo Deng', 'MOODENG', now);
    expect(original).toEqual({ copycats: 6, firstOfTrend: true });
    const copy = await sa.copycats('m6', 'Moo Deng', 'MOODENG', now);
    expect(copy).toEqual({ copycats: 6, firstOfTrend: false });

    const n = await sa.narrative(tok('m6', 'Moo Deng', 'MOODENG'), { boost: [], block: ['rug'] }, []);
    expect(n.score).toBeLessThan(0.4);
    expect(n.reason).toContain('copycat');
  });

  it('hard block stays hard and hot keywords boost', async () => {
    const r = new NarrativeFakeRedis();
    const sa = new SocialAnalyzer(r as unknown as Redis);
    const blocked = await sa.narrative(tok('a', 'Rug Pull Inu', 'RPI'), { boost: [], block: ['rug'] }, ['inu']);
    expect(blocked).toEqual({ score: 0, reason: 'blocked keyword "rug"', blocked: 'rug' });
    const hot = await sa.narrative(tok('b', 'Grok Cat', 'GCAT'), { boost: [], block: ['rug'] }, ['grok']);
    expect(hot.score).toBeGreaterThan(0.7);
    expect(hot.reason).toContain('grok');
  });

  it('uses learned keyword odds', async () => {
    const r = new NarrativeFakeRedis();
    const redis = r as unknown as Redis;
    for (let i = 0; i < 40; i++) await recordKeywordOutcome(redis, { name: 'losercat', symbol: 'LC' }, false);
    for (let i = 0; i < 20; i++) await recordKeywordOutcome(redis, { name: 'winnerfrog', symbol: 'WF' }, true);
    const sa = new SocialAnalyzer(redis);
    const good = await sa.narrative(tok('g', 'winnerfrog', 'WINNERFROG'), { boost: [], block: [] }, []);
    const bad = await sa.narrative(tok('b', 'losercat', 'LOSERCAT'), { boost: [], block: [] }, []);
    expect(good.score).toBeGreaterThan(0.55);
    expect(bad.score).toBeLessThan(0.45);
  });
});
