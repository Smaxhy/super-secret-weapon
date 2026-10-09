/**
 * PumpPortal listener — the FREE live data source (no Helius credits).
 *
 * PumpPortal (pumpportal.fun) streams Pump.fun data over one WebSocket:
 *   subscribeNewToken      → every launch (with the dev's first buy)
 *   subscribeTokenTrade    → every buy/sell for the mints we ask for
 *   subscribeMigration     → tokens moving from the curve to PumpSwap
 *
 * We translate its messages into the same events the Helius listener emits,
 * so the rest of the bot doesn't care which source is used. Helius is then
 * only used for the occasional RPC check (safety, dev wallet, fee sampling).
 *
 * Trades are per-mint subscriptions: the registry calls watch(mint) on every
 * launch and unwatch(mint) when it stops tracking it (after 24h). All watched
 * mints are re-subscribed automatically after a reconnect.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { PumpEvent, PumpEventEnvelope } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES, PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES, PUMP_DEFAULT_TOTAL_SUPPLY, WSOL_MINT } from '../lib/pumpfun';
import type { ListenerStats } from './pumpfun-listener';

const log = moduleLogger('pumpportal');

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';
const PING_INTERVAL_MS = 20_000;
const SILENCE_TIMEOUT_MS = 90_000;
const MAX_BACKOFF_MS = 30_000;
/** Subscribe/unsubscribe in batches, at most this often, to be gentle with PumpPortal. */
const FLUSH_MS = 1_000;
const BATCH = 100;

/** Shape of PumpPortal messages (fields we use). Amounts are human units: SOL and whole tokens. */
interface PortalMessage {
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: 'create' | 'buy' | 'sell' | 'migrate' | string;
  name?: string;
  symbol?: string;
  uri?: string;
  bondingCurveKey?: string;
  initialBuy?: number;
  tokenAmount?: number;
  solAmount?: number;
  newTokenBalance?: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  pool?: string;
  message?: string;
  errors?: string;
}

const raw = (tokens: number | undefined) => BigInt(Math.round((tokens ?? 0) * 1e6));
const lamports = (sol: number | undefined) => BigInt(Math.round((sol ?? 0) * 1e9));
const nowSec = () => Math.floor(Date.now() / 1000);

/** Translate one PumpPortal message into our events. Pure — exported for tests. */
export function translatePortalMessage(m: PortalMessage): PumpEvent[] {
  if (!m.mint || !m.txType) return [];
  const ts = nowSec();
  const user = m.traderPublicKey ?? '';

  if (m.txType === 'create') {
    const events: PumpEvent[] = [
      {
        kind: 'create',
        name: m.name ?? '',
        symbol: m.symbol ?? '',
        uri: m.uri ?? '',
        mint: m.mint,
        bondingCurve: m.bondingCurveKey ?? '',
        user,
        creator: user,
        timestamp: ts,
        virtualTokenReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
        virtualSolReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
        realTokenReserves: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
        tokenTotalSupply: PUMP_DEFAULT_TOTAL_SUPPLY,
      },
    ];
    // The dev's launch buy comes in the same message.
    if ((m.initialBuy ?? 0) > 0 && m.vSolInBondingCurve && m.vTokensInBondingCurve) {
      events.push({
        kind: 'trade',
        mint: m.mint,
        solAmount: lamports(m.solAmount),
        tokenAmount: raw(m.initialBuy),
        isBuy: true,
        user,
        timestamp: ts,
        virtualSolReserves: lamports(m.vSolInBondingCurve),
        virtualTokenReserves: raw(m.vTokensInBondingCurve),
        balanceAfter: raw(m.initialBuy),
      });
    }
    return events;
  }

  if (m.txType === 'buy' || m.txType === 'sell') {
    const isBuy = m.txType === 'buy';
    const balanceAfter = typeof m.newTokenBalance === 'number' ? raw(m.newTokenBalance) : undefined;
    // On the bonding curve PumpPortal reports the curve's reserves; anything else is a pool trade.
    if ((m.pool === undefined || m.pool === 'pump') && m.vSolInBondingCurve && m.vTokensInBondingCurve) {
      return [
        {
          kind: 'trade',
          mint: m.mint,
          solAmount: lamports(m.solAmount),
          tokenAmount: raw(m.tokenAmount),
          isBuy,
          user,
          timestamp: ts,
          virtualSolReserves: lamports(m.vSolInBondingCurve),
          virtualTokenReserves: raw(m.vTokensInBondingCurve),
          balanceAfter,
        },
      ];
    }
    return [
      {
        kind: 'ammTrade',
        pool: `amm:${m.mint}`,
        user,
        isBuy,
        baseAmount: raw(m.tokenAmount),
        quoteAmount: lamports(m.solAmount),
        feeLamports: (lamports(m.solAmount) * 30n) / 10_000n, // ~0.3% PumpSwap fee
        timestamp: ts,
        balanceAfter,
      },
    ];
  }

  if (m.txType === 'migrate' || m.txType === 'migration') {
    return [
      { kind: 'complete', user, mint: m.mint, bondingCurve: m.bondingCurveKey ?? '', timestamp: ts },
      // Reserves 0 → live state derives them from the token's final curve state.
      { kind: 'ammPool', pool: `amm:${m.mint}`, baseMint: m.mint, quoteMint: WSOL_MINT, baseReserve: 0n, quoteReserve: 0n, timestamp: ts },
    ];
  }
  return [];
}

