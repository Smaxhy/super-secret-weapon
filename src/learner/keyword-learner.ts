/**
 * Keyword learner — remembers how coins with a given word in their name,
 * ticker or description turned out (win / loss), so the narrative score can
 * favour words that have been working lately and avoid ones that keep dying.
 *
 * Storage (Redis, bounded):
 *   kw:w     hash word → weighted wins
 *   kw:n     hash word → weighted samples
 *   kw:base  hash {w, n} → global wins / samples (the base rate)
 *   kw:day   last UTC day number the counts were decayed
 *
 * Recency: once per day (lazily, on the first write of a new day) every count
 * is multiplied by DECAY_PER_DAY, and only the MAX_WORDS most-sampled words are
 * kept. Words with too few samples are ignored when scoring, and every win rate
 * is shrunk toward the global base rate so one lucky coin can't dominate.
 */
import type { Redis } from 'ioredis';

const K_WINS = 'kw:w';
const K_SAMPLES = 'kw:n';
const K_BASE = 'kw:base';
const K_DAY = 'kw:day';
const K_DECAY_LOCK = 'kw:decay:lock';

export const DECAY_PER_DAY = 0.98;
export const MAX_WORDS = 5_000;
/** Prune when the hash grows this far past MAX_WORDS between daily decays. */
const PRUNE_SLACK = 1_000;
/** Weighted samples a word needs before it counts. */
export const MIN_SAMPLES = 8;
/** Prior strength (pseudo-samples at the base rate) used for shrinkage. */
const PRIOR = 10;
/** Default base rate before any data. */
const DEFAULT_BASE = 0.2;
const MAX_DESC_WORDS = 40;

export interface KeywordText {
  name: string;
  symbol: string;
  description?: string | null;
}

export interface KeywordStat {
  word: string;
  winRate: number;
  n: number;
}

const STOPWORDS = new Set(
  (
    // English filler
    'the and for that this with have from your just what will been they them then than when were about there their would could should into more some very only also over ' +
    'like make made are was not but you our its all can get has had who how why out now new one two our his her him she let lets yes yet any too off own via per ' +
    'every first last next most much many such each other where here dont cant wont isnt im ive youre thats whats its ' +
    // generic crypto / launch filler
    'coin coins token tokens sol solana pump pumpfun fun official meme memecoin memes crypto chain community holders holder hold buy sell moon launch launched ' +
    'fair stealth dev devs team project website telegram twitter http https www com xyz org net io app lol ca contract address ticker supply liquidity lp ' +
    'burned burn renounced mint mints jeet jeets send sending gem gems 100x 1000x'
  ).split(/\s+/),
);

/** Lowercase, strip punctuation/emoji, keep words ≥3 chars that aren't filler. */
function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Keywords of a launch: words from name, symbol and (the first part of the)
 * description, plus bigrams of adjacent name words ("baby doge"). Unique. Pure.
 */
export function tokenize(text: KeywordText): string[] {
  const out = new Set<string>();
  const nameWords = words(text.name);
  for (const w of nameWords) out.add(w);
  for (let i = 0; i + 1 < nameWords.length; i++) out.add(`${nameWords[i]} ${nameWords[i + 1]}`);
  for (const w of words(text.symbol)) out.add(w);
  for (const w of words(text.description).slice(0, MAX_DESC_WORDS)) out.add(w);
  return [...out];
}

const num = (v: string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Win rate shrunk toward the base rate. Pure. */
export function shrunkRate(wins: number, n: number, base: number): number {
  return (wins + PRIOR * base) / (n + PRIOR);
}

const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

async function readBase(redis: Redis): Promise<number> {
  const [w, n] = await redis.hmget(K_BASE, 'w', 'n');
  const nn = num(n);
  return nn >= 20 ? Math.min(0.95, Math.max(0.01, num(w) / nn)) : DEFAULT_BASE;
}

/** Rewrite the hashes with every count decayed and only the top words kept. */
async function compact(redis: Redis, factor: number): Promise<void> {
  const [wins, samples, base] = await Promise.all([redis.hgetall(K_WINS), redis.hgetall(K_SAMPLES), redis.hgetall(K_BASE)]);
  const rows = Object.entries(samples)
    .map(([word, n]) => ({ word, n: num(n) * factor, w: num(wins[word]) * factor }))
    .filter((r) => r.n >= 0.05)
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_WORDS);
  const m = redis.multi();
  m.del(K_WINS, K_SAMPLES);
  if (rows.length) {
    m.hset(K_SAMPLES, Object.fromEntries(rows.map((r) => [r.word, r.n.toFixed(4)])));
    const withWins = rows.filter((r) => r.w > 0);
    if (withWins.length) m.hset(K_WINS, Object.fromEntries(withWins.map((r) => [r.word, r.w.toFixed(4)])));
  }
  if (factor !== 1 && (base.n || base.w)) m.hset(K_BASE, { w: (num(base.w) * factor).toFixed(4), n: (num(base.n) * factor).toFixed(4) });
  await m.exec();
}

