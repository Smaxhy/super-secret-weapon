/**
 * v27.46 Discord signal copier (owner: "copy a trade every time it's posted in the elite-signals channel"). The owner's
 * own self-bot (scripts/discord-scanner/bot.py) reads Kojiro's messages and POSTs their raw text to
 * /api/forex/discord-signal; this file turns the text into a paper trade on the bot account (coins → the coin bot).
 *
 *   "SIGNAL · NQ — LONG @ 29,026.25"   → open a long on NDXUSD
 *   "SELL @ 29,189.75"                 → close the open long copies (BUY / COVER closes shorts, CLOSE / EXIT both)
 *   "SL to BE" / "move stop to entry"  → the copies' stop goes to their entry
 *
 * The signal carries no stop, so the copy gets a safety stop (`DISCORD_COPY.stopPct` of the price, or the SL the
 * message names) and is sized so that stop loses `riskPct` of the account. It closes when he posts his exit; since v27.51
 * the profit lock also trails it tightly once it is in profit (owner: "trust his trades, take them and trail a tight SL").
 * v27.51: his "Levels" posts (a list of prices, mostly Nasdaq 100) are saved for a day (`POSTED_LEVELS`); the 15-minute
 * pass takes a trade when the price comes to one of them and the other side gets absorbed there (fast.ts →
 * `postedLevelSignal`). Paper only, like every trade here.
 */
import type Redis from 'ioredis';
import { INSTRUMENTS, instrument, isCrypto } from './types';

export const DISCORD_COPY = {
  on: process.env.DISCORD_COPY !== 'off',
  /** % of the account lost if the safety stop is hit */
  riskPct: num(process.env.DISCORD_COPY_RISK_PCT, 2),
  /** safety stop distance when the message names none, % of the price (NQ ≈ 29,000 → ~145 points) */
  stopPct: num(process.env.DISCORD_COPY_STOP_PCT, 0.5),
  leverage: num(process.env.DISCORD_COPY_LEVERAGE, 50),
  /** at most this share of free margin per copy */
  marginShare: 0.5,
  /** our (delayed) price this far past his price, in stop distances → the symbol is probably mapped wrong: refused */
  maxMismatchStops: 1.5,
  /** a message older than this when it reaches us is not opened (a reconnect replaying old posts) */
  maxAgeMs: 10 * 60_000,
  /** v27.51: the profit lock (tight trailing stop once in profit) is ON for copies too; `DISCORD_COPY_LOCK=off` = his exit only */
  profitLock: process.env.DISCORD_COPY_LOCK !== 'off',
  seenTtlSec: 7 * 86_400,
  logKey: 'fx:discord:log',
  logMax: 200,
};

function num(x: string | undefined, d: number): number {
  const v = Number(x);
  return x !== undefined && x !== '' && Number.isFinite(v) && v > 0 ? v : d;
}

/** Ticker words → our market. Futures roots, CFD names and our own ids. */
const SYMBOLS: Record<string, string> = {
  NQ: 'NDXUSD', MNQ: 'NDXUSD', NAS100: 'NDXUSD', NAS: 'NDXUSD', NASDAQ: 'NDXUSD', NDX: 'NDXUSD', US100: 'NDXUSD', USTEC: 'NDXUSD',
  ES: 'SPXUSD', MES: 'SPXUSD', SPX: 'SPXUSD', SPX500: 'SPXUSD', US500: 'SPXUSD', SP500: 'SPXUSD',
  YM: 'DJIUSD', MYM: 'DJIUSD', US30: 'DJIUSD', DOW: 'DJIUSD', DJI: 'DJIUSD',
  RTY: 'RUTUSD', M2K: 'RUTUSD', US2000: 'RUTUSD', RUT: 'RUTUSD',
  GC: 'XAUUSD', MGC: 'XAUUSD', GOLD: 'XAUUSD', XAU: 'XAUUSD',
  SI: 'XAGUSD', SIL: 'XAGUSD', SILVER: 'XAGUSD', XAG: 'XAGUSD',
  BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD',
};

export function symbolToPair(sym: string): string | null {
  const s = sym.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  // as written, then continuous (NQ1!) and dated futures contracts (NQZ6, MNQZ2026)
  for (const c of [s, s.replace(/\d+$/, ''), s.replace(/[FGHJKMNQUVXZ]\d{1,4}$/, '')]) if (SYMBOLS[c]) return SYMBOLS[c]!;
  const id = s.replace(/USDT$/, 'USD');
  return INSTRUMENTS.some((i) => i.id === id) ? id : null;
}

