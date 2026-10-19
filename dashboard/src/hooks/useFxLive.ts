/**
 * v17.9 live forex prices (owner: "I want to see the price actively change"). The bot pushes the newest mid / bid /
 * ask of every currency pair that moved over the WebSocket ('fx'); gold and silver are never in it (they keep updating
 * by polling). v17.10 (owner: "way faster, less than a second"): the bot pushes every 200 ms (was 1 s) and components
 * re-render up to 10× a second (was 2×). One shared store for every page. (v17.11: the page's own Pyth backup stream
 * was removed — Pyth refuses requests without an API key since August 2026; the bot streams Yahoo's prices instead.)
 * Live P&L of a position = pnlUsd + (live exit price − px) × pnlPerPx, with the exit at the bid for a long and at the
 * ask for a short (what a close would get). Older servers send no 'fx' and no pnlPerPx: everything stays as polled.
 * Pure helpers are exported for tests.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBotEvents, type BotEvent } from './useWebSocket';

/** Newest live price of one pair. `at` = when this browser got it, `dir` = up / down vs the previous mid. */
export interface FxTick { mid: number; bid: number; ask: number; priceT: number; at: number; dir: 1 | -1 | 0 }
export interface FxLive { ticks: Record<string, FxTick>; /** last push that changed anything (client ms) */ at: number }

export const EMPTY_FX: FxLive = { ticks: {}, at: 0 };
/** a pair's price older than this is not used (the page falls back to the polled numbers) */
export const FRESH_MS = 15_000;
/** the LIVE badge shows while any pair moved this recently */
export const LIVE_MS = 10_000;
/** a live exit price this far (share) from the server's px is a feed mismatch, not a move: ignored */
const MAX_JUMP = 0.03;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Fold one 'fx' push into the store. Broken rows are skipped; an older price never replaces a newer one. Pure. */
export function applyFx(store: FxLive, data: unknown, now: number): FxLive {
  const px = data && typeof data === 'object' ? (data as { px?: unknown }).px : null;
  if (!px || typeof px !== 'object') return store;
  let ticks: Record<string, FxTick> | null = null;
  for (const [id, row] of Object.entries(px as Record<string, unknown>)) {
    if (!Array.isArray(row)) continue;
    const [mid, bid, ask, priceT] = row as unknown[];
    if (!num(mid) || !num(bid) || !num(ask) || !(mid > 0 && bid > 0 && ask >= bid)) continue;
    const t = num(priceT) ? priceT : now;
    const prev = (ticks ?? store.ticks)[id];
    if (prev && t < prev.priceT) continue;
    ticks ??= { ...store.ticks };
    ticks[id] = { mid, bid, ask, priceT: t, at: now, dir: !prev || mid === prev.mid ? 0 : mid > prev.mid ? 1 : -1 };
  }
  return ticks ? { ticks, at: now } : store;
}

/** A pair's live price, or null when there is none or it is older than `maxAgeMs`. Pure. */
export function liveOf(store: FxLive, pair: string, maxAgeMs = FRESH_MS, now = Date.now()): FxTick | null {
  const t = store.ticks[pair];
  return t && now - t.at <= maxAgeMs ? t : null;
}

/** True while any pair moved in the last 10 s (the LIVE badge). Pure. */
export function isLive(store: FxLive, now = Date.now()): boolean {
  return store.at > 0 && now - store.at <= LIVE_MS;
}

export interface LivePos { pair: string; side: 1 | -1; pnlUsd: number; px?: number; pnlPerPx?: number }

/** The live price a close would get (bid for a long, ask for a short), or null (none / stale / far off the server's px). Pure. */
export function liveExit(pos: Pick<LivePos, 'pair' | 'side' | 'px'>, store: FxLive, now = Date.now()): number | null {
  const t = liveOf(store, pos.pair, FRESH_MS, now);
  if (!t) return null;
  const x = pos.side === 1 ? t.bid : t.ask;
  return num(pos.px) && pos.px > 0 && Math.abs(x / pos.px - 1) > MAX_JUMP ? null : x;
}

/** Open P&L with the live price: pnlUsd + (live exit − px) × pnlPerPx; without pnlPerPx / a live price → pnlUsd. Pure. */
export function livePnl(pos: LivePos, store: FxLive, now = Date.now()): number {
  if (!num(pos.pnlUsd) || !num(pos.px) || !num(pos.pnlPerPx)) return pos.pnlUsd;
  const x = liveExit(pos, store, now);
  return x === null ? pos.pnlUsd : pos.pnlUsd + (x - pos.px) * pos.pnlPerPx;
}

