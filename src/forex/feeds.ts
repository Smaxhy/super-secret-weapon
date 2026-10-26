/**
 * v17 feed health. Every outside source the forex side reads (all free, no account) reports here: when it last worked,
 * how many times in a row it failed, the newest data it returned. A provider that fails 3 times in a row is paused
 * (2 → 4 → 8 → 16 → 30 min) so a hung service can't stall the hourly run; any success closes the breaker. Redis HASH
 * `fx:feeds` (saved at most every 30 s). `feedHealth` turns the raw states into the Setup card's table (pure).
 * v17: the breakers travel with the hourly run's child process (`breakerSnapshot` / `mergeBreakers`, newer update wins).
 */
import type Redis from 'ioredis';

export type Provider = 'yahoo' | 'yahoo-stream' | 'dukascopy' | 'pyth' | 'oanda' | 'cftc' | 'bis' | 'forexfactory' | 'rss' | 'coinbase' | 'coinbase-stream' | 'hyperliquid-stream' | 'internal';
export type FeedId = 'yahoo-1h' | 'yahoo-fast' | 'yahoo-quotes' | 'dk-history' | 'dk-quotes' | 'yahoo-live' | 'pyth-live' | 'coinbase-candles' | 'coinbase-live' | 'hyperliquid-live' | 'oanda' | 'cftc' | 'bis' | 'calendar' | 'headlines' | 'cb-press' | 'world-news' | 'lab' | 'fast-lab';

export interface FeedState {
  okAt: number | null;
  tryAt: number | null;
  fails: number;
  error: string | null;
  /** how many items the last good call returned */
  items: number | null;
  /** the newest data point it returned (a bar time, a report date) */
  asOf: number | null;
}

export interface FeedInfo {
  label: string;
  provider: Provider;
  /** minutes since the last success before it counts as stale / down */
  staleMin: number;
  downMin: number;
  /** only expected to work while forex is open */
  marketHours: boolean;
  affects: string;
  fallback: string | null;
}

export const FEED_INFO: Record<FeedId, FeedInfo> = {
  'yahoo-1h': { label: 'Hourly candles (Yahoo)', provider: 'yahoo', staleMin: 90, downMin: 180, marketHours: true, affects: 'hourly + 4-hour strategies, strength meter, bot entries on 1h / 4h', fallback: 'the stored candles (markets that fall behind get no new trades)' },
  'yahoo-fast': { label: '15-minute + 1-minute candles (Yahoo)', provider: 'yahoo', staleMin: 20, downMin: 60, marketHours: true, affects: '15m / 1m strategies and their bot trades', fallback: 'the stored candles (markets that fall behind get no new trades)' },
  'yahoo-quotes': { label: 'Live prices (Yahoo, 1-minute)', provider: 'yahoo', staleMin: 10, downMin: 30, marketHours: true, affects: 'opening / closing bot trades, stops and targets', fallback: 'the last price seen (no new trades on an old price; closes wait for a real price)' },
  'dk-history': { label: 'Older history + real spreads (Dukascopy)', provider: 'dukascopy', staleMin: 36 * 60, downMin: 7 * 24 * 60, marketHours: false, affects: 'years of extra test history, spread per hour of day', fallback: 'the stored history and spread profile' },
  'dk-quotes': { label: 'Backup live prices (Dukascopy, 1-minute)', provider: 'dukascopy', staleMin: 30, downMin: 180, marketHours: true, affects: 'currency-pair prices when Yahoo fails', fallback: 'the last price seen' },
  'yahoo-live': { label: 'Live ticking prices (Yahoo stream, currency pairs)', provider: 'yahoo-stream', staleMin: 5, downMin: 30, marketHours: true, affects: 'live prices on the dashboard, stops / targets checked every second, bot entries at the live price', fallback: 'Pyth (with an API key), else Yahoo 1-minute prices (checked every 15 s), then Dukascopy' },
  'coinbase-candles': { label: 'Coin candles (Coinbase Exchange, hourly + 15-minute)', provider: 'coinbase', staleMin: 90, downMin: 180, marketHours: false, affects: 'the coin lab and the coin bot (BTC, ETH, SOL…)', fallback: 'Yahoo spot candles (15-minute delayed, no bid / ask)' },
  'coinbase-live': { label: 'Live coin prices (Coinbase Exchange feed, real bid / ask)', provider: 'coinbase-stream', staleMin: 5, downMin: 30, marketHours: false, affects: 'coin bot fills, stops, targets, live P&L', fallback: 'the Yahoo stream, then Yahoo quotes' },
  'hyperliquid-live': { label: 'Live prices from Hyperliquid (coins backup + indices / metals)', provider: 'hyperliquid-stream', staleMin: 5, downMin: 30, marketHours: false, affects: 'coin prices when the Coinbase feed is quiet; live Nasdaq / S&P / Dow / Russell / gold / silver prices (moved onto the futures price) instead of Yahoo\'s 10-min-late ones', fallback: 'Coinbase, then the Yahoo stream' },
  'pyth-live': { label: 'Live ticking prices (Pyth, needs an API key since Aug 2026)', provider: 'pyth', staleMin: 5, downMin: 30, marketHours: true, affects: 'a second live price stream next to Yahoo\'s', fallback: 'the Yahoo stream' },
  oanda: { label: 'Live prices (OANDA, optional)', provider: 'oanda', staleMin: 5, downMin: 30, marketHours: true, affects: 'prices + candles when a token is saved', fallback: 'Yahoo' },
  cftc: { label: 'Hedge-fund positioning (CFTC, weekly)', provider: 'cftc', staleMin: 9 * 24 * 60, downMin: 17 * 24 * 60, marketHours: false, affects: 'crowd filter, cot_squeeze, a sniper vote', fallback: 'the last report for up to 17 days, then nothing (those rules go quiet)' },
  bis: { label: 'Central-bank rates (BIS, monthly)', provider: 'bis', staleMin: 45 * 24 * 60, downMin: 100 * 24 * 60, marketHours: false, affects: 'carry: carry_trend, a sniper vote', fallback: 'the last rates for up to 100 days, then nothing (carry rules go quiet)' },
  calendar: { label: 'News calendar (ForexFactory)', provider: 'forexfactory', staleMin: 6 * 60, downMin: 3 * 24 * 60, marketHours: false, affects: 'no bot trades around big news', fallback: 'waits out the usual US release times when the calendar is gone' },
  'cb-press': { label: 'Central-bank press releases (Fed, ECB, Bank of England)', provider: 'rss', staleMin: 7 * 24 * 60, downMin: 14 * 24 * 60, marketHours: false, affects: 'a policy statement / decision / minutes pauses that currency for 30 minutes', fallback: 'the news calendar + the other headlines' },
  'world-news': { label: 'World events (Al Jazeera, BBC, Guardian, MEE, France 24, DW, UN, OilPrice)', provider: 'rss', staleMin: 60, downMin: 360, marketHours: false, affects: 'war / oil / shipping / sanctions alarms pause new trades on the markets they move', fallback: 'the normal headline pause + the price-shock check' },
  headlines: { label: 'Live headlines (ForexLive, FXStreet)', provider: 'rss', staleMin: 30, downMin: 180, marketHours: true, affects: 'no bot trades right after a big headline', fallback: 'a stricter price-shock check' },
  lab: { label: 'Hourly test run', provider: 'internal', staleMin: 90, downMin: 180, marketHours: false, affects: 'every hourly decision of the bot', fallback: 'the last report; open trades keep their stops' },
  'fast-lab': { label: '15m / 1m test run', provider: 'internal', staleMin: 90, downMin: 180, marketHours: false, affects: 'which 15m / 1m strategies the bot trades', fallback: 'the last report' },
};

