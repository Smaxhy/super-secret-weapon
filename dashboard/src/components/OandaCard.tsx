/** Forex → Setup: connect a free OANDA demo token as a live price feed (no trading, no money through it). */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Badge, Button, Card, inputCls } from './ui';

interface Data { connected: boolean; token: string | null; accountId: string | null; env: string; updatedAt: string | null }

export function OandaCard() {
  const { data, reload } = useApi<Data>('/api/forex/oanda', 0);
  const [token, setToken] = useState('');
  const [acct, setAcct] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/forex/oanda', { method: 'PUT', body: JSON.stringify(clear ? { clear: true } : { token, accountId: acct, env: 'practice' }) });
      setMsg({ ok: true, text: clear ? 'Disconnected' : 'Connected: prices now come from OANDA' });
      setToken('');
      setAcct('');
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Live price feed" subtitle="Free OANDA demo account used ONLY for prices (real bid / ask, ticks every second). No money, no trading, no payouts through it." action={data?.connected ? <Badge tone="up">OANDA connected</Badge> : <Badge tone="neutral">Yahoo (slower)</Badge>}>
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>Open a free fxTrade Practice (demo) account on oanda.com.</li>
        <li>In the account: Manage API Access → Generate a token.</li>
        <li>Paste the token and the account id (looks like 101-004-1234567-001) below.</li>
      </ol>
      {data?.connected && <p className="mb-2 text-sm text-ink-2">Token {data.token} · account {data.accountId}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={inputCls} placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        <input className={inputCls} placeholder="Account id" value={acct} onChange={(e) => setAcct(e.target.value)} autoComplete="off" />
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy || !token || !acct} onClick={() => void save()}>Connect</Button>
        {data?.connected && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>Disconnect</Button>}
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
    </Card>
  );
}