/** Decay once per UTC day (first caller of the day wins the lock); prune if oversized. */
async function maintain(redis: Redis, nowMs: number): Promise<void> {
  const today = utcDay(nowMs);
  const last = Number(await redis.get(K_DAY));
  if (!Number.isFinite(last) || last <= 0) {
    await redis.set(K_DAY, String(today));
  } else if (last < today) {
    if (await redis.set(K_DECAY_LOCK, String(today), 'EX', 300, 'NX')) {
      await redis.set(K_DAY, String(today));
      await compact(redis, Math.pow(DECAY_PER_DAY, Math.min(365, today - last)));
      return;
    }
  }
  if ((await redis.hlen(K_SAMPLES)) > MAX_WORDS + PRUNE_SLACK) await compact(redis, 1);
}

/** Record one labelled outcome for every keyword of a launch. Never throws. */
export async function recordKeywordOutcome(redis: Redis, text: KeywordText, win: boolean, weight = 1, nowMs = Date.now()): Promise<void> {
  if (!(weight > 0)) return;
  try {
    await maintain(redis, nowMs);
    const kws = tokenize(text);
    const m = redis.multi();
    for (const w of kws) {
      m.hincrbyfloat(K_SAMPLES, w, weight);
      if (win) m.hincrbyfloat(K_WINS, w, weight);
    }
    m.hincrbyfloat(K_BASE, 'n', weight);
    if (win) m.hincrbyfloat(K_BASE, 'w', weight);
    await m.exec();
  } catch {
    // learning is best-effort
  }
}

/**
 * How well this launch's keywords have done. `score` is the estimated win
 * chance (0..1) from keywords with ≥MIN_SAMPLES weighted samples, shrunk toward
 * the base rate; with no qualifying keyword it equals the base rate and n = 0.
 * `top` lists the qualifying keywords, most-sampled first.
 */
export async function keywordScore(
  redis: Redis,
  text: KeywordText,
): Promise<{ score: number; n: number; baseRate: number; top: KeywordStat[] }> {
  const kws = tokenize(text);
  let baseRate = DEFAULT_BASE;
  try {
    baseRate = await readBase(redis);
    const top = [...(await keywordStats(redis, kws)).values()];
    if (!top.length) return { score: baseRate, n: 0, baseRate, top: [] };
    top.sort((a, b) => b.n - a.n);
    // Weight each word by √n so a well-known word counts more, but not overwhelmingly.
    let sw = 0;
    let s = 0;
    let total = 0;
    for (const t of top) {
      const wgt = Math.sqrt(t.n);
      sw += wgt;
      s += wgt * t.winRate;
      total += t.n;
    }
    return { score: Math.max(0, Math.min(1, s / sw)), n: total, baseRate, top: top.slice(0, 5) };
  } catch {
    return { score: baseRate, n: 0, baseRate, top: [] };
  }
}

/** Learned stats for specific keywords (only those with ≥MIN_SAMPLES). */
export async function keywordStats(redis: Redis, words: string[]): Promise<Map<string, KeywordStat>> {
  const out = new Map<string, KeywordStat>();
  if (!words.length) return out;
  try {
    const [baseRate, ws, ns] = await Promise.all([readBase(redis), redis.hmget(K_WINS, ...words), redis.hmget(K_SAMPLES, ...words)]);
    words.forEach((word, i) => {
      const n = num(ns[i]);
      if (n >= MIN_SAMPLES) out.set(word, { word, n, winRate: shrunkRate(Math.min(num(ws[i]), n), n, baseRate) });
    });
  } catch {
    // best-effort
  }
  return out;
}

/** Best and worst keywords lately (for the dashboard / explanations). */
export async function keywordInsights(redis: Redis, limit = 20): Promise<{ good: KeywordStat[]; bad: KeywordStat[]; baseRate: number }> {
  const [baseRate, wins, samples] = await Promise.all([readBase(redis), redis.hgetall(K_WINS), redis.hgetall(K_SAMPLES)]);
  const all: KeywordStat[] = Object.entries(samples)
    .map(([word, nRaw]) => {
      const n = num(nRaw);
      return { word, n, winRate: shrunkRate(Math.min(num(wins[word]), n), n, baseRate) };
    })
    .filter((r) => r.n >= MIN_SAMPLES);
  const good = all.filter((r) => r.winRate > baseRate).sort((a, b) => b.winRate - a.winRate || b.n - a.n).slice(0, limit);
  const bad = all.filter((r) => r.winRate < baseRate).sort((a, b) => a.winRate - b.winRate || b.n - a.n).slice(0, limit);
  const round = (r: KeywordStat): KeywordStat => ({ word: r.word, n: Math.round(r.n * 10) / 10, winRate: Math.round(r.winRate * 1000) / 1000 });
  return { good: good.map(round), bad: bad.map(round), baseRate: Math.round(baseRate * 1000) / 1000 };
}
