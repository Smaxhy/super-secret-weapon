/**
 * v17.10 backup live prices straight from Pyth in the browser (owner: "the chart changes but the price doesn't, I need
 * it way faster, less than a second"). The bot normally pushes its Pyth prices over the WebSocket several times a
 * second; when that push goes quiet (the bot's stream is down, an older server, a socket hiccup) this opens the same
 * Hermes stream from the page itself (Hermes allows any origin) and feeds the same price store, so the numbers keep
 * ticking. It closes again once the bot's own push has been steady for a while, and whenever the page is hidden —
 * every Hermes message also carries a signed binary blob (several KB), too heavy to keep running on a phone for
 * nothing. Currency pairs only (gold / silver are COMEX futures in the bot, Pyth's are spot). The same feed plan as the
 * bot (src/forex/pyth.ts): a pair Pyth doesn't list is its inverse or the two USD legs multiplied; bid / ask use the
 * spread the bot last sent for that pair, else the typical retail spread. Pure helpers are exported for tests.
 */

export const HERMES = 'https://hermes.pyth.network';
/** the bot's push counts as quiet after this long without one (it pushes every 200 ms while anything moves) */
export const BOT_QUIET_MS = 4_000;
/** the backup closes once the bot's push has been steady this long */
export const BOT_STEADY_MS = 20_000;
/** the feed plan is looked up again after this long */
const PLAN_TTL_MS = 24 * 3_600_000;
const PLAN_KEY = 'fx.pyth.plan';
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** the currency pairs the bot trades: pip size + typical retail spread in pips (src/forex/types.ts) */
export const FX_PAIRS: Record<string, { pip: number; spreadPips: number }> = {
  EURUSD: { pip: 0.0001, spreadPips: 0.8 },
  GBPUSD: { pip: 0.0001, spreadPips: 1.2 },
  USDJPY: { pip: 0.01, spreadPips: 1.0 },
  AUDUSD: { pip: 0.0001, spreadPips: 1.0 },
  USDCAD: { pip: 0.0001, spreadPips: 1.5 },
  USDCHF: { pip: 0.0001, spreadPips: 1.5 },
  NZDUSD: { pip: 0.0001, spreadPips: 1.5 },
  EURJPY: { pip: 0.01, spreadPips: 1.5 },
  GBPJPY: { pip: 0.01, spreadPips: 2.5 },
  EURGBP: { pip: 0.0001, spreadPips: 1.2 },
  AUDNZD: { pip: 0.0001, spreadPips: 2.5 },
  EURCHF: { pip: 0.0001, spreadPips: 1.8 },
};

export interface PythMeta { id: string; attributes?: Record<string, string> }
export interface Leg { id: string; inv: boolean }
export interface FeedPrice { px: number; t: number }

const clean = (id: string) => id.replace(/^0x/, '').toLowerCase();

/** "BASE/QUOTE" of a feed (attributes base + quote_currency, else the symbol after its prefix). Pure. */
export function pairKey(m: PythMeta): string | null {
  const a = m.attributes ?? {};
  if (a.base && a.quote_currency) return `${a.base.toUpperCase()}/${a.quote_currency.toUpperCase()}`;
  const sym = a.symbol ?? '';
  const body = sym.includes('.') ? sym.slice(sym.indexOf('.') + 1) : sym;
  const [b, q] = body.split('/');
  return b && q && /^[A-Z]{3}$/i.test(b) && /^[A-Z]{3}$/i.test(q) ? `${b.toUpperCase()}/${q.toUpperCase()}` : null;
}

/** The legs per pair: direct, inverse, or base/USD × USD/quote; pairs Pyth can't make are left out. Pure. */
export function planFeeds(metas: readonly PythMeta[], pairs: readonly string[] = Object.keys(FX_PAIRS)): Record<string, Leg[]> {
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
  for (const id of pairs) {
    const b = id.slice(0, 3);
    const q = id.slice(3);
    const direct = leg(b, q);
    if (direct) {
      out[id] = [direct];
      continue;
    }
    if (b === 'USD' || q === 'USD') continue;
    const l1 = leg(b, 'USD');
    const l2 = leg('USD', q);
    if (l1 && l2) out[id] = [l1, l2];
  }
  return out;
}

/** A pair's price from its legs (time = the oldest leg's; null when a leg is missing). Pure. */
export function compose(legs: readonly Leg[], latest: ReadonlyMap<string, FeedPrice>): FeedPrice | null {
  let px = 1;
  let t = Infinity;
  for (const l of legs) {
    const p = latest.get(l.id);
    if (!p || !(p.px > 0)) return null;
    px *= l.inv ? 1 / p.px : p.px;
    t = Math.min(t, p.t);
  }
  return legs.length ? { px, t } : null;
}

type Row = [number, number, number, number];
const sig = (x: number) => Number(x.toPrecision(8));

/**
 * One Hermes message → the pairs it moved as push rows [mid, bid, ask, priceT] (the bot's 'fx' shape). `latest` is
 * updated in place (an older publish time never replaces a newer one); `half(pair)` = half the spread. Pure apart from
 * `latest`.
 */
