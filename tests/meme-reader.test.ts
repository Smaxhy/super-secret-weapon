import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { overrideConfig } from '../src/config/runtime-config';
import { DEFAULT_CONFIG } from '../src/config/default';
import {
  buildMemePrompt,
  DEFAULT_MEME,
  MemeReader,
  memeFeatures,
  memePoints,
  memeRuleFails,
  memeScore,
  parseMemeOutput,
  shouldRead,
  type MemeInput,
  type MemeVerdict,
} from '../src/evaluator/meme-reader';
import { variantEntryFails, type TournamentCandidate, type TournamentVariant } from '../src/learner/tournament';
import type { SniperConfig } from '../src/evaluator/sniper';
import type { MomentumGateConfig } from '../src/evaluator/momentum-gate';

/** Minimal in-memory Redis for the commands the meme reader uses. */
class MiniRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string) { this.kv.set(k, v); return 'OK'; }
  async incr(k: string) { const n = Number(this.kv.get(k) ?? 0) + 1; this.kv.set(k, String(n)); return n; }
  async incrbyfloat(k: string, by: number) { const n = Number(this.kv.get(k) ?? 0) + by; this.kv.set(k, String(n)); return String(n); }
  async expire() { return 1; }
  async lpush(k: string, v: string) { const l = this.lists.get(k) ?? []; l.unshift(v); this.lists.set(k, l); return l.length; }
  async ltrim(k: string, a: number, b: number) { this.lists.set(k, (this.lists.get(k) ?? []).slice(a, b + 1)); return 'OK'; }
  async lrange(k: string, a: number, b: number) { return (this.lists.get(k) ?? []).slice(a, b + 1); }
  async mget(...ks: string[]) { return ks.map((k) => this.kv.get(k) ?? null); }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['set', 'incr', 'incrbyfloat', 'expire', 'lpush', 'ltrim'] as const) {
      chain[m] = (...a: unknown[]) => { ops.push(() => (this[m] as (...x: unknown[]) => Promise<unknown>)(...a)); return chain; };
    }
    chain.exec = async () => { const out = []; for (const op of ops) out.push([null, await op()]); return out; };
    return chain;
  }
}

const INPUT: MemeInput = {
  mint: 'MINT1', name: 'Pepe Rocket', symbol: 'PROCK', description: 'x'.repeat(900), twitter: 'https://x.com/prock', telegram: null, website: 'https://prock.fun',
  createdAt: '2026-10-18T05:00:00.000Z', narratives: ['frog', 'rocket'], similar: [{ symbol: 'ROCK', mint: 'OTHER', mcUsd: 120_000 }],
};
const GOOD = { originality: 8, narrativeFit: 7, effortSignals: 6.5, redFlags: [], verdict: 'strong', oneLine: 'Fresh frog-rocket meme riding the frog narrative, real site and X.' };