/** v27.51: his posted price levels (one list per market, the newest post wins). */
export const POSTED_LEVELS = {
  /** `DISCORD_LEVEL_TRADES=off` keeps saving / drawing the levels but takes no trades at them */
  trade: process.env.DISCORD_LEVEL_TRADES !== 'off',
  key: 'fx:discord:levels',
  /** a list is used for this long after it was posted (his levels are for the day) */
  validMs: 24 * 3_600_000,
  /** he mainly trades the Nasdaq 100: a post that names no market is read as NQ */
  defaultPair: 'NDXUSD',
  /** prices further than this % from the list's median are numbering / noise, not levels */
  maxSpreadPct: 10,
};

export interface PostedLevels {
  pair: string;
  levels: number[];
  /** when the levels were posted (ms; 0 = no levels yet) */
  t: number;
  msgId: string;
  source: string;
  /** his daily plan post: 1 bullish / −1 bearish / 0 neutral → level trades only his way */
  bias?: 1 | -1 | 0;
  /** his "DOL" (draw on liquidity) = where he expects the price to go → the level trades' target */
  dol?: number | null;
  /** when the plan was posted (ms) */
  biasT?: number;
}

/** His daily plan post ("🔍 Bias: bullish · 💧 DOL: Around 29,385.25 · 🧠 Narrative: …"), or null. Pure. */
export function parseBias(raw: string): { pair: string; bias: 1 | -1 | 0 | null; dol: number | null } | null {
  const up = raw.replace(/[*_`~>|]/g, ' ').toUpperCase();
  const b = /\bBIAS\b\W*(BULLISH|BULL|LONG|BEARISH|BEAR|SHORT|NEUTRAL|NONE)/.exec(up);
  const d = /\bDOL\b\W*(?:AROUND|AT|NEAR|~)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(up);
  if (!b && !d) return null;
  const word = b?.[1] ?? '';
  const bias = !b ? null : /BULL|LONG/.test(word) ? 1 : /BEAR|SHORT/.test(word) ? -1 : 0;
  const dol = d ? Number(d[1]!.replace(/,/g, '')) || null : null;
  const sym = /\b(MNQ|NQ|NAS100|US100|USTEC|NASDAQ|ES|MES|US500|SPX|YM|US30|RTY|GC|GOLD|XAUUSD|SI|BTC|ETH|SOL)[A-Z]?\d{0,4}!?\b/.exec(up);
  return { pair: (sym && symbolToPair(sym[1]!)) || POSTED_LEVELS.defaultPair, bias, dol };
}

/** A "Levels" post → the prices in it (brackets, commas and list numbers ignored), or null. Pure. */
export function parseLevels(raw: string): { pair: string; levels: number[] } | null {
  const text = raw.replace(/[*_`~>|]/g, ' ');
  if (!/\bLEVELS?\b/i.test(text)) return null;
  const nums = [...text.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{3,})(?![\d,])/g)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((x) => Number.isFinite(x) && x > 0);
  if (nums.length < 2) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1]!;
  const levels = [...new Set(nums.filter((x) => Math.abs(x - med) <= (med * POSTED_LEVELS.maxSpreadPct) / 100))].sort((a, b) => b - a);
  if (levels.length < 2) return null;
  const sym = /\b(MNQ|NQ|NAS100|US100|USTEC|NASDAQ|ES|MES|US500|SPX|YM|US30|RTY|GC|GOLD|XAUUSD|SI|BTC|ETH|SOL)[A-Z]?\d{0,4}!?\b/.exec(text.toUpperCase());
  const pair = (sym && symbolToPair(sym[1]!)) || POSTED_LEVELS.defaultPair;
  return { pair, levels };
}

/** Every market's newest posted list still in force. */
export async function loadLevels(redis: Redis, now = Date.now()): Promise<Record<string, PostedLevels>> {
  const raw = await redis.get(POSTED_LEVELS.key).catch(() => null);
  let all: Record<string, PostedLevels> = {};
  try {
    all = raw ? (JSON.parse(raw) as Record<string, PostedLevels>) : {};
  } catch {
    all = {};
  }
  const out: Record<string, PostedLevels> = {};
  for (const [pair, x] of Object.entries(all)) {
    if (!x || !Array.isArray(x.levels)) continue;
    // the levels and the plan each count for a day from their own post
    const levelsOk = now - x.t <= POSTED_LEVELS.validMs;
    const planOk = x.biasT !== undefined && now - x.biasT <= POSTED_LEVELS.validMs;
    if (!levelsOk && !planOk) continue;
    out[pair] = { ...x, levels: levelsOk ? x.levels : [], ...(planOk ? {} : { bias: undefined, dol: undefined, biasT: undefined }) };
  }
  return out;
}

