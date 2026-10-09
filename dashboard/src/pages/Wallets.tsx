/** Wallets the bot copies: add, label, pause, remove — and see how copying each one went. */
import { useState, type FormEvent } from 'react';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, pct, shortAddr } from '../lib/format';

interface WalletRow {
  address: string;
  label: string | null;
  active: boolean;
  addedAt: string;
  lastSeenAt: string | null;
  tradesSeen: number;
  copies: number;
  openCopies: number;
  copyPnlSol: number;
  copyWinRate: number | null;
}

export function Wallets() {
  const { data, error, loading, reload } = useApi<WalletRow[]>('/api/wallets', 30_000, ['trade']);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/api/wallets', { method: 'POST', body: JSON.stringify({ address, label }) });
      setAddress('');
      setLabel('');
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(w: WalletRow) {
    await api(`/api/wallets/${w.address}`, { method: 'PATCH', body: JSON.stringify({ active: !w.active }) }).catch(() => undefined);
    await reload();
  }

  async function remove(w: WalletRow) {
    if (!window.confirm(`Stop tracking ${w.label ?? shortAddr(w.address)}?`)) return;
    await api(`/api/wallets/${w.address}`, { method: 'DELETE' }).catch(() => undefined);
    await reload();
  }

  return (
    <>
      <PageHeader title="Tracked wallets" subtitle="When one of these wallets buys, the bot checks that coin straight away and copies the trade if it passes the safety and anti-rug rules." />

      <Card title="Add a wallet" className="mb-4">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            Wallet address
            <input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 7xKX…" className="rounded-lg border border-line bg-page px-3 py-2.5 font-mono text-sm text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            Name (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Cupsey" className="rounded-lg border border-line bg-page px-3 py-2.5 text-ink" />
          </label>
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-white disabled:opacity-60">
            {busy ? 'Adding…' : '+ Add'}
          </button>
        </form>
        {formError && (
          <p role="alert" className="mt-2 text-sm text-down">
            {formError}
          </p>
        )}
      </Card>

      {error && <ErrorBox message={error} />}
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No wallets yet. Add one above. Good sources: wallets that keep showing up early on coins that ran (check the top traders on a coin's Pump.fun / GMGN page).</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((w) => (
            <Card key={w.address} className={w.active ? '' : 'opacity-60'}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-ink">{w.label ?? shortAddr(w.address)}</div>
                  <a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-ink-2 underline-offset-2 hover:underline">
                    {w.address}
                  </a>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void toggle(w)} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-2" aria-pressed={!w.active}>
                    {w.active ? '⏸ Pause' : '▶ Resume'}
                  </button>
                  <button type="button" onClick={() => void remove(w)} className="rounded-lg border border-line px-3 py-1.5 text-sm text-down hover:bg-surface-2">
                    Remove
                  </button>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted">Last trade</dt>
                  <dd className="text-ink">{w.lastSeenAt ? ago(w.lastSeenAt) : 'not yet'}</dd>
                </div>
                <div>
                  <dt className="text-muted">Trades seen</dt>
                  <dd className="tabular text-ink">{w.tradesSeen.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-muted">Copied</dt>
                  <dd className="tabular text-ink">
                    {w.copies}
                    {w.openCopies > 0 && <span className="text-muted"> ({w.openCopies} open)</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Copy result</dt>
                  <dd>
                    <Pnl value={w.copies - w.openCopies > 0 ? w.copyPnlSol : null} />
                    {w.copyWinRate !== null && <span className="ml-1 text-muted">· {pct(w.copyWinRate, 0)} wins</span>}
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
