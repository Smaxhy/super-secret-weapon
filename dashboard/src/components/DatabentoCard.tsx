/** v27.91 Forex → Setup: paste a Databento API key → the bot downloads CME futures history (indices + metals). */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, inputCls } from './ui';

interface MarketMeta { first: number | null; last: number | null; n: number; full: boolean; error: string | null }
interface Meta { at: number; spentUsd: number; availEnd: number | null; ids: Record<string, MarketMeta>; error: string | null; estimates?: Array<{ what: string; usd: number | null; error?: string }> }
interface Data { connected: boolean; source: 'dashboard' | 'env' | null; key: string | null; maxUsd: number; meta: Meta | null }

const NAMES: Record<string, string> = { NDXUSD: 'Nasdaq 100', SPXUSD: 'S&P 500', DJIUSD: 'Dow 30', RUTUSD: 'Russell 2000', XAUUSD: 'Gold', XAGUSD: 'Silver', EURUSD: 'EUR/USD (6E)', GBPUSD: 'GBP/USD (6B)', AUDUSD: 'AUD/USD (6A)', NZDUSD: 'NZD/USD (6N)', USDJPY: 'USD/JPY (6J)', USDCAD: 'USD/CAD (6C)', USDCHF: 'USD/CHF (6S)' };
const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '–');

export function DatabentoCard() {
  const { data, reload } = useApi<Data>('/api/forex/databento', 30_000);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/forex/databento', { method: 'PUT', body: JSON.stringify(body) });
      setMsg({ ok: true, text: done });
      setKey('');
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const m = data?.meta;
  const ids = m ? Object.entries(m.ids) : [];
  const status = !data?.connected ? <Badge tone="neutral">no key</Badge> : m?.error ? <Badge tone="warn">needs a look</Badge> : ids.length ? <Badge tone="up">downloading history</Badge> : <Badge tone="neutral">key saved</Badge>;
  return (
    <Card title="Databento (CME futures data)" subtitle="Real CME history for Nasdaq, S&P, Dow, Russell, gold and silver, with volume, so the lab can test those markets on about 3 years instead of Yahoo's 2. Every download is priced first and stops at a spending limit. The key is tested with Databento and kept only on your server, shown masked." action={status}>
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>Sign in at databento.com → API keys, copy your key (starts with db-).</li>
        <li>Paste it below and tap Save. The download starts by itself.</li>
      </ol>
      {data?.connected && (
        <p className="mb-2 text-sm text-ink-2">
          Key {data.key} · {data.source === 'env' ? 'from the server .env' : 'saved here'} · spent ${m?.spentUsd.toFixed(2) ?? '0.00'} of the ${data.maxUsd} limit
          {m?.at ? ` · last download ${ago(new Date(m.at).toISOString())}` : ' · first download in about 2 minutes'}
        </p>
      )}
      {m?.error && <p className="mb-2 text-sm text-down">{m.error}</p>}
      {ids.length > 0 && (
        <div className="mb-3 space-y-1 text-sm">
          {ids.map(([id, x]) => (
            <div key={id} className="flex flex-wrap justify-between gap-x-3 border-b border-line py-1 last:border-0">
              <span className="font-medium">{NAMES[id] ?? id}</span>
              <span className={x.error ? 'text-down' : 'text-ink-2'}>{x.error ?? `${x.n.toLocaleString()} hours · ${day(x.first)} → ${day(x.last)}${x.full ? '' : ' · still filling'}`}</span>
            </div>
          ))}
        </div>
      )}
      {m?.estimates?.length ? (
        <div className="mb-3 text-sm">
          <p className="font-semibold">What real order flow would cost (not downloaded)</p>
          <p className="mb-1 text-ink-2">Every trade with its buy or sell side, so the order-flow strategies can use real data instead of guessing from candles. Ask before buying any of these.</p>
          {m.estimates.map((e) => (
            <div key={e.what} className="flex justify-between gap-3 py-0.5">
              <span>{e.what}</span>
              <span className="tabular-nums">{e.usd === null ? 'no price' : `$${e.usd.toFixed(2)}`}</span>
            </div>
          ))}
        </div>
      ) : null}
      <input className={`${inputCls} w-full`} type="password" placeholder="Databento API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || key.trim().length < 16} onClick={() => void send({ key }, 'Key works: the history download starts now')}>{busy ? 'Testing…' : 'Save'}</Button>
        {data?.connected && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ refresh: true }, 'Download started: check back in a few minutes')}>Download now</Button>}
        {data?.source === 'dashboard' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ clear: true }, 'Key removed')}>Remove</Button>}
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
    </Card>
  );
}
