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
import { KSTUDY, kojiroGate, loadCard, saveHistory } from './kojiro-study';
import { sessionOf } from './montecarlo';
import type Redis from 'ioredis';
import { INSTRUMENTS, instrument, isCrypto } from './types';

export const DISCORD_COPY = {
  on: process.env.DISCORD_COPY !== 'off',
  /** % of the account lost if the safety stop is hit — v27.57: 20 (owner: "much more on Kojiro calls, also 20"), shared by
   * every open copy (signals + level trades together ≤ 20%), past the account's $ loss cap */
  riskPct: num(process.env.DISCORD_COPY_RISK_PCT, 20),
  /** safety stop distance when the message names none, % of the price (NQ ≈ 29,000 → ~145 points) */
  stopPct: num(process.env.DISCORD_COPY_STOP_PCT, 0.5),
  leverage: num(process.env.DISCORD_COPY_LEVERAGE, 50),
  /** at most this share of free margin per copy (v27.57: 0.9, like an all-in cell trade) */
  marginShare: 0.9,
  /** v27.72 (owner: "super big trades with insane fees … +50 pips but −40"): a copy whose round-trip venue fee is more
   * than this share of its stop distance is refused (it can't win after fees) … */
  maxFeeShare: 0.25,
  /** … and a copy is made smaller until its round-trip fee is at most this % of the account (gold at 50× paid ~$50) */
  maxFeePctOfEquity: num(process.env.DISCORD_COPY_MAX_FEE_PCT, 1),
  /** our (delayed) price this far past his price, in stop distances → the symbol is probably mapped wrong: refused */
  maxMismatchStops: 1.5,
  /** a message older than this when it reaches us is not opened (a reconnect replaying old posts) */
  maxAgeMs: 10 * 60_000,
  /** v27.51 profit lock on copies; v27.59 off (it closed his NQ long on a 45-point pullback); v27.61 ON again with the
   * looser copy lock (profit-lock.ts `COPY_LOCK`: arms +0.5R, trails 0.5R, 0.3R past +1.2R — owner: "trailing SL on his
   * calls is fine, just not too tight early on"). `DISCORD_COPY_LOCK=off` = his exit / his SL / the safety stop only. */
  profitLock: process.env.DISCORD_COPY_LOCK !== 'off',
  /** v27.77: his SIGNAL posts are NOT opened on the account (lab only: logged + graded by kojiro-study.ts); his exits still
   * close any copy left open. `DISCORD_COPY_LIVE=on` copies them again. */
  live: process.env.DISCORD_COPY_LIVE === 'on',
  /** v27.94 (owner: "Fullport FOMC longs is also a call … make sure it happens at all costs"): his FULL-conviction calls
   * ("fullport / full port / full send / all in … longs / shorts", or an event call like "FOMC longs") are taken even
   * while his other calls are lab-only, past his-record gate; `DISCORD_FULLPORT_LIVE=off` = lab only like the rest. */
  fullLive: process.env.DISCORD_FULLPORT_LIVE !== 'off',
  /** a full-conviction call is still opened when it reaches us this late (a copier catch-up can be minutes behind) */
  fullMaxAgeMs: 45 * 60_000,
  /** v28.3 (owner: "always go for elite calls, calls in the elite signal channel get prioritization and follow them
   * correctly"): every call posted in these channels is opened at once — even while his other calls are lab only, past
   * his-record gate, up to `fullMaxAgeMs` late (a copier catch-up), with its own room past the shared copy budget; his
   * exits / SL-to-BE posts close / move it like any copy; the $20 loss cap still sizes it. `DISCORD_ELITE_LIVE=off` = lab
   * only; `DISCORD_ELITE_CHANNELS` = a comma list to replace the default. */
  eliteChannels: (process.env.DISCORD_ELITE_CHANNELS ?? '1563800424769916968').split(',').map((x) => x.trim()).filter(Boolean),
  eliteLive: process.env.DISCORD_ELITE_LIVE !== 'off',
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
  /** v27.77 (owner: "keep all Kojiro calls in labs for now — they work for him, apparently not for us"): OFF by default —
   * the level watcher only records what it would have traded (`LEVEL_LAB`); `DISCORD_LEVEL_TRADES=on` trades them again */
  trade: process.env.DISCORD_LEVEL_TRADES === 'on',
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
  /** v27.64: a "Short Levels" post → only shorts at these prices (whatever the bias); `shortT` = when posted */
  shortLevels?: number[];
  shortT?: number;
  /** a "Long Levels" post → only longs at these prices */
  longLevels?: number[];
  longT?: number;
}

