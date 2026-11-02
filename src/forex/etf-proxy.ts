/**
 * v28.17 (owner: "fix the 10 min delay no matter what"): a live price for futures markets that have no live source.
 *
 * Yahoo's CME futures (RTY=F …) arrive ~10 minutes late (exchange licence) and Hyperliquid lists no Russell 2000 / Dow
 * market. The ETF that tracks the same index trades on US stock exchanges, and Yahoo serves US stock prices in real time
 * (incl. pre-market 04:00–09:30 and after-hours 16:00–20:00 New York): IWM for the Russell 2000, DIA for the Dow. The ETF
 * price × the futures ÷ ETF ratio (measured on the minutes both have, re-measured every 10 min, trusted for an hour) =
 * a live futures-equivalent price. Outside the ETF's hours (20:00–04:00 New York) there is no live price — the market
 * then gets no new bot trades (`BOT.liveOnly`), only Yahoo's late price for what is already open.
 *
 * Safety: the proxy is used only while Yahoo says the ETF itself is NOT delayed (`exchangeDataDelayedBy` 0) and its
 * newest minute is ≤ 2 minutes old; a ratio whose minutes disagree by more than 0.3% (wrong pairing, broken feed, a roll
 * inside the window) is refused.
 */
import type { Bar } from './types';
import { feeds } from './feeds';

export const ETF_PROXY: Readonly<Record<string, string>> = { RUTUSD: 'IWM', DJIUSD: 'DIA' };

export const PROXY = {
  /** the ETF's newest minute may be at most this old to count as live */
  freshMs: 2 * 60_000,
  /** REST answers are reused this long (the stream ticks in between) */
  cacheMs: 5_000,
  /** ratio: re-measured this often, trusted this long, at least this many shared minutes, minutes may disagree this much */
  refreshMs: 10 * 60_000,
  maxAgeMs: 60 * 60_000,
  minMatches: 10,
  maxDevPct: 0.3,
  /** an aggregated candle counts only with at least this share of its minutes (pre-market minutes can be thin) */
  minCover: 0.6,
};

/** One Yahoo 1-minute answer for an ETF, pre/post market included. */
export interface EtfMinutes {
  symbol: string;
  /** complete AND forming minutes, oldest first */
  bars: Bar[];
  /** newest price and its time */
  px: number;
  priceT: number;
  /** Yahoo's declared delay (0 = real time) */
  delayMs: number;
  at: number;
}

/** Parse Yahoo's 1-minute chart JSON (pre/post included). Pure. */
export function parseEtf(symbol: string, json: unknown, now: number): EtfMinutes | null {
  const r = (json as { chart?: { result?: Array<{ meta?: { exchangeDataDelayedBy?: number; regularMarketPrice?: number; regularMarketTime?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } }> } })?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const ts = r?.timestamp ?? [];
  if (!q) return null;
  const bars: Bar[] = [];
  for (let k = 0; k < ts.length; k++) {
    const o = q.open?.[k];
    const h = q.high?.[k];
    const l = q.low?.[k];
    const c = q.close?.[k];
    if (o == null || h == null || l == null || c == null || !(o > 0 && h > 0 && l > 0 && c > 0) || h < l) continue;
    const t = Math.floor((ts[k]! * 1000) / 60_000) * 60_000;
    const v = q.volume?.[k];
    bars.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, ...(v != null && v > 0 ? { v } : {}) });
  }
  const last = bars[bars.length - 1];
  const mt = r?.meta?.regularMarketTime ? r.meta.regularMarketTime * 1000 : 0;
  // the newest minute wins over the regular-session price (in pre / post market `regularMarketPrice` is the old close)
  const px = last && last.t + 60_000 >= mt ? last.c : (r?.meta?.regularMarketPrice ?? last?.c ?? 0);
  const priceT = last && last.t + 60_000 >= mt ? Math.min(now, last.t + 60_000) : mt;
  if (!(px > 0)) return null;
  return { symbol, bars, px, priceT, delayMs: Math.max(0, (r?.meta?.exchangeDataDelayedBy ?? 0) * 60_000), at: now };
}