const BACKOFF_MIN = [2, 4, 8, 16, 30];
const OPEN_AFTER = 3;
export const FX_FEEDS = 'fx:feeds';

const empty = (): FeedState => ({ okAt: null, tryAt: null, fails: 0, error: null, items: null, asOf: null });

/** one provider's breaker: consecutive failures, when calls may start again, when it was last updated (v17) */
export interface BreakerState {
  fails: number;
  until: number;
  at: number;
}

export class FeedBook {
  private states = new Map<FeedId, FeedState>();
  /** per provider: consecutive failures and when calls may start again */
  private breaker = new Map<Provider, BreakerState>();
  private dirty = false;
  private savedAt = 0;
  constructor(private readonly clock: () => number = Date.now) {}

  get(id: FeedId): FeedState {
    return this.states.get(id) ?? empty();
  }
  ok(id: FeedId, info: { items?: number; asOf?: number | null } = {}): void {
    const now = this.clock();
    const s = { ...this.get(id), okAt: now, tryAt: now, fails: 0, error: null, ...(info.items !== undefined ? { items: info.items } : {}), ...(info.asOf !== undefined ? { asOf: info.asOf } : {}) };
    this.states.set(id, s);
    this.breaker.set(FEED_INFO[id].provider, { fails: 0, until: 0, at: now });
    this.dirty = true;
  }
  fail(id: FeedId, err: unknown): void {
    const now = this.clock();
    const msg = err instanceof Error ? err.message : String(err);
    const s = this.get(id);
    this.states.set(id, { ...s, tryAt: now, fails: s.fails + 1, error: msg.slice(0, 200) });
    const p = FEED_INFO[id].provider;
    const b = this.breaker.get(p) ?? { fails: 0, until: 0, at: 0 };
    const fails = b.fails + 1;
    const until = fails >= OPEN_AFTER ? now + BACKOFF_MIN[Math.min(BACKOFF_MIN.length - 1, fails - OPEN_AFTER)]! * 60_000 : 0;
    this.breaker.set(p, { fails, until, at: now });
    this.dirty = true;
  }
  /** false while the provider's breaker is open (calls would only waste the run's time) */
  allow(p: Provider): boolean {
    return this.clock() >= (this.breaker.get(p)?.until ?? 0);
  }
  /** when calls to a paused provider start again (null = not paused) */
  pausedUntil(p: Provider): number | null {
    const u = this.breaker.get(p)?.until ?? 0;
    return u > this.clock() ? u : null;
  }
  /** v17.2: take a child process's newer feed reports (per feed, the later attempt wins). */
  merge(snap: Partial<Record<FeedId, FeedState>>): void {
    for (const [k, v] of Object.entries(snap) as Array<[FeedId, FeedState]>) {
      if (!(k in FEED_INFO) || !v) continue;
      const mine = this.states.get(k);
      if (!mine || (v.tryAt ?? 0) > (mine.tryAt ?? 0)) {
        this.states.set(k, { ...empty(), ...v });
        this.dirty = true;
      }
    }
  }
  snapshot(): Partial<Record<FeedId, FeedState>> {
    return Object.fromEntries(this.states) as Partial<Record<FeedId, FeedState>>;
  }
  /** v17: the per-provider breakers (in memory only), for the other process of the hourly run */
  breakerSnapshot(): Partial<Record<Provider, BreakerState>> {
    return Object.fromEntries([...this.breaker].map(([p, b]) => [p, { ...b }])) as Partial<Record<Provider, BreakerState>>;
  }
  /**
   * v17: take the other process's breakers — per provider the later update wins (an open breaker the child hit pauses
   * the parent's quote / candle calls too, and the child starts with the parent's open ones).
   */
  mergeBreakers(snap: Partial<Record<Provider, BreakerState>> | null | undefined): void {
    for (const [p, v] of Object.entries(snap ?? {}) as Array<[Provider, BreakerState | undefined]>) {
      if (!v || !Number.isFinite(v.at) || !Number.isFinite(v.until) || !Number.isFinite(v.fails)) continue;
      const mine = this.breaker.get(p);
      if (!mine || v.at > mine.at) this.breaker.set(p, { fails: v.fails, until: v.until, at: v.at });
    }
  }
  async load(redis: Pick<Redis, 'hgetall'>): Promise<void> {
    const raw = await redis.hgetall(FX_FEEDS).catch(() => ({}) as Record<string, string>);
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (!(k in FEED_INFO)) continue;
      try {
        this.states.set(k as FeedId, { ...empty(), ...(JSON.parse(v) as Partial<FeedState>) });
      } catch {
        // skip a bad row
      }
    }
  }
  /** save at most every 30 s (`force` = now) */
  async persist(redis: Pick<Redis, 'hset'>, force = false): Promise<void> {
    const now = this.clock();
    if (!this.dirty || (!force && now - this.savedAt < 30_000)) return;
    this.dirty = false;
    this.savedAt = now;
    const flat: Record<string, string> = {};
    for (const [k, v] of this.states) flat[k] = JSON.stringify(v);
    if (Object.keys(flat).length) await redis.hset(FX_FEEDS, flat).catch(() => undefined);
  }
}

