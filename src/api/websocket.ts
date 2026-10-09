/**
 * Real-time push to the dashboard.
 *
 * Connect to /ws?token=<jwt>. Every bus event (new token, safety result,
 * evaluation, trade, stats) is forwarded as JSON: { type, data }.
 *
 * Keep-alive (phones, proxies and NATs silently drop idle sockets):
 *  - on connect the server sends { type: 'hello', data: { startedAt } } so the
 *    dashboard can tell a bot restart from a network blip,
 *  - every HEARTBEAT_MS it sends { type: 'hb' } (browsers can't see protocol
 *    pings, so the client watches for these) and a protocol ping; a client that
 *    hasn't answered the previous ping is terminated,
 *  - a client that sends the text "ping" gets "pong" back,
 *  - slow clients are skipped while their send buffer is full, so one stalled
 *    phone can't grow the bot's memory.
 */
import type { FastifyInstance } from 'fastify';
import { bus, type BusEvent } from '../lib/bus';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('websocket');

export const HEARTBEAT_MS = 20_000;
/** Don't queue more than this per client; drop events until it drains. */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** When this process started (unix ms). Changes on every restart. */
export const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

const json = (e: unknown) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Minimal socket surface the keep-alive needs (lets tests use a fake). */
export interface HeartbeatSocket {
  readonly readyState: number;
  readonly OPEN: number;
  bufferedAmount?: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
}

/**
 * One heartbeat round. Returns false when the socket was terminated because
 * it never answered the previous ping.
 */
export function heartbeat(socket: HeartbeatSocket, state: { alive: boolean }, now = Date.now()): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (!state.alive) {
    socket.terminate();
    return false;
  }
  state.alive = false;
  try {
    socket.ping();
    socket.send(json({ type: 'hb', data: { t: now } }));
  } catch {
    /* closing */
  }
  return true;
}

/** Send unless the socket is closed or its buffer is backed up. */
export function safeSend(socket: HeartbeatSocket, payload: string): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if ((socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return false;
  try {
    socket.send(payload);
    return true;
  } catch {
    return false;
  }
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { token?: string } }>('/ws', { websocket: true }, (socket, req) => {
    try {
      app.jwt.verify(req.query.token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const state = { alive: true };
    const forward = (e: BusEvent) => void safeSend(socket, json(e));
    bus.on('event', forward);
    socket.on('pong', () => (state.alive = true));
    socket.on('message', (m: Buffer | string) => {
      state.alive = true;
      if (String(m) === 'ping') safeSend(socket, 'pong');
    });
    socket.on('error', (err: Error) => log.debug({ err: err.message }, 'dashboard socket error'));
    const timer = setInterval(() => {
      if (!heartbeat(socket, state)) clearInterval(timer);
    }, HEARTBEAT_MS);
    socket.on('close', () => {
      bus.off('event', forward);
      clearInterval(timer);
    });
    safeSend(socket, json({ type: 'hello', data: { startedAt: new Date(PROCESS_STARTED_AT).toISOString(), uptimeSec: Math.round(process.uptime()) } }));
    log.debug('dashboard connected');
  });
}
