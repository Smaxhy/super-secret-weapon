/**
 * v17.9 live prices from Pyth (Hermes, free, no account): the aggregated FX prices many on-chain venues settle on,
 * streamed over server-sent events (an update about every 400 ms while forex is open). Currency pairs only — the lab
 * tests gold / silver on Yahoo's COMEX futures, and Pyth's metals are spot (a $10–30 gap would hit stops that were
 * never hit). Feed ids are looked up by symbol once a day (`/v2/price_feeds`): a pair Pyth doesn't list directly is
 * taken from its inverse or built from the two USD legs (EUR/JPY = EUR/USD × USD/JPY). Keeps the newest price per
 * feed, builds 1-minute candles per pair from the ticks (so stop / target checks see the highs and lows between
 * checks), reconnects with back-off, and reports to the feed book ('pyth-live').
 * v17.11: since August 2026 Hermes refuses requests without a Pyth API key (401), so this stream only starts with a
 * key (sent as `Authorization: Bearer …`). v17.12: the key is pasted on the dashboard (Setup → "Pyth live prices",
 * tested first, stored in this server's DB as BotConfig `_pyth` {key, base}, never in git) or set as `PYTH_API_KEY`
 * in the VPS .env; the endpoint is the upgraded Hermes `https://pyth.dourolabs.app/hermes` (the old
 * `hermes.pyth.network` is tried too; `PYTH_HERMES_URL` overrides). Without a key the live prices come from Yahoo's
 * streamer (yahoo-live.ts).
 */
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { feeds } from './feeds';
import { INSTRUMENTS, type Instrument } from './types';

const log = moduleLogger('forex-pyth');

/** fixed settings */
export const PYTH = {
  /** where a key is tried, in order (the upgraded Hermes first) */
  bases: [...new Set([process.env.PYTH_HERMES_URL, 'https://pyth.dourolabs.app/hermes', 'https://hermes.pyth.network'].filter((x): x is string => !!x).map((x) => x.replace(/\/+$/, '')))],
  /** a composed price older than this is not live (falls back to Yahoo) */
  staleMs: 15_000,
  /** no bytes at all (Hermes sends keep-alive comments) for this long → reconnect */
  watchdogMs: 60_000,
  /** back-off between reconnects */
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  /** feed ids looked up again after this long */
  resolveEveryMs: 24 * 3_600_000,
  /** 1-minute candles kept per pair */
  keepBars: 180,
};

/** the key in use + where it worked: the dashboard's (DB) first, else the VPS .env's */
const conf: { key: string; base: string; source: 'dashboard' | 'env' | null } = { key: (process.env.PYTH_API_KEY ?? '').trim(), base: PYTH.bases[0]!, source: process.env.PYTH_API_KEY?.trim() ? 'env' : null };
/** the Pyth API key ('' = none: the stream stays off) */
export const pythKey = (): string => conf.key;
export const pythConf = (): Readonly<typeof conf> => conf;
/** v17.12: the key from the dashboard (null = back to the .env one, if any) */
export function setPythConf(c: { key: string; base: string } | null): void {
  const env = (process.env.PYTH_API_KEY ?? '').trim();
  if (c?.key) Object.assign(conf, { key: c.key, base: c.base.replace(/\/+$/, ''), source: 'dashboard' as const });
  else Object.assign(conf, { key: env, base: PYTH.bases[0]!, source: env ? ('env' as const) : null });
}
const auth = (): Record<string, string> => (conf.key ? { authorization: `Bearer ${conf.key}` } : {});

/** v17.12: the dashboard's key lives in this server's DB only (BotConfig row, never in git, masked on read) */
export const PYTH_ROW = '_pyth';
export async function loadPythConf(): Promise<void> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: PYTH_ROW } });
    const v = (row?.value ?? null) as { key?: string; base?: string } | null;
    if (v?.key && v.base) setPythConf({ key: v.key, base: v.base });
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'pyth key not loaded');
  }
}
export async function savePythConf(c: { key: string; base: string } | null): Promise<void> {
  const value = c ? { key: c.key, base: c.base, updatedAt: new Date().toISOString() } : { updatedAt: new Date().toISOString() };
  await prisma.botConfig.upsert({ where: { key: PYTH_ROW }, update: { value }, create: { key: PYTH_ROW, value } });
  setPythConf(c);
}

