/** Fetch JSON from the API, optionally re-fetching every `refreshMs`. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export function useApi<T>(path: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

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
    const t = refreshMs > 0 ? setInterval(() => void load(), refreshMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [load, refreshMs]);

  return { data, error, loading, reload: load };
}
