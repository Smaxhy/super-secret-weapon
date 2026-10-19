/**
 * v17.14 an AI read of every open forex trade (owner: "an AI that scans all active trades it's currently in and actively
 * analyses the price action"). One cheap Claude call per trade (Haiku 5.5 by default, `AI_TRADE_MODEL` overrides): the
 * trade's goal, the rule-based live read (trade-read.ts), the last hours of candles, nearby levels, the bigger-chart
 * trends and the news coming up → { verdict on_track / watch / at_risk, a headline, 2–3 sentences, up to 3 things to
 * watch, confidence 1–5 }.
 * When: a new trade at once, then every `everyMin` (15) while forex is open, and sooner (≥ `minGapMin` 5 after the last
 * read) when the live read turns serious (close to the stop, under pressure, almost at the target, profit locked); the
 * owner can ask for one any time (≥ 60 s apart per trade). Capped per hour and by its own daily budget (the spend also
 * counts in the AI coach's `ai:spend:<day>`); no `ANTHROPIC_API_KEY` → none (the live read still works).
 * DISPLAY ONLY: an AI opinion is not a tested rule — nothing here opens, closes or changes a trade.
 */
import Anthropic from '@anthropic-ai/sdk';
import type Redis from 'ioredis';
import { priceFor } from '../learner/ai-coach';
import { moduleLogger } from '../lib/logger';
import type { ReadStatus, TradeRead } from './trade-read';

const log = moduleLogger('forex-trade-ai');

const envNum = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

export const FX_AI = {
  enabled: process.env.AI_TRADE?.trim().toLowerCase() !== 'off',
  /** a scheduled read per trade at most this often while forex is open (minutes) */
  everyMin: envNum('AI_TRADE_EVERY_MIN', 15),
  /** the live read turned serious → a new read once this long after the last one (minutes) */
  minGapMin: 5,
  /** asked for on the dashboard: at most once a minute per trade */
  askGapMs: 60_000,
  maxPerHour: 60,
  dailyBudgetUsd: envNum('AI_TRADE_BUDGET_USD', 0.5),
  keepHistory: 8,
  ttlSec: 3 * 86_400,
};

/** live-read statuses that bring the next AI read forward */
const SERIOUS: ReadonlySet<ReadStatus> = new Set(['near_stop', 'pressure', 'near_target', 'locked']);

export type AiVerdict = 'on_track' | 'watch' | 'at_risk';
const VERDICTS: readonly AiVerdict[] = ['on_track', 'watch', 'at_risk'];

export interface AiRead {
  verdict: AiVerdict;
  headline: string;
  read: string;
  watch: string[];
  confidence: number;
  model: string;
  /** ms */
  at: number;
  /** the exit-side price and the live-read status when it was asked */
  px: number;
  status: ReadStatus;
  why: 'new' | 'time' | 'change' | 'asked';
  /** earlier reads of this trade, newest first */
  history: Array<{ at: number; verdict: AiVerdict; headline: string }>;
}

export const TRADE_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'headline', 'read', 'watch', 'confidence'],
  properties: {
    verdict: { type: 'string', enum: ['on_track', 'watch', 'at_risk'] },
    headline: { type: 'string' },
    read: { type: 'string' },
    watch: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
} as const;

export const TRADE_AI_SYSTEM =
  'You watch one open forex trade of a paper-trading bot and read its price action for the owner, a beginner. The bot\'s exits ' +
  '(stop, target, profit lock, trailing stop, time exit) are tested rules that run by themselves — you decide nothing and never ' +
  'tell anyone to trade. From the data given (all prices in the pair\'s own units; pips + = the trade\'s way): ' +
  'verdict = on_track (moving toward the target, or holding its gains calmly), watch (stalling, mixed signals, close to a level ' +
  'or to news), at_risk (momentum or structure against it, close to the stop). headline: ≤ 90 characters. read: 2–3 plain ' +
  'sentences — what the price did since the entry, what it is doing now, and what would confirm or break the idea behind the ' +
  'trade; explain any chart word in passing. watch: up to 3 concrete price levels or events to watch, each ≤ 80 characters, ' +
  'with the price. confidence: 1–5 in this read (low when the candles are few or the picture is mixed). Be calibrated, never ' +
  'promise an outcome.';

