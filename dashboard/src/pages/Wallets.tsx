/** Wallets: COPY wallets (copied one by one) and KOLs (Cupsey, Cented… — "how many KOLs are in" signal). */
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Chip, Empty, ErrorBox, inputCls, Loading, PageHeader, Pnl, Select, Sheet, Tabs, Th, tdCls, theadCls, trCls, useTab } from '../components/ui';
import { Icon } from '../components/Icon';
import { WalletEngine } from '../components/WalletEngine';
import { useApi } from '../hooks/useApi';
import { WalletAnalyzer } from '../components/WalletAnalyzer';
import { api } from '../lib/api';
import { Link, useSearchParams } from 'react-router-dom';
import { ago, shortAddr } from '../lib/format';

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
    <Card title="KOLs buying now" subtitle={`Last ${data?.windowMin ?? 60} min. 2+ KOLs in one coin makes the bot check it at once.`}>
      {data && data.coins.length ? (
        <ul className="divide-y divide-line text-sm">
          {data.coins.map((c) => (
            <li key={c.mint} className="flex min-h-11 min-w-0 items-center justify-between gap-2 py-1.5">
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
        <Empty>No KOL buys in the last {data?.windowMin ?? 60} min.</Empty>
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

function SmartMoney({ q }: { q: string }) {
  const { data } = useApi<SmartRow[]>('/api/smart-wallets', 60_000);
  const rows = (data ?? []).filter((r) => !q || r.wallet.toLowerCase().includes(q) || (r.label ?? '').toLowerCase().includes(q));
  return (
    <Card title="Smart money it found" subtitle="Real profit of every wallet it sees trading (~7 days; devs and launch snipers left out). The best become KOLs automatically every 30 min.">
      {data && rows.length ? (
        <ul className="divide-y divide-line text-sm">
          {rows.slice(0, 25).map((r, i) => (
            <li key={r.wallet} className="flex min-h-11 min-w-0 items-center justify-between gap-2 py-1.5">
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
        <Empty>{q && data?.length ? 'No smart wallet matches the search.' : 'Builds up as the bot watches trades; the first smart wallets usually show within an hour or two.'}</Empty>
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
      setMsg(`Added ${r.added} KOL wallets${r.invalid.length ? ` · skipped ${r.invalid.length} lines without a valid address` : ''}`);
      setText('');
      onDone();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="mb-2 text-sm text-ink-2">Paste one wallet per line, e.g. <code>Cupsey 2fg5QD…</code> (from kolscan.io / gmgn.ai). KOLs aren't copied one by one: the bot watches how many of them are in a coin.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={'Cupsey 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f\nCented CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o'} className={`${inputCls} w-full font-mono text-xs`} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={busy || !text.trim()} onClick={() => void run()}>
          {busy ? 'Importing…' : 'Import as KOLs'}
        </Button>
        {msg && <span className="text-sm text-ink-2">{msg}</span>}
      </div>
    </div>
  );
}

const TABS = [
  { key: 'board', label: 'Board' },
  { key: 'analyze', label: 'Analyze a wallet' },
] as const;
type Tab = (typeof TABS)[number]['key'];
type KindFilter = 'all' | 'KOL' | 'COPY' | 'auto';

export function Wallets() {
  const [tab, setTab] = useTab<Tab>('wallets', TABS.map((t) => t.key), 'board');
  const { data, error, loading, reload } = useApi<WalletRow[]>('/api/wallets', 30_000, ['trade']);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'COPY' | 'KOL'>('KOL');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'add' | 'import' | null>(null);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/api/wallets', { method: 'POST', body: JSON.stringify({ address, label, kind }) });
      setAddress('');
      setLabel('');
      setSheet(null);
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

  const all = data ?? [];
  const list = all
    .filter((w) => (filter === 'all' ? true : filter === 'auto' ? w.source === 'DISCOVERED' : w.kind === filter))
    .filter((w) => !q || w.address.toLowerCase().includes(q) || (w.label ?? '').toLowerCase().includes(q));
  const count = (f: KindFilter) => all.filter((w) => (f === 'all' ? true : f === 'auto' ? w.source === 'DISCOVERED' : w.kind === f)).length;
  const typeBadges = (w: WalletRow) => (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={w.kind === 'KOL' ? 'accent' : 'warn'}>{w.kind === 'KOL' ? 'KOL' : 'Copy'}</Badge>
      {w.source === 'DISCOVERED' && <Badge tone="up">auto-found</Badge>}
      {!w.active && <Badge>paused</Badge>}
    </span>
  );

  const tracked = (
    <Card
      padded={false}
      title="Tracked wallets"
      subtitle="KOL = a signal only. Copy = each buy is checked and copied if it passes the rules; his sells are mirrored."
      action={
        <span className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setSheet('import')}>Import</Button>
          <Button size="sm" onClick={() => setSheet('add')}>
            <Icon name="plus" size={14} />
            Add
          </Button>
        </span>
      }
    >
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5" role="group" aria-label="Wallet type">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={count('all')}>All</Chip>
        <Chip active={filter === 'KOL'} onClick={() => setFilter('KOL')} count={count('KOL')}>KOLs</Chip>
        <Chip active={filter === 'COPY'} onClick={() => setFilter('COPY')} count={count('COPY')}>Copy</Chip>
        <Chip active={filter === 'auto'} onClick={() => setFilter('auto')} count={count('auto')}>Auto-found</Chip>
      </div>
      {q && (
        <div className="px-4 pb-3 text-sm text-ink-2 sm:px-5">
          Matching “{params.get('q')}” · <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => setParams({})}>clear</button>
        </div>
      )}
      {error && <div className="px-4 sm:px-5"><ErrorBox message={error} /></div>}
      {loading && !data ? (
        <div className="p-4"><Loading kind="rows" /></div>
      ) : !list.length ? (
        <div className="p-4">
          <Empty action={<Button size="sm" variant="outline" onClick={() => setSheet('add')}>Add a wallet</Button>}>{all.length ? 'No wallet matches.' : 'No wallets yet. Good sources: wallets that keep showing up early on coins that ran.'}</Empty>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {list.map((w) => (
              <li key={w.address} className={`px-4 py-3 ${w.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink">{w.label ?? shortAddr(w.address)}</div>
                    <div className="mt-1">{typeBadges(w)}</div>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    {w.pnlSol !== null ? <span className={`tabular font-medium ${w.pnlSol >= 0 ? 'text-up' : 'text-down'}`}>{w.pnlSol >= 0 ? '+' : ''}{w.pnlSol.toFixed(1)} SOL</span> : <span className="text-muted">—</span>}
                    <div className="tabular text-xs text-muted">{w.lastSeenAt ? ago(w.lastSeenAt) : 'not seen'}</div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="tabular">{w.tradesSeen.toLocaleString()} trades seen · {w.copies} copied</span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void toggle(w)}>{w.active ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="ghost" className="text-down" onClick={() => void remove(w)}>Remove</Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto border-t border-line md:block">
            <table className="tabular w-full min-w-[38rem] text-sm [&_td]:whitespace-nowrap">
              <thead className={theadCls}>
                <tr>
                  <Th>Wallet</Th>
                  <Th>Type</Th>
                  <Th right>~7 d SOL</Th>
                  <Th right>Last trade</Th>
                  <Th right>Copy result</Th>
                  <Th right><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.address} className={`${trCls} ${w.active ? '' : 'opacity-60'}`}>
                    <td className={tdCls}>
                      <div className="max-w-[10rem] truncate font-semibold text-ink" title={w.label ?? w.address}>{w.label ?? shortAddr(w.address)}</div>
                      <a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" title={w.address} className="font-mono text-xs text-muted hover:underline">{shortAddr(w.address)}</a>
                    </td>
                    <td className={tdCls}><span className="flex flex-wrap gap-1">{typeBadges(w)}</span></td>
                    <td className={`${tdCls} text-right`}>
                      {w.pnlSol !== null ? <span className={w.pnlSol >= 0 ? 'text-up' : 'text-down'}>{w.pnlSol >= 0 ? '+' : ''}{w.pnlSol.toFixed(1)}</span> : <span className="text-muted">—</span>}
                      {w.winRate !== null && <div className="text-xs text-muted">{Math.round(w.winRate * 100)}% wins</div>}
                    </td>
                    <td className={`${tdCls} text-right text-ink-2`}>
                      {w.lastSeenAt ? ago(w.lastSeenAt).replace(' ago', '') : '—'}
                      <div className="text-xs text-muted">{w.tradesSeen.toLocaleString()} seen</div>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <Pnl value={w.copies - w.openCopies > 0 ? w.copyPnlSol : null} />
                      <div className="text-xs text-muted">{w.copies} copied{w.openCopies ? ` · ${w.openCopies} open` : ''}</div>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void toggle(w)} aria-pressed={!w.active}>{w.active ? 'Pause' : 'Resume'}</Button>
                        <Button size="sm" variant="ghost" className="text-down" onClick={() => void remove(w)}>Remove</Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title="Wallets & KOLs" subtitle="Several KOLs buying one coin = checked at once and scored higher; KOLs dumping = no buy / take profit." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} sticky label="Wallet sections" />
      {tab === 'board' && (
        <div className="grid gap-6 xl:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-7">
            <KolBoard />
            {tracked}
          </div>
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-5">
            <SmartMoney q={q} />
            <WalletEngine />
          </div>
        </div>
      )}
      {tab === 'analyze' && <WalletAnalyzer />}

      <Sheet open={sheet === 'add'} onClose={() => setSheet(null)} title="Add a wallet">
        <form onSubmit={add} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Wallet address
            <input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 7xKX…" className={`${inputCls} font-mono`} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Name (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Cupsey" className={inputCls} />
          </label>
          <Select label="Type" value={kind} onChange={(v) => setKind(v as 'COPY' | 'KOL')} options={[['KOL', 'KOL (signal only)'], ['COPY', 'Copy trades']]} />
          {formError && <p role="alert" className="text-sm text-down">{formError}</p>}
          <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add wallet'}</Button>
        </form>
      </Sheet>
      <Sheet open={sheet === 'import'} onClose={() => setSheet(null)} title="Import a KOL list">
        <BulkImport onDone={() => void reload()} />
      </Sheet>
    </>
  );
}
