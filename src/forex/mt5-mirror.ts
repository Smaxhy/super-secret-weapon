/**
 * v28.1 MT5 demo mirror (owner: "live trading as well … my bot id 62586512, it's using MT5, OANDA" → chose "Demo, with
 * OANDA" + "MetaApi cloud"). MT5 only runs on Windows and the VPS is Linux, so the bot talks to the MetaTrader account
 * through MetaApi (metaapi.cloud, a hosted MT5 terminal with a REST API). The owner adds the MT5 account on MetaApi's
 * own site (the MT5 password goes there, never here); the bot only gets a MetaApi API token + that account's MetaApi id,
 * pasted on Forex → Setup (BotConfig `_mt5`, masked on read) or `METAAPI_TOKEN` / `METAAPI_ACCOUNT_ID` in the VPS .env.
 *
 * What it does: every few seconds it compares the forex bot account's open trades with the MT5 positions it opened
 * and makes MT5 follow — a new bot trade is opened on MT5 (same side, size scaled to the MT5 account, stop / target at
 * the SAME distance from MT5's own fill, since OANDA's CFD prices differ from the futures / feed prices the bot uses),
 * a stop / target the bot moves (profit lock, trailing) is moved there too, a part the bot takes off is taken off
 * there, and a trade the bot closes is closed there. MT5 never decides anything on its own except its broker stop /
 * target. Only trades the bot opens AFTER the mirror is switched on are copied. DEMO ACCOUNTS ONLY: an account whose
 * MT5 trade mode isn't demo is refused. Endpoints from metaapi.cloud-sdk 29.3.4 (REST host `mt-client-api-v1.<region>.
 * <domain>`, provisioning `mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai`, header `auth-token`); UNVERIFIED from
 * the sandbox (it can't reach MetaApi) — the Setup card says what MetaApi answered.
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { moduleLogger } from '../lib/logger';
import { INSTRUMENTS } from './types';

const log = moduleLogger('mt5');

export const MT5 = {
  provisioning: 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai',
  /** used when MetaApi's own "which domain" answer can't be read */
  defaultDomain: 'agiliumtrade.ai',
  /** compare bot vs MT5 this often while on */
  tickMs: 5_000,
  /** account balance / equity re-read this often */
  infoMs: 60_000,
  /** symbol list + specifications cached this long */
  symbolsMs: 6 * 3_600_000,
  timeoutMs: 15_000,
  /** a stop / target change is sent at most this often per trade */
  modifyEveryMs: 10_000,
  /** a failed open is retried after this, at most `maxTries` times */
  retryMs: 5 * 60_000,
  maxTries: 3,
  /** which practice accounts are mirrored (the forex bot; the coin bot's coins aren't OANDA markets) */
  accts: ['bot'] as const,
  /** a lot cap per trade unless the owner sets another */
  defaultMaxLots: 5,
  logMax: 60,
};
export const MT5_ROW = '_mt5';
export const MT5_MAP = 'fx:mt5:map';
export const MT5_LOG = 'fx:mt5:log';
export const OK_CODES = new Set(['ERR_NO_ERROR', 'TRADE_RETCODE_PLACED', 'TRADE_RETCODE_DONE', 'TRADE_RETCODE_DONE_PARTIAL', 'TRADE_RETCODE_NO_CHANGES']);

// ── settings ──
export interface Mt5Settings {
  token: string | null;
  accountId: string | null;
  /** copying on */
  on: boolean;
  /** only bot trades opened at / after this are copied (set when switched on) */
  since: number | null;
  /** 'match' = MT5 equity ÷ bot equity (same % of the account); a number = that many MT5 units per bot unit */
  scale: 'match' | number;
  maxLots: number;
  /** our market id → MT5 symbol, when the automatic match is wrong */
  symbols: Record<string, string>;
  updatedAt?: string;
}
export const MT5_DEFAULTS: Mt5Settings = { token: null, accountId: null, on: false, since: null, scale: 'match', maxLots: MT5.defaultMaxLots, symbols: {} };