/** Merge a post into the market's record; an older post arriving late never replaces a newer one. */
async function savePosted(redis: Redis, pair: string, patch: { levels: number[]; t: number; msgId: string; source: string } | { bias: 1 | -1 | 0 | null; dol: number | null; biasT: number; source: string }): Promise<void> {
  const raw = await redis.get(POSTED_LEVELS.key).catch(() => null);
  let all: Record<string, PostedLevels> = {};
  try {
    all = raw ? (JSON.parse(raw) as Record<string, PostedLevels>) : {};
  } catch {
    all = {};
  }
  const cur: PostedLevels = all[pair] ?? { pair, levels: [], t: 0, msgId: '', source: patch.source };
  if ('levels' in patch) {
    if (cur.t > patch.t) return;
    all[pair] = { ...cur, ...patch };
  } else {
    if ((cur.biasT ?? 0) > patch.biasT) return;
    all[pair] = { ...cur, ...(patch.bias !== null ? { bias: patch.bias } : {}), ...(patch.dol !== null ? { dol: patch.dol } : {}), biasT: patch.biasT };
  }
  await redis.set(POSTED_LEVELS.key, JSON.stringify(all));
}

/** Strategy name for trades taken at a source's posted levels (kojiro → discord_kojiro_levels). Pure. */
export const levelStrategy = (source: string | undefined) => `${copyStrategy(source)}_levels`;

export type ParsedSignal =
  | { kind: 'open'; pair: string | null; symbol: string | null; side: 1 | -1; price: number | null; stop: number | null; target: number | null }
  | { kind: 'close'; pair: string | null; symbol: string | null; closes: 1 | -1 | 0; price: number | null }
  | { kind: 'breakeven'; pair: string | null; symbol: string | null }
  | { kind: 'none' };

const PRICE = String.raw`([0-9][0-9,]*(?:\.[0-9]+)?)`;
const toNum = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/,/g, '')) || null);

