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
import { runBacktest } from '../learner/backtester';
import { replayStatus, startReplay } from '../learner/replay-runner';
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
import { learningSince } from '../learner/labels';
import { recentChanges } from '../lib/change-log';
import { redis } from '../lib/redis';

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
    // Loss autopsy: what keeps going wrong + which kinds of trades are blocked. POST = run it now.
    secured.get('/api/autopsy', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return deps.autopsy?.snapshot() ?? null;
    });
    secured.post('/api/autopsy/run', async () => (await deps.autopsy?.run()) ?? null);
    // Best hours / days to trade (market motion + our results) and what that means right now.
    // What the bot changed about how it trades (learners' adjustments, newest first) + how each strategy enters now.
    secured.get('/api/changes', async () => ({ changes: await recentChanges(60), entryStyles: deps.autopsy?.snapshot()?.entryStyles ?? [], tuning: deps.autopsy?.snapshot()?.tuning ?? [] }));
    // The brain: win model, discovered rules, budget allocation, entry styles, change log.
    secured.get('/api/brain', async () => (deps.brain ? deps.brain.snapshot(false) : null));
    secured.get('/api/timing', async () => deps.timing?.snapshot() ?? null);
    // Shadow trades: what the coins it didn't buy would have done (since the last paper reset).
    secured.get('/api/moonshot', async () => (deps.moonshot ? deps.moonshot.report() : null));
    secured.get('/api/shadow', async () => (deps.shadow ? deps.shadow.report((await learningSince(redis))?.getTime() ?? 0) : null));
    // AI coach: insights + rules under test / live, spend; POST = review now.
    secured.get('/api/ai-coach', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return deps.aiCoach ? deps.aiCoach.snapshot() : null;
    });
    secured.post<{ Body: { deep?: boolean } | null }>('/api/ai-coach/run', async (req) => (deps.aiCoach ? deps.aiCoach.review(true, req.body?.deep === true, false, true) : { ran: false, why: 'AI coach not running' }));
    // Tips to the brain: the owner talks to it; the AI coach turns each tip into live rules / setting changes and answers.
    secured.get('/api/brain/tips', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { tips: deps.aiCoach ? await deps.aiCoach.tips() : [], hasKey: !!process.env.ANTHROPIC_API_KEY, lastError: deps.aiCoach?.lastError ?? null };
    });
    secured.post<{ Body: { text?: unknown } | null }>('/api/brain/tips', async (req, reply) => {
      const text = String(req.body?.text ?? '').trim();
      if (text.length < 3) return reply.code(400).send({ error: 'Write a tip first' });
      if (!deps.aiCoach) return reply.code(503).send({ error: 'AI coach not running' });
      const { tip, review } = await deps.aiCoach.addTip(text);
      // Wait a little for the answer (a review usually takes 10–60 s); the page keeps polling after that.
      const r = await Promise.race([review, new Promise<null>((res) => setTimeout(() => res(null), 45_000))]);
      return { ok: true, tip, review: r ?? { ran: false, why: 'still thinking — the answer shows up here in a minute' } };
    });
    secured.delete<{ Params: { id: string } }>('/api/brain/tips/:id', async (req, reply) => {
      if (!deps.aiCoach || !(await deps.aiCoach.removeTip(req.params.id))) return reply.code(404).send({ error: 'tip not found' });
      return { ok: true };
    });
    // Backtest: replay the archived paper trades' real price paths with the live exits + every exit-lab variant.
    let bt: { at: number; days: number; report: unknown } | null = null;
    let btRunning: Promise<unknown> | null = null;
    secured.get<{ Querystring: { days?: string; refresh?: string } }>('/api/backtest', async (req) => {
      const days = Math.max(1, Math.min(14, Number(req.query.days ?? 7) || 7));
      if (bt && bt.days === days && Date.now() - bt.at < 10 * 60_000 && req.query.refresh !== '1') return bt.report;
      btRunning ??= runBacktest(days).then((report) => (bt = { at: Date.now(), days, report })).finally(() => (btRunning = null));
      await btRunning;
      return bt?.report ?? null;
    });
    // v11.5 replay: the bot's rules over the recorded market, in a child process (the event loop stays free).
    secured.get('/api/replay', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return replayStatus();
    });
    secured.post<{ Body: { from?: string; to?: string; policy?: string; set?: Record<string, unknown> | string[] } }>('/api/replay', async (req, reply) => {
      const r = startReplay(req.body ?? {});
      reply.code(r.ok ? 202 : 409);
      return r;
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
