/**
 * Controls page: "Data feed" — paste a paid feed (Chainstack WebSocket, or Yellowstone gRPC endpoint + token)
 * from the phone. Saved on the bot's own server only; the bot restarts to use it. Keys are never shown back.
 */
import { useId, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Card } from './ui';

interface Feed {
  active: { dataSource: string; trades: string | null; grpc: string | null; from: { trades: string; grpc: string } } | null;
  connected: boolean;
  saved: { tradesWsUrl: string | null; grpcEndpoint: string | null; hasGrpcToken: boolean; useGrpc: boolean; updatedAt: string | null };
}

const SOURCE: Record<string, string> = { hybrid: 'WebSocket trade stream', grpc: 'Yellowstone gRPC (paid)', pumpportal: 'PumpPortal only', helius: 'Helius logs' };

export function DataFeed() {
  const id = useId();
  const { data, error, reload } = useApi<Feed>('/api/controls/feed', 30_000);
  const [ws, setWs] = useState('');
  const [ep, setEp] = useState('');
  const [tk, setTk] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/controls/feed', { method: 'PUT', body: JSON.stringify(body) });
      setMsg({ ok: true, text: `✓ ${done} The bot restarts now (about a minute) — then check that it says connected.` });
      setWs('');
      setEp('');
      setTk('');
      setTimeout(() => void reload(), 70_000);
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink';
  const a = data?.active;
  const s = data?.saved;
  return (
    <Card title="Data feed">
      {error && <p className="text-sm text-down">{error}</p>}
      {data && (
        <div className="mb-4 space-y-1 text-sm">
          <div>
            <span className="text-muted">Now using: </span>
            <span className="font-medium text-ink">{a ? SOURCE[a.dataSource] ?? a.dataSource : '—'}</span>
            <span className={`ml-2 text-xs ${data.connected ? 'text-up' : 'text-down'}`}>{data.connected ? '● connected' : '● not connected'}</span>
          </div>
          {a?.trades && a.dataSource !== 'grpc' && <div className="break-all text-xs text-muted">{a.trades} ({a.from.trades === 'dashboard' ? 'set here' : 'from the server file'})</div>}
          {a?.grpc && a.dataSource === 'grpc' && <div className="break-all text-xs text-muted">{a.grpc} ({a.from.grpc === 'dashboard' ? 'set here' : 'from the server file'})</div>}
        </div>
      )}
      <div className="space-y-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ws.trim()) void save({ tradesWsUrl: ws }, 'WebSocket saved.');
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`${id}-ws`} className="text-sm font-medium text-ink">
            Paid WebSocket (Chainstack node, no add-on needed)
          </label>
          <p className="text-xs font-medium text-down">⚠ Burns credits fast (every trade message counts — about 2 million an hour). Not needed with gRPC: when gRPC is on, the bot never uses this.</p>
          <p className="text-xs text-muted">Chainstack → your Solana mainnet node → Access → copy the address that starts with wss://.{s?.tradesWsUrl ? ` Saved: ${s.tradesWsUrl}` : ''}</p>
          <input id={`${id}-ws`} className={input} value={ws} onChange={(e) => setWs(e.target.value)} placeholder="wss://solana-mainnet.core.chainstack.com/…" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !ws.trim()} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-50">
              Save and restart
            </button>
            {s?.tradesWsUrl && (
              <button type="button" disabled={busy} onClick={() => void save({ tradesWsUrl: '' }, 'Back to the free WebSocket.')} className="rounded-lg px-4 py-2.5 text-sm text-ink-2 hover:bg-surface-2">
                Use the free one again
              </button>
            )}
          </div>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ep.trim()) void save({ grpcEndpoint: ep, grpcToken: tk, useGrpc: true }, 'gRPC saved and switched on.');
          }}
          className="flex flex-col gap-2 border-t border-line pt-4"
        >
          <span className="text-sm font-medium text-ink">Yellowstone gRPC (Chainstack Geyser add-on)</span>
          <p className="text-xs text-muted">Only with the Yellowstone add-on. Endpoint with https:// and :443, plus its token.{s?.grpcEndpoint ? ` Saved: ${s.grpcEndpoint}${s.hasGrpcToken ? ' + token' : ''}${s.useGrpc ? ' (on)' : ' (off)'}` : ''}</p>
          <input aria-label="gRPC endpoint" className={input} value={ep} onChange={(e) => setEp(e.target.value)} placeholder="https://yellowstone-solana-mainnet.core.chainstack.com:443" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <input aria-label="gRPC token" type="password" className={input} value={tk} onChange={(e) => setTk(e.target.value)} placeholder="x-token" autoComplete="off" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !ep.trim()} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-50">
              Save, switch on and restart
            </button>
            {s?.useGrpc && (
              <button type="button" disabled={busy} onClick={() => void save({ useGrpc: false }, 'gRPC switched off.')} className="rounded-lg px-4 py-2.5 text-sm text-ink-2 hover:bg-surface-2">
                Switch gRPC off
              </button>
            )}
          </div>
        </form>
        {msg && <p className={`text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
        <p className="text-xs text-muted">Saved only on your bot's server, never in the code. Keys are never shown here again. If the paid feed drops, the bot falls back to the free one.</p>
      </div>
    </Card>
  );
}
