/**
 * Dashboard API (Fastify).
 *
 *   POST /api/auth/login        → JWT (public)
 *   GET  /api/health            → { ok, version, startedAt, uptimeSec, eventLoopLagMs } (public, for uptime checks;
 *                                  startedAt changes on every restart → tells restarts from network blips)
 *   GET  /api/overview          → headline numbers + P&L curve
 *   GET  /api/detections[/:mint]→ live feed / token breakdown
 *   GET  /api/positions         → open positions
 *   GET  /api/trades            → trade history (filterable)
 *   GET  /api/performance       → charts data
 *   GET  /api/scanner-stats     → market overview
 *   WS   /ws?token=…            → real-time events
 *
 * Disabled (with a warning) unless DASHBOARD_PASSWORD and JWT_SECRET are set.
 */
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { moduleLogger } from '../lib/logger';
import { registerAuth, requireAuth } from './auth';
import type { ApiDeps } from './deps';
import { detectionsRoutes } from './routes/detections';
import { performanceRoutes } from './routes/performance';
import { positionsRoutes } from './routes/positions';
import { scannerStatsRoutes } from './routes/scanner-stats';
import { tradesRoutes } from './routes/trades';
import { walletsRoutes } from './routes/wallets';
import { learnerRoutes } from './routes/learner';
import { controlsRoutes } from './routes/controls';
import { swingRoutes } from './routes/swing';
import { registerWebSocket } from './websocket';
import { healthSnapshot, requestUpdate, updateStatus } from '../lib/bot-health';

const log = moduleLogger('api');

const bigintSafe = (payload: unknown) => JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export async function startApi(deps: ApiDeps): Promise<FastifyInstance | null> {
  if (!env.DASHBOARD_PASSWORD || !env.JWT_SECRET) {
    log.warn('DASHBOARD_PASSWORD / JWT_SECRET not set in .env — dashboard API disabled');
    return null;
  }
  if (env.JWT_SECRET.length < 32) log.warn('JWT_SECRET is short — use at least 32 random characters');

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  app.setReplySerializer(bigintSafe);

  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(websocket);

  app.get('/api/health', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Public: just enough to tell a restart from a network blip and which code version runs.
    const h = await healthSnapshot();
    return { ok: true, version: h.version, startedAt: h.startedAt, uptimeSec: h.uptimeSec, eventLoopLagMs: h.eventLoopLagMs };
  });
  await registerAuth(app);
  await registerWebSocket(app);

  // Everything registered inside this block requires a valid token.
  await app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);
    // Logged-in only: restarts, why the last run ended, recent errors, memory.
    secured.get('/api/system', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return healthSnapshot();
    });
    // Update button: ask the VPS updater to pull + rebuild now (force = rebuild even without new code).
    secured.get('/api/update', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return updateStatus();
    });
    secured.post('/api/update', async (req) => {
      const force = (req.body as { force?: boolean } | null)?.force === true;
      await requestUpdate(force);
      return { ok: true, force, message: 'Asked the server to update — it starts within a minute' };
    });
    await detectionsRoutes(secured, deps);
    await positionsRoutes(secured, deps);
    await tradesRoutes(secured, deps);
    await performanceRoutes(secured, deps);
    await scannerStatsRoutes(secured, deps);
    await walletsRoutes(secured, deps);
    await learnerRoutes(secured);
    await controlsRoutes(secured, deps);
    await swingRoutes(secured, deps);
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as { message?: string; statusCode?: number };
    const code = err.statusCode ?? 500;
    log.error({ url: req.url, err: err.message }, 'api error');
    reply.code(code).send({ error: code < 500 ? err.message : 'Internal error' });
  });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  log.info({ port: env.API_PORT, origins }, '🌐 dashboard API listening');
  return app;
}
