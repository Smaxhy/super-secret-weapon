/**
 * Bot controls (dashboard Controls page).
 *   GET  /api/controls               current settings
 *   PUT  /api/controls               { trading?, entry?, keywords?, paper? } — validated, partial
 *   POST /api/controls/pause         { paused: boolean }
 *   POST /api/controls/kill          stop new entries AND sell every open position now
 *   POST /api/controls/resume        clear pause + kill switch
 *   POST /api/controls/reset-paper   { confirm: "RESET", startingBalanceSol?: 0.1–1000 } wipe paper trades/positions
 *                                    (open ones too) and optionally set a new starting balance
 *   GET  /api/controls/feed          the trade feed in use + what is saved (masked, never the key itself)
 *   PUT  /api/controls/feed          { tradesWsUrl?, grpcEndpoint?, grpcToken?, useGrpc? } save a paid feed, then restart
 *   POST /api/controls/add-funds     { sol: 0.01–1000 } add paper SOL without resetting anything
 *   GET  /api/controls/rules         buy rules per strategy (config/editable.ts) with current values
 *   PUT  /api/controls/rules         { key, value } change one of them (validated against its limits)
 *   POST /api/positions/:id/sell     manual sell of one position
 */
import type { FastifyInstance } from 'fastify';
import { getConfig, updateConfigSection } from '../../config/runtime-config';
import { recordEvent } from '../../lib/bot-events';
import { prisma } from '../../lib/prisma';
import { getSettings, hasSubscription, isSubscription, publicKey, saveSettings, sendAll, subscribe, subscriberCount, unsubscribe } from '../../lib/push';
import { activeFeed, loadFeedSettings, maskUrl, saveFeedSettings, validateFeed } from '../../lib/feed-settings';
import { applyEdit } from '../../config/apply-edit';
import { EDITABLE, getPath } from '../../config/editable';
import { DEFAULT_CONFIG } from '../../config/default';
import type { ApiDeps } from '../deps';
import { addPaperFunds, isResetting, MAX_ADD_SOL, MAX_START_SOL, MIN_START_SOL, parseStartingBalance, resetPaperAccount } from '../paper-reset';

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
};
const words = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => x.length > 0 && x.length <= 30))].slice(0, 100) : undefined;
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function controlsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get('/api/controls', async () => {
    const c = getConfig();
    return { state: c.state, trading: c.trading, entry: c.entry, keywords: c.keywords, paper: c.paper, copy: c.copy };
  });

  app.put<{ Body: Record<string, Record<string, unknown>> }>('/api/controls', async (req) => {
    const b = req.body ?? {};
    const changed: string[] = [];
    if (b.trading) {
      const t = b.trading;
      const size = num(t.maxPositionSol, 0.01, 10);
      const patch = defined({
        maxPositionSol: size,
        // Raising the size raises the safety ceiling with it.
        maxPositionSolCeiling: size !== undefined ? Math.max(size, 0.01) : undefined,
        maxConcurrentPositions: num(t.maxConcurrentPositions, 1, 20),
        enabledStrategies: t.enabledStrategies && typeof t.enabledStrategies === 'object' ? { ...getConfig().trading.enabledStrategies, ...(t.enabledStrategies as object) } : undefined,
      });
      await updateConfigSection('trading', patch as never);
      changed.push(...Object.keys(patch));
    }
    if (b.entry) {
      const e = b.entry;
      const patch = defined({
        minCombinedScore: num(e.minCombinedScore, 30, 95),
        minVolumeUsd: num(e.minVolumeUsd, 0, 1_000_000),
        minMarketCapUsd: num(e.minMarketCapUsd, 0, 10_000_000),
        minTotalFeesSol: num(e.minTotalFeesSol, 0, 100),
        maxBundlePct: num(e.maxBundlePct, 0, 100),
        maxTop10Pct: num(e.maxTop10Pct, 0, 100),
        maxDevHoldingPct: num(e.maxDevHoldingPct, 0, 100),
        requireTwitter: typeof e.requireTwitter === 'boolean' ? e.requireTwitter : undefined,
        riskyEntry: typeof e.riskyEnabled === 'boolean' ? { ...getConfig().entry.riskyEntry, enabled: e.riskyEnabled } : undefined,
      });
      await updateConfigSection('entry', patch as never);
      changed.push(...Object.keys(patch));
    }
    if (b.keywords) {
      const patch = defined({ boost: words(b.keywords.boost), block: words(b.keywords.block) });
      await updateConfigSection('keywords', patch as never);
      changed.push(...Object.keys(patch).map((k) => `keywords.${k}`));
    }
    if (b.paper) {
      const patch = defined({ startingBalanceSol: num(b.paper.startingBalanceSol, MIN_START_SOL, MAX_START_SOL) });
      await updateConfigSection('paper', patch as never);
      changed.push(...Object.keys(patch));
    }
    if (changed.length) void recordEvent({ module: 'controls', type: 'settings_changed', message: `Settings changed: ${changed.join(', ')}` });
    const c = getConfig();
    return { ok: true, changed, state: c.state, trading: c.trading, entry: c.entry, keywords: c.keywords, paper: c.paper };
  });

  app.post<{ Body: { paused?: boolean } }>('/api/controls/pause', async (req) => {
    const paused = req.body?.paused !== false;
    await updateConfigSection('state', { paused });
    void recordEvent({ level: 'WARN', module: 'controls', type: paused ? 'paused' : 'unpaused', message: paused ? 'Bot paused (no new entries)' : 'Bot resumed' });
    return { ok: true, state: getConfig().state };
  });

  app.post('/api/controls/kill', async () => {
    await updateConfigSection('state', { killSwitch: true, paused: true });
    const open = await prisma.position.findMany({ where: { status: 'OPEN' }, select: { id: true } });
    for (const p of open) await deps.sellManager.closeNow(p.id, 'KILL_SWITCH').catch(() => undefined);
    void recordEvent({ level: 'WARN', module: 'controls', type: 'kill_switch', message: `Kill switch: entries stopped, ${open.length} positions sold` });
    return { ok: true, closed: open.length, state: getConfig().state };
  });

  app.post('/api/controls/resume', async () => {
    await updateConfigSection('state', { killSwitch: false, paused: false });
    void recordEvent({ module: 'controls', type: 'resumed', message: 'Bot resumed' });
    return { ok: true, state: getConfig().state };
  });

  app.post<{ Body: { confirm?: string; startingBalanceSol?: unknown } }>('/api/controls/reset-paper', async (req, reply) => {
    if (req.body?.confirm !== 'RESET') return reply.code(400).send({ error: 'Type RESET to confirm' });
    const start = parseStartingBalance(req.body?.startingBalanceSol);
    if (start === null) return reply.code(400).send({ error: `Starting balance must be ${MIN_START_SOL}–${MAX_START_SOL} SOL` });
    if (isResetting()) return reply.code(409).send({ error: 'A reset is already running' });
    // Open positions are frozen and removed too (entries are paused while it runs).
    return resetPaperAccount({ startingBalanceSol: start });
  });

  // Phone notifications (Web Push to the installed app).
  app.get<{ Querystring: { endpoint?: string } }>('/api/push', async (req) => ({
    publicKey: await publicKey(),
    subscribers: await subscriberCount(),
    settings: await getSettings(),
    // Lets the phone check that the server really has its subscription (else it re-subscribes).
    known: typeof req.query.endpoint === 'string' ? await hasSubscription(req.query.endpoint) : null,
  }));
  app.post<{ Body: { subscription?: unknown } }>('/api/push/subscribe', async (req, reply) => {
    if (!isSubscription(req.body?.subscription)) return reply.code(400).send({ error: 'Not a valid push subscription' });
    await subscribe(req.body.subscription);
    return { ok: true, subscribers: await subscriberCount() };
  });
  app.post<{ Body: { endpoint?: unknown } }>('/api/push/unsubscribe', async (req) => {
    if (typeof req.body?.endpoint === 'string') await unsubscribe(req.body.endpoint);
    return { ok: true, subscribers: await subscriberCount() };
  });
  app.put<{ Body: Record<string, unknown> }>('/api/push/settings', async (req) => ({ ok: true, settings: await saveSettings(req.body ?? {}) }));
  app.post('/api/push/test', async () => sendAll({ title: '💰 $TEST closed +0.123 SOL (paper)', body: 'This is how a profit notification looks', url: '/history', tag: 'test' }));

  // Paid data feed pasted from the phone: stored in this server's database only, used after a restart.
  app.get('/api/controls/feed', async () => {
    const saved = await loadFeedSettings();
    const ls = deps.listenerStats();
    return {
      active: activeFeed(),
      connected: ls?.connected ?? false,
      tradesPerMinHint: ls?.trades ?? 0,
      saved: { tradesWsUrl: maskUrl(saved.tradesWsUrl), grpcEndpoint: maskUrl(saved.grpcEndpoint), hasGrpcToken: !!saved.grpcToken, useGrpc: !!saved.useGrpc, updatedAt: saved.updatedAt ?? null },
    };
  });
  app.put<{ Body: { tradesWsUrl?: unknown; grpcEndpoint?: unknown; grpcToken?: unknown; useGrpc?: unknown } }>('/api/controls/feed', async (req, reply) => {
    const v = validateFeed(req.body ?? {}, await loadFeedSettings());
    if (!v.ok) return reply.code(400).send({ error: v.error });
    await saveFeedSettings(v.value);
    void recordEvent({ level: 'WARN', module: 'controls', type: 'feed_changed', message: `Data feed changed from the dashboard (trades: ${maskUrl(v.value.tradesWsUrl) ?? 'free default'}, gRPC: ${v.value.useGrpc ? maskUrl(v.value.grpcEndpoint) : 'off'}) — restarting to use it` });
    // Docker restarts the bot right away (restart: unless-stopped); the new feed is read at start.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1_500).unref();
    return { ok: true, restarting: true };
  });

  app.post<{ Body: { sol?: unknown } }>('/api/controls/add-funds', async (req, reply) => {
    if (deps.executor.mode !== 'PAPER') return reply.code(400).send({ error: 'Only the paper account can be topped up' });
    const sol = Number(req.body?.sol);
    if (!Number.isFinite(sol) || sol < 0.01 || sol > MAX_ADD_SOL) return reply.code(400).send({ error: `Amount must be 0.01–${MAX_ADD_SOL} SOL` });
    return addPaperFunds(Math.round(sol * 1e4) / 1e4);
  });

  app.get('/api/controls/rules', async () => {
    const c = getConfig();
    return { settings: EDITABLE.map((e) => ({ ...e, value: getPath(c, e.key), default: getPath(DEFAULT_CONFIG, e.key) })) };
  });

  app.put<{ Body: { key?: unknown; value?: unknown } }>('/api/controls/rules', async (req, reply) => {
    const key = String(req.body?.key ?? '');
    const r = await applyEdit(key, req.body?.value, 'owner', 'changed by you on the Controls page');
    if (!r.ok) return reply.code(400).send({ error: r.error });
    void recordEvent({ module: 'controls', type: 'settings_changed', message: `Settings changed: ${r.text}` });
    return { ok: true, key, value: r.value };
  });

  app.post<{ Params: { id: string } }>('/api/positions/:id/sell', async (req, reply) => {
    const p = await prisma.position.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!p || p.status !== 'OPEN') return reply.code(404).send({ error: 'No open position with that id' });
    await deps.sellManager.closeNow(req.params.id, 'MANUAL');
    return { ok: true };
  });
}
