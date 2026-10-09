/**
 * "Refetch everything" signal. Every useApi hook listens; call refreshAll()
 * after a paper reset, when the WebSocket comes back, or when the bot restarted.
 */
const EVENT = 'solbot-refresh-all';

let pending: ReturnType<typeof setTimeout> | null = null;

/** Coalesces bursts (reconnect + restart notice arriving together) into one refetch. */
export function refreshAll(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    window.dispatchEvent(new Event(EVENT));
  }, 150);
}

export function onRefreshAll(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