/** v17.12: try a key on each endpoint (the feed list must answer with currency pairs); the first that works. */
export async function testPythKey(key: string, fetcher: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = fetch as never): Promise<{ ok: true; base: string; pairs: number } | { ok: false; error: string }> {
  const errs: string[] = [];
  for (const base of PYTH.bases) {
    try {
      const res = await fetcher(`${base}/v2/price_feeds?asset_type=fx`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', authorization: `Bearer ${key}` } });
      if (!res.ok) {
        errs.push(`${new URL(base).host}: ${res.status === 401 ? '401 (no key accepted)' : res.status === 403 ? '403 (key not allowed)' : `HTTP ${res.status}`}`);
        continue;
      }
      const j = await res.json();
      const pairs = Object.keys(planFeeds(Array.isArray(j) ? (j as PythMeta[]) : [])).length;
      if (pairs) return { ok: true, base, pairs };
      errs.push(`${new URL(base).host}: no currency pairs in the answer`);
    } catch (err) {
      errs.push(`${(() => { try { return new URL(base).host; } catch { return base; } })()}: ${(err as Error).message}`);
    }
  }
  return { ok: false, error: errs.join('; ') };
}

export interface PythMeta {
  id: string;
  attributes: Record<string, string>;
}
/** one leg of a pair's price: a Pyth feed, maybe inverted */
export interface Leg {
  id: string;
  inv: boolean;
}

const clean = (id: string) => id.replace(/^0x/, '').toLowerCase();

/** "BASE/QUOTE" of a feed (attributes base + quote_currency, else the symbol after its "FX." / "Metal." prefix). Pure. */
export function pairKey(m: PythMeta): string | null {
  const a = m.attributes ?? {};
  if (a.base && a.quote_currency) return `${a.base.toUpperCase()}/${a.quote_currency.toUpperCase()}`;
  const sym = a.symbol ?? '';
  const body = sym.includes('.') ? sym.slice(sym.indexOf('.') + 1) : sym;
  const [b, q] = body.split('/');
  return b && q && /^[A-Z]{3}$/i.test(b) && /^[A-Z]{3}$/i.test(q) ? `${b.toUpperCase()}/${q.toUpperCase()}` : null;
}

/**
 * The legs for each currency pair: the pair itself, its inverse, or base/USD × USD/quote. Metals and pairs Pyth can't
 * make are left out. Pure.
 */
export function planFeeds(metas: readonly PythMeta[], insts: readonly Pick<Instrument, 'id' | 'kind'>[] = INSTRUMENTS): Record<string, Leg[]> {
  const byKey = new Map<string, string>();
  for (const m of metas) {
    const k = pairKey(m);
    const type = (m.attributes?.asset_type ?? '').toLowerCase();
    if (k && (type === '' || type === 'fx') && !byKey.has(k)) byKey.set(k, clean(m.id));
  }
  const leg = (b: string, q: string): Leg | null => {
    const d = byKey.get(`${b}/${q}`);
    if (d) return { id: d, inv: false };
    const r = byKey.get(`${q}/${b}`);
    return r ? { id: r, inv: true } : null;
  };
  const out: Record<string, Leg[]> = {};
  for (const inst of insts) {
    if (inst.kind !== 'fx' || inst.id.length !== 6) continue;
    const b = inst.id.slice(0, 3);
    const q = inst.id.slice(3);
    const direct = leg(b, q);
    if (direct) {
      out[inst.id] = [direct];
      continue;
    }
    if (b === 'USD' || q === 'USD') continue;
    const l1 = leg(b, 'USD');
    const l2 = leg('USD', q);
    if (l1 && l2) out[inst.id] = [l1, l2];
  }
  return out;
}

export interface FeedPrice {
  px: number;
  conf: number;
  /** publish time (ms) */
  t: number;
}

/** A pair's price from its legs (oldest leg's time; null if a leg is missing or not positive). Pure. */
export function compose(legs: readonly Leg[], latest: ReadonlyMap<string, FeedPrice>): FeedPrice | null {
  let px = 1;
  let relConf = 0;
  let t = Infinity;
  for (const l of legs) {
    const p = latest.get(l.id);
    if (!p || !(p.px > 0)) return null;
    px *= l.inv ? 1 / p.px : p.px;
    relConf += p.conf / p.px;
    t = Math.min(t, p.t);
  }
  return legs.length ? { px, conf: px * relConf, t } : null;
}

/** One parsed Hermes price row → our price (price × 10^expo). Pure. */
export function parsePrice(row: { id?: string; price?: { price?: string | number; conf?: string | number; expo?: number; publish_time?: number } }): { id: string; p: FeedPrice } | null {
  const pr = row?.price;
  if (!row?.id || !pr || pr.price === undefined || pr.expo === undefined || !pr.publish_time) return null;
  const scale = 10 ** pr.expo;
  const px = Number(pr.price) * scale;
  const conf = Number(pr.conf ?? 0) * scale;
  if (!Number.isFinite(px) || !(px > 0)) return null;
  return { id: clean(row.id), p: { px, conf: Number.isFinite(conf) ? conf : 0, t: pr.publish_time * 1000 } };
}

/** Splits a server-sent-events byte stream into events ({event, data}); keep-alive comments count as activity. */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private event = 'message';
  push(chunk: string, onEvent: (e: { event: string; data: string }) => void): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) onEvent({ event: this.event, data: this.data.join('\n') });
        this.data = [];
        this.event = 'message';
      } else if (line.startsWith(':')) {
        // keep-alive comment
      } else {
        const k = line.indexOf(':');
        const field = k < 0 ? line : line.slice(0, k);
        const value = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '');
        if (field === 'data') this.data.push(value);
        else if (field === 'event') this.event = value;
      }
    }
  }
}

