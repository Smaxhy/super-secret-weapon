/**
 * AI meme-reading (v11.16): one cheap Claude call per serious candidate judges the coin's name, ticker, description and
 * socials for originality, narrative fit and effort — the judgment our keyword narrative score can't make.
 *
 * Runs ONLY for coins that already pass every rule (soft concentration limits aside) and score within `withinBar` of the
 * bar; once per mint (Redis `meme:<mint>`, `cacheHours`); capped per hour and by its own daily budget (the spend also
 * counts in the AI coach's `ai:spend:<day>`). The call never blocks a buy: if it isn't back within `timeoutMs` the
 * evaluation goes on without it and the answer is cached for the next checkpoint. Text only — no image (cheap).
 *
 * Effect: `features.meme` for the learners; "avoid" with a drainer / impersonation red flag → rule fail (Sniper too);
 * ±`points` around a 5/10 score (watch-only in Sniper mode unless `applyPointsInSniper`); `minScore` > 0 → rule fail.
 */
import Anthropic from '@anthropic-ai/sdk';
import type Redis from 'ioredis';
import { getConfig } from '../config/runtime-config';
import { priceFor } from '../learner/ai-coach';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('meme-reader');

export interface MemeConfig {
  enabled: boolean;
  maxPerHour: number;
  dailyBudgetUsd: number;
  cacheHours: number;
  /** 0 = off; > 0 → "meme score X < Y" rule fail. */
  minScore: number;
  /** ± points around a 5/10 meme score. */
  points: number;
  applyPointsInSniper: boolean;
  /** Only coins scoring within this many points of the bar are read. */
  withinBar: number;
  timeoutMs: number;
}

export const DEFAULT_MEME: MemeConfig = { enabled: true, maxPerHour: 30, dailyBudgetUsd: 0.25, cacheHours: 24, minScore: 0, points: 6, applyPointsInSniper: false, withinBar: 10, timeoutMs: 4000 };

export interface MemeInput {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  createdAt: string | null;
  narratives: readonly string[];
  similar: ReadonlyArray<{ symbol: string; mint: string; mcUsd: number | null }>;
}

export type MemeVerdictKind = 'strong' | 'ok' | 'weak' | 'avoid';

export interface MemeVerdict {
  originality: number;
  narrativeFit: number;
  effortSignals: number;
  redFlags: string[];
  verdict: MemeVerdictKind;
  oneLine: string;
  score: number;
  model: string;
  at: string;
}

export const MEME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['originality', 'narrativeFit', 'effortSignals', 'redFlags', 'verdict', 'oneLine'],
  properties: {
    originality: { type: 'number' },
    narrativeFit: { type: 'number' },
    effortSignals: { type: 'number' },
    redFlags: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['strong', 'ok', 'weak', 'avoid'] },
    oneLine: { type: 'string' },
  },
} as const;

export const MEME_SYSTEM =
  'You judge a brand-new Solana pump.fun memecoin for a trading bot, from its name, ticker, description and socials only. Score 0–10: ' +
  'originality (a fresh idea vs a copy of an existing coin or a generic low-effort ticker), narrativeFit (how well it rides the current hot narratives given), ' +
  'effortSignals (a real website / X / Telegram and a written description vs empty or spammy). redFlags: at most 4 short phrases, only real ones — e.g. ' +
  '"copy of $X", "drainer link", "impersonates <brand/celebrity>", "fake official team". verdict: strong / ok / weak / avoid (avoid = clear scam or impersonation). ' +
  'oneLine: one plain sentence (≤120 chars) for the owner. Be strict and calibrated: most new coins are weak.';

const VERDICTS: readonly MemeVerdictKind[] = ['strong', 'ok', 'weak', 'avoid'];
const RANK: Record<MemeVerdictKind, number> = { avoid: 0, weak: 1, ok: 2, strong: 3 };
const HARD_FLAG = /drain|phish|impersonat|fake (celebrity|team|official|dev|ca)|wallet ?connect|seed phrase/i;

const clamp10 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(10, x)) : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: the user message (JSON). The description is cut to 600 chars. */
export function buildMemePrompt(i: MemeInput): string {
  return JSON.stringify({
    name: i.name,
    ticker: i.symbol,
    description: (i.description ?? '').slice(0, 600),
    socials: { x: i.twitter ?? null, telegram: i.telegram ?? null, website: i.website ?? null },
    createdAt: i.createdAt,
    hotNarrativesNow: i.narratives.slice(0, 20),
    similarTickersSeenRecently: i.similar.slice(0, 5),
  });
}

