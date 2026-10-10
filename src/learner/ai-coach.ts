/**
 * AI coach (owner: "learn not only pure statistics but also the behaviours it sees").
 *
 * Every hour (when enough new trades closed) Claude reads the bot's recent trades the way a trader
 * would — the market + crowd + launch-flow picture at entry, why it bought, how it ended, the coach's
 * lesson — and writes back:
 *   - plain-language INSIGHTS (shown on the Performance page)
 *   - candidate RULES over the bot's own measurable features ("avoid CURVE_SNIPE when crowd.paperHandsPct > 40")
 *
 * A rule is never trusted on the AI's word. It is checked on the past trades (backtest — disagrees →
 * retired at once), then FORWARD-tested on new trades while it only records matches; it goes live only
 * when the new trades prove it (avoid: matching trades ≥5 pts worse and still negative after one SE;
 * prefer: ≥5 pts better and positive), and is retired when it stops working. Live avoid rules refuse
 * the buy (1 in 5 still goes through small so the evidence keeps coming); live prefer rules lower the bar.
 *
 * Cost control: ANTHROPIC_API_KEY only in the VPS .env; AI_DAILY_BUDGET_USD (default 2) hard daily cap,
 * counted from each response's real token usage; no call without new trades to read.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { moduleLogger } from '../lib/logger';
import { learningSince } from './labels';

const log = moduleLogger('ai-coach');

export interface AiRuleCondition {
  feature: string;
  op: 'lt' | 'gt';
  value: number;
}

export interface RuleStats {
  n: number;
  avgPct: number;
  sePct: number;
  restAvgPct: number;
}

export interface AiRule {
  id: string;
  title: string;
  why: string;
  /** null = any strategy. */
  strategy: string | null;
  action: 'avoid' | 'prefer';
  conditions: AiRuleCondition[];
  createdAt: string;
  status: 'testing' | 'live' | 'retired';
  statusWhy: string;
  backtest: RuleStats | null;
  forward: RuleStats | null;
}

export interface AiCoachConfig {
  enabled: boolean;
  everyMin: number;
  minNewTrades: number;
  tradesPerReview: number;
  maxRules: number;
  /** Forward trades needed before a rule can go live / be retired. */
  minForward: number;
  /** Points better / worse than the rest a rule's trades must be. */
  edgePct: number;
  probeEvery: number;
  preferBarDelta: number;
}

// ---------------------------------------------------------------------------
// Features: one flat map of numbers per trade (same shape at entry and in the backtest)
// ---------------------------------------------------------------------------

const SECTIONS = ['market', 'crowd', 'manipulation', 'newPair', 'trending', 'kol', 'chart', 'swing'] as const;

/** Pure: numeric (and boolean → 0/1) leaves of the evaluation features, namespaced, ≤3 levels deep. */
export function flattenFeatures(features: unknown, extra: Record<string, number | null | undefined> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[path] = v;
    } else if (typeof v === 'boolean') out[path] = v ? 1 : 0;
    else if (typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  const f = (features ?? {}) as Record<string, unknown>;
  for (const s of SECTIONS) walk(f[s], s, 0);
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'number' && Number.isFinite(v)) out[`entry.${k}`] = v;
  return out;
}

/** Pure: does a rule match this trade / candidate? A missing feature never matches. */
export function matchRule(rule: Pick<AiRule, 'strategy' | 'conditions'>, strategy: string, flat: Readonly<Record<string, number>>): boolean {
  if (rule.strategy && rule.strategy !== strategy) return false;
  if (!rule.conditions.length) return false;
  return rule.conditions.every((c) => {
    const v = flat[c.feature];
    return v !== undefined && (c.op === 'lt' ? v < c.value : v > c.value);
  });
}

