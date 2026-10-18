/**
 * Forex process (v15.4, owner: "if I push an update on crypto I don't want forex to be affected, same the other way
 * around"). Runs in its own container (`forex` in docker-compose.yml) from the same image: the hourly lab, the 15m / 1m
 * lab, the practice accounts, the calendar and headlines, and the /api/forex routes on FOREX_PORT (8081; Caddy sends
 * /api/forex* here). Shares Redis + Postgres with the crypto bot but no code path: a crypto-only push rebuilds only the
 * `bot` container, a forex-only push only this one (scripts/auto-update.sh + scripts/forex-paths.txt).
 */
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { env } from './config/env';
import { moduleLogger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { forexRoutes } from './api/forex-routes';
import { ForexLab } from './forex/lab';
import { FastLab } from './forex/fast';
import { Practice } from './forex/practice';
import { ForexCalendar } from './forex/calendar';
import { ForexHeadlines } from './forex/headlines';

const log = moduleLogger('forex-main');
const startedAt = Date.now();
const PORT = Number(process.env.FOREX_PORT ?? 8081) || 8081;

async function main(): Promise<void> {
  log.info({ version: process.env.GIT_SHA ?? 'dev' }, 'forex process starting');
  const forex = new ForexLab(redis);
  const practice = new Practice(redis);
  const fxCalendar = new ForexCalendar(redis);
  const fxNews = new ForexHeadlines(redis);
  forex.practice = practice;
  forex.calendar = fxCalendar;
  forex.headlines = fxNews;
  forex.start();
  practice.start();
  void fxCalendar.start();
  void fxNews.start();
  const fastFx = new FastLab(redis, forex);
  fastFx.start();

  let api: FastifyInstance | null = null;
  if (env.DASHBOARD_PASSWORD && env.JWT_SECRET) {
    const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
    api = app;
    const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
    // same secret as the crypto API: the dashboard's one login token works here too
    await app.register(jwt, { secret: env.JWT_SECRET });
    app.get('/api/forex/health', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { ok: true, version: process.env.GIT_SHA ?? 'dev', startedAt: new Date(startedAt).toISOString(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
    });
    await app.register(async (secured) => {
      secured.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          await req.jwtVerify();
        } catch {
          reply.code(401).send({ error: 'Not logged in' });
        }
      });
      await forexRoutes(secured, { forex, fastFx, practice, fxCalendar, fxNews }, redis);
    });
    app.setErrorHandler((error, req, reply) => {
      const err = error as { message?: string; statusCode?: number };
      const code = err.statusCode ?? 500;
      log.error({ url: req.url, err: err.message }, 'forex api error');
      reply.code(code).send({ error: code < 500 ? err.message : 'Internal error' });
    });
    await app.listen({ port: PORT, host: '0.0.0.0' });
    log.info({ port: PORT }, 'forex API listening');
  } else log.warn('DASHBOARD_PASSWORD / JWT_SECRET not set — forex API disabled');

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'forex process stopping');
    const hard = setTimeout(() => process.exit(0), 15_000);
    hard.unref();
    try {
      forex.stop();
      fastFx.stop();
      practice.stop();
      fxCalendar.stop();
      fxNews.stop();
      await api?.close();
      await fastFx.persist().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// a bug in one job must not take the forex process down; repeated crashes still exit (Docker restarts it)
let crashes: number[] = [];
const survive = (kind: string) => (err: unknown) => {
  log.error({ kind, err: (err as Error)?.message ?? String(err) }, 'uncaught error in the forex process');
  crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
  if (crashes.length >= 5) process.exit(1);
};
process.on('uncaughtException', survive('exception'));
process.on('unhandledRejection', survive('rejection'));

void main().catch((err: Error) => {
  log.error({ err: err.message }, 'forex process failed to start');
  process.exit(1);
});
