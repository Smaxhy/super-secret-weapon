/** Forex → Setup: connect a free OANDA demo token as a live price feed (no trading, no money through it). */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Badge, Button, Card, inputCls } from './ui';

interface Data { connected: boolean; token: string | null; accountId: string | null; env: string; updatedAt: string | null; basis?: Record<string, { basis: number; n: number; at: number; src?: 'oanda' | 'hl' }> }

/** v27.47: the futures markets that get a live OANDA price once their gap to the futures price is measured */
const FUTURES: Array<[string, string]> = [['NDXUSD', 'Nasdaq 100'], ['SPXUSD', 'S&P 500'], ['DJIUSD', 'Dow 30'], ['RUTUSD', 'Russell 2000'], ['XAUUSD', 'Gold'], ['XAGUSD', 'Silver']];
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 1 ? 'just now' : `${m} min ago`;
};

export function OandaCard() {
  const { data, reload } = useApi<Data>('/api/forex/oanda', 60_000);
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
      {data && (
        <div className="mb-3 rounded-lg border border-line p-3 text-sm">
          <p className="mb-1 text-ink-2">Indices and metals: the bot tests and trades them on futures prices, which Yahoo shows 10 minutes late. A live price from OANDA (when connected) or Hyperliquid (free, no account) is moved onto the futures price by the gap measured every 10 minutes; until a gap is measured, the market stays on Yahoo's late price.</p>
          <ul className="space-y-0.5">
            {FUTURES.map(([id, name]) => {
              const b = data.basis?.[id];
              const fresh = b && Date.now() - b.at < 60 * 60_000;
              return (
                <li key={id} className="flex justify-between gap-2">
                  <span>{name}</span>
                  <span className={fresh ? 'text-up' : 'text-muted'}>{fresh ? `live via ${b!.src === 'hl' ? 'Hyperliquid' : 'OANDA'} · gap ${b!.basis >= 0 ? '+' : '−'}${Math.abs(b!.basis).toFixed(id === 'XAGUSD' ? 3 : 2)} (${ago(b!.at)})` : '10 min late (no live source yet)'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
