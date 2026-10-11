/**
 * Yellowstone gRPC trade stream (Chainstack / Shyft / Helius LaserStream / Triton …) — OFF until the owner
 * buys a plan: set DATA_SOURCE=grpc + GRPC_ENDPOINT + GRPC_TOKEN in the VPS .env.
 *
 * Subscribes to every confirmed, successful transaction that touches pump.fun or PumpSwap and decodes
 * the same program log lines the free logsSubscribe stream gives (lib/pumpfun parsePumpLogs), so
 * everything downstream works unchanged. Faster and far more complete than Solana's public node.
 * Launches still come from PumpPortal; the free public stream keeps running as a backup and is only
 * used while this stream is down (see index.ts).
 *
 * The native client is loaded only when this listener starts, so the bot runs without it.
 */
import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import type { PumpEvent, PumpEventEnvelope } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { parsePumpLogs, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from '../lib/pumpfun';
import type { ListenerStats } from './pumpfun-listener';

const log = moduleLogger('grpc-listener');

const PING_EVERY_MS = 15_000;
const SILENCE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUPE_WINDOW = 10_000;

/** What we read from one gRPC transaction update. */
export interface GrpcTx {
  signature: Uint8Array | string;
  slot: string | number;
  failed: boolean;
  logs: readonly string[];
}

/** Pure: the pump.fun / PumpSwap events in one transaction (failed ones changed nothing). */
export function eventsFromTx(tx: GrpcTx): { signature: string; slot: number; events: PumpEvent[]; decodeErrors: number; truncated: boolean } | null {
  if (tx.failed || !tx.logs.length) return null;
  const signature = typeof tx.signature === 'string' ? tx.signature : bs58.encode(tx.signature);
  const parsed = parsePumpLogs([...tx.logs]);
  return { signature, slot: Number(tx.slot), events: parsed.events, decodeErrors: parsed.decodeErrors, truncated: parsed.truncated };
}

/** Pure: the subscription — every successful pump.fun + PumpSwap transaction, confirmed. */
export function subscribeRequest(commitment: number): Record<string, unknown> {
  return {
    accounts: {},
    slots: {},
    transactions: {
      pump: { vote: false, failed: false, accountInclude: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID], accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment,
  };
}

export declare interface GrpcListener {
  on(event: 'event', listener: (env: PumpEventEnvelope) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: (downSinceMs: number) => void): this;
}

interface StreamLike {
  on(ev: 'data', f: (u: unknown) => void): unknown;
  on(ev: 'error' | 'end' | 'close', f: (e?: Error) => void): unknown;
  write(req: unknown, cb?: (err?: Error | null) => void): boolean;
  destroy(): void;
}

export class GrpcListener extends EventEmitter {
  private stopped = true;
  private stream: StreamLike | null = null;
  private backoffMs = 1_000;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastDataAt = 0;
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[] = [];
  private pingId = 1;

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

  constructor(
    private readonly endpoint: string,
    private readonly token: string | undefined,
  ) {
    super();
  }

  get connected(): boolean {
    return this.stats.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.stream?.destroy();
    this.stream = null;
    this.stats.connected = false;
  }

  private async connect(): Promise<void> {
    try {
      // Loaded on demand: the native module is only needed when this stream is switched on.
      const mod = (await import('@triton-one/yellowstone-grpc')) as unknown as {
        default: new (endpoint: string, token: string | undefined, opts: Record<string, unknown> | undefined) => { connect(): Promise<void>; subscribe(): Promise<StreamLike> };
        CommitmentLevel: { CONFIRMED: number };
      };
      const client = new mod.default(this.endpoint, this.token, { grpcMaxDecodingMessageSize: 64 * 1024 * 1024 });
      await client.connect();
      const stream = await client.subscribe();
      this.stream = stream;
      stream.on('data', (u: unknown) => {
        this.lastDataAt = Date.now();
        this.handle(u);
      });
      const down = (why: string, err?: Error) => {
        if (this.stream !== stream) return;
        this.stream = null;
        const since = this.stats.connectedSince ?? Date.now();
        this.stats.connected = false;
        this.clearTimers();
        stream.destroy();
        if (this.stopped) return;
        if (Date.now() - since > 30_000) this.backoffMs = 500;
        log.warn({ why, err: err?.message }, `gRPC stream ${why}, reconnecting in ${this.backoffMs}ms`);
        this.emit('disconnected', since);
        this.scheduleReconnect();
      };
      stream.on('error', (e) => down('error', e));
      stream.on('end', () => down('ended'));
      stream.on('close', () => down('closed'));
      await new Promise<void>((resolve, reject) => stream.write(subscribeRequest(mod.CommitmentLevel.CONFIRMED), (err) => (err ? reject(err) : resolve())));
      this.backoffMs = 1_000;
      this.lastDataAt = Date.now();
      this.stats.connected = true;
      this.stats.connectedSince = Date.now();
      this.startPing();
      log.info('gRPC stream connected (pump.fun + PumpSwap transactions)');
      this.emit('connected');
    } catch (err) {
      log.warn({ err: (err as Error).message }, `gRPC connect failed, retrying in ${this.backoffMs}ms`);
      this.stream?.destroy();
      this.stream = null;
      this.stats.connected = false;
      if (!this.stopped) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects++;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startPing(): void {
    // Load balancers drop idle gRPC streams: a ping keeps it open; silence means it died quietly.
    this.pingTimer = setInterval(() => {
      if (!this.stream) return;
      if (Date.now() - this.lastDataAt > SILENCE_MS) {
        log.warn('gRPC stream silent for 45s — reconnecting');
        this.stream.destroy();
        return;
      }
      this.stream.write({ ...subscribeRequest(1), ping: { id: this.pingId++ } });
    }, PING_EVERY_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private handle(u: unknown): void {
    const upd = u as { transaction?: { slot: string; transaction?: { signature: Uint8Array; meta?: { err?: unknown; logMessages?: string[] } } } };
    const t = upd.transaction?.transaction;
    if (!t) return;
    this.stats.notifications++;
    try {
      const r = eventsFromTx({ signature: t.signature, slot: upd.transaction!.slot, failed: !!t.meta?.err, logs: t.meta?.logMessages ?? [] });
      if (!r) return;
      this.stats.decodeErrors += r.decodeErrors;
      if (r.truncated) this.stats.truncatedLogs++;
      if (this.isDuplicate(r.signature)) return;
      for (const event of r.events) this.dispatch(r.signature, r.slot, event);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'failed to handle gRPC transaction');
    }
  }

  private dispatch(signature: string, slot: number, event: PumpEvent): void {
    if (event.kind === 'create') this.stats.creates++;
    else if (event.kind === 'trade') this.stats.trades++;
    else if (event.kind === 'complete') this.stats.completes++;
    else if (event.kind === 'ammPool') this.stats.ammPools++;
    else this.stats.ammTrades++;
    this.stats.lastEventAt = Date.now();
    this.emit('event', { signature, slot, event } satisfies PumpEventEnvelope);
  }

  private isDuplicate(sig: string): boolean {
    if (this.recent.has(sig)) return true;
    this.recent.add(sig);
    this.recentOrder.push(sig);
    if (this.recentOrder.length > DEDUPE_WINDOW) this.recent.delete(this.recentOrder.shift()!);
    return false;
  }
}
