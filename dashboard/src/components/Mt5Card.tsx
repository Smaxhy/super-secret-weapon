/**
 * v28.1 Forex → Setup: copy the forex bot's trades to the owner's MT5 DEMO account (OANDA) through MetaApi.
 * The MT5 password is typed on metaapi.cloud only; this card takes MetaApi's API token + account id (masked on read).
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, inputCls } from './ui';

interface Row { posId: string; pair: string; symbol: string | null; side: 1 | -1; lots0: number; state: 'open' | 'failed' | 'gone' | 'closed'; error?: string; at: number }
interface Pos { id: string; symbol: string; type: string; volume: number; openPrice: number; stopLoss?: number; takeProfit?: number; profit?: number }
interface Data {
  connected: boolean;
  source?: 'dashboard' | 'env' | null;
  on: boolean;
  since?: number | null;
  token?: string | null;
  accountId?: string | null;
  maxLots?: number;
  scale?: 'match' | number;
  account?: { login?: string | number; server?: string; state?: string; connectionStatus?: string } | null;
  info?: { broker?: string; currency?: string; balance: number; equity: number } | null;
  demo?: boolean | null;
  lastTickAt?: number | null;
  error?: string | null;
  rows?: Row[];
  positions?: Pos[];
  log?: Array<{ t: number; e: string }>;
}

const when = (t: number) => ago(new Date(t).toISOString());
const money = (x: number, ccy = 'USD') => `${x.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${ccy}`;

export function Mt5Card() {
  const { data, reload } = useApi<Data>('/api/forex/mt5', 10_000);
  const [token, setToken] = useState('');
  const [acct, setAcct] = useState('');
  const [lots, setLots] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ note?: string | null }>('/api/forex/mt5', { method: 'PUT', body: JSON.stringify(body) });
      setMsg({ ok: true, text: r?.note ? `${done}. ${r.note}` : done });
      setToken('');
      setAcct('');
      setLots('');
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const d = data;
  const open = (d?.rows ?? []).filter((r) => r.state === 'open');
  const status = !d?.connected ? (
    <Badge tone="neutral">not connected</Badge>
  ) : d.error ? (
    <Badge tone="warn">needs a look</Badge>
  ) : d.demo === false ? (
    <Badge tone="down">not a demo account</Badge>
  ) : d.on ? (
    <Badge tone="up">copying</Badge>
  ) : (
    <Badge tone="neutral">paused</Badge>
  );
  return (
    <Card title="MT5 demo account (OANDA)" subtitle="The forex bot's trades copied to your MetaTrader 5 demo account: same direction, a size matched to that account, the same stop and target distance, and every stop move, part taken off and close follows. Demo accounts only. Only trades the bot opens after you switch this on are copied." action={status}>
      {!d?.connected && (
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li>Sign up at metaapi.cloud and add your MT5 account there (Accounts → Add account): login, password, server OANDA's demo server. Your MT5 password goes there only, never here.</li>
          <li>Wait until MetaApi shows the account as Deployed and Connected. Copy its account id (a long id, not your MT5 login).</li>
          <li>In MetaApi → API access, create a token. Paste both below and tap Connect.</li>
        </ol>
      )}
      {d?.connected && (
        <div className="mb-3 space-y-1 text-sm text-ink-2">
          <p>
            Account {d.account?.login ?? d.accountId} {d.account?.server ? `on ${d.account.server}` : ''} · token {d.token} · {d.source === 'env' ? 'from the server .env' : 'saved here'}
          </p>
          {d.info && (
            <p>
              {d.info.broker ?? 'MT5'} · balance {money(d.info.balance, d.info.currency)} · equity {money(d.info.equity, d.info.currency)}
              {d.lastTickAt ? ` · checked ${when(d.lastTickAt)}` : ''}
            </p>
          )}
          <p>
            Size: {d.scale === 'match' ? 'same share of the account as the bot' : `${d.scale}× the bot's units`} · at most {d.maxLots} lots a trade
            {d.on && d.since ? ` · copying trades opened since ${new Date(d.since).toLocaleString()}` : ''}
          </p>
        </div>
      )}
      {d?.error && <p className="mb-2 text-sm text-down">{d.error}</p>}
      {open.length > 0 && (
        <div className="mb-3 text-sm">
          <p className="font-semibold">Open on MT5</p>
          {open.map((r) => {
            const p = d?.positions?.find((x) => x.symbol === r.symbol);
            return (
              <div key={r.posId} className="flex flex-wrap justify-between gap-x-3 border-b border-line py-1 last:border-0">
                <span className="font-medium">
                  {r.side > 0 ? 'Buy' : 'Sell'} {r.symbol}
                </span>
                <span className="tabular-nums text-ink-2">
                  {p ? `${p.volume} lots · ${p.profit !== undefined ? money(p.profit, d?.info?.currency) : ''}` : `${r.lots0} lots`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {(d?.log?.length ?? 0) > 0 && (
        <details className="mb-3 text-sm">
          <summary className="cursor-pointer font-semibold">What it did</summary>
          <div className="mt-1 space-y-0.5 text-ink-2">
            {d!.log!.slice(0, 12).map((l, i) => (
              <p key={i}>
                <span className="tabular-nums">{when(l.t)}</span> · {l.e}
              </p>
            ))}
          </div>
        </details>
      )}
      {!d?.connected || d.source !== 'env' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={`${inputCls} w-full`} type="password" placeholder="MetaApi API token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <input className={`${inputCls} w-full`} placeholder="MetaApi account id" value={acct} onChange={(e) => setAcct(e.target.value)} autoComplete="off" />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {(token.trim() || acct.trim()) && (
          <Button size="sm" disabled={busy || token.trim().length < 20 || acct.trim().length < 8} onClick={() => void send({ token: token.trim(), accountId: acct.trim() }, 'Connected')}>
            {busy ? 'Testing…' : 'Connect'}
          </Button>
        )}
        {d?.connected && d.demo !== false && (
          <Button size="sm" variant={d.on ? 'ghost' : undefined} disabled={busy} onClick={() => void send({ on: !d.on }, d.on ? 'Paused: open MT5 trades stay as they are' : 'Copying new bot trades')}>
            {d.on ? 'Pause copying' : 'Start copying'}
          </Button>
        )}
        {d?.connected && open.length > 0 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ closeAll: true }, 'Stopped and closed its MT5 trades')}>
            Stop and close all
          </Button>
        )}
        {d?.source === 'dashboard' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ clear: true }, 'Disconnected')}>
            Disconnect
          </Button>
        )}
      </div>
      {d?.connected && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="mt5-lots" className="text-ink-2">
            Most lots a trade
          </label>
          <input id="mt5-lots" className={`${inputCls} w-24`} inputMode="decimal" placeholder={String(d.maxLots ?? '')} value={lots} onChange={(e) => setLots(e.target.value)} />
          <Button size="sm" variant="ghost" disabled={busy || !(Number(lots) > 0)} onClick={() => void send({ maxLots: Number(lots) }, 'Lot cap saved')}>
            Save
          </Button>
        </div>
      )}
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
    </Card>
  );
}