/** [t, h, l, c, o] — the shape the practice account's stop / target checks read */
export type MinuteBar = [number, number, number, number, number];

/** Fold one price into a pair's 1-minute candles (a tick older than the newest candle's minute is ignored). Pure. */
export function addTick(bars: MinuteBar[], t: number, px: number, keep = PYTH.keepBars): MinuteBar[] {
  const m = Math.floor(t / 60_000) * 60_000;
  const last = bars[bars.length - 1];
  if (last && m < last[0]) return bars;
  if (last && m === last[0]) {
    last[1] = Math.max(last[1], px);
    last[2] = Math.min(last[2], px);
    last[3] = px;
    return bars;
  }
  bars.push([m, px, px, px, px]);
  if (bars.length > keep) bars.splice(0, bars.length - keep);
  return bars;
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body: ReadableStream<Uint8Array> | null }>;

export interface LiveTick {
  id: string;
  mid: number;
  conf: number;
  t: number;
}

/** The live stream. `get(id)` = the newest composed price of a currency pair (null when not live). */
export class PythLive {
  readonly name = 'pyth';
  private plans: Record<string, Leg[]> = {};
  private byFeed = new Map<string, string[]>();
  private latest = new Map<string, FeedPrice>();
  private bars = new Map<string, MinuteBar[]>();
  private listeners = new Set<(ticks: LiveTick[]) => void>();
  private abort: AbortController | null = null;
  private stopped = true;
  /** v17.12: each start runs its own loop; an older loop (before a restart) ends at its next turn */
  private gen = 0;
  private fails = 0;
  private resolvedAt = 0;
  private lastByteAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  /** updates applied since start (for the feed card) */
  updates = 0;
  /** when the last price arrived (ms, this process's clock) */
  lastTickAt = 0;

  constructor(private readonly fetcher: Fetch = fetch as unknown as Fetch, private readonly clock: () => number = Date.now) {}