/** Read one message. Pure. */
export function parseSignal(raw: string): ParsedSignal {
  // markdown / emoji noise out, all dash kinds and the middle dot become spaces
  const text = raw.replace(/[*_`~>|]/g, ' ').replace(/[—–·•:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'none' };
  const up = text.toUpperCase();
  const symM = /\bSIGNAL\s+([A-Z0-9!/]{1,10})\b/.exec(up) ?? /\b(MNQ|NQ|NAS100|US100|ES|MES|US500|SPX|YM|US30|RTY|GC|XAUUSD|GOLD|SI|BTC|ETH|SOL)[A-Z]?\d{0,4}!?\b/.exec(up);
  const symbol = symM ? symM[1]! : null;
  const pair = symbol ? symbolToPair(symbol) : null;
  const stop = toNum(new RegExp(String.raw`\b(?:SL|STOP(?:\s*LOSS)?)\s*(?:@|AT|=)?\s*${PRICE}`).exec(up)?.[1]);
  const target = toNum(new RegExp(String.raw`\b(?:TP1?|TARGET|TAKE\s*PROFIT)\s*(?:@|AT|=)?\s*${PRICE}`).exec(up)?.[1]);
  const entry = new RegExp(String.raw`\b(LONG|SHORT|BUY|SELL|COVER|CLOSE|EXIT)\b\s*(?:@|AT)\s*${PRICE}`).exec(up);
  const isSignal = /\bSIGNAL\b/.test(up);
  if (entry) {
    const word = entry[1]!;
    const price = toNum(entry[2]);
    // an entry is a SIGNAL post, or LONG / SHORT anywhere; a bare BUY / SELL @ is his exit
    if (isSignal && (word === 'LONG' || word === 'BUY' || word === 'SHORT' || word === 'SELL')) return { kind: 'open', pair, symbol, side: word === 'LONG' || word === 'BUY' ? 1 : -1, price, stop, target };
    if (word === 'LONG' || word === 'SHORT') return { kind: 'open', pair, symbol, side: word === 'LONG' ? 1 : -1, price, stop, target };
    return { kind: 'close', pair, symbol, closes: word === 'SELL' ? 1 : word === 'BUY' || word === 'COVER' ? -1 : 0, price };
  }
  if (/\b(?:SL|STOP)\b.*\b(?:BE|BREAK\s*EVEN|ENTRY)\b/.test(up) || /\bMOVE\b.*\b(?:BE|BREAK\s*EVEN)\b/.test(up)) return { kind: 'breakeven', pair, symbol };
  if (/\b(?:CLOSED?|EXIT(?:ED)?|OUT|FLAT)\b/.test(up) && /\b(?:ALL|POSITION|TRADE|SIGNAL)\b/.test(up)) return { kind: 'close', pair, symbol, closes: 0, price: null };
  return { kind: 'none' };
}

/** The strategy name a source's trades carry ("kojiro" → discord_kojiro). Pure. */
export const copyStrategy = (source: string | undefined) => `discord_${(source ?? 'kojiro').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'kojiro'}`;
export const copyRef = (strategy: string, pair: string, msgId: string) => `${strategy}:signal:${pair}:${msgId}`;
export const acctForPair = (pair: string): 'bot' | 'cbot' => (isCrypto(pair) ? 'cbot' : 'bot');

/** Safety stop for a copy: the message's SL when it's on the losing side, else `stopPct` of the price. Pure. */
export function copyStop(side: 1 | -1, entry: number, named: number | null, stopPct = DISCORD_COPY.stopPct): number {
  if (named !== null && (side === 1 ? named < entry : named > entry)) return named;
  return entry - side * entry * (stopPct / 100);
}

/** Size of a copy: margin so the stop loses `riskUsd`, capped by free margin. Pure. `usdPerUnitMove` = USD a unit makes
 * per 1.0 of price (1 for USD-priced markets); `notionalPerUnit` = USD notional of one unit. */
export function copySize(o: { riskUsd: number; stopDist: number; usdPerUnitMove: number; notionalPerUnit: number; leverage: number; freeMarginUsd: number; marginShare?: number }): { marginUsd: number; riskUsd: number } {
  if (!(o.stopDist > 0) || !(o.usdPerUnitMove > 0) || !(o.notionalPerUnit > 0) || !(o.leverage > 0)) return { marginUsd: 0, riskUsd: 0 };
  const units = o.riskUsd / (o.stopDist * o.usdPerUnitMove);
  const want = (units * o.notionalPerUnit) / o.leverage;
  const marginUsd = Math.min(want, o.freeMarginUsd * (o.marginShare ?? DISCORD_COPY.marginShare));
  const riskUsd = want > 0 ? (o.riskUsd * marginUsd) / want : 0;
  return { marginUsd: Math.floor(marginUsd * 100) / 100, riskUsd: Math.round(riskUsd * 100) / 100 };
}

export interface SignalIn {
  id: string;
  text: string;
  /** when Discord says it was posted (ms) */
  at: number;
  source?: string;
  channel?: string;
}

export interface CopyLogRow {
  t: number;
  id: string;
  source: string;
  text: string;
  kind: ParsedSignal['kind'] | 'old' | 'duplicate' | 'off' | 'levels';
  pair?: string | null;
  side?: 1 | -1;
  hisPx?: number | null;
  ok: boolean;
  what: string;
}

/** What the practice account offers the copier (Practice implements it). */
export interface CopyBook {
  copyOpen(r: { pair: string; side: 1 | -1; stopNamed: number | null; hisPx: number | null; strategy: string; ref: string; riskPct: number; leverage: number; profitLock: boolean; stop?: number; target?: number | null }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; error?: string; entry?: number; stop?: number; riskUsd?: number; marginUsd?: number }>;
  copyClose(m: { strategy: string; pair: string | null; side: 1 | -1 | 0 }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; closed: string[]; pending: number }>;
  copyBreakeven(m: { strategy: string; pair: string | null }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; moved: string[] }>;
}

/** Turn one posted message into a trade action; every message is logged (Redis `fx:discord:log`). */
export async function handleSignal(redis: Redis, book: CopyBook, s: SignalIn, now = Date.now()): Promise<CopyLogRow> {
  const source = (s.source ?? 'kojiro').slice(0, 24);
  const strategy = copyStrategy(source);
  const base = { t: now, id: s.id, source, text: s.text.slice(0, 300) };
  const done = async (row: CopyLogRow) => {
    await redis.multi().lpush(DISCORD_COPY.logKey, JSON.stringify(row)).ltrim(DISCORD_COPY.logKey, 0, DISCORD_COPY.logMax - 1).exec().catch(() => undefined);
    return row;
  };
  if (!DISCORD_COPY.on) return done({ ...base, kind: 'off', ok: false, what: 'copying is switched off (DISCORD_COPY=off)' });
  const first = await redis.set(`fx:discord:seen:${s.id}`, '1', 'EX', DISCORD_COPY.seenTtlSec, 'NX');
  if (first !== 'OK') return { ...base, kind: 'duplicate', ok: true, what: 'already handled' };
  const sig = parseSignal(s.text);
  if (sig.kind === 'none') {
    const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 5 });
    const plan = parseBias(s.text);
    const lv = parseLevels(s.text);
    if (!lv && !plan) return done({ ...base, kind: 'none', ok: true, what: 'not a trade message' });
    const said: string[] = [];
    if (plan) {
      await savePosted(redis, plan.pair, { bias: plan.bias, dol: plan.dol, biasT: s.at, source });
      said.push(`${plan.pair} plan for today: ${plan.bias === 1 ? 'bullish (only long trades at his levels)' : plan.bias === -1 ? 'bearish (only short trades at his levels)' : plan.bias === 0 ? 'neutral' : 'no bias'}${plan.dol ? `, target (DOL) ${fmt(plan.dol)}` : ''}`);
    }
    if (lv) {
      await savePosted(redis, lv.pair, { levels: lv.levels, t: s.at, msgId: s.id, source });
      said.push(`${lv.pair} levels saved for today: ${lv.levels.map(fmt).join(' · ')}${POSTED_LEVELS.trade ? ' — the bot trades a reversal at them (15-minute candles)' : ''}`);
    }
    return done({ ...base, kind: 'levels', pair: (lv ?? plan)!.pair, ok: true, what: said.join('; ') });
  }
  if (sig.kind === 'open') {
    if (now - s.at > DISCORD_COPY.maxAgeMs) return done({ ...base, kind: 'old', pair: sig.pair, side: sig.side, hisPx: sig.price, ok: false, what: `posted ${Math.round((now - s.at) / 60_000)} min ago — too old to copy` });
    if (!sig.pair || !instrument(sig.pair)) return done({ ...base, kind: 'open', pair: null, side: sig.side, hisPx: sig.price, ok: false, what: `unknown market "${sig.symbol ?? '?'}"` });
    const r = await book.copyOpen({ pair: sig.pair, side: sig.side, stopNamed: sig.stop, hisPx: sig.price, strategy, ref: copyRef(strategy, sig.pair, s.id), riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage, profitLock: DISCORD_COPY.profitLock }, acctForPair(sig.pair));
    const what = r.ok ? `copied ${sig.side === 1 ? 'LONG' : 'SHORT'} ${sig.pair} at ${r.entry} (his ${sig.price ?? '?'}), safety stop ${r.stop}, risking $${r.riskUsd}` : `not copied: ${r.error}`;
    return done({ ...base, kind: 'open', pair: sig.pair, side: sig.side, hisPx: sig.price, ok: r.ok, what });
  }
  if (sig.kind === 'close') {
    const accts: Array<'bot' | 'cbot'> = sig.pair ? [acctForPair(sig.pair)] : ['bot', 'cbot'];
    const closed: string[] = [];
    let pending = 0;
    for (const acct of accts) {
      const r = await book.copyClose({ strategy, pair: sig.pair, side: sig.closes }, acct);
      closed.push(...r.closed);
      pending += r.pending;
    }
    const what = closed.length ? `closed ${closed.join(', ')}${pending ? ` (${pending} at the first price)` : ''}` : 'no open copy to close';
    return done({ ...base, kind: 'close', pair: sig.pair, hisPx: sig.price, ok: closed.length > 0, what });
  }
  const accts: Array<'bot' | 'cbot'> = sig.pair ? [acctForPair(sig.pair)] : ['bot', 'cbot'];
  const moved: string[] = [];
  for (const acct of accts) moved.push(...(await book.copyBreakeven({ strategy, pair: sig.pair }, acct)).moved);
  return done({ ...base, kind: 'breakeven', pair: sig.pair, ok: moved.length > 0, what: moved.length ? `stop to entry on ${moved.join(', ')}` : 'no open copy to move' });
}

export async function copyLog(redis: Redis, n = 50): Promise<CopyLogRow[]> {
  const raw = await redis.lrange(DISCORD_COPY.logKey, 0, n - 1).catch(() => [] as string[]);
  return raw.flatMap((x) => {
    try {
      return [JSON.parse(x) as CopyLogRow];
    } catch {
      return [];
    }
  });
}
