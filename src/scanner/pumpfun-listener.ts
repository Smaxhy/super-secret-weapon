/**
 * Pump.fun WebSocket listener.
 *
 * Opens a WebSocket to Helius and calls `logsSubscribe` for every transaction
 * that touches the Pump.fun program. Each notification carries the
 * transaction's log lines; we decode the Create / Trade / Complete events from
 * them and emit them to the rest of the bot.
 *
 * Why raw `ws` instead of web3.js's onLogs()? Control. We need:
 *   - a heartbeat that notices a silently-dead socket (it happens),
 *   - automatic reconnect with backoff,
 *   - counters for the dashboard (events/sec, reconnects, decode errors).
 *
 * Usage:
 *   const listener = new PumpFunListener(wsUrl);
 *   listener.on('event', (env) => { ... });
 *   listener.start();
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import { redactUrl } from '../config/env';
import type { PumpEvent, PumpEventEnvelope } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { decodeEventsFromInnerInstructions, parsePumpLogs, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';

const log = moduleLogger('pumpfun-listener');

/** Send a ping this often to keep the connection alive. */
const PING_INTERVAL_MS = 20_000;
/** If nothing arrives for this long, assume the socket is dead and reconnect. */
const SILENCE_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Remember this many recent signatures to drop duplicate notifications. */
const DEDUPE_WINDOW = 5_000;

export interface ListenerStats {
  connected: boolean;
  connectedSince: number | null;
  reconnects: number;
  notifications: number;
  creates: number;
  trades: number;
  completes: number;
  ammPools: number;
  ammTrades: number;
  decodeErrors: number;
  truncatedLogs: number;
  fallbackFetches: number;
  lastEventAt: number | null;
}

interface LogsNotification {
  jsonrpc: '2.0';
  method: 'logsNotification';
  params: {
    subscription: number;
    result: {
      context: { slot: number };
      value: { signature: string; err: unknown; logs: string[] | null };
    };
  };
}

export declare interface PumpFunListener {
  on(event: 'event', listener: (env: PumpEventEnvelope) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: (downSinceMs: number) => void): this;
}

export class PumpFunListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoffMs = 1_000;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  /** One subscription for the bonding curve program, one for PumpSwap (post-migration trading). */
  private readonly subscriptions: Array<{ id: number; program: string }> = [
    { id: 1, program: PUMP_PROGRAM_ID },
    { id: 2, program: PUMP_AMM_PROGRAM_ID },
  ];
  private readonly recentSigs = new Set<string>();
  private readonly recentSigOrder: string[] = [];

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
    private readonly wsUrl: string,
    /** Fetch full transactions (Helius RPC credits) when a create's event is missing. Off when another source supplies launches. */
    private readonly fetchMissingCreates = true,
  ) {
    super();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.stats.connected = false;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private connect(): void {
    log.info({ url: redactUrl(this.wsUrl) }, 'connecting to Helius WebSocket');
    const ws = new WebSocket(this.wsUrl, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1_000;
      this.lastMessageAt = Date.now();
      this.stats.connected = true;
      this.stats.connectedSince = Date.now();
      this.subscribe();
      this.startHeartbeat();
      log.info('connected');
      this.emit('connected');
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(data.toString());
    });

    // A pong counts as "alive" too.
    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'websocket error');
    });

    ws.on('close', (code, reason) => {
      const downSince = this.stats.connectedSince ?? Date.now();
      this.stats.connected = false;
      this.clearTimers();
      if (this.stopped) return;
      log.warn({ code, reason: reason.toString() }, `websocket closed, reconnecting in ${this.backoffMs}ms`);
      this.emit('disconnected', downSince);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects++;
      this.connect();
    }, this.backoffMs);
    // Exponential backoff: 1s, 2s, 4s ... capped at 30s.
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        log.warn('no data for 60s — socket looks dead, forcing reconnect');
        this.ws.terminate(); // triggers 'close' → reconnect
        return;
      }
      this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private subscribe(): void {
    for (const s of this.subscriptions) {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: s.id, method: 'logsSubscribe', params: [{ mentions: [s.program] }, { commitment: 'confirmed' }] }));
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('received non-JSON message');
      return;
    }
    const m = msg as Record<string, unknown>;

    // Reply to one of our subscribe requests.
    const sub = this.subscriptions.find((s) => s.id === m.id);
    if (sub) {
      if (m.error) {
        log.error({ error: m.error, program: sub.program }, 'logsSubscribe was rejected');
        return;
      }
      log.info({ subscriptionId: m.result, program: sub.program === PUMP_PROGRAM_ID ? 'pump.fun' : 'pumpswap' }, 'subscribed');
      return;
    }

    if (m.method === 'logsNotification') {
      try {
        this.handleLogs(msg as LogsNotification);
      } catch (err) {
        // A bad message must never take the listener down.
        log.error({ err: (err as Error).message }, 'failed to handle logs notification');
      }
    }
  }

  private handleLogs(n: LogsNotification): void {
    const { value, context } = n.params.result;
    this.stats.notifications++;

    // Failed transactions changed nothing on-chain — ignore them.
    if (value.err || !value.logs) return;
    if (this.isDuplicate(value.signature)) return;

    const parsed = parsePumpLogs(value.logs);
    this.stats.decodeErrors += parsed.decodeErrors;
    if (parsed.truncated) this.stats.truncatedLogs++;

    const hasCreate = parsed.events.some((e) => e.kind === 'create');
    if (parsed.sawCreateInstruction && !hasCreate && this.fetchMissingCreates) {
      // The create ran but its event wasn't in the logs (truncated logs or an
      // emit_cpi-style event). Fetch the full transaction and decode it there.
      void this.fallbackFetch(value.signature, context.slot);
      return;
    }

    for (const event of parsed.events) this.dispatch(value.signature, context.slot, event);
  }

  private async fallbackFetch(signature: string, slot: number): Promise<void> {
    this.stats.fallbackFetches++;
    try {
      const tx = await getConnection().getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const datas = extractPumpInnerInstructionData(tx);
      const events = decodeEventsFromInnerInstructions(datas);
      if (events.length === 0 && tx?.meta?.logMessages) {
        // getTransaction returns un-truncated logs — try those too.
        events.push(...parsePumpLogs(tx.meta.logMessages).events);
      }
      if (events.length === 0) {
        log.warn({ signature }, 'create instruction seen but no CreateEvent could be decoded');
      }
      for (const event of events) this.dispatch(signature, slot, event);
    } catch (err) {
      log.warn({ signature, err: (err as Error).message }, 'fallback transaction fetch failed');
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
    if (this.recentSigs.has(sig)) return true;
    this.recentSigs.add(sig);
    this.recentSigOrder.push(sig);
    if (this.recentSigOrder.length > DEDUPE_WINDOW) {
      this.recentSigs.delete(this.recentSigOrder.shift()!);
    }
    return false;
  }
}

/** Collect base58 data of every Pump.fun inner instruction in a parsed transaction. */
function extractPumpInnerInstructionData(tx: ParsedTransactionWithMeta | null): string[] {
  const out: string[] = [];
  for (const group of tx?.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const pd = ix as PartiallyDecodedInstruction;
      if (pd.programId?.toBase58() === PUMP_PROGRAM_ID && typeof pd.data === 'string') out.push(pd.data);
    }
  }
  return out;
}
