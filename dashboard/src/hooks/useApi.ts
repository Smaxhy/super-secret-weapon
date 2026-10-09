/**
 * Fetch JSON from the API and keep it fresh:
 *  - instantly (debounced) when a matching real-time event arrives over the WebSocket,
 *  - every `refreshMs` as a fallback,
 *  - whenever the app comes back to the foreground (phone unlocked, tab re-opened),
 *  - whenever refreshAll() fires (paper reset, reconnect, bot restart).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { onRefreshAll } from '../lib/refresh';
import { useBotEvents, type BotEvent } from './useWebSocket';

export function useApi<T>(path: string | null, refreshMs = 0, liveOn: Array<BotEvent['type']> = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void load();
    const t = refreshMs > 0 ? setInterval(() => document.visibilityState === 'visible' && void load(), refreshMs) : null;
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    // Paper reset, WebSocket reconnect or bot restart → refetch.
    const offRefresh = onRefreshAll(() => void load());
    return () => {
      offRefresh();
      alive.current = false;
      if (t) clearInterval(t);
      if (debounce.current) clearTimeout(debounce.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, refreshMs]);

  const key = liveOn.join(',');
  const onEvent = useCallback(
    (e: BotEvent) => {
      if (!key.split(',').includes(e.type)) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(), 400);
    },
    [key, load],
  );
  useBotEvents(onEvent);

  return { data, error, loading, reload: load };
}
