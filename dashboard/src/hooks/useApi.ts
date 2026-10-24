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
  // Path the screen wants now: a slow answer for an older path (e.g. a day tapped before) is dropped.
  const current = useRef(path);
  current.current = path;

  // v27.41: a slow server must not get a second copy of the same request while the first one is still out
  // (a reload asked for meanwhile, e.g. after a button press, runs once the answer is in)
  const inFlight = useRef<string | null>(null);
  const again = useRef(false);
  const load = useCallback(async (queue = false): Promise<void> => {
    if (!path) return;
    if (inFlight.current === path) {
      if (queue) again.current = true; // timer polls are simply skipped
      return;
    }
    inFlight.current = path;
    again.current = false;
    try {
      const d = await api<T>(path);
      if (current.current !== path) return;
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (inFlight.current === path) inFlight.current = null;
      if (alive.current) setLoading(false);
    }
    if (again.current && alive.current && current.current === path) {
      again.current = false;
      return load(true);
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
    const offRefresh = onRefreshAll(() => void load(true));
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
      debounce.current = setTimeout(() => void load(true), 400);
    },
    [key, load],
  );
  useBotEvents(onEvent);

  const reload = useCallback(() => load(true), [load]);
  return { data, error, loading, reload };
}