  /** pairs this stream covers */
  get pairs(): string[] {
    return Object.keys(this.plans);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop(++this.gen);
    this.watchdog = setInterval(() => {
      if (this.abort && this.clock() - this.lastByteAt > PYTH.watchdogMs) {
        log.warn('pyth stream silent — reconnecting');
        this.abort.abort();
      }
    }, 15_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.abort?.abort();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** called with each batch of updated pairs */
  onTicks(fn: (ticks: LiveTick[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** the newest live price of a pair (null when unknown or older than `PYTH.staleMs`) */
  get(id: string, now = this.clock()): (FeedPrice & { bars: MinuteBar[] }) | null {
    const legs = this.plans[id];
    if (!legs) return null;
    const p = compose(legs, this.latest);
    if (!p || now - p.t > PYTH.staleMs) return null;
    return { ...p, bars: (this.bars.get(id) ?? []).map((b) => [...b] as MinuteBar) };
  }

  /** prices arrived in the last 10 s (the practice account checks stops every second then) */
  flowing(now = this.clock()): boolean {
    return now - this.lastTickAt < 10_000;
  }

  /** feed ids by symbol (also used by tests) */
  async resolve(): Promise<void> {
    const metas: PythMeta[] = [];
    const res = await this.fetcher(`${conf.base}/v2/price_feeds?asset_type=fx`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', ...auth() } });
    if (!res.ok) throw new Error(`price_feeds HTTP ${res.status}`);
    const j = (await res.json()) as PythMeta[];
    if (Array.isArray(j)) metas.push(...j);
    const plans = planFeeds(metas);
    if (!Object.keys(plans).length) throw new Error('no currency pairs found in the Pyth feed list');
    this.plans = plans;
    this.byFeed.clear();
    for (const [id, legs] of Object.entries(plans)) for (const l of legs) (this.byFeed.get(l.id) ?? this.byFeed.set(l.id, []).get(l.id)!).push(id);
    this.resolvedAt = this.clock();
    log.info({ pairs: Object.keys(plans).length, feeds: this.byFeed.size }, 'pyth feeds resolved');
  }

  /** apply one Hermes update (exported for tests) */
  apply(data: string): void {
    let j: { parsed?: Array<Parameters<typeof parsePrice>[0]> };
    try {
      j = JSON.parse(data) as typeof j;
    } catch {
      return;
    }
    const touched = new Set<string>();
    for (const row of j.parsed ?? []) {
      const r = parsePrice(row);
      if (!r) continue;
      const prev = this.latest.get(r.id);
      if (prev && prev.t > r.p.t) continue;
      this.latest.set(r.id, r.p);
      for (const pair of this.byFeed.get(r.id) ?? []) touched.add(pair);
    }
    const ticks: LiveTick[] = [];
    for (const id of touched) {
      const p = compose(this.plans[id]!, this.latest);
      if (!p) continue;
      addTick(this.bars.get(id) ?? this.bars.set(id, []).get(id)!, p.t, p.px);
      ticks.push({ id, mid: p.px, conf: p.conf, t: p.t });
    }
    if (!ticks.length) return;
    this.updates++;
    this.lastTickAt = this.clock();
    for (const fn of this.listeners) {
      try {
        fn(ticks);
      } catch {
        // a broken listener must not stop the stream
      }
    }
  }

  /** v17.12: start again with the current key / endpoint (feeds looked up again) */
  restart(): void {
    this.stop();
    this.resolvedAt = 0;
    this.plans = {};
    this.fails = 0;
    if (conf.key) this.start();
  }

  private async loop(gen: number): Promise<void> {
    const live = () => !this.stopped && gen === this.gen;
    while (live()) {
      try {
        if (!this.pairs.length || this.clock() - this.resolvedAt > PYTH.resolveEveryMs) await this.resolve();
        if (!live()) break;
        await this.stream();
        this.fails = 0;
      } catch (err) {
        if (!live()) break;
        this.fails++;
        feeds.fail('pyth-live', err);
        log.warn({ err: (err as Error).message, fails: this.fails }, 'pyth stream failed');
      }
      if (!live()) break;
      const wait = PYTH.backoffMs[Math.min(PYTH.backoffMs.length - 1, Math.max(0, this.fails - 1))]!;
      await new Promise((r) => setTimeout(r, this.fails ? wait : 1_000));
    }
  }

  /** one connection; returns when the server ends it (it does after 24 h), throws on errors */
  private async stream(): Promise<void> {
    const ids = [...this.byFeed.keys()];
    const qs = ids.map((id) => `ids[]=${id}`).join('&');
    this.abort = new AbortController();
    this.lastByteAt = this.clock();
    const res = await this.fetcher(`${conf.base}/v2/updates/price/stream?${qs}&parsed=true&ignore_invalid_price_ids=true`, { signal: this.abort.signal, headers: { accept: 'text/event-stream', ...auth() } });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
    const parser = new SseParser();
    const dec = new TextDecoder();
    const reader = res.body.getReader();
    let errorText: string | null = null;
    let got = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastByteAt = this.clock();
        parser.push(dec.decode(value, { stream: true }), (e) => {
          if (e.event === 'error') {
            errorText = e.data;
            return;
          }
          const before = this.updates;
          this.apply(e.data);
          if (this.updates > before && (!got || this.updates % 60 === 0)) {
            got = true;
            feeds.ok('pyth-live', { items: this.pairs.length, asOf: this.clock() });
          }
        });
        if (errorText) throw new Error(`stream error: ${String(errorText).slice(0, 120)}`);
      }
    } catch (err) {
      if (this.stopped) return;
      if ((err as Error).name === 'AbortError') throw new Error('stream silent for a minute');
      throw err;
    } finally {
      this.abort = null;
      reader.releaseLock?.();
    }
  }
}

/** The one stream the forex side uses. */
export const pythLive = new PythLive();