export interface TradeAiContext {
  acct: 'bot' | 'me';
  posId: string;
  pair: string;
  label: string;
  digits: number;
  side: 1 | -1;
  entry: number;
  px: number;
  stop: number | null;
  target: number | null;
  openedAt: number;
  strategy: { name: string; desc: string; chart: string | null } | null;
  read: TradeRead;
  /** hourly candles [t, o, h, l, c], oldest first */
  hourly: ReadonlyArray<readonly number[]>;
  /** 1-minute candles (t, h, l, c[, o]), oldest first */
  minute: ReadonlyArray<readonly [number, number, number, number, number?]>;
  market: { atrPips?: number; trend?: { h1: number; h4: number; d1: number }; rsi1h?: number; strengthGap?: number | null; levels?: string[] } | null;
  news: ReadonlyArray<{ t: number; ccy: string; title: string; impact: string }>;
  now: number;
}

const trendWord = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : 'none');

/** 1-minute candles → 15-minute candles [t, o, h, l, c] (complete or forming). Pure. */
export function toQuarter(bars: TradeAiContext['minute']): number[][] {
  const out: number[][] = [];
  for (const b of bars) {
    const t = Math.floor(b[0] / 900_000) * 900_000;
    const o = b[4] ?? b[3];
    const cur = out[out.length - 1];
    if (cur && cur[0] === t) {
      cur[2] = Math.max(cur[2]!, b[1]);
      cur[3] = Math.min(cur[3]!, b[2]);
      cur[4] = b[3];
    } else out.push([t, o, b[1], b[2], b[3]]);
  }
  return out;
}

/** Pure: the user message (compact JSON; prices at the pair's digits, times as minutes ago). */
export function buildTradePrompt(c: TradeAiContext): string {
  const px = (x: number) => Number(x.toFixed(c.digits));
  const ago = (t: number) => Math.round((c.now - t) / 60_000);
  const candle = (b: readonly number[]) => [ago(b[0]!), px(b[1]!), px(b[2]!), px(b[3]!), px(b[4]!)];
  return JSON.stringify({
    trade: {
      market: c.label,
      side: c.side === 1 ? 'long (bought)' : 'short (sold)',
      strategy: c.strategy ? `${c.strategy.name}${c.strategy.chart ? ` on the ${c.strategy.chart} chart` : ''}` : 'opened by hand',
      strategyIdea: c.strategy?.desc ?? null,
      entry: px(c.entry),
      priceNow: px(c.px),
      stop: c.stop === null ? null : px(c.stop),
      target: c.target === null ? null : px(c.target),
      openMinutes: ago(c.openedAt),
      pipsNow: c.read.pips.now,
      pipsToTarget: c.read.pips.target === null ? null : Math.round((c.read.pips.target - c.read.pips.now) * 10) / 10,
      pipsToStop: c.read.pips.stop === null ? null : Math.round((c.read.pips.now - c.read.pips.stop) * 10) / 10,
      bestPips: c.read.pips.best,
      profitLockArmsAtPips: c.read.pips.lockAt,
    },
    liveRead: { status: c.read.label, goal: c.read.goal, notes: c.read.lines, movePips: c.read.move },
    market: c.market
      ? {
          hourlyRangePips: c.market.atrPips ?? null,
          trend: c.market.trend ? { '1h': trendWord(c.market.trend.h1), '4h': trendWord(c.market.trend.h4), daily: trendWord(c.market.trend.d1) } : null,
          rsi1h: c.market.rsi1h ?? null,
          currencyStrengthGapItsWay: c.market.strengthGap === null || c.market.strengthGap === undefined ? null : Math.round(c.market.strengthGap * c.side * 100) / 100,
          levelsNearby: c.market.levels ?? [],
        }
      : null,
    candleFormat: '[minutesAgo, open, high, low, close]',
    hourlyCandles: c.hourly.slice(-24).map(candle),
    quarterHourCandles: toQuarter(c.minute).slice(-12).map(candle),
    lastMinutesClose: c.minute.slice(-30).map((b) => px(b[3])),
    newsNext6h: c.news.slice(0, 5).map((e) => ({ inMinutes: -ago(e.t), currency: e.ccy, title: e.title, impact: e.impact })),
  });
}