export interface CoachTrade {
  strategy: string;
  pnlPct: number;
  openedAtMs: number;
  flat: Record<string, number>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: how trades matching the rule did vs the rest (same strategy scope). */
export function ruleStats(rule: Pick<AiRule, 'strategy' | 'conditions'>, trades: readonly CoachTrade[]): RuleStats | null {
  const scope = trades.filter((t) => !rule.strategy || t.strategy === rule.strategy);
  const m = scope.filter((t) => matchRule(rule, t.strategy, t.flat)).map((t) => t.pnlPct);
  const rest = scope.filter((t) => !matchRule(rule, t.strategy, t.flat)).map((t) => t.pnlPct);
  if (!m.length) return null;
  const mean = m.reduce((a, b) => a + b, 0) / m.length;
  const sd = m.length > 1 ? Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / (m.length - 1)) : 0;
  return { n: m.length, avgPct: r1(mean), sePct: r1(m.length > 1 ? sd / Math.sqrt(m.length) : 0), restAvgPct: r1(rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0) };
}

/** Pure: a rule's next status from its backtest (on creation) and forward record. */
export function nextStatus(rule: AiRule, c: Pick<AiCoachConfig, 'minForward' | 'edgePct'>): { status: AiRule['status']; why: string } {
  if (rule.status === 'retired') return { status: 'retired', why: rule.statusWhy };
  const b = rule.backtest;
  const f = rule.forward;
  const good = (s: RuleStats) => (rule.action === 'avoid' ? s.avgPct <= s.restAvgPct - c.edgePct && s.avgPct + s.sePct < 0 : s.avgPct >= s.restAvgPct + c.edgePct && s.avgPct - s.sePct > 0);
  const wrong = (s: RuleStats) => (rule.action === 'avoid' ? s.avgPct >= s.restAvgPct : s.avgPct <= s.restAvgPct);
  if (rule.status === 'testing' && b && b.n >= 8 && wrong(b) && (!f || f.n < c.minForward)) return { status: 'retired', why: `past trades disagree (${b.n} matching averaged ${b.avgPct}% vs ${b.restAvgPct}%)` };
  if (!f || f.n < c.minForward) return { status: rule.status, why: `testing on new trades: ${f?.n ?? 0}/${c.minForward}` };
  if (good(f)) return { status: 'live', why: `proven on ${f.n} new trades: ${f.avgPct}% vs ${f.restAvgPct}% for the rest` };
  if (f.n >= c.minForward * 2 || wrong(f)) return { status: 'retired', why: `didn't hold up on ${f.n} new trades (${f.avgPct}% vs ${f.restAvgPct}%)` };
  return { status: rule.status, why: `not clear yet: ${f.n} new trades, ${f.avgPct}% vs ${f.restAvgPct}%` };
}

// ---------------------------------------------------------------------------
// Live use (evaluator) — cached rules, no I/O
// ---------------------------------------------------------------------------

let liveRules: AiRule[] = [];
let probeCounter = 0;

export function setAiRules(rules: readonly AiRule[]): void {
  liveRules = rules.filter((r) => r.status === 'live');
}

/** What the live AI rules say about a buy: refuse (avoid), easier bar (prefer). */
export function aiRuleVerdict(strategy: string, flat: Readonly<Record<string, number>>, c: Pick<AiCoachConfig, 'probeEvery' | 'preferBarDelta'>): { fail: string | null; barDelta: number; notes: string[] } {
  let barDelta = 0;
  const notes: string[] = [];
  let fail: string | null = null;
  for (const r of liveRules) {
    if (!matchRule(r, strategy, flat)) continue;
    if (r.action === 'prefer') {
      barDelta += c.preferBarDelta;
      notes.push(`AI rule: ${r.title}`);
    } else if (!fail) {
      probeCounter++;
      if (c.probeEvery > 0 && probeCounter % c.probeEvery === 0) notes.push(`AI rule "${r.title}" matched — probe trade (still testing it)`);
      else fail = `AI rule: ${r.title}`;
    }
  }
  return { fail, barDelta: Math.max(-8, barDelta), notes };
}

// ---------------------------------------------------------------------------
// The coach
// ---------------------------------------------------------------------------

