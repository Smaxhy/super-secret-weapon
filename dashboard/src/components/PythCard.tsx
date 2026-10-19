/** v17.12 Forex → Setup: paste a Pyth API key (Pyth Terminal) for a second live price stream next to Yahoo's. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, inputCls } from './ui';

interface Data { connected: boolean; source: 'dashboard' | 'env' | null; key: string | null; host: string | null; flowing: boolean; lastTickAt: number | null; pairs: number }

export function PythCard() {
  const { data, reload } = useApi<Data>('/api/forex/pyth', 15_000);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; host?: string; pairs?: number }>('/api/forex/pyth', { method: 'PUT', body: JSON.stringify(clear ? { clear: true } : { key }) });
      setMsg({ ok: true, text: clear ? 'Removed: live prices come from the Yahoo stream only' : `Key works (${r.host}, ${r.pairs} currency pairs): Pyth prices start streaming now` });
      setKey('');
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const status = !data?.connected ? <Badge tone="neutral">no key</Badge> : data.flowing ? <Badge tone="up">streaming</Badge> : <Badge tone="warn">key saved, not streaming</Badge>;
  return (
    <Card title="Pyth live prices" subtitle="Since August 2026 Pyth only answers with an API key. With one, the bot streams Pyth's prices next to Yahoo's and always uses the freshest. The key is tested with Pyth first and kept only on your server (never in the code), shown masked." action={status}>
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>Sign in at Pyth Terminal and create an API key (Pyth Core).</li>
        <li>Paste it below and tap Save.</li>
      </ol>
      {data?.connected && (
        <p className="mb-2 text-sm text-ink-2">
          Key {data.key} · {data.host} · {data.source === 'env' ? 'from the server .env' : 'saved here'}
          {data.lastTickAt ? ` · last price ${ago(new Date(data.lastTickAt).toISOString())}` : ' · no price yet'}
        </p>
      )}
      <input className={`${inputCls} w-full`} type="password" placeholder="Pyth API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy || key.trim().length < 16} onClick={() => void save()}>{busy ? 'Testing…' : 'Save'}</Button>
        {data?.source === 'dashboard' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>Remove</Button>}
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
    </Card>
  );
}