/** Pure: the model's JSON → a read (clamped), or null when it doesn't parse. */
export function parseTradeAi(text: string): Pick<AiRead, 'verdict' | 'headline' | 'read' | 'watch' | 'confidence'> | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const verdict = VERDICTS.includes(o.verdict as AiVerdict) ? (o.verdict as AiVerdict) : null;
    if (!verdict || typeof o.headline !== 'string' || !o.headline.trim()) return null;
    const watch = Array.isArray(o.watch) ? o.watch.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).map((w) => w.trim().slice(0, 100)).slice(0, 3) : [];
    const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.max(1, Math.min(5, Math.round(o.confidence))) : 3;
    return { verdict, headline: o.headline.trim().slice(0, 110), read: typeof o.read === 'string' ? o.read.trim().slice(0, 700) : '', watch, confidence: conf };
  } catch {
    return null;
  }
}

/** Pure: is a scheduled read due for this trade? (why, or null) */
export function aiDue(prev: Pick<AiRead, 'at' | 'status'> | null, status: ReadStatus, marketOpen: boolean, now: number, cfg: Pick<typeof FX_AI, 'everyMin' | 'minGapMin'> = FX_AI): AiRead['why'] | null {
  if (!marketOpen) return null;
  if (!prev) return 'new';
  const age = now - prev.at;
  if (age >= cfg.everyMin * 60_000) return 'time';
  if (status !== prev.status && SERIOUS.has(status) && age >= cfg.minGapMin * 60_000) return 'change';
  return null;
}

const K = {
  read: (acct: string, id: string) => `fx:ai:read:${acct}:${id}`,
  calls: (hour: string) => `fx:ai:calls:${hour}`,
  spend: (day: string) => `fx:ai:spend:${day}`,
  coachSpend: (day: string) => `ai:spend:${day}`,
};

type BetaCreate = Pick<Anthropic['beta']['messages'], 'create'>;
export type TradeAiClient = { beta: { messages: BetaCreate } };

export class TradeAi {
  private readonly inflight = new Map<string, Promise<AiRead | null>>();
  readonly client: TradeAiClient | null;
  /** why the last call failed (shown on the dashboard), null after a good one */
  lastError: string | null = null;

  constructor(private readonly redis: Redis, client?: TradeAiClient | null, private readonly cfg: typeof FX_AI = FX_AI) {
    this.client = client !== undefined ? client : process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  }

  /** Haiku 5.5 by default (cheap: about a tenth of a cent a read); AI_TRADE_MODEL overrides. */
  get model(): string {
    return process.env.AI_TRADE_MODEL?.trim() || 'claude-haiku-5-5';
  }

  async cached(acct: string, id: string): Promise<AiRead | null> {
    const raw = await this.redis.get(K.read(acct, id)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AiRead;
    } catch {
      return null;
    }
  }

  async cachedMany(acct: string, ids: readonly string[]): Promise<Record<string, AiRead | null>> {
    if (!ids.length) return {};
    const raws = await this.redis.mget(...ids.map((id) => K.read(acct, id))).catch(() => ids.map(() => null));
    const out: Record<string, AiRead | null> = {};
    ids.forEach((id, k) => {
      try {
        out[id] = raws[k] ? (JSON.parse(raws[k]!) as AiRead) : null;
      } catch {
        out[id] = null;
      }
    });
    return out;
  }

