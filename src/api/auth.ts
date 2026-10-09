/**
 * Single-user JWT auth.
 *
 * POST /api/auth/login { password } → { token }. The password is
 * DASHBOARD_PASSWORD from .env. Tokens last 7 days. Every other /api route
 * (and the WebSocket) requires `Authorization: Bearer <token>`.
 *
 * Brute-force protection: 5 wrong passwords per IP per 15 minutes.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { recordEvent } from '../lib/bot-events';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function passwordMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(env.DASHBOARD_PASSWORD ?? '');
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const now = Date.now();
    const rec = attempts.get(req.ip);
    if (rec && rec.resetAt > now && rec.count >= MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many attempts — try again in 15 minutes' });
    }
    if (!passwordMatches(String(req.body?.password ?? ''))) {
      const next = rec && rec.resetAt > now ? { ...rec, count: rec.count + 1 } : { count: 1, resetAt: now + WINDOW_MS };
      attempts.set(req.ip, next);
      void recordEvent({ level: 'WARN', module: 'api', type: 'login_failed', message: `Failed dashboard login from ${req.ip}` });
      return reply.code(401).send({ error: 'Wrong password' });
    }
    attempts.delete(req.ip);
    return { token: app.jwt.sign({ sub: 'owner' }, { expiresIn: '7d' }) };
  });
}

/** preHandler for protected routes. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Not logged in' });
  }
}
