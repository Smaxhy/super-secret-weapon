/**
 * Real-time push to the dashboard.
 *
 * Connect to /ws?token=<jwt>. Every bus event (new token, safety result,
 * evaluation, trade, stats) is forwarded as JSON: { type, data }.
 */
import type { FastifyInstance } from 'fastify';
import { bus, type BusEvent } from '../lib/bus';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('websocket');

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { token?: string } }>('/ws', { websocket: true }, (socket, req) => {
    try {
      app.jwt.verify(req.query.token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const forward = (e: BusEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    bus.on('event', forward);
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000);
    socket.on('close', () => {
      bus.off('event', forward);
      clearInterval(ping);
    });
    log.debug('dashboard connected');
  });
}