/** The forming candle(s) built from live prices: [t, o, h, l, c] per candle bucket. */
export interface LiveBar { t: number; o: number; h: number; l: number; c: number }

/** Fold one live price into the forming candles (keeps this bucket and the one before it). Pure. */
export function foldTick(prev: LiveBar[], mid: number, tickT: number, barMs: number): LiveBar[] {
  if (!num(mid) || !num(tickT) || !(barMs > 0)) return prev;
  const t = Math.floor(tickT / barMs) * barMs;
  const last = prev[prev.length - 1];
  if (last && last.t === t) return [...prev.slice(0, -1), { t, o: last.o, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid }];
  if (last && last.t > t) return prev; // an older price: the candle it belongs to is already behind us
  return [...(last ? [last] : []), { t, o: mid, h: mid, l: mid, c: mid }].slice(-2);
}

/**
 * The polled candles with the live price on top (the candles stay the source of truth; each refresh replaces them):
 * newest candle = the live price's bucket → its high / low widen to the live ones and it closes at the live price;
 * newest candle = the bucket before → a new candle opens at that close; anything older (a feed that is behind) is left
 * alone, so a stale chart is never stretched. Pure.
 */
export function overlayLive(bars: number[][], live: LiveBar[], barMs: number): number[][] {
  const cur = live[live.length - 1];
  const newest = bars[bars.length - 1]?.[0];
  if (!cur || newest === undefined || (newest !== cur.t && newest !== cur.t - barMs)) return bars;
  let out = bars;
  for (const lb of live) {
    const last = out[out.length - 1];
    if (!last) break;
    const t = last[0]!;
    if (t === lb.t) out = [...out.slice(0, -1), [t, last[1]!, Math.max(last[2]!, lb.h), Math.min(last[3]!, lb.l), lb.c]];
    else if (t === lb.t - barMs) out = [...out, [lb.t, last[4]!, Math.max(last[4]!, lb.h), Math.min(last[4]!, lb.l), lb.c]];
  }
  return out;
}

// ---- the shared store (one per tab), fed by every component that uses it ----
let store: FxLive = EMPTY_FX; // every push
let shown: FxLive = EMPTY_FX; // what components render (≤ 10 a second)
let lastEvent: BotEvent | null = null;
let shownAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let freshSig = '';
const subs = new Set<() => void>();
export const RENDER_MS = 100;

const sigOf = (s: FxLive, now: number) => `${isLive(s, now) ? 1 : 0}:${Object.keys(s.ticks).filter((id) => liveOf(s, id, FRESH_MS, now)).join(',')}`;

function publish() {
  timer = null;
  shownAt = Date.now();
  shown = store;
  freshSig = sigOf(shown, shownAt);
  subs.forEach((f) => f());
}

function ingest(e: BotEvent) {
  // every subscribed component passes the same event object on: fold it once
  if (e.type !== 'fx' || e === lastEvent) return;
  lastEvent = e;
  const next = applyFx(store, e.data, Date.now());
  if (next === store) return;
  store = next;
  if (!timer) timer = setTimeout(publish, Math.max(0, shownAt + RENDER_MS - Date.now()));
}

function subscribe(f: () => void) {
  subs.add(f);
  // prices that stop arriving go stale with no push to say so: re-render when the fresh set changes
  ticker ??= setInterval(() => {
    const sig = sigOf(shown, Date.now());
    if (sig === freshSig) return;
    freshSig = sig;
    shown = { ...shown };
    subs.forEach((g) => g());
  }, 2_000);
  return () => {
    subs.delete(f);
    if (!subs.size && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** The live forex prices (re-renders at most ~10× a second; EMPTY until the first push). */
export function useFxLive(): FxLive {
  const onEvent = useCallback((e: BotEvent) => ingest(e), []);
  useBotEvents(onEvent);
  return useSyncExternalStore(subscribe, () => shown, () => EMPTY_FX);
}

/** prefers-reduced-motion, kept up to date. */
export function useReducedMotion(): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const q = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
    if (!q) return;
    const f = () => setOn(q.matches);
    q.addEventListener?.('change', f);
    return () => q.removeEventListener?.('change', f);
  }, []);
  return on;
}
