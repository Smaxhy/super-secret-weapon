import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { DECAY_PER_DAY, keywordInsights, keywordScore, MAX_WORDS, recordKeywordOutcome, tokenize } from '../src/learner/keyword-learner';
import { NarrativeFakeRedis } from './narrative-fake-redis';

const asRedis = (r: NarrativeFakeRedis) => r as unknown as Redis;

describe('tokenize', () => {
  it('lowercases, strips punctuation/emoji, drops filler and short words, adds name bigrams', () => {
    const t = tokenize({ name: 'Baby Doge 🚀 Official', symbol: '$BDOGE', description: 'The first dog coin on Solana!! to the moon' });
    expect(t).toContain('baby');
    expect(t).toContain('doge');
    expect(t).toContain('baby doge');
    expect(t).toContain('bdoge');
    expect(t).toContain('dog');
    for (const bad of ['official', 'the', 'coin', 'solana', 'to', 'on', 'first', '🚀']) expect(t).not.toContain(bad);
  });
  it('is unique and handles missing description', () => {
    const t = tokenize({ name: 'pepe pepe', symbol: 'PEPE' });
    expect(t.filter((w) => w === 'pepe')).toHaveLength(1);
  });
});

describe('keyword learner', () => {
  it('ignores words with too few samples and shrinks toward the base rate', async () => {
    const r = new NarrativeFakeRedis();
    const redis = asRedis(r);
    // 30 losers named "rugcat", 10 winners named "goodfrog"
    for (let i = 0; i < 30; i++) await recordKeywordOutcome(redis, { name: 'rugcat', symbol: 'RC' }, false);
    for (let i = 0; i < 10; i++) await recordKeywordOutcome(redis, { name: 'goodfrog', symbol: 'GF' }, true);
    // only 3 samples → not counted
    for (let i = 0; i < 3; i++) await recordKeywordOutcome(redis, { name: 'rarebird', symbol: 'RB' }, true);

    const base = 13 / 43;
    const good = await keywordScore(redis, { name: 'goodfrog', symbol: 'XX' });
    expect(good.n).toBe(10);
    expect(good.score).toBeGreaterThan(base);
    expect(good.score).toBeLessThan(1); // shrunk
    expect(good.top[0]!.word).toBe('goodfrog');

    const bad = await keywordScore(redis, { name: 'rugcat', symbol: 'XX' });
    expect(bad.score).toBeLessThan(base);

    const unknown = await keywordScore(redis, { name: 'rarebird', symbol: 'XX' });
    expect(unknown.n).toBe(0);
    expect(unknown.score).toBeCloseTo(base, 5);

    const ins = await keywordInsights(redis, 5);
    expect(ins.good.map((g) => g.word)).toContain('goodfrog');
    expect(ins.bad.map((g) => g.word)).toContain('rugcat');
    expect(ins.good.map((g) => g.word)).not.toContain('rarebird');
    expect(ins.baseRate).toBeCloseTo(base, 2);
  });

  it('weights samples', async () => {
    const r = new NarrativeFakeRedis();
    await recordKeywordOutcome(asRedis(r), { name: 'heavy', symbol: 'HV' }, true, 3);
    expect(Number(r.h.get('kw:n')!.get('heavy'))).toBe(3);
    expect(Number(r.h.get('kw:w')!.get('heavy'))).toBe(3);
  });

  it('decays counts once per day lazily', async () => {
    const r = new NarrativeFakeRedis();
    const redis = asRedis(r);
    const day0 = Date.UTC(2026, 0, 1, 12);
    for (let i = 0; i < 10; i++) await recordKeywordOutcome(redis, { name: 'oldword', symbol: 'OW' }, true, 1, day0);
    expect(Number(r.h.get('kw:n')!.get('oldword'))).toBe(10);
    // Two days later the first write decays everything by 0.98² before adding.
    await recordKeywordOutcome(redis, { name: 'newword', symbol: 'NW' }, false, 1, day0 + 2 * 86_400_000);
    expect(Number(r.h.get('kw:n')!.get('oldword'))).toBeCloseTo(10 * DECAY_PER_DAY ** 2, 3);
    // Same day again → no further decay.
    await recordKeywordOutcome(redis, { name: 'newword', symbol: 'NW' }, false, 1, day0 + 2 * 86_400_000 + 1000);
    expect(Number(r.h.get('kw:n')!.get('oldword'))).toBeCloseTo(10 * DECAY_PER_DAY ** 2, 3);
  });

  it('prunes to the most-sampled words when oversized', async () => {
    const r = new NarrativeFakeRedis();
    const n = new Map<string, string>();
    for (let i = 0; i < MAX_WORDS + 1500; i++) n.set(`word${i}x`, String(i < 10 ? 1000 : 1));
    r.h.set('kw:n', n);
    r.s.set('kw:day', String(Math.floor(Date.now() / 86_400_000)));
    await recordKeywordOutcome(asRedis(r), { name: 'fresh', symbol: 'FR' }, true);
    const size = r.h.get('kw:n')!.size;
    expect(size).toBeLessThanOrEqual(MAX_WORDS + 3);
    expect(r.h.get('kw:n')!.has('word0x')).toBe(true);
  });
});
