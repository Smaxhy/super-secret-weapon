/**
 * One shared WebSocket to the bot. Components subscribe with `useBotEvents`.
 * Reconnects automatically (1s → 30s backoff).
 */
import { useEffect, useState } from 'react';
import { getApiUrl, getToken } from '../lib/api';

export interface BotEvent {
  type: 'token' | 'safety' | 'evaluation' | 'trade' | 'stats' | 'positions';
  data: Record<string, unknown>;
}

type Listener = (e: BotEvent) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(c: boolean) => void>();
let socket: WebSocket | null = null;
let connected = false;
let backoff = 1000;
let retry: ReturnType<typeof setTimeout> | null = null;

function setConnected(c: boolean) {
  connected = c;
  statusListeners.forEach((l) => l(c));
}

function connect() {
  const token = getToken();
  if (!token || socket) return;
  const url = `${getApiUrl().replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    backoff = 1000;
    setConnected(true);
  };
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as BotEvent;
      listeners.forEach((l) => l(e));
    } catch {
      /* ignore */
    }
  };
  ws.onclose = (ev) => {
    socket = null;
    setConnected(false);
    if (ev.code === 4401 || listeners.size + statusListeners.size === 0) return;
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

export function disconnectSocket() {
  if (retry) clearTimeout(retry);
  socket?.close();
  socket = null;
}

export function useBotEvents(onEvent: Listener) {
  useEffect(() => {
    listeners.add(onEvent);
    connect();
    return () => {
      listeners.delete(onEvent);
    };
  }, [onEvent]);
}

export function useSocketStatus(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    statusListeners.add(setC);
    connect();
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}