/** The one book every forex module reports to. */
export const feeds = new FeedBook();

export interface FeedHealth extends FeedState {
  id: FeedId;
  label: string;
  provider: Provider;
  status: 'ok' | 'stale' | 'down' | 'off' | 'closed' | 'never';
  /** minutes since the last success */
  ageMin: number | null;
  affects: string;
  fallback: string | null;
  pausedUntil: number | null;
}

/**
 * The feed table: ok / stale / down by the time since the last success; 'closed' for a market-hours feed while forex
 * is shut, 'off' for OANDA without a token / Pyth without an API key, 'never' for a feed that hasn't reported yet. Pure.
 */
export function feedHealth(states: Partial<Record<FeedId, FeedState>>, x: { now: number; open: boolean; oanda: boolean; pyth?: boolean; paused?: (p: Provider) => number | null }): FeedHealth[] {
  return (Object.keys(FEED_INFO) as FeedId[]).map((id) => {
    const info = FEED_INFO[id];
    const s = states[id] ?? empty();
    const ageMin = s.okAt === null ? null : Math.round((x.now - s.okAt) / 60_000);
    let status: FeedHealth['status'];
    if ((id === 'oanda' && !x.oanda) || (id === 'pyth-live' && !x.pyth)) status = 'off';
    else if (info.marketHours && !x.open) status = 'closed';
    else if (ageMin === null) status = s.fails ? 'down' : 'never';
    else status = ageMin >= info.downMin ? 'down' : ageMin >= info.staleMin || s.fails > 0 ? 'stale' : 'ok';
    return { id, ...s, label: info.label, provider: info.provider, status, ageMin, affects: info.affects, fallback: info.fallback, pausedUntil: x.paused?.(info.provider) ?? null };
  });
}