/** One list of his levels to trade: entry prices, the only side allowed (0 = both), when it was posted, the DOL target. */
export interface LevelSet {
  levels: number[];
  side: 1 | -1 | 0;
  t: number;
  dol: number | null;
  /** every level of his in force (targets come from the whole map, not only this list) */
  all: number[];
}

/** A market's posted lists as tradable sets: plain levels follow his bias + DOL; short / long lists force their side and
 * target his other levels (his DOL is the bias side's target). Pure. */
export function levelSets(x: PostedLevels): LevelSet[] {
  const all = [...new Set([...x.levels, ...(x.shortLevels ?? []), ...(x.longLevels ?? [])])];
  const out: LevelSet[] = [];
  if (x.levels.length) out.push({ levels: x.levels, side: x.bias ?? 0, t: x.t, dol: x.dol ?? null, all });
  if (x.shortLevels?.length) out.push({ levels: x.shortLevels, side: -1, t: x.shortT ?? 0, dol: x.bias === -1 ? (x.dol ?? null) : null, all });
  if (x.longLevels?.length) out.push({ levels: x.longLevels, side: 1, t: x.longT ?? 0, dol: x.bias === 1 ? (x.dol ?? null) : null, all });
  return out;
}

/** His daily plan post ("🔍 Bias: bullish · 💧 DOL: Around 29,385.25 · 🧠 Narrative: …"), or null. Pure. */
export function parseBias(raw: string): { pair: string; bias: 1 | -1 | 0 | null; dol: number | null } | null {
  const up = raw.replace(/[*_`~>|]/g, ' ').toUpperCase();
  // v27.69: "Leaning towards bearish" / "leaning bullish" / "leaning short" is his bias too (Oct 27: missed → the bot kept
  // the morning's bullish plan and only bought at his evening levels while he was short)
  const b = /\bBIAS\b\W*(BULLISH|BULL|LONG|BEARISH|BEAR|SHORT|NEUTRAL|NONE)/.exec(up) ?? /\bLEANING\b(?:\s+(?:TOWARDS?|TO|MORE|SLIGHTLY|A\s+BIT))*\W*(BULLISH|BULL|LONGS?|BEARISH|BEAR|SHORTS?)\b/.exec(up);
  const d = /\bDOL\b\W*(?:AROUND|AT|NEAR|~)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(up);
  if (!b && !d) return null;
  const word = b?.[1] ?? '';
  const bias = !b ? null : /BULL|LONG/.test(word) ? 1 : /BEAR|SHORT/.test(word) ? -1 : 0;
  const dol = d ? Number(d[1]!.replace(/,/g, '')) || null : null;
  const sym = /\b(MNQ|NQ|NAS100|US100|USTEC|NASDAQ|ES|MES|US500|SPX|YM|US30|RTY|GC|GOLD|XAUUSD|SI|BTC|ETH|SOL)[A-Z]?\d{0,4}!?\b/.exec(up);
  return { pair: (sym && symbolToPair(sym[1]!)) || POSTED_LEVELS.defaultPair, bias, dol };
}

/** A "Levels" post → the prices in it (brackets, commas and list numbers ignored), or null. Pure. */
export function parseLevels(raw: string): { pair: string; levels: number[]; side?: 1 | -1 } | null {
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
  // v27.64: "Short Levels (for today)" / "Sell levels" → shorts only; "Long / Buy levels" → longs only
  const up = text.toUpperCase();
  const side = /\b(SHORT|SELL)\s+LEVELS?\b/.test(up) ? -1 : /\b(LONG|BUY)\s+LEVELS?\b/.test(up) ? 1 : undefined;
  return side ? { pair, levels, side } : { pair, levels };
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
    // the levels, the short / long lists and the plan each count for a day from their own post
    const fresh = (t: number | undefined) => t !== undefined && now - t <= POSTED_LEVELS.validMs;
    const levelsOk = fresh(x.t);
    const planOk = fresh(x.biasT);
    const shortOk = !!x.shortLevels?.length && fresh(x.shortT);
    const longOk = !!x.longLevels?.length && fresh(x.longT);
    if (!levelsOk && !planOk && !shortOk && !longOk) continue;
    const { shortLevels, shortT, longLevels, longT, ...rest } = x;
    out[pair] = {
      ...rest,
      levels: levelsOk ? x.levels : [],
      ...(planOk ? {} : { bias: undefined, dol: undefined, biasT: undefined }),
      ...(shortOk ? { shortLevels, shortT } : {}),
      ...(longOk ? { longLevels, longT } : {}),
    };
  }
  return out;
}

/** Merge a post into the market's record; an older post arriving late never replaces a newer one (`force` = it does:
 * a correction by hand). A levels post with a `side` fills the short / long list and leaves his plain levels alone. */
export async function savePosted(redis: Redis, pair: string, patch: { levels: number[]; t: number; msgId: string; source: string; side?: 1 | -1 } | { bias: 1 | -1 | 0 | null; dol: number | null; biasT: number; source: string }, force = false): Promise<void> {
  const raw = await redis.get(POSTED_LEVELS.key).catch(() => null);
  let all: Record<string, PostedLevels> = {};
  try {
    all = raw ? (JSON.parse(raw) as Record<string, PostedLevels>) : {};
  } catch {
    all = {};
  }
  const cur: PostedLevels = all[pair] ?? { pair, levels: [], t: 0, msgId: '', source: patch.source };
  if ('levels' in patch && patch.side) {
    const k = patch.side === -1 ? 'short' : 'long';
    if (!force && (cur[`${k}T`] ?? 0) > patch.t) return;
    all[pair] = { ...cur, [`${k}Levels`]: patch.levels, [`${k}T`]: patch.t };
  } else if ('levels' in patch) {
    if (!force && cur.t > patch.t) return;
    const { side: _side, ...p } = patch;
    all[pair] = { ...cur, ...p };
  } else {
    if (!force && (cur.biasT ?? 0) > patch.biasT) return;
    all[pair] = { ...cur, ...(patch.bias !== null ? { bias: patch.bias } : {}), ...(patch.dol !== null ? { dol: patch.dol } : {}), biasT: patch.biasT };
  }
  await redis.set(POSTED_LEVELS.key, JSON.stringify(all));
}

/** Strategy name for trades taken at a source's posted levels (kojiro → discord_kojiro_levels). Pure. */
export const levelStrategy = (source: string | undefined) => `${copyStrategy(source)}_levels`;

export type ParsedSignal =
  | { kind: 'open'; pair: string | null; symbol: string | null; side: 1 | -1; price: number | null; stop: number | null; target: number | null; conviction?: 'full'; event?: string | null }
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
  const full = fullCall(up);
  if (full) return { kind: 'open', pair: pair ?? POSTED_LEVELS.defaultPair, symbol: symbol ?? 'NQ', side: full.side, price: null, stop, target, conviction: 'full', event: full.event };
  if (/\b(?:SL|STOP)\b.*\b(?:BE|BREAK\s*EVEN|ENTRY)\b/.test(up) || /\bMOVE\b.*\b(?:BE|BREAK\s*EVEN)\b/.test(up)) return { kind: 'breakeven', pair, symbol };
  if (/\b(?:CLOSED?|EXIT(?:ED)?|OUT|FLAT)\b/.test(up) && /\b(?:ALL|POSITION|TRADE|SIGNAL)\b/.test(up)) return { kind: 'close', pair, symbol, closes: 0, price: null };
  return { kind: 'none' };
}

/** v27.94: a full-conviction call without a price — "Fullport FOMC longs", "full port shorts", "all in longs into CPI",
 * "FOMC longs" — → its side (+ the event named), or null. Chatter that says not to ("no longs before FOMC", "careful with
 * fullport shorts") is not a call. Pure (takes the upper-cased text). */
export function fullCall(up: string): { side: 1 | -1; event: string | null } | null {
  const sideM = /\b(LONGS?|BUYS?|CALLS|SHORTS?|PUTS)\b/.exec(up);
  if (!sideM) return null;
  const fullWord = /\b(?:FULL\s*-?\s*PORT(?:ED)?|FULLPORT(?:ED)?|FULL\s+SEND|FULL\s+SIZE|ALL\s*-?\s*IN|MAX\s+SIZE)\b/.test(up);
  const eventM = /\b(FOMC|CPI|PPI|NFP|PCE|POWELL|FED|JOBS\s+REPORT|RATE\s+DECISION)\b/.exec(up);
  if (!fullWord && !eventM) return null;
  if (/\b(?:NO|NOT|DON'?T|DONT|AVOID|CAREFUL|NEVER|STOP(?:PED)?|WOULDN'?T|SKIP|CLOSE[DS]?|CLOSING|EXIT(?:ED|ING)?|SOLD|COVER(?:ED)?|TOOK|TRIM(?:MED)?|FLAT|PAID|PROFITS?|SECURED?|RECAP|WON|LOST)\b/.test(up)) return null;
  // an event call needs the side word right next to it ("FOMC longs", "longs into FOMC"), not a sentence that mentions both
  if (!fullWord && eventM && !new RegExp(String.raw`\b${eventM[1]}\b\W+(?:(?:MNQ|NQ|ES|MES|GC|GOLD|NASDAQ|NAS100|SPX|BIG|HEAVY|SIZED)\W+)?${sideM[1]}\b|\b${sideM[1]}\b\W+(?:INTO|FOR|BEFORE|ON|THROUGH|OVER|AHEAD\s+OF)\W+(?:THE\W+)?${eventM[1]}\b`).test(up)) return null;
  const w = sideM[1]!;
  return { side: /^(LONG|BUY|CALL)/.test(w) ? 1 : -1, event: eventM ? eventM[1]!.replace(/\s+/g, ' ') : null };
}

/** The strategy name a source's trades carry ("kojiro" → discord_kojiro). Pure. */
export const copyStrategy = (source: string | undefined) => `discord_${(source ?? 'kojiro').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'kojiro'}`;
export const copyRef = (strategy: string, pair: string, msgId: string) => `${strategy}:signal:${pair}:${msgId}`;
/** v28.3: a call from one of his elite channels? Pure. */
export const isEliteChannel = (channel: string | undefined | null) => !!channel && DISCORD_COPY.eliteChannels.includes(String(channel));
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
  /** v27.65: posted in his channel by someone else → logged only, never traded on */
  other?: boolean;
  author?: string;
}

export interface CopyLogRow {
  t: number;
  id: string;
  source: string;
  text: string;
  kind: ParsedSignal['kind'] | 'old' | 'duplicate' | 'off' | 'levels' | 'other';
  pair?: string | null;
  side?: 1 | -1;
  hisPx?: number | null;
  ok: boolean;
  what: string;
  /** v28.3: the channel it was posted in, and whether that is one of his elite channels */
  channel?: string;
  elite?: boolean;
}

/** What the practice account offers the copier (Practice implements it). */
export interface CopyBook {
  copyOpen(r: { pair: string; side: 1 | -1; stopNamed: number | null; hisPx: number | null; strategy: string; ref: string; riskPct: number; leverage: number; profitLock: boolean; stop?: number; target?: number | null; copyLock?: 'copy' | 'tight'; priority?: boolean }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; error?: string; entry?: number; stop?: number; riskUsd?: number; marginUsd?: number }>;
  copyClose(m: { strategy: string; pair: string | null; side: 1 | -1 | 0 }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; closed: string[]; pending: number }>;
  copyBreakeven(m: { strategy: string; pair: string | null }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; moved: string[] }>;
}

/** Turn one posted message into a trade action; every message is logged (Redis `fx:discord:log`). */
export async function handleSignal(redis: Redis, book: CopyBook, s: SignalIn, now = Date.now()): Promise<CopyLogRow> {
  const source = (s.source ?? 'kojiro').slice(0, 24);
  const strategy = copyStrategy(source);
  const elite = isEliteChannel(s.channel);
  const base = { t: now, id: s.id, source, text: s.text.slice(0, 300), ...(s.channel ? { channel: String(s.channel).slice(0, 25) } : {}), ...(elite ? { elite: true } : {}) };
  const done = async (row: CopyLogRow) => {
    await redis.multi().lpush(DISCORD_COPY.logKey, JSON.stringify(row)).ltrim(DISCORD_COPY.logKey, 0, DISCORD_COPY.logMax - 1).exec().catch(() => undefined);
    return row;
  };
  if (!DISCORD_COPY.on) return done({ ...base, kind: 'off', ok: false, what: 'copying is switched off (DISCORD_COPY=off)' });
  const first = await redis.set(`fx:discord:seen:${s.id}`, '1', 'EX', DISCORD_COPY.seenTtlSec, 'NX');
  if (first !== 'OK') return { ...base, kind: 'duplicate', ok: true, what: 'already handled' };
  if (s.other) return done({ ...base, kind: 'other', ok: true, what: `posted by ${(s.author ?? 'someone else').slice(0, 40)}, not him — logged, not copied` });
  await saveHistory(redis, [{ id: s.id, at: s.at, text: s.text }]).catch(() => 0); // v27.66: his record grows with every post
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
      await savePosted(redis, lv.pair, { levels: lv.levels, t: s.at, msgId: s.id, source, ...(lv.side ? { side: lv.side } : {}) });
      const which = lv.side === -1 ? 'SHORT levels (shorts only)' : lv.side === 1 ? 'LONG levels (longs only)' : 'levels';
      said.push(`${lv.pair} ${which} saved for today: ${lv.levels.map(fmt).join(' · ')}${POSTED_LEVELS.trade ? ' — the bot trades a bounce, a break-and-retest or a move toward them (live 1-minute candles)' : ' — lab only: the bot records what it would trade at them'}`);
    }
    return done({ ...base, kind: 'levels', pair: (lv ?? plan)!.pair, ok: true, what: said.join('; ') });
  }
  if (sig.kind === 'open') {
    const full = sig.conviction === 'full';
    if (full && sig.pair) await savePosted(redis, sig.pair, { bias: sig.side, dol: null, biasT: s.at, source }).catch(() => undefined);
    const eliteGo = elite && DISCORD_COPY.eliteLive;
    if (now - s.at > (full || eliteGo ? DISCORD_COPY.fullMaxAgeMs : DISCORD_COPY.maxAgeMs)) return done({ ...base, kind: 'old', pair: sig.pair, side: sig.side, hisPx: sig.price, ok: false, what: `posted ${Math.round((now - s.at) / 60_000)} min ago — too old to copy` });
    if (!sig.pair || !instrument(sig.pair)) return done({ ...base, kind: 'open', pair: null, side: sig.side, hisPx: sig.price, ok: false, what: `unknown market "${sig.symbol ?? '?'}"` });
    // v27.66: his own record decides — a kind of his calls that kept losing is skipped; the trailing stop is the one
    // that made the most on his past calls (kojiro-study.ts)
    const lv = (await loadLevels(redis, now))[sig.pair];
    const px = sig.price;
    const gate = kojiroGate(await loadCard(redis), {
      side: sig.side,
      session: sessionOf(s.at),
      bias: lv?.bias ? (lv.bias === sig.side ? 1 : -1) : 0,
      atLevel: px !== null && !!lv && levelSets(lv).some((st) => st.all.some((L) => Math.abs(L - px) <= (px * KSTUDY.levelPct) / 100)),
      stopNamed: sig.stop,
    });
    const fullGo = (full && DISCORD_COPY.fullLive) || eliteGo;
    if (!gate.take && !fullGo) return done({ ...base, kind: 'open', pair: sig.pair, side: sig.side, hisPx: sig.price, ok: false, what: `not copied — his record: ${gate.why}` });
    if (!DISCORD_COPY.live && !fullGo) return done({ ...base, kind: 'open', pair: sig.pair, side: sig.side, hisPx: sig.price, ok: false, what: `lab only — not traded (Kojiro calls are in the lab; his record keeps being graded): his ${sig.side === 1 ? 'LONG' : 'SHORT'} ${sig.pair}${sig.price ? ` @ ${sig.price}` : ''}` });
    const r = await book.copyOpen({ pair: sig.pair, side: sig.side, stopNamed: sig.stop, hisPx: sig.price, strategy, ref: copyRef(strategy, sig.pair, s.id), riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage, profitLock: gate.plan !== 'none', ...(gate.plan === 'tight' ? { copyLock: 'tight' as const } : {}), ...(eliteGo ? { priority: true } : {}) }, acctForPair(sig.pair));
    const tag = eliteGo ? `his ELITE-channel call${!gate.take ? ` — taken past his record (${gate.why})` : ''}: ` : full ? `his FULL-conviction call${sig.event ? ` (${sig.event})` : ''}${!gate.take ? ` — taken past his record (${gate.why})` : ''}: ` : '';
    const what = r.ok ? `${tag}copied ${sig.side === 1 ? 'LONG' : 'SHORT'} ${sig.pair} at ${r.entry} (his ${sig.price ?? 'market'}), safety stop ${r.stop}, risking $${r.riskUsd}` : `${tag}not copied: ${r.error}`;
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

/**
 * v27.94: his full-conviction calls the bot read before it knew them (logged "not a trade message" / "lab only" in the last
 * `withinMs`) are taken now, at the market — once each (`fx:discord:fullcatch:<id>` NX). Run after a deploy.
 */
export async function catchUpFullCalls(redis: Redis, book: CopyBook, now = Date.now(), withinMs = 4 * 3_600_000, final = true): Promise<string[]> {
  if (!DISCORD_COPY.on || (!DISCORD_COPY.fullLive && !DISCORD_COPY.eliteLive)) return [];
  const out: string[] = [];
  for (const row of (await copyLog(redis, DISCORD_COPY.logMax)).reverse()) {
    if (row.ok && row.kind === 'open') continue; // already copied
    if (now - row.t > withinMs || row.kind === 'other' || row.kind === 'duplicate') continue;
    const sig = parseSignal(row.text);
    // v28.3: an elite-channel call missed (lab only before, or no price then) is caught up like a full call
    const eliteRow = !!row.elite && DISCORD_COPY.eliteLive;
    if (sig.kind !== 'open' || !(eliteRow || (sig.conviction === 'full' && DISCORD_COPY.fullLive)) || !sig.pair || !instrument(sig.pair)) continue;
    if ((await redis.set(`fx:discord:fullcatch:${row.id}`, '1', 'EX', 7 * 86_400, 'NX')) !== 'OK') continue;
    const strategy = copyStrategy(row.source);
    await savePosted(redis, sig.pair, { bias: sig.side, dol: null, biasT: row.t, source: row.source }).catch(() => undefined);
    const r = await book.copyOpen({ pair: sig.pair, side: sig.side, stopNamed: sig.stop, hisPx: null, strategy, ref: copyRef(strategy, sig.pair, row.id), riskPct: DISCORD_COPY.riskPct, leverage: DISCORD_COPY.leverage, profitLock: DISCORD_COPY.profitLock, ...(eliteRow ? { priority: true } : {}) }, acctForPair(sig.pair));
    if (!r.ok && !final) {
      await redis.del(`fx:discord:fullcatch:${row.id}`).catch(() => 0); // e.g. no live price yet → the next try takes it
      continue;
    }
    const what = `his ${eliteRow ? 'ELITE-channel' : 'FULL-conviction'} call${sig.event ? ` (${sig.event})` : ''} posted ${Math.round((now - row.t) / 60_000)} min ago, missed then — ${r.ok ? `taken now: ${sig.side === 1 ? 'LONG' : 'SHORT'} ${sig.pair} at ${r.entry}, safety stop ${r.stop}, risking $${r.riskUsd}` : `still not taken: ${r.error}`}`;
    await redis.multi().lpush(DISCORD_COPY.logKey, JSON.stringify({ t: now, id: `${row.id}:catchup`, source: row.source, text: row.text, kind: 'open', pair: sig.pair, side: sig.side, hisPx: null, ok: r.ok, what, ...(row.channel ? { channel: row.channel } : {}), ...(row.elite ? { elite: true } : {}) } satisfies CopyLogRow)).ltrim(DISCORD_COPY.logKey, 0, DISCORD_COPY.logMax - 1).exec().catch(() => undefined);
    out.push(`Kojiro: ${what}`);
  }
  return out;
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

/** v27.65 (owner: "don't miss shit again"): the copier says it is alive every 2 minutes (it also re-reads his channels). */
export const COPIER_HB = { key: 'fx:discord:hb', alertKey: 'fx:discord:hbalert', staleMs: 15 * 60_000 };

export interface CopierBeat {
  t: number;
  channels: string[];
  sent: number;
}

export async function saveHeartbeat(redis: Redis, b: { channels?: unknown; sent?: unknown }, now = Date.now()): Promise<CopierBeat> {
  const beat: CopierBeat = { t: now, channels: Array.isArray(b.channels) ? b.channels.slice(0, 20).map((x) => String(x).slice(0, 25)) : [], sent: Number(b.sent) || 0 };
  await redis.set(COPIER_HB.key, JSON.stringify(beat), 'EX', 7 * 86_400);
  return beat;
}

export async function loadHeartbeat(redis: Redis): Promise<CopierBeat | null> {
  const raw = await redis.get(COPIER_HB.key).catch(() => null);
  try {
    return raw ? (JSON.parse(raw) as CopierBeat) : null;
  } catch {
    return null;
  }
}

/** Is the copier quiet for too long? null = it never reported (an older copier / not running yet). Pure. */
export function copierDown(beat: CopierBeat | null, now: number): boolean | null {
  return beat ? now - beat.t > COPIER_HB.staleMs : null;
}
