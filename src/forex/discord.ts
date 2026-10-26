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
 * message names) and is sized so that stop loses `riskPct` of the account. It closes when he posts his exit — no target
 * and (by default) no profit lock, so it follows his exit, not ours. Paper only, like every trade here.
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
  /** the profit lock trails behind every bot trade; off here so the copy follows HIS exit */
  profitLock: process.env.DISCORD_COPY_LOCK === 'on',
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
  kind: ParsedSignal['kind'] | 'old' | 'duplicate' | 'off';
  pair?: string | null;
  side?: 1 | -1;
  hisPx?: number | null;
  ok: boolean;
  what: string;
}

/** What the practice account offers the copier (Practice implements it). */
export interface CopyBook {
  copyOpen(r: { pair: string; side: 1 | -1; stopNamed: number | null; hisPx: number | null; strategy: string; ref: string; riskPct: number; leverage: number; profitLock: boolean }, acct: 'bot' | 'cbot'): Promise<{ ok: boolean; error?: string; entry?: number; stop?: number; riskUsd?: number; marginUsd?: number }>;
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
  if (sig.kind === 'none') return done({ ...base, kind: 'none', ok: true, what: 'not a trade message' });
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
