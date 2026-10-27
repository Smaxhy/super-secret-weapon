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
  /** v17.12 forex: a trade is doing really well (its profit got locked, ⅔ of the way to its target) */
  fxGood: boolean;
  /** v17.12 forex: a trade closed in profit (losses follow `lossClose`) */
  fxClose: boolean;
  /** v27.30: a bot (forex or coin) opened a trade */
  fxOpen: boolean;
  /** v27.30: Monday's summary of last week (forex + coin bot); v27.32 also Sunday's "ready for Monday" line */
  fxWeek: boolean;
}
export const DEFAULT_PUSH_SETTINGS: PushSettings = { profitClose: true, minProfitSol: 0, lossClose: false, takeProfit: false, fxGood: true, fxClose: true, fxOpen: true, fxWeek: true };

export interface PushMessage {
  title: string;
  body: string;
  /** Opens this dashboard route when tapped. */
  url: string;
  tag?: string;
}

const fxUsd = (x: number) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`;
const FX_WHY: Record<string, string> = { stop: 'its stop', target: 'its target', signal: "its strategy's exit", manual: 'closed by hand', 'stop-out': 'margin call', spike: 'a big spike its way (sold into it)' };

/** v17.12 Pure: the notification for a forex trade event, or null when the owner doesn't want it. */
export function fxMessageFor(n: Extract<BusEvent, { type: 'fxTrade' }>['data'], s: PushSettings): PushMessage | null {
  const who = n.acct === 'bot' ? 'Forex bot' : n.acct === 'cbot' ? 'Coin bot' : 'Your trade';
  const dir = n.side === 1 ? 'long' : 'short';
  const url = n.acct === 'bot' ? '/forex/bot' : n.acct === 'cbot' ? '/crypto/bot' : '/forex/practice';
  // v27.32: the Sunday "ready for Monday" line rides the weekly-summary switch
  if (n.kind === 'ready') return s.fxWeek ? { title: n.ok === false ? `⚠️ ${who} not ready for Monday` : `✅ ${who} ready for Monday`, body: (n.reason ?? '').replace(/^\S+ (Forex|Coin) bot (NOT )?ready for Monday — /, ''), url, tag: `fx-ready-${n.acct}` } : null;
  // v27.65: the Discord copier went quiet / came back (`ok` true = back) — always sent, missing his calls costs money
  if (n.kind === 'copier') return { title: n.ok ? '✅ Kojiro copier back online' : '⚠️ Kojiro copier is offline', body: n.reason ?? '', url, tag: 'fx-copier' };
  if (n.kind === 'week') return s.fxWeek ? { title: `📒 ${who} last week ${fxUsd(n.pnlUsd)}`, body: n.reason ?? '', url, tag: `fx-week-${n.acct}` } : null;
  const pair = n.pair.length === 6 ? `${n.pair.slice(0, 3)}/${n.pair.slice(3)}` : n.pair;
  const safe = typeof n.stopPnlUsd === 'number' ? ` — even if it turns, it closes ${fxUsd(n.stopPnlUsd)}` : '';
  if (n.kind === 'open') {
    if (!s.fxOpen || n.acct === 'me') return null;
    const name = n.pair.length === 6 ? `${n.pair.slice(0, 3)}/${n.pair.slice(3)}` : n.pair;
    const risk = typeof n.stopPnlUsd === 'number' ? `stop ${fxUsd(n.stopPnlUsd)}` : 'no stop';
    const tgt = typeof n.targetPnlUsd === 'number' ? ` · target ${fxUsd(n.targetPnlUsd)}` : '';
    const pct = typeof n.riskPct === 'number' ? ` (${n.riskPct}% of the account at risk)` : '';
    return { title: `📈 ${who} ${n.side === 1 ? 'bought' : 'sold'} ${name}`, body: `${n.strategy ?? 'trade'}${n.tf ? ` ${n.tf}` : ''} · ${risk}${tgt}${pct}`, url, tag: `fx-open-${n.acct}-${n.pair}` };
  }
  if (n.kind === 'lock') return s.fxGood ? { title: `🔒 ${pair} ${fxUsd(n.pnlUsd)} — profit locked`, body: `${who} (${dir}): the stop moved past the entry and now trails the price${safe}.`, url, tag: `fx-${n.acct}-${n.pair}` } : null;
  if (n.kind === 'run') return s.fxGood ? { title: `🚀 ${pair} ${fxUsd(n.pnlUsd)} — two thirds of the way to the target`, body: `${who} (${dir}) is doing really well${safe}.`, url, tag: `fx-${n.acct}-${n.pair}` } : null;
  const why = FX_WHY[n.reason ?? ''] ?? n.reason ?? 'closed';
  if (n.pnlUsd > 0 && s.fxClose) return { title: `💰 ${pair} closed ${fxUsd(n.pnlUsd)}`, body: `${who} (${dir}) · ${why}`, url, tag: `fx-close-${n.acct}-${n.pair}` };
  if (n.pnlUsd <= 0 && s.lossClose) return { title: `🔻 ${pair} closed ${fxUsd(n.pnlUsd)}`, body: `${who} (${dir}) · ${why}`, url, tag: `fx-close-${n.acct}-${n.pair}` };
  return null;
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
    // Apple (and some others) reject a made-up sender like mailto:…@localhost — use the dashboard's real https address.
    webpush.setVapidDetails(process.env.PUSH_SUBJECT?.trim() || 'https://smaxhy.github.io/super-secret-weapon/', keys.publicKey!, keys.privateKey!);
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
    fxGood: typeof patch.fxGood === 'boolean' ? patch.fxGood : cur.fxGood,
    fxClose: typeof patch.fxClose === 'boolean' ? patch.fxClose : cur.fxClose,
    fxOpen: typeof patch.fxOpen === 'boolean' ? patch.fxOpen : cur.fxOpen,
    fxWeek: typeof patch.fxWeek === 'boolean' ? patch.fxWeek : cur.fxWeek,
    minProfitSol: Number.isFinite(Number(patch.minProfitSol)) ? Math.max(0, Math.min(100, Number(patch.minProfitSol))) : cur.minProfitSol,
  };
  await redis.set(SETTINGS, JSON.stringify(next));
  return next;
}

/** Send to every subscribed phone; drops subscriptions the push service says are gone or no longer valid. */
export async function sendAll(m: PushMessage): Promise<{ sent: number; failed: number; subscribers: number; errors: string[] }> {
  await publicKey();
  const subs = Object.values(await redis.hgetall(SUBS));
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
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
        const e = err as { statusCode?: number; body?: string; message?: string };
        const host = (() => {
          try {
            return new URL(sub.endpoint).host;
          } catch {
            return '?';
          }
        })();
        errors.push(`${host}: ${e.statusCode ?? ''} ${(e.body || e.message || '').toString().slice(0, 140)}`.trim());
        // 404/410 = gone; 401/403 = made with another key / bad token → the phone must subscribe again.
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 401 || e.statusCode === 403) await unsubscribe(sub.endpoint).catch(() => undefined);
        log.warn({ code: e.statusCode, host, body: e.body, err: e.message }, 'push failed');
      }
    }),
  );
  return { sent, failed, subscribers: subs.length, errors };
}

/** Is this exact subscription saved on the server? */
export async function hasSubscription(endpoint: string): Promise<boolean> {
  return (await redis.hexists(SUBS, endpoint)) === 1;
}

/** Listen for trades and notify (call once at start). */
export function startPushNotifier(): () => void {
  const listener = (e: BusEvent) => {
    if (e.type !== 'trade' && e.type !== 'fxTrade') return;
    void (async () => {
      if (!(await subscriberCount())) return;
      const s = await getSettings();
      const m = e.type === 'trade' ? messageFor(e.data, s) : fxMessageFor(e.data, s);
      if (m) await sendAll(m);
    })().catch((err: Error) => log.warn({ err: err.message }, 'notification not sent'));
  };
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