export class PumpPortalListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoffMs = 1_000;
  private pingTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private readonly watched = new Set<string>();
  private readonly toSub = new Set<string>();
  private readonly toUnsub = new Set<string>();

  readonly stats: ListenerStats = {
    connected: false,
    connectedSince: null,
    reconnects: 0,
    notifications: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    ammPools: 0,
    ammTrades: 0,
    decodeErrors: 0,
    truncatedLogs: 0,
    fallbackFetches: 0,
    lastEventAt: null,
  };

  constructor(private readonly url: string = DEFAULT_URL) {
    super();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.stats.connected = false;
  }

  /** Start receiving trades for a mint. */
  watch(mint: string): void {
    if (this.watched.has(mint)) return;
    this.watched.add(mint);
    this.toUnsub.delete(mint);
    this.toSub.add(mint);
  }

  /** Stop receiving trades for a mint. */
  unwatch(mint: string): void {
    if (!this.watched.delete(mint)) return;
    this.toSub.delete(mint);
    this.toUnsub.add(mint);
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  private connect(): void {
    log.info({ url: this.url.replace(/api-key=[^&]+/, 'api-key=***') }, 'connecting to PumpPortal');
    const ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1_000;
      this.lastMessageAt = Date.now();
      this.stats.connected = true;
      this.stats.connectedSince = Date.now();
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      // Re-subscribe everything we were watching before the reconnect.
      for (const m of this.watched) this.toSub.add(m);
      this.toUnsub.clear();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
          log.warn('no data from PumpPortal for 90s — reconnecting');
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
      log.info('connected to PumpPortal (new tokens + migrations)');
      this.emit('connected');
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handle(data.toString());
    });
    ws.on('pong', () => (this.lastMessageAt = Date.now()));
    ws.on('error', (err) => log.warn({ err: err.message }, 'PumpPortal websocket error'));
    ws.on('close', (code) => {
      this.stats.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      log.warn({ code }, `PumpPortal closed, reconnecting in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.stats.reconnects++;
        this.connect();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private flush(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const take = (set: Set<string>) => {
      const keys = [...set].slice(0, BATCH);
      keys.forEach((k) => set.delete(k));
      return keys;
    };
    const sub = take(this.toSub);
    if (sub.length) this.send({ method: 'subscribeTokenTrade', keys: sub });
    const unsub = take(this.toUnsub);
    if (unsub.length) this.send({ method: 'unsubscribeTokenTrade', keys: unsub });
  }

  private handle(text: string): void {
    let m: PortalMessage;
    try {
      m = JSON.parse(text) as PortalMessage;
    } catch {
      this.stats.decodeErrors++;
      return;
    }
    if (m.errors || (m.message && !m.txType)) {
      // Subscription confirmations ("Successfully subscribed…") or errors.
      if (m.errors) log.warn({ error: m.errors }, 'PumpPortal error');
      else log.debug({ message: m.message }, 'PumpPortal');
      return;
    }
    this.stats.notifications++;
    let events: PumpEvent[];
    try {
      events = translatePortalMessage(m);
    } catch {
      this.stats.decodeErrors++;
      return;
    }
    for (const event of events) {
      if (event.kind === 'create') this.stats.creates++;
      else if (event.kind === 'trade') this.stats.trades++;
      else if (event.kind === 'complete') this.stats.completes++;
      else if (event.kind === 'ammPool') this.stats.ammPools++;
      else this.stats.ammTrades++;
      this.stats.lastEventAt = Date.now();
      this.emit('event', { signature: m.signature ?? `${m.mint}:${Date.now()}`, slot: 0, event } satisfies PumpEventEnvelope);
    }
  }
}