/** Pure: (o + n + e) / 3, one decimal. */
export function memeScore(o: { originality: number; narrativeFit: number; effortSignals: number }): number {
  return round1((clamp10(o.originality) + clamp10(o.narrativeFit) + clamp10(o.effortSignals)) / 3);
}

/** Pure: the model's JSON → a verdict (clamped), or null when it doesn't parse. */
export function parseMemeOutput(text: string, model: string, at = new Date().toISOString()): MemeVerdict | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const verdict = VERDICTS.includes(o.verdict as MemeVerdictKind) ? (o.verdict as MemeVerdictKind) : null;
    if (!verdict) return null;
    const v = { originality: clamp10(o.originality), narrativeFit: clamp10(o.narrativeFit), effortSignals: clamp10(o.effortSignals) };
    const redFlags = Array.isArray(o.redFlags) ? o.redFlags.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim().slice(0, 80)).slice(0, 4) : [];
    return { ...v, redFlags, verdict, oneLine: typeof o.oneLine === 'string' ? o.oneLine.trim().slice(0, 120) : '', score: memeScore(v), model, at };
  } catch {
    return null;
  }
}

/** Pure: is this candidate worth a read? Every rule passes (soft concentration fails aside), score within `withinBar`. */
export function shouldRead(o: { ruleFailsAllSoft: boolean; hardFail: boolean; score: number; threshold: number }, c: Pick<MemeConfig, 'enabled' | 'withinBar'>): boolean {
  return c.enabled && !o.hardFail && o.ruleFailsAllSoft && o.score >= o.threshold - c.withinBar;
}

/** Pure: rule fails from a verdict — drainer / impersonation "avoid" (also in Sniper mode) and the optional score gate. */
export function memeRuleFails(v: MemeVerdict | null, c: Pick<MemeConfig, 'minScore'>): string[] {
  if (!v) return [];
  const out: string[] = [];
  if (v.verdict === 'avoid') {
    const flag = v.redFlags.find((f) => HARD_FLAG.test(f));
    if (flag) out.push(`meme: ${flag}`);
  }
  if (c.minScore > 0 && v.score < c.minScore) out.push(`meme score ${v.score} < ${c.minScore}`);
  return out;
}

/** Pure: score points (lower the bar by this) — ±points around 5/10; 0 in Sniper mode unless allowed. */
export function memePoints(v: MemeVerdict | null, c: Pick<MemeConfig, 'points' | 'applyPointsInSniper'>, sniper: boolean): number {
  if (!v || (sniper && !c.applyPointsInSniper)) return 0;
  return round1(Math.max(-1, Math.min(1, (v.score - 5) / 5)) * c.points);
}

/** Pure: the numeric section stored as `features.meme` (flattened for the learners). */
export function memeFeatures(v: MemeVerdict | null): { score: number; originality: number; narrativeFit: number; effortSignals: number; verdict: MemeVerdictKind; verdictRank: number; redFlagsCount: number } | null {
  if (!v) return null;
  return { score: v.score, originality: v.originality, narrativeFit: v.narrativeFit, effortSignals: v.effortSignals, verdict: v.verdict, verdictRank: RANK[v.verdict], redFlagsCount: v.redFlags.length };
}

const K = {
  cache: (mint: string) => `meme:${mint}`,
  calls: (hour: string) => `meme:calls:${hour}`,
  spend: (day: string) => `meme:spend:${day}`,
  coachSpend: (day: string) => `ai:spend:${day}`,
  recent: 'meme:recent',
  hits: (day: string) => `meme:hits:${day}`,
};

type BetaCreate = Pick<Anthropic['beta']['messages'], 'create'>;

export class MemeReader {
  private readonly inflight = new Map<string, Promise<MemeVerdict | null>>();
  readonly client: { beta: { messages: BetaCreate } } | null;

  constructor(private readonly redis: Redis, client?: { beta: { messages: BetaCreate } } | null) {
    this.client = client !== undefined ? client : process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  }

  cfg(): MemeConfig {
    return { ...DEFAULT_MEME, ...((getConfig() as { meme?: Partial<MemeConfig> }).meme ?? {}) };
  }

  /** The owner chose Sonnet for the AI work; AI_MEME_MODEL overrides, then AI_MODEL. */
  get model(): string {
    return process.env.AI_MEME_MODEL?.trim() || process.env.AI_MODEL?.trim() || 'claude-sonnet-5-5';
  }

  async cached(mint: string): Promise<MemeVerdict | null> {
    const raw = await this.redis.get(K.cache(mint)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MemeVerdict;
    } catch {
      return null;
    }
  }