export function applyHermes(data: string, plans: Record<string, Leg[]>, latest: Map<string, FeedPrice>, half: (pair: string) => number): Record<string, Row> {
  let j: { parsed?: Array<{ id?: string; price?: { price?: string | number; expo?: number; publish_time?: number } }> };
  try {
    j = JSON.parse(data) as typeof j;
  } catch {
    return {};
  }
  const moved = new Set<string>();
  for (const row of j.parsed ?? []) {
    const pr = row?.price;
    if (!row?.id || !pr || pr.price === undefined || pr.expo === undefined || !pr.publish_time) continue;
    const px = Number(pr.price) * 10 ** pr.expo;
    if (!Number.isFinite(px) || !(px > 0)) continue;
    const id = clean(row.id);
    const prev = latest.get(id);
    const t = pr.publish_time * 1000;
    if (prev && prev.t > t) continue;
    latest.set(id, { px, t });
    moved.add(id);
  }
  const out: Record<string, Row> = {};
  if (!moved.size) return out;
  for (const [pair, legs] of Object.entries(plans)) {
    if (!legs.some((l) => moved.has(l.id))) continue;
    const p = compose(legs, latest);
    if (!p) continue;
    const h = half(pair);
    out[pair] = [sig(p.px), sig(p.px - h), sig(p.px + h), p.t];
  }
  return out;
}

/** The typical half-spread of a pair (price units). Pure. */
export const typicalHalf = (pair: string): number => {
  const p = FX_PAIRS[pair];
  return p ? (p.spreadPips * p.pip) / 2 : 0;
};

/**
 * Should the backup stream run now? Only while someone watches prices and the page is visible; on when the bot's push
 * has been quiet for BOT_QUIET_MS (or never came), off again once it has been steady for BOT_STEADY_MS. Pure.
 */
export function wantDirect(s: { watchers: number; visible: boolean; running: boolean; botLastAt: number; botSteadySince: number; now: number }): boolean {
  if (!s.watchers || !s.visible) return false;
  const quiet = !s.botLastAt || s.now - s.botLastAt > BOT_QUIET_MS;
  if (quiet) return true;
  // bot pushing: keep the backup a little while to be sure it stays
  return s.running && s.now - s.botSteadySince < BOT_STEADY_MS;
}

/** What the backup needs from its surroundings (tests pass fakes). */
export interface DirectEnv {
  fetchJson(url: string): Promise<unknown>;
  openStream(url: string, on: { message(data: string): void; failed(): void }): { close(): void };
  now(): number;
  load(key: string): string | null;
  save(key: string, value: string): void;
}

/** The backup stream: `sync()` decides start / stop; `onPx` gets each batch of moved pairs. */
export class PythDirect {
  private plans: Record<string, Leg[]> | null = null;
  private latest = new Map<string, FeedPrice>();
  private stream: { close(): void } | null = null;
  private starting = false;
  private fails = 0;
  private retryAt = 0;
  private want = false;
  /** updates applied (for the badge / tests) */
  updates = 0;
  lastAt = 0;

  constructor(private readonly env: DirectEnv, private readonly onPx: (px: Record<string, Row>) => void, private readonly half: (pair: string) => number = typicalHalf) {}

  get running(): boolean {
    return !!this.stream || this.starting;
  }

  /** start or stop to match `want` (retries after a failure with back-off) */
  sync(want: boolean): void {
    this.want = want;
    if (!want) return this.stop();
    if (this.running || this.env.now() < this.retryAt) return;
    this.starting = true;
    void this.open().finally(() => (this.starting = false));
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
  }

  private failed(): void {
    this.stream?.close();
    this.stream = null;
    this.retryAt = this.env.now() + RETRY_MS[Math.min(RETRY_MS.length - 1, this.fails++)]!;
  }

  private async loadPlans(): Promise<Record<string, Leg[]>> {
    if (this.plans) return this.plans;
    try {
      const c = JSON.parse(this.env.load(PLAN_KEY) ?? 'null') as { at: number; plans: Record<string, Leg[]> } | null;
      if (c && this.env.now() - c.at < PLAN_TTL_MS && c.plans && Object.keys(c.plans).length) return (this.plans = c.plans);
    } catch {
      // no / broken cache
    }
    const metas = await this.env.fetchJson(`${HERMES}/v2/price_feeds?asset_type=fx`);
    const plans = planFeeds(Array.isArray(metas) ? (metas as PythMeta[]) : []);
    if (!Object.keys(plans).length) throw new Error('no currency pairs in the Pyth feed list');
    try {
      this.env.save(PLAN_KEY, JSON.stringify({ at: this.env.now(), plans }));
    } catch {
      // storage full / blocked: fine, it is looked up again next time
    }
    return (this.plans = plans);
  }

  private async open(): Promise<void> {
    let plans: Record<string, Leg[]>;
    try {
      plans = await this.loadPlans();
    } catch {
      return this.failed();
    }
    // switched off while the feed list was loading
    if (!this.want || this.stream) return;
    const ids = [...new Set(Object.values(plans).flat().map((l) => l.id))];
    const url = `${HERMES}/v2/updates/price/stream?${ids.map((id) => `ids[]=${id}`).join('&')}&parsed=true&ignore_invalid_price_ids=true`;
    try {
      this.stream = this.env.openStream(url, {
        message: (data) => {
          const px = applyHermes(data, plans, this.latest, this.half);
          if (!Object.keys(px).length) return;
          this.fails = 0;
          this.updates++;
          this.lastAt = this.env.now();
          this.onPx(px);
        },
        failed: () => this.failed(),
      });
    } catch {
      this.failed();
    }
  }
}

/** The browser's real surroundings: fetch, EventSource (it reconnects by itself after a dropped connection), localStorage. */
export const browserEnv: DirectEnv = {
  fetchJson: async (url) => {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  openStream: (url, on) => {
    const es = new EventSource(url);
    es.onmessage = (e) => on.message(String(e.data));
    // a refused request (HTTP error) closes it for good; a dropped connection is retried by the browser
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) on.failed();
    };
    return { close: () => es.close() };
  },
  now: () => Date.now(),
  load: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  save: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // ignored
    }
  },
};
