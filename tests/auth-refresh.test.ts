import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { describe, expect, it } from 'vitest';
import { registerAuth } from '../src/api/auth';

async function app() {
  const a = Fastify();
  await a.register(jwt, { secret: 'x'.repeat(40) });
  await registerAuth(a);
  await a.ready();
  return a;
}

describe('login refresh (v27.53)', () => {
  it('a valid token gets a fresh 7-day one', async () => {
    const a = await app();
    const old = a.jwt.sign({ sub: 'owner' }, { expiresIn: '1h' });
    const r = await a.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${old}` } });
    expect(r.statusCode).toBe(200);
    const { token } = r.json() as { token: string };
    const p = a.jwt.decode<{ exp: number; iat: number }>(token)!;
    expect(p.exp - p.iat).toBe(7 * 86_400);
    await a.close();
  });

  it('no token or an expired one is refused', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    const expired = a.jwt.sign({ sub: 'owner', iat: Math.floor(Date.now() / 1000) - 8 * 86_400 }, { expiresIn: '7d' });
    expect((await a.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${expired}` } })).statusCode).toBe(401);
    const forged = Fastify();
    await forged.register(jwt, { secret: 'y'.repeat(40) });
    const bad = forged.jwt.sign({ sub: 'owner' });
    expect((await a.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${bad}` } })).statusCode).toBe(401);
    await a.close();
  });
});