export async function loadMt5Settings(): Promise<Mt5Settings & { source: 'dashboard' | 'env' | null }> {
  let v: Partial<Mt5Settings> = {};
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: MT5_ROW } });
    v = ((row?.value ?? {}) as Partial<Mt5Settings>) || {};
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'mt5 settings not loaded');
  }
  const s: Mt5Settings = { ...MT5_DEFAULTS, ...v, symbols: { ...(v.symbols ?? {}) } };
  if (s.token && s.accountId) return { ...s, source: 'dashboard' };
  const token = (process.env.METAAPI_TOKEN ?? '').trim();
  const accountId = (process.env.METAAPI_ACCOUNT_ID ?? '').trim();
  if (token && accountId) return { ...s, token, accountId, source: 'env' };
  return { ...s, source: null };
}
export async function saveMt5Settings(s: Mt5Settings): Promise<void> {
  const value = { ...s, updatedAt: new Date().toISOString() };
  await prisma.botConfig.upsert({ where: { key: MT5_ROW }, update: { value: value as never }, create: { key: MT5_ROW, value: value as never } });
}

// ── HTTP ──
export interface MtResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type MtFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<MtResponse>;

export interface Mt5Account {
  id: string;
  login?: string | number;
  server?: string;
  name?: string;
  region: string;
  state?: string;
  connectionStatus?: string;
}
export interface Mt5Info {
  broker?: string;
  server?: string;
  currency?: string;
  balance: number;
  equity: number;
  freeMargin?: number;
  leverage?: number;
  login?: number;
  type?: string;
  tradeAllowed?: boolean;
}
export interface Mt5Spec {
  symbol: string;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  digits?: number;
}
export interface Mt5Pos {
  id: string;
  symbol: string;
  type: string;
  volume: number;
  openPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  clientId?: string;
  profit?: number;
}
export interface Mt5Trade {
  actionType: 'ORDER_TYPE_BUY' | 'ORDER_TYPE_SELL' | 'POSITION_MODIFY' | 'POSITION_CLOSE_ID' | 'POSITION_PARTIAL';
  symbol?: string;
  volume?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionId?: string;
  clientId?: string;
  comment?: string;
}
export interface Mt5TradeResult {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  orderId?: string;
  positionId?: string;
}

function errText(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown };
    const m = j.message ?? j.error;
    return typeof m === 'string' ? `— ${m.slice(0, 200)}` : '';
  } catch {
    return body ? `— ${body.slice(0, 200)}` : '';
  }
}

/** MetaApi REST: the provisioning API finds the account's region, the client API reads / trades it. */
export class MetaApiRest {
  private base: string | null = null;
  constructor(
    private token: string,
    readonly accountId: string,
    private fetcher: MtFetch = fetch as never,
  ) {}

