/** Wallets: COPY wallets (copied one by one) and KOLs (Cupsey, Cented… — "how many KOLs are in" signal). */
import { useState, type FormEvent } from 'react';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Link } from 'react-router-dom';
import { ago, pct, shortAddr } from '../lib/format';

interface WalletRow {
  address: string;
  label: string | null;
  kind: 'COPY' | 'KOL';
  notes: string | null;
  source: 'MANUAL' | 'DISCOVERED';
  pnlSol: number | null;
  winRate: number | null;
  active: boolean;
  addedAt: string;
  lastSeenAt: string | null;
  tradesSeen: number;
  copies: number;
  openCopies: number;
  copyPnlSol: number;
  copyWinRate: number | null;
}

interface KolCoin {
  mint: string;
  symbol: string | null;
  kols: number;
  names: string[];
  sold: number;
  lastBuyAt: string;
}

function KolBoard() {
  const { data } = useApi<{ windowMin: number; coins: KolCoin[] }>('/api/kols', 30_000);
  return (
    <Card title="KOLs buying now" className="mb-4">
      {data && data.coins.length ? (
        <ul className="divide-y divide-line text-sm">
          {data.coins.map((c) => (
            <li key={c.mint} className="flex min-w-0 items-center justify-between gap-2 py-1.5">
              <Link to={`/token/${c.mint}`} className="min-w-0 truncate font-semibold text-ink hover:underline">
                {c.symbol ?? shortAddr(c.mint)} <span className="font-normal text-muted">· {c.names.slice(0, 4).join(', ')}</span>
              </Link>
              <span className="shrink-0 tabular-nums">
                <span className={c.kols >= 2 ? 'text-up' : 'text-ink-2'}>{c.kols} KOL{c.kols === 1 ? '' : 's'}</span>
                {c.sold > 0 && <span className="text-down"> · {c.sold} sold</span>}
                <span className="text-muted"> · {ago(c.lastBuyAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No KOL buys in the last {data?.windowMin ?? 60} min. 2+ KOLs in the same coin makes the bot check it right away.</Empty>
      )}
    </Card>
  );
}

interface SmartRow {
  wallet: string;
  label: string | null;
  tracked: boolean;
  pnlSol: number;
  sells: number;
  winRate: number;
  avgPnlSol: number;
}

function SmartMoney() {
  const { data } = useApi<SmartRow[]>('/api/smart-wallets', 60_000);
  return (
    <Card title="Smart money the bot found (~7 days)" className="mb-4">
      <p className="mb-2 text-sm text-ink-2">
        Real profit of every wallet the bot sees trading (devs and launch snipers left out). The best ones become KOLs automatically every 30 min — so it isn't
        limited to the names you know.
      </p>
      {data && data.length ? (
        <ul className="divide-y divide-line text-sm">
          {data.map((r, i) => (
            <li key={r.wallet} className="flex min-w-0 items-center justify-between gap-2 py-1.5">
              <a href={`https://solscan.io/account/${r.wallet}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-ink hover:underline">
                <span className="mr-1 font-sans text-muted">#{i + 1}</span>
                {r.label ?? shortAddr(r.wallet)}
                {r.tracked && <span className="ml-1 font-sans text-xs text-accent">● KOL</span>}
              </a>
              <span className="shrink-0 tabular-nums">
                <span className="text-up">+{r.pnlSol.toFixed(1)} SOL</span>
                <span className="text-muted">
                  {' '}
                  · {Math.round(r.winRate * 100)}% · {Math.round(r.sells)} sells
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Builds up as the bot watches trades — the first smart wallets usually show within an hour or two.</Empty>
      )}
    </Card>
  );
}

function BulkImport({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ added: number; invalid: string[] }>('/api/wallets/bulk', { method: 'POST', body: JSON.stringify({ text, kind: 'KOL' }) });
      setMsg(`✓ Added ${r.added} KOL wallets${r.invalid.length ? ` · skipped ${r.invalid.length} lines without a valid address` : ''}`);
      setText('');
      onDone();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Import a KOL list" className="mb-4">
      <p className="mb-2 text-sm text-ink-2">Paste one wallet per line, e.g. <code>Cupsey 2fg5QD…</code> (from kolscan.io / gmgn.ai). KOLs aren't copied one by one — the bot watches how many of them are in a coin.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={'Cupsey 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f\nCented CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o'} className="w-full rounded-lg border border-line bg-page px-3 py-2 font-mono text-xs text-ink" />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !text.trim()} onClick={() => void run()} className="rounded-lg bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60">
          {busy ? 'Importing…' : 'Import as KOLs'}
        </button>
        {msg && <span className="text-sm text-ink-2">{msg}</span>}
      </div>
    </Card>
  );
}

export function Wallets() {
  const { data, error, loading, reload } = useApi<WalletRow[]>('/api/wallets', 30_000, ['trade']);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'COPY' | 'KOL'>('KOL');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/api/wallets', { method: 'POST', body: JSON.stringify({ address, label, kind }) });
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
      <PageHeader title="Wallets & KOLs" subtitle="KOLs (Cupsey, Cented…): when several buy the same coin the bot checks it right away and scores it higher; KOLs dumping = no buy / take profit. Copy wallets: each buy is checked and copied (half size, strict) if it passes the rules." />

      <KolBoard />
      <SmartMoney />

      <Card title="Add a wallet" className="mb-4">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            Wallet address
            <input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 7xKX…" className="rounded-lg border border-line bg-page px-3 py-2.5 font-mono text-sm text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            Name (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Cupsey" className="rounded-lg border border-line bg-page px-3 py-2.5 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as 'COPY' | 'KOL')} className="rounded-lg border border-line bg-page px-3 py-2.5 text-ink">
              <option value="KOL">KOL (signal)</option>
              <option value="COPY">Copy trades</option>
            </select>
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

      <BulkImport onDone={() => void reload()} />

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
                  <div className="font-semibold text-ink">
                    {w.label ?? shortAddr(w.address)}{' '}
                    <span className={`ml-1 rounded border border-line px-1.5 py-0.5 text-xs font-normal ${w.kind === 'KOL' ? 'text-accent' : 'text-ink-2'}`}>{w.kind === 'KOL' ? 'KOL' : 'Copy'}</span>
                    {w.source === 'DISCOVERED' && <span className="ml-1 rounded border border-line px-1.5 py-0.5 text-xs font-normal text-up">Auto-found</span>}
                  </div>
                  {w.pnlSol !== null && (
                    <div className="text-xs tabular-nums text-ink-2">
                      ~7d: <span className={w.pnlSol >= 0 ? 'text-up' : 'text-down'}>{w.pnlSol >= 0 ? '+' : ''}{w.pnlSol.toFixed(1)} SOL</span>
                      {w.winRate !== null && ` · ${Math.round(w.winRate * 100)}% wins`}
                    </div>
                  )}
                  {w.notes && <div className="text-xs text-muted">{w.notes}</div>}
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
