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
import { copyReplayStatus, startCopyReplay } from '../learner/copy-replay-runner';
import { cohortTestRunning, lastCohortTest, runCohortTest } from '../learner/cohort-test';
import { marketClock } from '../forex/calendar';
import { loadOanda, maskToken, oandaReady, saveOanda, testOanda } from '../forex/oanda';
import { feedHealth, feeds as fxFeeds } from '../forex/feeds';
import { pythConf, pythKey, pythLive, savePythConf, testPythKey } from '../forex/pyth';
import { RISK_MODES, isRiskMode, ledgerSummary, pnlUsd, riskSummary } from '../forex/practice';
import { buildPlan } from '../forex/plan';
import { FX_CONFIG } from '../forex/lab';
import { botStatus, dayTrades, parsePnlQuery, pnlReport } from '../forex/pnl';
import { STRATEGIES } from '../forex/strategies';
import { moneyMap } from '../learner/money-map';
import { DEFAULT_CONFIG as DEFAULTS } from '../config/default';
import { getConfig as cfgNow } from '../config/runtime-config';
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
    // v11.17 "Where's the money": every coin it checked (bought / shadow / outcome), split by feature, with what it did next.
    secured.get('/api/money-map', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const q = req.query as { hours?: string; strategy?: string; source?: string };
      const h = Number(q.hours ?? 48);
      const source = q.source === 'real' || q.source === 'skipped' || q.source === 'filtered' ? q.source : 'all';
      return moneyMap(redis, { hours: Number.isFinite(h) ? Math.min(168, Math.max(1, h)) : 48, strategy: q.strategy || null, source });
    });
    // v11.18 copy replay (back in v11.22 with "method" mode): who is actually making money, walk-forward on the tape.
    secured.get('/api/copy-replay', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return copyReplayStatus();
    });
    secured.post<{ Body: { from?: string; to?: string; sizeSol?: number; method?: boolean } }>('/api/copy-replay/run', async (req, reply) => {
      const r = startCopyReplay(req.body ?? {});
      if (!r.ok) reply.code(409);
      return r;
    });
    // v11.22 cohort test: the BOOST trade and the survivor trade on every graduate's PumpSwap tape (child process).
    secured.get('/api/cohort-test', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { running: cohortTestRunning(), last: await lastCohortTest() };
    });
    secured.post<{ Body: { days?: number } }>('/api/cohort-test/run', async (req, reply) => {
      if (cohortTestRunning()) {
        reply.code(409);
        return { ok: false, error: 'a cohort test is already running' };
      }
      const days = Math.min(14, Math.max(1, Number(req.body?.days ?? 5) || 5));
      const now = Date.now();
      void runCohortTest(now - days * 86_400_000, now).catch(() => undefined);
      return { ok: true, days };
    });
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
      const [snap, logRaw, chosenRaw, droppedRaw, portfolioRaw, judgeRaw, convRaw, sniperRaw, rollRaw, deskRaw] = await Promise.all([deps.practice ? deps.practice.snapshot('bot') : null, redis.get('fx:bot:log').catch(() => null), redis.get('fx:bot:chosen').catch(() => null), redis.get('fx:bot:dropped').catch(() => null), redis.get('fx:portfolio').catch(() => null), redis.get('fx:judge:report').catch(() => null), redis.get('fx:conviction').catch(() => null), redis.get('fx:sniper').catch(() => null), redis.get('fx:roll').catch(() => null), redis.get('fx:desk').catch(() => null)]);
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
      let planError: string | null = null;
      const oandaOn = oandaReady(await loadOanda());
      const fx = deps.forex;
      let plan: ReturnType<typeof buildPlan> | null = null;
      try {
        plan =
          fx && snap
            ? buildPlan({
              now,
              clock: marketClock(now),
              oanda: oandaOn,
              markets: fx.marketsNow,
              mood: fx.moodNow,
              fastFiring: deps.fastFx?.firing ?? {},
              chosen: [...fx.chosen, ...(deps.fastFx?.chosen ?? [])],
              fastCharts: FX_CONFIG.botFastCharts,
              names: Object.fromEntries(STRATEGIES.map((x) => [x.id, x.name])),
              positions: snap.account.positions,
              resume: snap.account.resume ?? [],
              equityUsd: snap.account.equityUsd,
              lastSync: fx.lastSync,
              labOpen: Object.assign({}, fx.labOpen, ...Object.values(deps.fastFx?.labOpen ?? {})),
              runs: fx.runs,
              upcoming: (pair) => deps.fxCalendar?.upcoming(pair, now) ?? [],
              blockNow: (pair) => deps.fxCalendar?.blockFor(pair, now) ?? deps.fxNews?.blockFor(pair) ?? null,
              pnlAt: (p, price) => pnlUsd(p, price, mids),
            })
            : null;
      } catch (err) {
        planError = (err as Error).message;
        log.warn({ err: planError }, 'forex plan failed to build');
      }
      return {
        plan,
        // v18.12: why the plan is missing (the Today card says so instead of going quiet)
        planError: planError ?? (!deps.forex ? 'forex lab not running' : !snap ? 'bot account unreadable' : null),
        account: snap ? { ...snap.account, ledger: undefined } : null,
        risk: snap ? riskSummary(snap.account, mids, snap.account.equityUsd) : null,
        // v17: what the bot itself made per strategy:chart, in R (its own trades only — never rewritten)
        ledger: snap ? ledgerSummary(snap.account) : {},
        // v17: the last hourly lab run's error (null after a good run)
        labError: deps.forex?.lastError ?? null,
        portfolio: parse(portfolioRaw, null as unknown),
        judge: parse(judgeRaw, null as unknown),
        // v15.2: bigger size when more sure — hourly charts + the 15m / 1m charts
        conviction: { hourly: parse(convRaw, null as unknown), ...(deps.fastFx?.report?.conviction ?? {}) },
        // v16: the sniper's vote level and whether it proved itself
        sniper: parse(sniperRaw, null as unknown),
        // v17: the rolling picker (re-picks every week; live only once it beats random pickers on unseen weeks)
        rolling: parse(rollRaw, null as unknown),
        // v18: the quant desk (vol-targeted forecast system) and what it would hold today
        desk: parse(deskRaw, null as unknown),
        chooser: deps.forex?.chooser ?? 'verdict',
        names: Object.fromEntries(STRATEGIES.map((x) => [x.id, x.name])),
        log: parse(logRaw, [] as Array<{ t: number; e: string }>),
        chosen: parse(chosenRaw, [] as string[]),
        dropped: parse(droppedRaw, [] as string[]),
        clock: marketClock(Date.now()),
        // v15.6: how hard the bot trades (normal / aggressive / max) + what each level means
        riskMode: snap?.account.riskMode ?? 'normal',
        riskModes: RISK_MODES,
      };
    });
    // v17.8 (owner: "see much easier if the bot is in a trade … a PnL and calendar view"): is the bot in a trade (no plan
    // building), and the P&L + calendar of either practice account from its durable close log; days in the viewer's clock
    const fxNames = () => Object.fromEntries(STRATEGIES.map((x) => [x.id, x.name]));
    secured.get('/api/forex/bot/status', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return botStatus(deps.practice ? (await deps.practice.snapshot('bot')).account : null, fxNames());
    });
    // v17.14 (owner: "an active diagnosis of what the goal of the trade is … an AI that scans all active trades and
    // analyses the price action"): every open trade's live read (rules, free) + its newest AI read (display only)
    secured.get('/api/forex/trades/read', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const acct = (req.query as { acct?: string }).acct === 'me' ? 'me' : 'bot';
      if (!deps.tradeWatch) return { trades: [], ai: null };
      return deps.tradeWatch.reads(acct);
    });
    secured.post<{ Body: { id?: string; acct?: string } }>('/api/forex/trades/ai', async (req, reply) => {
      const id = typeof req.body?.id === 'string' ? req.body.id : '';
      if (!id || !deps.tradeWatch) {
        reply.code(400);
        return { ok: false, error: !id ? 'id is needed' : 'not running' };
      }
      return deps.tradeWatch.askNow(req.body?.acct === 'me' ? 'me' : 'bot', id);
    });
    secured.get('/api/forex/pnl', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const q = parsePnlQuery(req.query as Record<string, unknown>);
      if (!q.ok) {
        reply.code(400);
        return { ok: false, error: q.error };
      }
      if (!deps.practice) return pnlReport(q.acct, [], null, Date.now(), q.tz);
      // the account first (its tick may book a close), then the log that close went into
      const snap = await deps.practice.snapshot(q.acct);
      return pnlReport(q.acct, await deps.practice.pnlRows(q.acct), snap.account, Date.now(), q.tz, fxNames());
    });
    secured.get('/api/forex/pnl/day', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const q = parsePnlQuery(req.query as Record<string, unknown>, true);
      if (!q.ok) {
        reply.code(400);
        return { ok: false, error: q.error };
      }
      const day = q.day!;
      return { day, trades: deps.practice ? dayTrades(await deps.practice.pnlRows(q.acct), day, q.tz, fxNames()) : [] };
    });
    // v15.6: owner switches how hard the bot account trades
    secured.post<{ Body: { mode?: string } }>('/api/forex/bot/mode', async (req, reply) => {
      const mode = req.body?.mode;
      if (!isRiskMode(mode)) {
        reply.code(400);
        return { ok: false, error: 'mode must be normal, aggressive or max' };
      }
      if (!deps.practice) {
        reply.code(503);
        return { ok: false, error: 'not running' };
      }
      return { ok: true, mode: await deps.practice.setRiskMode(mode) };
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
    // v17.11: the owner's profit lock on their own trades (the bot account always uses it)
    secured.post<{ Body: { on?: boolean } }>('/api/forex/practice/lock', async (req, reply) => {
      if (typeof req.body?.on !== 'boolean') {
        reply.code(400);
        return { ok: false, error: 'on must be true or false' };
      }
      if (!deps.practice) {
        reply.code(503);
        return { ok: false, error: 'not running' };
      }
      return { ok: true, on: await deps.practice.setProfitLock(req.body.on) };
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
    // v17: every free data feed's health + how up to date each market's prices are (1h + 15m + 1m)
    secured.get('/api/forex/feeds', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const now = Date.now();
      const clock = marketClock(now);
      const ages = [...Object.values(deps.forex?.dataAge ?? {}), ...Object.values(deps.fastFx?.dataAge ?? {}).flatMap((m) => Object.values(m ?? {}))];
      return {
        at: now,
        open: clock.open,
        feeds: feedHealth(fxFeeds.snapshot(), { now, open: clock.open, oanda: oandaReady(await loadOanda()), pyth: !!pythKey(), paused: (p) => fxFeeds.pausedUntil(p) }),
        dataAge: ages,
        calendarBlind: deps.fxCalendar?.blind(now) ?? null,
        labError: deps.forex?.lastError ?? null,
      };
    });
    // OANDA demo token = a free DATA feed only (no trading through it); masked on read.
    // v17.12: the Pyth API key, pasted on the dashboard: tested on Pyth first, kept in this server's DB, shown masked
    secured.get('/api/forex/pyth', async () => {
      const c = pythConf();
      return { connected: !!c.key, source: c.source, key: maskToken(c.key || null), host: c.key ? new URL(c.base).host : null, flowing: pythLive.flowing(), lastTickAt: pythLive.lastTickAt || null, pairs: pythLive.pairs.length };
    });
    secured.put<{ Body: { key?: string; clear?: boolean } }>('/api/forex/pyth', async (req, reply) => {
      const b = req.body ?? {};
      if (b.clear) {
        await savePythConf(null);
        pythLive.restart();
        return { ok: true };
      }
      const key = String(b.key ?? '').trim();
      if (!/^[A-Za-z0-9._~+/=-]{16,300}$/.test(key)) {
        reply.code(400);
        return { ok: false, error: 'paste the API key from Pyth Terminal' };
      }
      const t = await testPythKey(key);
      if (!t.ok) {
        reply.code(400);
        return { ok: false, error: `Pyth said no: ${t.error}` };
      }
      await savePythConf({ key, base: t.base });
      pythLive.restart();
      return { ok: true, host: new URL(t.base).host, pairs: t.pairs };
    });
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
    // v11.16 AI meme reader: today's reads, spend, cache hits, last 20 verdicts.
    secured.get('/api/meme', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return deps.meme ? await deps.meme.snapshot() : { enabled: false, hasKey: false, model: null, today: 0, spentTodayUsd: 0, budgetUsd: 0, cacheHits: 0, recent: [] };
    });
    // v11.15 policy tournament: Sniper variants vs the current settings on the same live candidates.
    secured.get('/api/tournament', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return deps.tournament ? await deps.tournament.report() : { enabled: false, at: Date.now(), baseline: 'zero', rows: [], open: 0, minResults: 0, offers: [] };
    });
    // v11.13 self-improving loop: state + last experiments; Run = one experiment now (replays take minutes → answers early).
    secured.get('/api/loop', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return deps.selfLoop ? { enabled: true, ...(await deps.selfLoop.state()) } : { enabled: false };
    });
    secured.post('/api/loop/run', async () => {
      if (!deps.selfLoop) return { ran: false, why: 'the loop is not running' };
      const run = deps.selfLoop.runOnce(true);
      const quick = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      return quick ?? { ran: true, why: 'started — proving the idea on the recorded market (a few minutes)' };
    });
    // Best hours / days to trade (market motion + our results) and what that means right now.
    // What the bot changed about how it trades (learners' adjustments, newest first) + how each strategy enters now.
    secured.get('/api/changes', async () => ({ changes: await recentChanges(60), entryStyles: deps.autopsy?.snapshot()?.entryStyles ?? [], tuning: deps.autopsy?.snapshot()?.tuning ?? [] }));
    // The brain: win model, discovered rules, budget allocation, entry styles, change log.
    secured.get('/api/brain', async () => (deps.brain ? deps.brain.snapshot(false) : null));
    secured.get('/api/timing', async () => deps.timing?.snapshot() ?? null);
    // Shadow trades: what the coins it didn't buy would have done (since the last paper reset).
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