function fakeClient(out: unknown, opts: { refusal?: boolean; delayMs?: number } = {}) {
  const create = vi.fn(async (_params: unknown) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return { stop_reason: opts.refusal ? 'refusal' : 'end_turn', usage: { input_tokens: 600, output_tokens: 120 }, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
  return { client: { beta: { messages: { create } } } as unknown as ConstructorParameters<typeof MemeReader>[1], create };
}

const verdict = (over: Partial<MemeVerdict> = {}): MemeVerdict => ({ originality: 6, narrativeFit: 6, effortSignals: 6, redFlags: [], verdict: 'ok', oneLine: '', score: 6, model: 'm', at: 'x', ...over });

afterEach(() => overrideConfig({ meme: { ...DEFAULT_MEME }, sniper: { enabled: true } }));

describe('meme reader — pure parts', () => {
  it('prompt carries every field and cuts the description to 600 chars', () => {
    const p = JSON.parse(buildMemePrompt(INPUT));
    expect(p.name).toBe('Pepe Rocket');
    expect(p.ticker).toBe('PROCK');
    expect(p.description).toHaveLength(600);
    expect(p.socials).toEqual({ x: 'https://x.com/prock', telegram: null, website: 'https://prock.fun' });
    expect(p.hotNarrativesNow).toEqual(['frog', 'rocket']);
    expect(p.similarTickersSeenRecently[0].symbol).toBe('ROCK');
  });

  it('parses the schema output, clamps out-of-range numbers and computes the meme score', () => {
    const v = parseMemeOutput(JSON.stringify({ ...GOOD, effortSignals: 14, redFlags: ['a', 'b', 'c', 'd', 'e'] }), 'm')!;
    expect(v.effortSignals).toBe(10);
    expect(v.redFlags).toHaveLength(4);
    expect(v.score).toBe(memeScore({ originality: 8, narrativeFit: 7, effortSignals: 10 }));
    expect(memeScore({ originality: 8, narrativeFit: 7, effortSignals: 6.5 })).toBe(7.2);
    expect(parseMemeOutput('{"verdict":"great"}', 'm')).toBeNull();
    expect(parseMemeOutput('not json', 'm')).toBeNull();
  });

  it('only reads serious candidates', () => {
    const c = { enabled: true, withinBar: 10 };
    expect(shouldRead({ ruleFailsAllSoft: true, hardFail: false, score: 56, threshold: 65 }, c)).toBe(true);
    expect(shouldRead({ ruleFailsAllSoft: true, hardFail: false, score: 54, threshold: 65 }, c)).toBe(false);
    expect(shouldRead({ ruleFailsAllSoft: false, hardFail: false, score: 80, threshold: 65 }, c)).toBe(false);
    expect(shouldRead({ ruleFailsAllSoft: true, hardFail: true, score: 80, threshold: 65 }, c)).toBe(false);
    expect(shouldRead({ ruleFailsAllSoft: true, hardFail: false, score: 80, threshold: 65 }, { enabled: false, withinBar: 10 })).toBe(false);
  });

  it('avoid + drainer / impersonation flag → rule fail; a plain "weak" or a flag-less avoid does not', () => {
    expect(memeRuleFails(verdict({ verdict: 'avoid', redFlags: ['drainer link in the website'] }), { minScore: 0 })).toEqual(['meme: drainer link in the website']);
    expect(memeRuleFails(verdict({ verdict: 'avoid', redFlags: ['impersonates Elon Musk'] }), { minScore: 0 })).toEqual(['meme: impersonates Elon Musk']);
    expect(memeRuleFails(verdict({ verdict: 'avoid', redFlags: ['copy of $ROCK'] }), { minScore: 0 })).toEqual([]);
    expect(memeRuleFails(verdict({ verdict: 'weak', redFlags: ['drainer link'] }), { minScore: 0 })).toEqual([]);
    expect(memeRuleFails(null, { minScore: 9 })).toEqual([]);
  });

  it('minScore gate: 0 = off, otherwise "meme score X < Y"', () => {
    expect(memeRuleFails(verdict({ score: 5.5 }), { minScore: 0 })).toEqual([]);
    expect(memeRuleFails(verdict({ score: 5.5 }), { minScore: 6 })).toEqual(['meme score 5.5 < 6']);
    expect(memeRuleFails(verdict({ score: 7 }), { minScore: 6 })).toEqual([]);
  });

  it('points scale around 5/10 and are watch-only in Sniper mode', () => {
    const c = { points: 6, applyPointsInSniper: false };
    expect(memePoints(verdict({ score: 10 }), c, false)).toBe(6);
    expect(memePoints(verdict({ score: 5 }), c, false)).toBe(0);
    expect(memePoints(verdict({ score: 0 }), c, false)).toBe(-6);
    expect(memePoints(verdict({ score: 7.5 }), c, false)).toBe(3);
    expect(memePoints(verdict({ score: 10 }), c, true)).toBe(0);
    expect(memePoints(verdict({ score: 10 }), { ...c, applyPointsInSniper: true }, true)).toBe(6);
    expect(memePoints(null, c, false)).toBe(0);
  });

  it('features are numeric for the learners (verdict rank, red-flag count)', () => {
    expect(memeFeatures(verdict({ verdict: 'strong', redFlags: ['x'] }))).toMatchObject({ verdictRank: 3, redFlagsCount: 1, score: 6 });
    expect(memeFeatures(null)).toBeNull();
  });
});

describe('meme reader — calls, cache, caps, timeout', () => {
  it('calls the configured model with structured output, low effort and the refusal fallback; caches the verdict', async () => {
    const redis = new MiniRedis();
    const { client, create } = fakeClient(GOOD);
    const r = new MemeReader(redis as unknown as Redis, client);
    const v = await r.read(INPUT);
    expect(v?.verdict).toBe('strong');
    expect(v?.score).toBe(7.2);
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe(r.model);
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    // cached: the second read never calls
    const again = await r.read(INPUT);
    expect(again?.score).toBe(7.2);
    expect(create).toHaveBeenCalledTimes(1);
    // spend counted on its own line and in the shared AI spend
    const day = new Date().toISOString().slice(0, 10);
    expect(Number(redis.kv.get(`meme:spend:${day}`))).toBeGreaterThan(0);
    expect(Number(redis.kv.get(`ai:spend:${day}`))).toBeGreaterThan(0);
  });

  it('refusal → no verdict (nothing cached)', async () => {
    const redis = new MiniRedis();
    const { client } = fakeClient(GOOD, { refusal: true });
    const r = new MemeReader(redis as unknown as Redis, client);
    expect(await r.read(INPUT)).toBeNull();
    expect(await r.cached('MINT1')).toBeNull();
  });

  it('timeout → the evaluation goes on without it; the late answer lands in the cache', async () => {
    overrideConfig({ meme: { timeoutMs: 20 } });
    const redis = new MiniRedis();
    const { client, create } = fakeClient(GOOD, { delayMs: 80 });
    const r = new MemeReader(redis as unknown as Redis, client);
    expect(await r.read(INPUT)).toBeNull();
    await new Promise((res) => setTimeout(res, 120));
    expect((await r.cached('MINT1'))?.verdict).toBe('strong');
    expect(await r.read(INPUT)).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('hourly cap and daily budget stop new calls', async () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    overrideConfig({ meme: { maxPerHour: 2 } });
    const redis = new MiniRedis();
    redis.kv.set(`meme:calls:${iso.slice(0, 13)}`, '2');
    const { client, create } = fakeClient(GOOD);
    const r = new MemeReader(redis as unknown as Redis, client);
    expect(await r.read(INPUT, now)).toBeNull();
    expect(await r.capped(now)).toMatch(/hourly cap/);
    overrideConfig({ meme: { maxPerHour: 30, dailyBudgetUsd: 0.01 } });
    redis.kv.set(`meme:calls:${iso.slice(0, 13)}`, '0');
    redis.kv.set(`meme:spend:${iso.slice(0, 10)}`, '0.02');
    expect(await r.read(INPUT, now)).toBeNull();
    expect(await r.capped(now)).toMatch(/daily budget/);
    expect(create).not.toHaveBeenCalled();
  });

  it('no API key → no call, no verdict', async () => {
    const r = new MemeReader(new MiniRedis() as unknown as Redis, null);
    expect(await r.read(INPUT)).toBeNull();
    expect(await r.capped()).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('tournament meme-score variants', () => {
  const live = DEFAULT_CONFIG as unknown as { sniper: SniperConfig; momentumGate: MomentumGateConfig };
  const base: TournamentCandidate = {
    mint: 'M', symbol: 'S', strategy: 'MIGRATION_MOMENTUM', strategyEnabled: true, priceSol: 1, onAmm: true, hardFail: false, ruleFails: [], shape: null,
    sniper: { flow: { buyers: 50, buySol: 30, buySharePct: 70, organicPct: 80 } as never, score: 90, threshold: 60, momentumGateWhy: null, entryQualityVerdict: 'ok', edgeGatePass: true, pressureSellersInControl: false, crowd: null, risky: false, deployerClass: null },
    memeScore: 6.5,
  };
  const v = (min: number): TournamentVariant => ({ id: `m${min}`, name: 'x', entryOverrides: { 'meme.minScore': min }, exitOverrides: {} });

  it('a variant with its own meme gate judges the coin itself; no read = no verdict', () => {
    expect(variantEntryFails(base, v(6), live.sniper, live.momentumGate).filter((f) => f.startsWith('meme'))).toEqual([]);
    expect(variantEntryFails(base, v(7.5), live.sniper, live.momentumGate)).toContain('meme score 6.5 < 7.5');
    expect(variantEntryFails({ ...base, memeScore: null }, v(7.5), live.sniper, live.momentumGate).filter((f) => f.startsWith('meme'))).toEqual([]);
  });

  it('both variants are in the default list', () => {
    const ids = (DEFAULT_CONFIG.tournament.variants as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['meme6', 'meme75']));
  });
});