  /** Why a new call can't go now (null = it can). */
  async capped(now = Date.now()): Promise<string | null> {
    const c = this.cfg();
    if (!this.client) return 'no ANTHROPIC_API_KEY';
    const iso = new Date(now).toISOString();
    const [calls, spend] = await Promise.all([this.redis.get(K.calls(iso.slice(0, 13))), this.redis.get(K.spend(iso.slice(0, 10)))]);
    if (Number(calls ?? 0) >= c.maxPerHour) return `hourly cap ${c.maxPerHour}`;
    if (Number(spend ?? 0) >= c.dailyBudgetUsd) return `daily budget $${c.dailyBudgetUsd}`;
    return null;
  }

  /**
   * The verdict for this coin: cached → returned at once; else one call (caps permitting) raced against `timeoutMs`.
   * A late answer still lands in the cache for the next checkpoint. Never throws.
   */
  async read(input: MemeInput, now = Date.now()): Promise<MemeVerdict | null> {
    const c = this.cfg();
    if (!c.enabled) return null;
    const hit = await this.cached(input.mint);
    if (hit) {
      void this.redis.incr(K.hits(new Date(now).toISOString().slice(0, 10))).catch(() => undefined);
      return hit;
    }
    let p = this.inflight.get(input.mint);
    if (!p) {
      if (await this.capped(now).catch(() => 'cap check failed')) return null;
      p = this.call(input, now).finally(() => this.inflight.delete(input.mint));
      this.inflight.set(input.mint, p);
    }
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), c.timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async call(input: MemeInput, now: number): Promise<MemeVerdict | null> {
    if (!this.client) return null;
    const c = this.cfg();
    const iso = new Date(now).toISOString();
    const hourKey = K.calls(iso.slice(0, 13));
    await this.redis.multi().incr(hourKey).expire(hourKey, 2 * 3600).exec();
    const model = this.model;
    try {
      // Server-side refusal fallback exists for the Opus / Sonnet / Fable models, not for Haiku (same as the AI coach).
      const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
      const res = await this.client.beta.messages.create({
        model,
        max_tokens: 1000,
        ...fallback,
        system: MEME_SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: MEME_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: buildMemePrompt(input) }],
      });
      const price = priceFor(model, res.usage.input_tokens);
      const cost = (res.usage.input_tokens * price.in + res.usage.output_tokens * price.out) / 1e6;
      const day = iso.slice(0, 10);
      await this.redis.multi().incrbyfloat(K.spend(day), cost).expire(K.spend(day), 3 * 86_400).incrbyfloat(K.coachSpend(day), cost).expire(K.coachSpend(day), 3 * 86_400).exec();
      if (res.stop_reason === 'refusal') return null;
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const v = parseMemeOutput(text, model, iso);
      if (!v) return null;
      await this.redis
        .multi()
        .set(K.cache(input.mint), JSON.stringify(v), 'EX', Math.max(60, Math.round(c.cacheHours * 3600)))
        .lpush(K.recent, JSON.stringify({ mint: input.mint, symbol: input.symbol, score: v.score, verdict: v.verdict, oneLine: v.oneLine, redFlags: v.redFlags, at: v.at }))
        .ltrim(K.recent, 0, 19)
        .exec();
      return v;
    } catch (err) {
      log.warn({ mint: input.mint, err: (err as Error).message }, 'meme read failed');
      return null;
    }
  }

  async snapshot(now = Date.now()): Promise<{ enabled: boolean; hasKey: boolean; model: string; today: number; spentTodayUsd: number; budgetUsd: number; cacheHits: number; recent: unknown[] }> {
    const c = this.cfg();
    const iso = new Date(now).toISOString();
    const day = iso.slice(0, 10);
    const hourKeys = Array.from({ length: Number(iso.slice(11, 13)) + 1 }, (_, h) => K.calls(`${day}T${String(h).padStart(2, '0')}`));
    const [calls, spend, hits, recent] = await Promise.all([
      hourKeys.length ? this.redis.mget(...hourKeys) : Promise.resolve([] as Array<string | null>),
      this.redis.get(K.spend(day)),
      this.redis.get(K.hits(day)),
      this.redis.lrange(K.recent, 0, 19),
    ]);
    return {
      enabled: c.enabled,
      hasKey: !!this.client,
      model: this.model,
      today: calls.reduce((a, x) => a + Number(x ?? 0), 0),
      spentTodayUsd: Math.round(Number(spend ?? 0) * 1000) / 1000,
      budgetUsd: c.dailyBudgetUsd,
      cacheHits: Number(hits ?? 0),
      recent: recent.map((r) => {
        try {
          return JSON.parse(r) as unknown;
        } catch {
          return null;
        }
      }).filter(Boolean),
    };
  }
}