/** $ per million tokens (input / output) for the models this coach may use. */
export function priceFor(model: string, promptTokens = 0): { in: number; out: number } {
  if (/haiku-5-5/.test(model)) return promptTokens > 100_000 ? { in: 0.5, out: 2.5 } : { in: 0.1, out: 0.5 };
  if (/sonnet-5/.test(model)) return { in: 2, out: 10 };
  if (/fable/.test(model)) return { in: 10, out: 50 };
  if (/opus-5-5/.test(model)) return { in: 4, out: 20 };
  return { in: 5, out: 25 };
}

const K = { rules: 'ai:rules', insights: 'ai:insights', last: 'ai:lastRun', lastDeep: 'ai:lastDeep', spend: (d: string) => `ai:spend:${d}` };
const STRATS = ['CURVE_SNIPE', 'SOON', 'MIGRATION_MOMENTUM', 'SMART_MONEY_COPY', 'SWING'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights', 'rules'],
  properties: {
    insights: { type: 'array', items: { type: 'string' } },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'strategy', 'action', 'conditions'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          strategy: { type: 'string', enum: [...STRATS, 'ANY'] },
          action: { type: 'string', enum: ['avoid', 'prefer'] },
          conditions: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['feature', 'op', 'value'], properties: { feature: { type: 'string' }, op: { type: 'string', enum: ['lt', 'gt'] }, value: { type: 'number' } } },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are the trading coach of an autonomous Solana pump.fun paper-trading bot. It buys memecoins (fresh launches, coins about to graduate, freshly migrated coins, KOL-followed coins, swings on bigger coins) and sells by take-profit tiers, trailing stops and a 10-20% stop loss. Round-trip costs are about 5%.

You get its recent closed trades: the measurable picture at entry (flattened feature names such as market.top10HolderPct or crowd.paperHandsPct), why it bought, how the trade ended, the peak it reached, and the trade coach's lesson. You also get the rules already being tested and how they are doing.

Read the trades like an experienced trader: look for BEHAVIOUR patterns that separate the losers from the winners — who was buying and selling, how the launch went, holder structure, crowd quality, timing, chart state — not just one number.

Return:
- insights: up to 6 short, concrete observations in plain English (what keeps going wrong or right, with the evidence).
- rules: up to 4 NEW candidate rules that would have avoided the losers or found more winners. Every condition must use a feature name that appears in the "features" list, with a threshold inside its observed range. Prefer 1-3 conditions per rule. Use strategy "ANY" only when the pattern holds across strategies. Do not repeat a rule that is already being tested. Every rule will be tested on new trades before it is used, so propose what the evidence supports, and return no rules when nothing is clear.`;

export class AiCoach {
  private timer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private running = false;
  private client: Anthropic | null = null;
  lastError: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly cfg: () => AiCoachConfig,
  ) {
    if (process.env.ANTHROPIC_API_KEY) this.client = new Anthropic();
  }

  get model(): string {
    // Owner: Haiku to keep costs down (AI_MODEL in .env overrides).
    return process.env.AI_MODEL?.trim() || 'claude-haiku-5-5';
  }
  /** Once a day a deeper review on a stronger model (owner: Haiku hourly + Sonnet daily). */
  get deepModel(): string {
    return process.env.AI_DEEP_MODEL?.trim() || 'claude-sonnet-5-5';
  }
  get budgetUsd(): number {
    const b = Number(process.env.AI_DAILY_BUDGET_USD ?? 2);
    return Number.isFinite(b) && b >= 0 ? b : 2;
  }

  start(): void {
    void this.refreshRules();
    this.statsTimer = setInterval(() => void this.refreshRules(), 10 * 60_000);
    this.statsTimer.unref?.();
    this.timer = setInterval(() => void this.review(), Math.max(15, this.cfg().everyMin) * 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.review(), 3 * 60_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
  }

  async spentToday(): Promise<number> {
    return Number((await this.redis.get(K.spend(new Date().toISOString().slice(0, 10)))) ?? 0);
  }

  async rules(): Promise<AiRule[]> {
    const h = await this.redis.hgetall(K.rules);
    return Object.values(h)
      .flatMap((v) => {
        try {
          return [JSON.parse(v) as AiRule];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async snapshot(): Promise<{ enabled: boolean; hasKey: boolean; model: string; deepModel: string; spentTodayUsd: number; budgetUsd: number; lastRun: unknown; lastError: string | null; insights: Array<{ at: string; text: string }>; rules: AiRule[] }> {
    const [spent, last, ins, rules] = await Promise.all([this.spentToday(), this.redis.get(K.last), this.redis.lrange(K.insights, 0, 29), this.rules()]);
    return {
      enabled: this.cfg().enabled,
      hasKey: !!this.client,
      model: this.model,
      deepModel: this.deepModel,
      spentTodayUsd: Math.round(spent * 1000) / 1000,
      budgetUsd: this.budgetUsd,
      lastRun: last ? JSON.parse(last) : null,
      lastError: this.lastError,
      insights: ins.flatMap((x) => {
        try {
          return [JSON.parse(x) as { at: string; text: string }];
        } catch {
          return [];
        }
      }),
      rules,
    };
  }

  /** Closed paper trades (since the reset, 14 days) with their entry features. */
  private async loadTrades(limit = 400): Promise<Array<CoachTrade & { symbol: string; exitReason: string; peakMultiple: number; heldMin: number; explanation: string; lesson: string | null; closedAtMs: number }>> {
    const since = new Date(Math.max((await learningSince(this.redis))?.getTime() ?? 0, Date.now() - 14 * 86_400_000));
    const rows = await prisma.position.findMany({
      where: { mode: 'PAPER', status: 'CLOSED', closedAt: { gte: since } },
      orderBy: { closedAt: 'desc' },
      take: limit,
      select: { strategy: true, sizeSol: true, realizedPnlSol: true, exitReason: true, entryPriceSol: true, peakPriceSol: true, openedAt: true, closedAt: true, entryContext: true, token: { select: { symbol: true, createdAt: true } }, evaluation: { select: { combinedScore: true, features: true } } },
    });
    return rows.map((p) => {
      const ec = (p.entryContext ?? {}) as { marketCapUsd?: number; kols?: number; explanation?: string; review?: { lesson?: string } };
      return {
        strategy: p.strategy,
        symbol: p.token?.symbol ?? '?',
        pnlPct: p.sizeSol > 0 ? (p.realizedPnlSol / p.sizeSol) * 100 : 0,
        openedAtMs: p.openedAt.getTime(),
        closedAtMs: p.closedAt?.getTime() ?? 0,
        exitReason: p.exitReason ?? 'UNKNOWN',
        peakMultiple: p.entryPriceSol > 0 ? Math.round((p.peakPriceSol / p.entryPriceSol) * 100) / 100 : 1,
        heldMin: p.closedAt ? Math.round((p.closedAt.getTime() - p.openedAt.getTime()) / 6_000) / 10 : 0,
        explanation: (ec.explanation ?? '').slice(0, 500),
        lesson: ec.review?.lesson ?? null,
        flat: flattenFeatures(p.evaluation?.features, {
          score: p.evaluation?.combinedScore ?? null,
          kols: ec.kols ?? null,
          mcUsd: ec.marketCapUsd ?? null,
          ageMin: p.token ? (p.openedAt.getTime() - p.token.createdAt.getTime()) / 60_000 : null,
          hourUtc: p.openedAt.getUTCHours(),
        }),
      };
    });
  }

  /** Re-score every rule on the latest trades (no AI call). */
  async refreshRules(): Promise<void> {
    try {
      const rules = await this.rules();
      if (!rules.length) return setAiRules([]);
      const trades = await this.loadTrades();
      const c = this.cfg();
      const p = this.redis.pipeline();
      for (const r of rules) {
        if (r.status === 'retired') continue;
        const created = Date.parse(r.createdAt);
        r.forward = ruleStats(r, trades.filter((t) => t.openedAtMs > created));
        const next = nextStatus(r, c);
        if (next.status !== r.status) log.info({ rule: r.title, from: r.status, to: next.status, why: next.why }, '🤖 AI rule status changed');
        r.status = next.status;
        r.statusWhy = next.why;
        p.hset(K.rules, r.id, JSON.stringify(r));
      }
      await p.exec();
      setAiRules(rules);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'AI rule refresh failed');
    }
  }

  /** Ask Claude to review the latest trades (when there are new ones and budget left). */
  async review(force = false, deepAsked = false): Promise<{ ran: boolean; why: string }> {
    const c = this.cfg();
    if (!c.enabled) return { ran: false, why: 'AI coach is off' };
    if (!this.client) return { ran: false, why: 'no ANTHROPIC_API_KEY on the server' };
    if (this.running) return { ran: false, why: 'already running' };
    this.running = true;
    try {
      const spent = await this.spentToday();
      if (spent >= this.budgetUsd) return { ran: false, why: `daily AI budget used ($${spent.toFixed(2)} of $${this.budgetUsd})` };
      const trades = await this.loadTrades();
      const last = JSON.parse((await this.redis.get(K.last)) ?? 'null') as { at: string; newestClosedMs: number } | null;
      const newest = trades[0]?.closedAtMs ?? 0;
      const fresh = trades.filter((t) => t.closedAtMs > (last?.newestClosedMs ?? 0)).length;
      if (!force && fresh < c.minNewTrades) return { ran: false, why: `only ${fresh} new closed trades (needs ${c.minNewTrades})` };
      if (trades.length < 10) return { ran: false, why: `only ${trades.length} closed trades so far` };
      // Deep review: once every 24 h (or when asked) — stronger model, twice the trades, more effort.
      const lastDeepAt = Date.parse((await this.redis.get(K.lastDeep)) ?? '') || 0;
      const deep = !!this.deepModel && this.deepModel !== 'off' && (deepAsked || Date.now() - lastDeepAt >= 24 * 3600_000);
      const model = deep ? this.deepModel : this.model;

      const rules = await this.rules();
      const sample = trades.slice(0, deep ? c.tradesPerReview * 2 : c.tradesPerReview);
      // Features worth showing: present on most trades and actually varying.
      const names = new Map<string, number[]>();
      for (const t of sample) for (const [k, v] of Object.entries(t.flat)) names.set(k, [...(names.get(k) ?? []), v]);
      const featureList = [...names.entries()]
        .filter(([, vs]) => vs.length >= sample.length * 0.3 && Math.min(...vs) !== Math.max(...vs))
        .map(([k, vs]) => {
          const s = [...vs].sort((a, b) => a - b);
          return { name: k, min: r1(s[0]!), median: r1(s[Math.floor(s.length / 2)]!), max: r1(s[s.length - 1]!) };
        })
        .slice(0, 80);
      const allowed = new Set(featureList.map((f) => f.name));
      const input = {
        features: featureList,
        trades: sample.map((t) => ({
          strategy: t.strategy,
          symbol: t.symbol,
          resultPct: r1(t.pnlPct),
          exit: t.exitReason,
          peakMultiple: t.peakMultiple,
          heldMin: t.heldMin,
          whyBought: t.explanation,
          coachLesson: t.lesson,
          atEntry: Object.fromEntries(Object.entries(t.flat).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, r1(v)])),
        })),
        rulesBeingTested: rules.filter((r) => r.status !== 'retired').map((r) => ({ title: r.title, strategy: r.strategy ?? 'ANY', action: r.action, conditions: r.conditions, status: r.status, result: r.forward ?? r.backtest })),
        retiredRules: rules.filter((r) => r.status === 'retired').slice(0, 10).map((r) => ({ title: r.title, why: r.statusWhy })),
      };

      // Server-side refusal fallback exists for the Opus / Sonnet / Fable models, not for Haiku.
      const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
      const res = await this.client.beta.messages.create({
        model,
        max_tokens: 16000,
        ...fallback,
        system: SYSTEM,
        output_config: { effort: deep ? 'high' : 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: `Here are the bot's ${sample.length} most recent closed trades (newest first) as JSON:\n\n${JSON.stringify(input)}` }],
      });
      // Cost from the real usage at the model's price (AI_PRICE_IN/OUT_PER_MTOK override).
      const promptTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      const price = priceFor(model, promptTokens);
      const inP = Number(process.env.AI_PRICE_IN_PER_MTOK ?? price.in);
      const outP = Number(process.env.AI_PRICE_OUT_PER_MTOK ?? price.out);
      const cost = ((res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) * 0.1 + (res.usage.cache_creation_input_tokens ?? 0) * 1.25) * inP + res.usage.output_tokens * outP) / 1e6;
      const day = new Date().toISOString().slice(0, 10);
      await this.redis.multi().incrbyfloat(K.spend(day), cost).expire(K.spend(day), 3 * 86_400).exec();
      await this.redis.set(K.last, JSON.stringify({ at: new Date().toISOString(), newestClosedMs: newest, trades: sample.length, costUsd: Math.round(cost * 1000) / 1000, model, deep }));
      if (deep) await this.redis.set(K.lastDeep, new Date().toISOString());

      if (res.stop_reason === 'refusal') {
        this.lastError = 'the AI declined this review';
        return { ran: true, why: this.lastError };
      }
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const out = JSON.parse(text) as { insights: string[]; rules: Array<{ title: string; why: string; strategy: string; action: 'avoid' | 'prefer'; conditions: AiRuleCondition[] }> };
      const at = new Date().toISOString();
      const p = this.redis.pipeline();
      for (const i of out.insights.slice(0, 6).reverse()) p.lpush(K.insights, JSON.stringify({ at, text: i.slice(0, 400) }));
      p.ltrim(K.insights, 0, 59);
      let added = 0;
      const active = rules.filter((r) => r.status !== 'retired').length;
      for (const r of out.rules.slice(0, 4)) {
        const conditions = r.conditions.filter((x) => allowed.has(x.feature) && Number.isFinite(x.value)).slice(0, 4);
        if (!conditions.length || conditions.length !== r.conditions.length) continue; // invented a feature → drop
        if (active + added >= c.maxRules) break;
        const rule: AiRule = {
          id: `r${Date.now().toString(36)}${added}`,
          title: r.title.slice(0, 120),
          why: r.why.slice(0, 400),
          strategy: r.strategy === 'ANY' ? null : r.strategy,
          action: r.action,
          conditions,
          createdAt: at,
          status: 'testing',
          statusWhy: 'new — testing on new trades',
          backtest: null,
          forward: null,
        };
        rule.backtest = ruleStats(rule, trades);
        const s = nextStatus(rule, c);
        rule.status = s.status;
        rule.statusWhy = s.why;
        p.hset(K.rules, rule.id, JSON.stringify(rule));
        added++;
      }
      await p.exec();
      // Keep the store small: drop the oldest retired rules beyond 40.
      const all = await this.rules();
      const retired = all.filter((r) => r.status === 'retired');
      if (retired.length > 40) await this.redis.hdel(K.rules, ...retired.slice(40).map((r) => r.id));
      this.lastError = null;
      log.info({ insights: out.insights.length, rules: added, costUsd: cost.toFixed(3) }, '🤖 AI coach reviewed the latest trades');
      return { ran: true, why: `${deep ? 'deep review: ' : ''}read ${sample.length} trades, ${out.insights.length} insights, ${added} new rules to test ($${cost.toFixed(3)})` };
    } catch (err) {
      this.lastError = err instanceof Anthropic.AuthenticationError ? 'the ANTHROPIC_API_KEY was rejected' : err instanceof Anthropic.RateLimitError ? 'rate limited by the AI API — will retry next hour' : (err as Error).message.slice(0, 200);
      log.warn({ err: this.lastError }, 'AI coach review failed');
      return { ran: false, why: this.lastError };
    } finally {
      this.running = false;
    }
  }
}