  private async call<T>(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
    const res = await this.fetcher(url, {
      method,
      headers: { 'auth-token': this.token, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(MT5.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? ' (token not accepted)' : res.status === 404 ? ' (no such account on MetaApi)' : '';
      throw new Error(`MetaApi HTTP ${res.status}${why} ${errText(text)}`.trim());
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** the MetaApi account (region, deployed?, connected?) */
  account(): Promise<Mt5Account> {
    return this.call<Mt5Account>(`${MT5.provisioning}/users/current/accounts/${encodeURIComponent(this.accountId)}`);
  }

  private async client(): Promise<string> {
    if (this.base) return this.base;
    const acc = await this.account();
    let domain = MT5.defaultDomain;
    try {
      const d = await this.call<{ domain?: string }>(`${MT5.provisioning}/users/current/servers/mt-client-api`);
      if (d.domain) domain = d.domain;
    } catch {
      /* default domain */
    }
    this.base = `https://mt-client-api-v1.${acc.region}.${domain}/users/current/accounts/${encodeURIComponent(this.accountId)}`;
    return this.base;
  }

  async info(): Promise<Mt5Info> {
    return this.call<Mt5Info>(`${await this.client()}/account-information`);
  }
  async positions(): Promise<Mt5Pos[]> {
    const rows = await this.call<Array<Mt5Pos & { id: string | number }>>(`${await this.client()}/positions`);
    return (Array.isArray(rows) ? rows : []).map((p) => ({ ...p, id: String(p.id) }));
  }
  async symbols(): Promise<string[]> {
    const rows = await this.call<unknown[]>(`${await this.client()}/symbols`);
    return (Array.isArray(rows) ? rows : []).map((x) => (typeof x === 'string' ? x : String((x as { symbol?: string }).symbol ?? ''))).filter(Boolean);
  }
  async spec(symbol: string): Promise<Mt5Spec> {
    return this.call<Mt5Spec>(`${await this.client()}/symbols/${encodeURIComponent(symbol)}/specification`);
  }
  async price(symbol: string): Promise<{ bid: number; ask: number }> {
    return this.call<{ bid: number; ask: number }>(`${await this.client()}/symbols/${encodeURIComponent(symbol)}/current-price`);
  }
  /** a trade request; throws with MT5's own code when it isn't accepted */
  async trade(t: Mt5Trade): Promise<Mt5TradeResult> {
    const r = await this.call<Mt5TradeResult>(`${await this.client()}/trade`, 'POST', t);
    if (!r.stringCode || !OK_CODES.has(r.stringCode)) throw new Error(`MT5 refused: ${r.stringCode ?? 'no answer'}${r.message ? ` — ${r.message}` : ''}`);
    return r;
  }
}

/** Token + account work: the account exists on MetaApi and answers. Demo accounts only. */
export async function testMt5(token: string, accountId: string, fetcher: MtFetch = fetch as never): Promise<{ ok: true; account: Mt5Account; info: Mt5Info | null; note?: string } | { ok: false; error: string }> {
  try {
    const c = new MetaApiRest(token, accountId, fetcher);
    const account = await c.account();
    let info: Mt5Info | null = null;
    try {
      info = await c.info();
    } catch (err) {
      return { ok: true, account, info: null, note: `account found but not answering yet (${(err as Error).message}) — on MetaApi, deploy it and wait until it says Connected` };
    }
    if (!isDemo(info)) return { ok: false, error: `this is not a demo account (MT5 says ${info.type ?? 'unknown'}) — the mirror only trades demo accounts` };
    return { ok: true, account, info };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const isDemo = (i: Pick<Mt5Info, 'type'> | null | undefined): boolean => i?.type === 'ACCOUNT_TRADE_MODE_DEMO';

// ── pure helpers ──
/** usual broker names for our index ids */
export const INDEX_NAMES: Record<string, string[]> = {
  NDXUSD: ['NAS100', 'US100', 'USTEC', 'NDX100', 'NASDAQ100', 'NQ100'],
  SPXUSD: ['SPX500', 'US500', 'SP500', 'SPX'],
  DJIUSD: ['US30', 'DJ30', 'WS30', 'DOW30'],
  RUTUSD: ['US2000', 'RUS2000', 'RUSSELL2000', 'RTY'],
};
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Our market id → the MT5 symbol on this account: an override, else the exact name, else the shortest symbol that
 * starts with it (brokers add suffixes like ".pro" / ".sml" / "m"), indices by their usual names. Pure. */
export function matchSymbol(id: string, symbols: readonly string[], overrides: Record<string, string> = {}): string | null {
  if (overrides[id]) return overrides[id]!;
  const names = INDEX_NAMES[id] ?? [id];
  for (const n of names) {
    const exact = symbols.find((s) => norm(s) === n);
    if (exact) return exact;
  }
  for (const n of names) {
    // a separator right after the name ("EURUSD.pro") beats a glued suffix ("EURUSDm"), then the shortest
    const glued = (s: string) => (/^[A-Z0-9]$/.test(s.toUpperCase().charAt(n.length)) ? 1 : 0);
    const pre = symbols.filter((s) => norm(s).startsWith(n) && norm(s).length <= n.length + 4).sort((a, b) => glued(a) - glued(b) || a.length - b.length);
    if (pre.length) return pre[0]!;
  }
  return null;
}

/** Units of the market → MT5 lots, rounded DOWN to the volume step, capped. null = under the minimum. Pure. */
export function lotsFor(units: number, spec: Pick<Mt5Spec, 'contractSize' | 'minVolume' | 'maxVolume' | 'volumeStep'>, maxLots: number): number | null {
  if (!(units > 0) || !(spec.contractSize > 0)) return null;
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.01;
  const raw = Math.min(units / spec.contractSize, maxLots > 0 ? maxLots : Infinity, spec.maxVolume > 0 ? spec.maxVolume : Infinity);
  const lots = Math.floor(raw / step + 1e-9) * step;
  const r = Number(lots.toFixed(8));
  return r >= (spec.minVolume > 0 ? spec.minVolume : step) - 1e-12 ? r : null;
}

/** a short id MT5 keeps on the position (comment + clientId ≤ 26 characters) */
export const clientIdOf = (posId: string) => `FX${createHash('sha1').update(posId).digest('hex').slice(0, 10)}`;

export interface MirrorBotPos {
  id: string;
  pair: string;
  side: 1 | -1;
  units: number;
  entry: number;
  stop: number | null;
  target: number | null;
  openedAt: number;
  closePending: boolean;
}
export interface MirrorRow {
  posId: string;
  pair: string;
  symbol: string | null;
  mt5Id: string | null;
  clientId: string;
  side: 1 | -1;
  units0: number;
  lots0: number;
  step: number;
  minVol: number;
  /** the bot's entry and MT5's fill: stops / targets keep their distance from the fill */
  entry: number;
  fill: number | null;
  /** price rounding on MT5 */
  digits: number;
  state: 'open' | 'failed' | 'gone' | 'closed';
  tries: number;
  at: number;
  modAt: number;
  error?: string;
}
export type MirrorAction =
  | { kind: 'open'; pos: MirrorBotPos; retry: boolean }
  | { kind: 'close'; posId: string; mt5Id: string; why: string }
  | { kind: 'reduce'; posId: string; mt5Id: string; volume: number }
  | { kind: 'modify'; posId: string; mt5Id: string; sl: number | null; tp: number | null }
  | { kind: 'gone'; posId: string }
  | { kind: 'drop'; posId: string };

const pipOf = (pair: string) => INSTRUMENTS.find((i) => i.id === pair)?.pip ?? 0.0001;
const roundTo = (x: number, d: number) => Number(x.toFixed(Math.max(0, Math.min(10, d))));

/** Where MT5's stop / target go: the bot's distance from its entry, from MT5's own fill. Pure. */
export function mirrorLevels(row: Pick<MirrorRow, 'entry' | 'fill' | 'digits'>, pos: Pick<MirrorBotPos, 'entry' | 'stop' | 'target'>): { sl: number | null; tp: number | null } {
  const base = row.fill ?? row.entry;
  return {
    sl: pos.stop !== null ? roundTo(base + (pos.stop - pos.entry), row.digits) : null,
    tp: pos.target !== null ? roundTo(base + (pos.target - pos.entry), row.digits) : null,
  };
}

/** What MT5 must do to look like the bot account. Pure. */
export function planMirror(o: { bot: readonly MirrorBotPos[]; rows: Readonly<Record<string, MirrorRow>>; mt5: readonly Mt5Pos[]; since: number; now: number }): MirrorAction[] {
  const out: MirrorAction[] = [];
  const byId = new Map(o.mt5.map((p) => [p.id, p]));
  const botIds = new Set(o.bot.map((p) => p.id));
  for (const p of o.bot) {
    const r = o.rows[p.id];
    if (!r) {
      if (p.openedAt >= o.since && !p.closePending) out.push({ kind: 'open', pos: p, retry: false });
      continue;
    }
    if (r.state === 'failed') {
      if (r.tries < MT5.maxTries && o.now - r.at >= MT5.retryMs && !p.closePending) out.push({ kind: 'open', pos: p, retry: true });
      continue;
    }
    if (r.state !== 'open' || !r.mt5Id) continue;
    const m = byId.get(r.mt5Id);
    if (!m) {
      out.push({ kind: 'gone', posId: p.id });
      continue;
    }
    if (p.closePending) {
      out.push({ kind: 'close', posId: p.id, mt5Id: r.mt5Id, why: 'the bot is closing it' });
      continue;
    }
    // a part the bot took off
    if (r.units0 > 0 && p.units < r.units0 * 0.995) {
      const want = Math.floor(((r.lots0 * p.units) / r.units0) / r.step + 1e-9) * r.step;
      if (want < r.minVol - 1e-12) {
        out.push({ kind: 'close', posId: p.id, mt5Id: r.mt5Id, why: 'what is left is under the MT5 minimum' });
        continue;
      }
      const cut = Number((m.volume - want).toFixed(8));
      if (cut >= r.step - 1e-12) {
        out.push({ kind: 'reduce', posId: p.id, mt5Id: r.mt5Id, volume: cut });
        continue;
      }
    }
    // stop / target moved
    if (o.now - r.modAt >= MT5.modifyEveryMs) {
      const want = mirrorLevels(r, p);
      const tol = pipOf(p.pair) * 0.5;
      const diff = (a: number | null, b: number | undefined) => (a === null ? !!b : !b || Math.abs(a - b) > tol);
      if (diff(want.sl, m.stopLoss) || diff(want.tp, m.takeProfit)) out.push({ kind: 'modify', posId: p.id, mt5Id: r.mt5Id, sl: want.sl, tp: want.tp });
    }
  }
  for (const r of Object.values(o.rows)) {
    if (botIds.has(r.posId)) continue;
    if (r.state === 'open' && r.mt5Id && byId.has(r.mt5Id)) out.push({ kind: 'close', posId: r.posId, mt5Id: r.mt5Id, why: 'the bot closed it' });
    else out.push({ kind: 'drop', posId: r.posId });
  }
  return out;
}

/** MT5 units per bot unit: 'match' = the two accounts' equity ratio (same share of the account at risk). Pure. */
export function scaleOf(scale: Mt5Settings['scale'], mt5Equity: number | null, botEquity: number): number | null {
  if (typeof scale === 'number') return scale > 0 ? scale : null;
  if (!(mt5Equity && mt5Equity > 0) || !(botEquity > 0)) return null;
  return mt5Equity / botEquity;
}

// ── the loop ──
export interface MirrorSource {
  rawAccount(acct: 'bot'): Promise<{ balanceUsd: number; open: Array<{ id: string; pair: string; side: 1 | -1; units: number; entry: number; stop: number | null; target: number | null; openedAt: number; closePending?: unknown }> }>;
}
export interface Mt5Status {
  connected: boolean;
  source: 'dashboard' | 'env' | null;
  on: boolean;
  since: number | null;
  token: string | null;
  accountId: string | null;
  scale: Mt5Settings['scale'];
  maxLots: number;
  account: Mt5Account | null;
  info: Mt5Info | null;
  demo: boolean | null;
  lastTickAt: number | null;
  error: string | null;
  rows: MirrorRow[];
  positions: Mt5Pos[];
  log: Array<{ t: number; e: string }>;
}

const mask = (s: string | null) => (s ? (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '••••') : null);

export class Mt5Mirror {
  private s: (Mt5Settings & { source: 'dashboard' | 'env' | null }) | null = null;
  private api: MetaApiRest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private rows: Record<string, MirrorRow> = {};
  private logRows: Array<{ t: number; e: string }> = [];
  private account: Mt5Account | null = null;
  private info: Mt5Info | null = null;
  private infoAt = 0;
  private symbolList: string[] = [];
  private symbolsAt = 0;
  private specs = new Map<string, { spec: Mt5Spec; at: number }>();
  private positions: Mt5Pos[] = [];
  private lastTickAt: number | null = null;
  private error: string | null = null;
  private stopped = false;

  constructor(
    private redis: Pick<Redis, 'get' | 'set'>,
    private source: MirrorSource,
    private botLog: (lines: string[]) => void = () => undefined,
    private fetcher: MtFetch = fetch as never,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const [m, l] = await Promise.all([this.redis.get(MT5_MAP), this.redis.get(MT5_LOG)]);
      if (m) this.rows = JSON.parse(m) as Record<string, MirrorRow>;
      if (l) this.logRows = JSON.parse(l) as Array<{ t: number; e: string }>;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'mt5 map not loaded');
    }
    await this.reload();
    this.arm();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.arm());
    }, MT5.tickMs);
    this.timer.unref?.();
  }

  /** settings changed on the dashboard */
  async reload(): Promise<void> {
    this.s = await loadMt5Settings();
    this.api = this.s.token && this.s.accountId ? new MetaApiRest(this.s.token, this.s.accountId, this.fetcher) : null;
    this.account = null;
    this.info = null;
    this.infoAt = 0;
    this.symbolsAt = 0;
    this.specs.clear();
    this.error = null;
  }

  private note(e: string, now = Date.now()): void {
    this.logRows.unshift({ t: now, e });
    this.logRows = this.logRows.slice(0, MT5.logMax);
    this.botLog([`MT5 demo: ${e}`]);
    void this.redis.set(MT5_LOG, JSON.stringify(this.logRows)).catch(() => undefined);
  }
  private save(): void {
    void this.redis.set(MT5_MAP, JSON.stringify(this.rows)).catch(() => undefined);
  }

  private async specOf(symbol: string, now: number): Promise<Mt5Spec> {
    const c = this.specs.get(symbol);
    if (c && now - c.at < MT5.symbolsMs) return c.spec;
    const spec = await this.api!.spec(symbol);
    this.specs.set(symbol, { spec, at: now });
    return spec;
  }
  private async symbolFor(pair: string, now: number): Promise<string | null> {
    if (!this.symbolList.length || now - this.symbolsAt > MT5.symbolsMs) {
      this.symbolList = await this.api!.symbols();
      this.symbolsAt = now;
    }
    return matchSymbol(pair, this.symbolList, this.s?.symbols ?? {});
  }

  /** one comparison round (exported for tests: `now` injectable) */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || !this.api || !this.s) return;
    this.busy = true;
    try {
      if (!this.account) this.account = await this.api.account();
      if (!this.info || now - this.infoAt >= MT5.infoMs) {
        this.info = await this.api.info();
        this.infoAt = now;
        if (!isDemo(this.info)) {
          if (this.s.on) this.note(`stopped — MT5 says this is not a demo account (${this.info.type ?? 'unknown'}); the mirror only trades demo accounts`, now);
          this.s.on = false;
          await saveMt5Settings(this.s).catch(() => undefined);
        }
      }
      this.positions = await this.api.positions();
      this.lastTickAt = now;
      this.error = null;
      if (!this.s.on || !isDemo(this.info)) return;
      this.syncRows();
      const acc = await this.source.rawAccount('bot');
      const bot: MirrorBotPos[] = acc.open.map((p) => ({ id: p.id, pair: p.pair, side: p.side, units: p.units, entry: p.entry, stop: p.stop, target: p.target, openedAt: p.openedAt, closePending: !!p.closePending }));
      const actions = planMirror({ bot, rows: this.rows, mt5: this.positions, since: this.s.since ?? now, now });
      const scale = scaleOf(this.s.scale, this.info.equity ?? null, acc.balanceUsd);
      for (const a of actions) await this.apply(a, scale, now);
      if (actions.length) this.save();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.error) log.warn({ err: msg }, 'mt5 mirror round failed');
      this.error = msg;
    } finally {
      this.busy = false;
    }
  }

  /** MT5's real fill becomes the base for the stop / target distances; a position found by its clientId is linked */
  private syncRows(): void {
    for (const r of Object.values(this.rows)) {
      if (r.state !== 'open') continue;
      const m = this.positions.find((p) => (r.mt5Id && p.id === r.mt5Id) || (p.clientId && p.clientId === r.clientId));
      if (!m) continue;
      r.mt5Id = m.id;
      if (Number.isFinite(m.openPrice) && m.openPrice > 0) r.fill = m.openPrice;
    }
  }

  private async apply(a: MirrorAction, scale: number | null, now: number): Promise<void> {
    const api = this.api!;
    if (a.kind === 'drop') {
      delete this.rows[a.posId];
      return;
    }
    if (a.kind === 'gone') {
      const r = this.rows[a.posId]!;
      r.state = 'gone';
      r.at = now;
      this.note(`${r.pair} closed on MT5 by its own stop / target (the bot's trade is still open)`, now);
      return;
    }
    if (a.kind === 'open') {
      const p = a.pos;
      const prev = this.rows[p.id];
      const row: MirrorRow = prev ?? { posId: p.id, pair: p.pair, symbol: null, mt5Id: null, clientId: clientIdOf(p.id), side: p.side, units0: p.units, lots0: 0, step: 0.01, minVol: 0.01, entry: p.entry, fill: null, digits: 5, state: 'failed', tries: 0, at: now, modAt: 0 };
      row.tries += 1;
      row.at = now;
      this.rows[p.id] = row;
      const fail = (why: string, final = false) => {
        row.state = 'failed';
        row.error = why;
        if (final) row.tries = MT5.maxTries;
        this.note(`${p.pair} ${p.side > 0 ? 'buy' : 'sell'} not copied — ${why}${!final && row.tries < MT5.maxTries ? ' (will try again in 5 min)' : ''}`, now);
      };
      try {
        const symbol = await this.symbolFor(p.pair, now);
        if (!symbol) return fail(`no matching MT5 symbol on this account (set one on Setup)`, true);
        if (scale === null) return fail('no account size to scale from yet');
        const spec = await this.specOf(symbol, now);
        const lots = lotsFor(p.units * scale, spec, this.s!.maxLots);
        if (lots === null) return fail(`size under the MT5 minimum (${spec.minVolume} lots)`, true);
        const px = await api.price(symbol);
        const digits = spec.digits ?? Math.max(0, Math.round(-Math.log10(pipOf(p.pair))) + 1);
        Object.assign(row, { symbol, lots0: lots, step: spec.volumeStep > 0 ? spec.volumeStep : 0.01, minVol: spec.minVolume > 0 ? spec.minVolume : 0.01, digits, units0: p.units, entry: p.entry });
        const here = p.side > 0 ? px.ask : px.bid;
        const lv = mirrorLevels({ entry: p.entry, fill: here, digits }, p);
        const r = await api.trade({ actionType: p.side > 0 ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL', symbol, volume: lots, ...(lv.sl !== null ? { stopLoss: lv.sl } : {}), ...(lv.tp !== null ? { takeProfit: lv.tp } : {}), clientId: row.clientId, comment: 'fxbot' });
        const id = r.positionId ?? r.orderId ?? null;
        Object.assign(row, { mt5Id: id ? String(id) : null, fill: here, state: 'open' as const, modAt: now });
        delete row.error;
        this.note(`${p.side > 0 ? 'bought' : 'sold'} ${lots} lots ${symbol} near ${here} (bot: ${p.units.toLocaleString('en-US', { maximumFractionDigits: 2 })} units ${p.pair})`, now);
      } catch (err) {
        fail((err as Error).message);
      }
      return;
    }
    const r = this.rows[a.posId]!;
    try {
      if (a.kind === 'close') {
        await api.trade({ actionType: 'POSITION_CLOSE_ID', positionId: a.mt5Id });
        r.state = 'closed';
        r.at = now;
        this.note(`closed ${r.symbol} (${a.why})`, now);
      } else if (a.kind === 'reduce') {
        await api.trade({ actionType: 'POSITION_PARTIAL', positionId: a.mt5Id, volume: a.volume });
        this.note(`took ${a.volume} lots off ${r.symbol} (the bot took a part)`, now);
      } else if (a.kind === 'modify') {
        r.modAt = now;
        await api.trade({ actionType: 'POSITION_MODIFY', positionId: a.mt5Id, ...(a.sl !== null ? { stopLoss: a.sl } : {}), ...(a.tp !== null ? { takeProfit: a.tp } : {}) });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (r.error !== msg) this.note(`${r.symbol}: ${a.kind} failed — ${msg}`, now);
      r.error = msg;
    }
  }

  /** the kill switch: close every MT5 position the mirror opened, then stop copying */
  async closeAll(now = Date.now()): Promise<number> {
    if (!this.api || !this.s) return 0;
    this.s.on = false;
    await saveMt5Settings(this.s);
    const pos = await this.api.positions();
    let n = 0;
    for (const r of Object.values(this.rows)) {
      if (r.state !== 'open' || !r.mt5Id || !pos.some((p) => p.id === r.mt5Id)) continue;
      try {
        await this.api.trade({ actionType: 'POSITION_CLOSE_ID', positionId: r.mt5Id });
        r.state = 'closed';
        n++;
      } catch (err) {
        this.note(`${r.symbol}: close failed — ${(err as Error).message}`, now);
      }
    }
    this.save();
    this.note(`stopped copying; closed ${n} position${n === 1 ? '' : 's'} it had opened`, now);
    return n;
  }

  status(): Mt5Status {
    const s = this.s;
    return {
      connected: !!this.api,
      source: s?.source ?? null,
      on: !!s?.on,
      since: s?.since ?? null,
      token: mask(s?.token ?? null),
      accountId: mask(s?.accountId ?? null),
      scale: s?.scale ?? 'match',
      maxLots: s?.maxLots ?? MT5.defaultMaxLots,
      account: this.account,
      info: this.info,
      demo: this.info ? isDemo(this.info) : null,
      lastTickAt: this.lastTickAt,
      error: this.error,
      rows: Object.values(this.rows).sort((a, b) => b.at - a.at).slice(0, 30),
      positions: this.positions,
      log: this.logRows.slice(0, 30),
    };
  }
}
