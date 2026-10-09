/**
 * One shared WebSocket to the bot. Components subscribe with `useBotEvents`.
 *
 * Staying connected (phones and proxies love to drop sockets quietly):
 *  - the server sends a heartbeat ('hb') every 20s; if nothing at all arrives
 *    for 45s the socket is treated as dead and replaced,
 *  - reconnects use exponential backoff with jitter (1s → 30s),
 *  - when the app comes back to the foreground (iOS suspends installed PWAs),
 *    the browser goes back online, or the page is restored, it reconnects
 *    immediately instead of waiting for the backoff,
 *  - after any reconnect every page refetches its data (refreshAll), and the
 *    'hello' message tells us if the bot itself restarted.
 *  - the badge only says "Offline" after 10s without a connection; shorter
 *    blips show "Reconnecting…".
 */
import { useEffect, useState } from 'react';
import { getApiUrl, getToken, setToken } from '../lib/api';
import { backoffDelay, connStatus, SILENT_TIMEOUT_MS, type ConnStatus } from '../lib/reconnect';
import { refreshAll } from '../lib/refresh';

export interface BotEvent {
  type: 'token' | 'safety' | 'evaluation' | 'trade' | 'stats' | 'positions' | 'hello' | 'hb';
  data: Record<string, unknown>;
}

type Listener = (e: BotEvent) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let socket: WebSocket | null = null;
let connected = false;
let disconnectedSince: number | null = null;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let everConnected = false;
let botStartedAt: string | null = null;
let botUptimeAt: { uptimeSec: number; at: number } | null = null;
let stopped = false;

let lastStatus: ConnStatus | null = null;
let connectStartedAt = 0;

function notify(onlyIfChanged = false) {
  const st = connStatus(connected, disconnectedSince, Date.now());
  if (onlyIfChanged && st === lastStatus) return;
  lastStatus = st;
  statusListeners.forEach((l) => l());
}

function setConnected(c: boolean) {
  connected = c;
  if (c) disconnectedSince = null;
  else if (disconnectedSince === null) disconnectedSince = Date.now();
  notify();
}

function wanted() {
  return !stopped && !!getToken() && listeners.size + statusListeners.size > 0;
}

function scheduleReconnect(immediate = false) {
  if (retry) clearTimeout(retry);
  retry = null;
  if (!wanted()) return;
  const delay = immediate ? 0 : backoffDelay(attempt++);
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, delay);
}

function dropSocket() {
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  if (connected || disconnectedSince === null) setConnected(false);
}

function connect() {
  const token = getToken();
  if (!token || socket || stopped) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${getApiUrl().replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  connectStartedAt = Date.now();
  ws.onopen = () => {
    attempt = 0;
    lastMessageAt = Date.now();
    const wasReconnect = everConnected;
    everConnected = true;
    setConnected(true);
    // We may have missed trades while away: refetch everything.
    if (wasReconnect) refreshAll();
  };
  ws.onmessage = (m) => {
    lastMessageAt = Date.now();
    if (m.data === 'pong') return;
    let e: BotEvent;
    try {
      e = JSON.parse(m.data as string) as BotEvent;
    } catch {
      return;
    }
    if (e.type === 'hello') {
      const started = typeof e.data.startedAt === 'string' ? e.data.startedAt : null;
      if (started && botStartedAt && started !== botStartedAt) refreshAll(); // bot restarted
      botStartedAt = started;
      if (typeof e.data.uptimeSec === 'number') botUptimeAt = { uptimeSec: e.data.uptimeSec, at: Date.now() };
      notify();
    }
    if (e.type === 'stats' && e.data.reset) refreshAll(); // paper account reset
    listeners.forEach((l) => l(e));
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return;
    socket = null;
    setConnected(false);
    if (ev.code === 4401) {
      // Login expired: back to the login screen.
      setToken(null);
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
  ensureWatchdog();
}

/** Replace a socket that has gone silent (no heartbeat) — common after phone sleep. */
function ensureWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    notify(true); // lets the badge move from "Reconnecting…" to "Offline" on time
    const now = Date.now();
    const silent = socket && connected && now - lastMessageAt > SILENT_TIMEOUT_MS;
    const stuck = socket && !connected && now - connectStartedAt > 15_000; // handshake hung
    if (silent || stuck) {
      dropSocket();
      scheduleReconnect(!!silent);
    }
  }, 2_000);
}

/** App came back / network returned: reconnect now, don't wait for the backoff. */
function wake() {
  if (!wanted()) return;
  if (socket && connected && Date.now() - lastMessageAt < SILENT_TIMEOUT_MS / 2) return;
  if (socket && !connected && Date.now() - connectStartedAt < 5_000) return; // already connecting
  dropSocket();
  attempt = 0;
  scheduleReconnect(true);
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', (e) => (e as PageTransitionEvent).persisted && wake());
  window.addEventListener('focus', wake);
  window.addEventListener('solbot-auth', () => {
    if (getToken()) {
      stopped = false;
      wake();
    }
  });
}

export function disconnectSocket() {
  stopped = true;
  if (retry) clearTimeout(retry);
  retry = null;
  dropSocket();
  everConnected = false;
}

export function useBotEvents(onEvent: Listener) {
  useEffect(() => {
    listeners.add(onEvent);
    stopped = false;
    connect();
    return () => {
      listeners.delete(onEvent);
    };
  }, [onEvent]);
}

/** 'online' | 'reconnecting' | 'offline' for the header badge and footer. */
export function useSocketStatus(): ConnStatus {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    statusListeners.add(l);
    stopped = false;
    connect();
    return () => {
      statusListeners.delete(l);
    };
  }, []);
  return connStatus(connected, disconnectedSince, Date.now());
}

/** Bot process uptime in seconds (from the last 'hello'), or null if unknown. */
export function useBotUptime(): number | null {
  useSocketStatus();
  return botUptimeAt ? botUptimeAt.uptimeSec + Math.round((Date.now() - botUptimeAt.at) / 1000) : null;
}
