/**
 * Phone notifications (owner: "notify me when a trade closes in profit, with the amount").
 *
 * Standard Web Push to the installed dashboard app (PWA) — no extra app, no API key: the server makes its own
 * VAPID key pair once and keeps it in the database (BotConfig row `_push`, never in git). Phones subscribe from
 * the Controls page; subscriptions live in Redis (`push:subs`). Dead subscriptions (404 / 410) are dropped.
 * Works on Android (Chrome) and iPhone (iOS 16.4+, the app must be added to the home screen).
 */
import webpush from 'web-push';
import { redis } from './redis';
import { prisma } from './prisma';
import { bus, type BusEvent } from './bus';
import { moduleLogger } from './logger';

const log = moduleLogger('push');
const KEYS_ROW = '_push';
const SUBS = 'push:subs';
const SETTINGS = 'push:settings';

export interface PushSettings {
  /** A trade closed in profit. */
  profitClose: boolean;
  /** Only when the trade made at least this much SOL. */
  minProfitSol: number;
  /** A trade closed at a loss (off by default). */
  lossClose: boolean;
  /** A take-profit tier was sold while the trade keeps running. */
  takeProfit: boolean;
}
export const DEFAULT_PUSH_SETTINGS: PushSettings = { profitClose: true, minProfitSol: 0, lossClose: false, takeProfit: false };

export interface PushMessage {
  title: string;
  body: string;
  /** Opens this dashboard route when tapped. */
  url: string;
  tag?: string;
}

/** Pure: the notification for a trade event, or null when the owner doesn't want it. */
export function messageFor(e: Extract<BusEvent, { type: 'trade' }>['data'], s: PushSettings): PushMessage | null {
  if (e.side !== 'SELL') return null;
  const sym = e.symbol ? `$${e.symbol}` : 'a coin';
  const paper = e.mode === 'PAPER' ? ' (paper)' : '';
  const sol = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)} SOL`;
  const why = (e.reason ?? '').split(':')[0]!.replace(/_/g, ' ').toLowerCase();
  if (e.closed && typeof e.totalPnlSol === 'number') {
    const peak = e.peakMultiple && e.peakMultiple > 1 ? ` · peak ${e.peakMultiple.toFixed(2)}x` : '';
    if (e.totalPnlSol > 0 && s.profitClose && e.totalPnlSol >= s.minProfitSol) {
      return { title: `💰 ${sym} closed ${sol(e.totalPnlSol)}${paper}`, body: `${why}${peak}`, url: '/history', tag: `close-${e.mint}` };
    }
    if (e.totalPnlSol <= 0 && s.lossClose) {
      return { title: `🔻 ${sym} closed ${sol(e.totalPnlSol)}${paper}`, body: `${why}${peak}`, url: '/history', tag: `close-${e.mint}` };
    }
    return null;
  }
  if (!e.closed && s.takeProfit && typeof e.pnlSol === 'number' && e.pnlSol > 0) {
    return { title: `✅ ${sym} took profit ${sol(e.pnlSol)}${paper}`, body: 'part sold, the rest keeps running', url: '/positions', tag: `tp-${e.mint}` };
  }
  return null;
}

let ready: Promise<string> | null = null;

/** The server's public VAPID key (made once, stored in the DB). */
export function publicKey(): Promise<string> {
  ready ??= (async () => {
    const row = await prisma.botConfig.findUnique({ where: { key: KEYS_ROW } });
    let keys = row?.value as { publicKey?: string; privateKey?: string } | null;
    if (!keys?.publicKey || !keys.privateKey) {
      keys = webpush.generateVAPIDKeys();
      await prisma.botConfig.upsert({ where: { key: KEYS_ROW }, update: { value: keys }, create: { key: KEYS_ROW, value: keys } });
    }
    webpush.setVapidDetails('mailto:bot@localhost', keys.publicKey!, keys.privateKey!);
    return keys.publicKey!;
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

interface Sub { endpoint: string; keys: { p256dh: string; auth: string } }

/** Pure: is this a usable browser push subscription? */
export function isSubscription(x: unknown): x is Sub {
  const s = x as Sub;
  return !!s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
}

export async function subscribe(sub: Sub): Promise<void> {
  await redis.hset(SUBS, sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }));
}
export async function unsubscribe(endpoint: string): Promise<void> {
  await redis.hdel(SUBS, endpoint);
}
export async function subscriberCount(): Promise<number> {
  return redis.hlen(SUBS);
}

export async function getSettings(): Promise<PushSettings> {
  try {
    const raw = await redis.get(SETTINGS);
    return { ...DEFAULT_PUSH_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<PushSettings>) : {}) };
  } catch {
    return DEFAULT_PUSH_SETTINGS;
  }
}
export async function saveSettings(patch: Partial<PushSettings>): Promise<PushSettings> {
  const cur = await getSettings();
  const next: PushSettings = {
    profitClose: typeof patch.profitClose === 'boolean' ? patch.profitClose : cur.profitClose,
    lossClose: typeof patch.lossClose === 'boolean' ? patch.lossClose : cur.lossClose,
    takeProfit: typeof patch.takeProfit === 'boolean' ? patch.takeProfit : cur.takeProfit,
    minProfitSol: Number.isFinite(Number(patch.minProfitSol)) ? Math.max(0, Math.min(100, Number(patch.minProfitSol))) : cur.minProfitSol,
  };
  await redis.set(SETTINGS, JSON.stringify(next));
  return next;
}

/** Send to every subscribed phone; drops subscriptions the push service says are gone. */
export async function sendAll(m: PushMessage): Promise<{ sent: number; failed: number }> {
  await publicKey();
  const subs = Object.values(await redis.hgetall(SUBS));
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (raw) => {
      let sub: Sub;
      try {
        sub = JSON.parse(raw) as Sub;
      } catch {
        return;
      }
      try {
        await webpush.sendNotification(sub, JSON.stringify(m), { TTL: 3600, urgency: 'high', timeout: 10_000 });
        sent++;
      } catch (err) {
        failed++;
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await unsubscribe(sub.endpoint).catch(() => undefined);
        else log.warn({ code, err: (err as Error).message }, 'push failed');
      }
    }),
  );
  return { sent, failed };
}

/** Listen for trades and notify (call once at start). */
export function startPushNotifier(): () => void {
  const listener = (e: BusEvent) => {
    if (e.type !== 'trade') return;
    void (async () => {
      if (!(await subscriberCount())) return;
      const m = messageFor(e.data, await getSettings());
      if (m) await sendAll(m);
    })().catch((err: Error) => log.warn({ err: err.message }, 'notification not sent'));
  };
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
