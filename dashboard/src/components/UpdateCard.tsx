/**
 * Updates: which code the bot and this app run, and buttons to update now
 * (the VPS updater picks the request up within a minute) or reload the app.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { SITE_VERSION } from './SystemHealth';
import { Card } from './ui';

interface UpdateData {
  running: string;
  requested: string | null;
  last: { at: string; state: 'up_to_date' | 'updating' | 'done' | 'failed'; message: string; deployed: string; remote: string } | null;
}

const STATE: Record<string, string> = { up_to_date: 'Up to date', updating: 'Updating…', done: 'Updated', failed: 'Update failed' };

/** Newest app build on GitHub Pages (version.json is written by the deploy workflow). */
function useLatestSite(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { sha?: string } | null) => j?.sha && setV(j.sha.slice(0, 7)))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return v;
}

/** Throw away the cached app and load the newest version. */
async function reloadApp(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
    if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch {
    /* reload anyway */
  }
  window.location.reload();
}

export function UpdateCard() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { data, error, reload } = useApi<UpdateData>('/api/update', busy ? 5_000 : 30_000);
  const latestSite = useLatestSite();
  const last = data?.last ?? null;
  const pending = !!data?.requested || last?.state === 'updating';
  const behind = !!last?.remote && !!data && last.remote !== data.running && data.running !== 'dev';
  const siteBehind = !!latestSite && SITE_VERSION !== 'dev' && latestSite !== SITE_VERSION;

  // A finished update restarts the bot: keep polling fast until it reports the new version.
  useEffect(() => {
    if (busy && data && !pending && (!behind || last?.state === 'failed')) setBusy(false);
  }, [busy, data, pending, behind, last?.state]);

  const ask = async (force: boolean) => {
    setNote(null);
    try {
      const r = await api<{ message: string }>('/api/update', { method: 'POST', body: JSON.stringify({ force }) });
      setNote(r.message);
      setBusy(true);
      void reload();
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <Card title="Updates" className="mt-4">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Row label="Bot runs" value={data?.running ?? '—'} warn={behind} sub={behind ? `newest ${last?.remote}` : last ? STATE[last.state] : undefined} />
        <Row label="Server checked" value={last ? ago(last.at) : '—'} sub={last?.message} warn={last?.state === 'failed'} />
        <Row label="App runs" value={SITE_VERSION} warn={siteBehind} sub={siteBehind ? `newest ${latestSite}` : 'up to date'} />
        <Row label="Status" value={pending ? 'Updating…' : behind ? 'Update ready' : 'Up to date'} warn={behind && !pending} />
      </div>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      {note && <p className="mt-2 text-sm text-ink-2">{note}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => void ask(false)} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? 'Updating bot…' : 'Update bot now'}
        </button>
        <button type="button" disabled={pending} onClick={() => void ask(true)} className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50" title="Rebuild and restart even if there is no new code">
          Force rebuild
        </button>
        <button type="button" onClick={() => void reloadApp()} className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink">
          Reload app
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        The server updates by itself every 5 minutes; the button makes it check right away (starts within a minute, rebuild takes 1–3 min, the bot restarts once).
      </p>
    </Card>
  );
}

function Row({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={`truncate font-medium tabular-nums ${warn ? 'text-warning' : 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted" title={sub}>{sub}</div>}
    </div>
  );
}
