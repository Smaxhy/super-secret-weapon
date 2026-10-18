/**
 * Forex API routes (v15.4: served by the forex process, `src/forex-main.ts`, on its own port; Caddy sends /api/forex*
 * there). Same JWT as the crypto API, so one dashboard login works for both.
 */
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { marketClock } from '../forex/calendar';
import type { ForexCalendar } from '../forex/calendar';
import type { FastLab } from '../forex/fast';
import type { ForexHeadlines } from '../forex/headlines';
import type { ForexLab } from '../forex/lab';
import { loadOanda, maskToken, oandaReady, saveOanda, testOanda } from '../forex/oanda';
import { buildPlan } from '../forex/plan';
import { pnlUsd, riskSummary, type Practice } from '../forex/practice';
import { STRATEGIES } from '../forex/strategies';

export interface ForexDeps {
  forex: ForexLab | null;
  fastFx: FastLab | null;
  practice: Practice | null;
  fxCalendar: ForexCalendar | null;
  fxNews: ForexHeadlines | null;
}

/** Register every /api/forex route on an authenticated scope. */
export async function forexRoutes(secured: FastifyInstance, deps: ForexDeps, redis: Redis): Promise<void> {
  // v12 forex lab: last report (backtest + paper) and a Run button.
  secured.get('/api/forex', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { running: (deps.forex?.isRunning() ?? false) || (deps.fastFx?.isRunning() ?? false), last: deps.forex ? await deps.forex.last() : null, fast: deps.fastFx?.report ?? null };
  });
  secured.post<{ Body: { refresh?: boolean } }>('/api/forex/run', async (req, reply) => {
    if (!deps.forex) {
      reply.code(503);
      return { ok: false, error: 'forex lab not running' };
    }
    if (deps.forex.isRunning()) return { ok: true, already: true };
    // the hourly lab first (it builds the market read the 15m / 1m test needs), then the 15m / 1m test
    void deps.forex
      .run(req.body?.refresh !== false)
      .then(() => deps.fastFx?.evaluate())
      .catch(() => undefined);
    return { ok: true };
  });
  // v12.1 forex practice account
  secured.get('/api/forex/practice', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!deps.practice) return { account: null, quotes: {} };
    return deps.practice.snapshot((req.query as { acct?: string }).acct === 'bot' ? 'bot' : 'me');
  });
  secured.get('/api/forex/bot', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const [snap, logRaw, chosenRaw, droppedRaw, portfolioRaw, judgeRaw, convRaw] = await Promise.all([deps.practice ? deps.practice.snapshot('bot') : null, redis.get('fx:bot:log').catch(() => null), redis.get('fx:bot:chosen').catch(() => null), redis.get('fx:bot:dropped').catch(() => null), redis.get('fx:portfolio').catch(() => null), redis.get('fx:judge:report').catch(() => null), redis.get('fx:conviction').catch(() => null)]);
    const parse = <T,>(x: string | null, d: T): T => {
      try {
        return x ? (JSON.parse(x) as T) : d;
      } catch {
        return d;
      }
    };
    const mids: Record<string, number> = {};
    for (const x of Object.values(snap?.quotes ?? {})) mids[x.id] = x.mid;
    const now = Date.now();
    const plan =
      deps.forex && snap
        ? buildPlan({
            now,
            clock: marketClock(now),
            oanda: oandaReady(await loadOanda()),
            markets: deps.forex.marketsNow,
            mood: deps.forex.moodNow,
            fastFiring: deps.fastFx?.firing ?? {},
            chosen: [...deps.forex.chosen, ...(deps.fastFx?.chosen ?? [])],
            names: Object.fromEntries(STRATEGIES.map((x) => [x.id, x.name])),
            positions: snap.account.positions,
            resume: snap.account.resume ?? [],
            equityUsd: snap.account.equityUsd,
            lastSync: deps.forex.lastSync,
            labOpen: Object.assign({}, deps.forex.labOpen, ...Object.values(deps.fastFx?.labOpen ?? {})),
            runs: deps.forex.runs,
            upcoming: (pair) => deps.fxCalendar?.upcoming(pair, now) ?? [],
            blockNow: (pair) => deps.fxCalendar?.blockFor(pair, now) ?? deps.fxNews?.blockFor(pair) ?? null,
            pnlAt: (p, price) => pnlUsd(p, price, mids),
          })
        : null;
    return {
      plan,
      account: snap?.account ?? null,
      risk: snap ? riskSummary(snap.account, mids, snap.account.equityUsd) : null,
      portfolio: parse(portfolioRaw, null as unknown),
      judge: parse(judgeRaw, null as unknown),
      // v15.2: bigger size when more sure — hourly charts + the 15m / 1m charts
      conviction: { hourly: parse(convRaw, null as unknown), ...(deps.fastFx?.report?.conviction ?? {}) },
      log: parse(logRaw, [] as Array<{ t: number; e: string }>),
      chosen: parse(chosenRaw, [] as string[]),
      dropped: parse(droppedRaw, [] as string[]),
      clock: marketClock(Date.now()),
    };
  });
  secured.post<{ Body: { pair?: string; side?: number; marginUsd?: number; leverage?: number; stop?: number | null; target?: number | null } }>('/api/forex/practice/open', async (req, reply) => {
    const b = req.body ?? {};
    const r = deps.practice ? await deps.practice.open({ pair: String(b.pair ?? ''), side: b.side === -1 ? -1 : 1, marginUsd: Number(b.marginUsd), leverage: Number(b.leverage), stop: b.stop == null || b.stop === ('' as unknown) ? null : Number(b.stop), target: b.target == null || b.target === ('' as unknown) ? null : Number(b.target) }) : { ok: false, error: 'not running' };
    if (!r.ok) reply.code(400);
    return r;
  });
  secured.post<{ Body: { id?: string; acct?: string } }>('/api/forex/practice/close', async (req, reply) => {
    const r = deps.practice ? await deps.practice.close(req.body?.id === 'all' ? 'all' : String(req.body?.id ?? ''), req.body?.acct === 'bot' ? 'bot' : 'me') : { ok: false, error: 'not running' };
    if (!r.ok) reply.code(400);
    return r;
  });
  secured.post<{ Body: { id?: string; stop?: number | null; target?: number | null } }>('/api/forex/practice/edit', async (req, reply) => {
    const b = req.body ?? {};
    const r = deps.practice ? await deps.practice.edit(String(b.id ?? ''), b.stop == null ? null : Number(b.stop), b.target == null ? null : Number(b.target)) : { ok: false, error: 'not running' };
    if (!r.ok) reply.code(400);
    return r;
  });
  secured.get('/api/forex/candles', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = req.query as { pair?: string; tf?: string; count?: string };
    const tf = (['S5', 'M1', 'M5', 'M15', 'H1', 'H4', 'D'] as const).find((x) => x === q.tf) ?? 'M5';
    if (!deps.practice) return { source: 'yahoo', bars: [] };
    return deps.practice.candles(String(q.pair ?? 'EURUSD'), tf, Math.min(500, Math.max(30, Number(q.count ?? 200) || 200)));
  });
  secured.get('/api/forex/calendar', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const c = deps.fxCalendar?.get() ?? { at: 0, events: [] };
    const now = Date.now();
    const heads = (deps.fxNews?.get() ?? []).slice(0, 80);
    return { at: c.at, clock: marketClock(now), headlines: heads, events: c.events.filter((e) => e.t >= now - 12 * 3_600_000 && e.t <= now + 8 * 86_400_000 && e.impact !== 'Non-Economic') };
  });
  // OANDA demo token = a free DATA feed only (no trading through it); masked on read.
  secured.get('/api/forex/oanda', async () => {
    const s = await loadOanda();
    return { connected: oandaReady(s), token: maskToken(s.token), accountId: s.accountId ? `${s.accountId.slice(0, 4)}…${s.accountId.slice(-3)}` : null, env: s.env ?? 'practice', updatedAt: s.updatedAt ?? null };
  });
  secured.put<{ Body: { token?: string; accountId?: string; env?: string; clear?: boolean } }>('/api/forex/oanda', async (req, reply) => {
    const b = req.body ?? {};
    if (b.clear) {
      await saveOanda({ updatedAt: new Date().toISOString() });
      return { ok: true };
    }
    const token = String(b.token ?? '').trim();
    const accountId = String(b.accountId ?? '').trim();
    if (!/^[A-Za-z0-9-]{20,}$/.test(token) || !/^[0-9-]{6,}$/.test(accountId)) {
      reply.code(400);
      return { ok: false, error: 'paste the API token and the account id (like 101-004-1234567-001)' };
    }
    const next = { token, accountId, env: b.env === 'live' ? ('live' as const) : ('practice' as const), updatedAt: new Date().toISOString() };
    const t = await testOanda(next);
    if (!t.ok) {
      reply.code(400);
      return { ok: false, error: `OANDA said no: ${t.error}` };
    }
    await saveOanda(next);
    return { ok: true };
  });
  secured.post<{ Body: { startUsd?: number; acct?: string } }>('/api/forex/practice/reset', async (req) => {
    await deps.practice?.reset(Number(req.body?.startUsd ?? 1000) || 1000, req.body?.acct === 'bot' ? 'bot' : 'me');
    return { ok: true };
  });
}