  /** Why a scheduled call can't go now (null = it can). The owner's own asks skip the hourly cap and the budget. */
  async capped(now = Date.now(), asked = false): Promise<string | null> {
    if (!this.cfg.enabled) return 'switched off (AI_TRADE=off)';
    if (!this.client) return 'no ANTHROPIC_API_KEY on the server';
    if (asked) return null;
    const iso = new Date(now).toISOString();
    const [calls, spend] = await Promise.all([this.redis.get(K.calls(iso.slice(0, 13))), this.redis.get(K.spend(iso.slice(0, 10)))]);
    if (Number(calls ?? 0) >= this.cfg.maxPerHour) return `hourly cap ${this.cfg.maxPerHour}`;
    if (Number(spend ?? 0) >= this.cfg.dailyBudgetUsd) return `daily budget $${this.cfg.dailyBudgetUsd}`;
    return null;
  }

  /** One read of this trade (deduped while one is running). Never throws; null when it couldn't. */
  async ask(c: TradeAiContext, why: AiRead['why']): Promise<AiRead | null> {
    const key = `${c.acct}:${c.posId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    if (await this.capped(c.now, why === 'asked').catch(() => 'cap check failed')) return null;
    const p = this.call(c, why).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async call(c: TradeAiContext, why: AiRead['why']): Promise<AiRead | null> {
    if (!this.client) return null;
    const iso = new Date(c.now).toISOString();
    const hourKey = K.calls(iso.slice(0, 13));
    await this.redis.multi().incr(hourKey).expire(hourKey, 2 * 3600).exec();
    const model = this.model;
    try {
      // the server-side refusal fallback exists for Opus / Sonnet / Fable, not Haiku (same as the meme reader)
      const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
      const res = await this.client.beta.messages.create({
        model,
        max_tokens: 2000,
        ...fallback,
        system: TRADE_AI_SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: TRADE_AI_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: buildTradePrompt(c) }],
      });
      const price = priceFor(model, res.usage.input_tokens);
      const cost = (res.usage.input_tokens * price.in + res.usage.output_tokens * price.out) / 1e6;
      const day = iso.slice(0, 10);
      await this.redis.multi().incrbyfloat(K.spend(day), cost).expire(K.spend(day), 3 * 86_400).incrbyfloat(K.coachSpend(day), cost).expire(K.coachSpend(day), 3 * 86_400).exec();
      if (res.stop_reason === 'refusal') {
        this.lastError = 'the model declined to answer';
        return null;
      }
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const v = parseTradeAi(text);
      if (!v) {
        this.lastError = res.stop_reason === 'max_tokens' ? 'the answer was cut off' : 'the answer did not parse';
        return null;
      }
      const prev = await this.cached(c.acct, c.posId);
      const history = prev ? [{ at: prev.at, verdict: prev.verdict, headline: prev.headline }, ...prev.history].slice(0, this.cfg.keepHistory) : [];
      const out: AiRead = { ...v, model, at: c.now, px: c.px, status: c.read.status, why, history };
      await this.redis.set(K.read(c.acct, c.posId), JSON.stringify(out), 'EX', this.cfg.ttlSec);
      this.lastError = null;
      return out;
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 160);
      log.warn({ pair: c.pair, err: this.lastError }, 'trade AI read failed');
      return null;
    }
  }

  async status(now = Date.now()): Promise<{ on: boolean; reason: string | null; model: string; spentTodayUsd: number; budgetUsd: number; everyMin: number; lastError: string | null }> {
    const spend = await this.redis.get(K.spend(new Date(now).toISOString().slice(0, 10))).catch(() => null);
    const reason = await this.capped(now).catch(() => 'cap check failed');
    return { on: this.cfg.enabled && !!this.client, reason, model: this.model, spentTodayUsd: Math.round(Number(spend ?? 0) * 1000) / 1000, budgetUsd: this.cfg.dailyBudgetUsd, everyMin: this.cfg.everyMin, lastError: this.lastError };
  }
}