/** Median futures ÷ ETF close over the minutes / candles both have (rows [t, close]), or null (too few / they disagree). Pure. */
export function measureRatio(fut: ReadonlyArray<readonly [number, number]>, etf: ReadonlyArray<readonly [number, number]>, bucketMs = 60_000): { ratio: number; n: number } | null {
  const by = new Map(etf.filter(([, c]) => c > 0).map(([t, c]) => [Math.floor(t / bucketMs), c]));
  const rs: number[] = [];
  for (const [t, c] of fut) {
    const e = by.get(Math.floor(t / bucketMs));
    if (e !== undefined && c > 0) rs.push(c / e);
  }
  if (rs.length < PROXY.minMatches) return null;
  rs.sort((a, b) => a - b);
  const m = rs.length >> 1;
  const ratio = rs.length % 2 ? rs[m]! : (rs[m - 1]! + rs[m]!) / 2;
  // the middle half of the minutes must sit within maxDevPct of the median (a wrong pairing / a roll in the window fails)
  const q1 = rs[Math.floor(rs.length * 0.25)]!;
  const q3 = rs[Math.floor(rs.length * 0.75)]!;
  if (!(ratio > 0) || ((q3 - q1) / ratio) * 100 > PROXY.maxDevPct) return null;
  return { ratio, n: rs.length };
}

/** 1-minute bars → candles of `barMs` on its own grid; only candles holding ≥ `minCover` of their minutes. Pure. */
export function aggregate(bars: readonly Bar[], barMs: number, minCover = PROXY.minCover): Bar[] {
  const groups = new Map<number, Bar[]>();
  for (const b of bars) {
    const k = Math.floor(b.t / barMs) * barMs;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(b);
  }
  const need = Math.max(1, Math.ceil((barMs / 60_000) * minCover));
  const out: Bar[] = [];
  for (const [t, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (g.length < need) continue;
    const vol = g.reduce((s, b) => s + (b.v ?? 0), 0);
    out.push({ t, o: g[0]!.o, h: Math.max(...g.map((b) => b.h)), l: Math.min(...g.map((b) => b.l)), c: g[g.length - 1]!.c, ...(vol > 0 ? { v: vol } : {}) });
  }
  return out;
}

/** Bars × a ratio. Pure. */
export const scaleBars = (bars: readonly Bar[], r: number): Bar[] => bars.map((b) => ({ t: b.t, o: b.o * r, h: b.h * r, l: b.l * r, c: b.c * r, ...(b.v ? { v: b.v } : {}) }));

/**
 * The ETF's candles at `barMs`, moved onto the futures price: the ratio is measured on the futures candles both have
 * (`fut`, Yahoo's late ones are fine — they are history by then). [] when the ETF is delayed, too thin or the ratio fails.
 * Feed into `extendWithLive` (which measures the small gap left and adds only finished candles). Pure.
 */
export function etfAsFutures(m: EtfMinutes | null, fut: readonly Bar[], barMs: number): Bar[] {
  if (!m || m.delayMs > 0 || !m.bars.length) return [];
  const agg = barMs === 60_000 ? m.bars : aggregate(m.bars, barMs);
  const r = measureRatio(fut.map((b) => [b.t, b.c] as const), agg.map((b) => [b.t, b.c] as const), barMs);
  return r ? scaleBars(agg, r.ratio) : [];
}

const cache = new Map<string, EtfMinutes>();
const inflight = new Map<string, Promise<EtfMinutes | null>>();

export type EtfFetch = (url: string) => Promise<unknown>;
const realFetch: EtfFetch = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** The ETF's 1-minute bars (pre/post market included), cached `PROXY.cacheMs`; null on failure. */
export async function etfMinutes(symbol: string, now = Date.now(), range = '5d', get: EtfFetch = realFetch): Promise<EtfMinutes | null> {
  const key = `${symbol}:${range}`;
  const c = cache.get(key);
  if (c && now - c.at < PROXY.cacheMs) return c;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (!feeds.allow('yahoo-etf')) return c ?? null;
  const p = (async () => {
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const m = parseEtf(symbol, await get(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=${range}&includePrePost=true`), now);
        if (m) {
          cache.set(key, m);
          feeds.ok('etf-proxy', { items: m.bars.length, asOf: m.priceT });
          return m;
        }
      } catch {
        // next host
      }
    }
    feeds.fail('etf-proxy', `no ${symbol} minutes from Yahoo`);
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Is the ETF answer usable as a LIVE price right now? Pure. */
export const etfLive = (m: EtfMinutes | null, now: number): m is EtfMinutes => !!m && m.delayMs === 0 && now - m.priceT <= PROXY.freshMs;

/** For tests. */
export function clearEtfCache(): void {
  cache.clear();
  inflight.clear();
}
