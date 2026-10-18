/** Wallets page: the wallet engine — every wallet's record from the trade stream (proven wallets, known dumpers). */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { Card, Empty, Tabs } from './ui';

interface Row {
  wallet: string;
  pnlSol: number;
  sells: number;
  winRate: number;
  holdMin: number | null;
  dumps: number;
  coins: number;
}
interface Book {
  stats: { enabled: boolean; wallets: number; proven: number; dumpers: number; losers: number; bots: number; trades: number; dumpEvents: number };
  proven: Row[];
  dumpers: Row[];
}

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function List({ rows, kind }: { rows: Row[]; kind: 'proven' | 'dumper' }) {
  if (!rows.length) return <Empty>Nothing yet — builds up as trades flow.</Empty>;
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((r, i) => (
        <li key={r.wallet} className="flex min-h-11 min-w-0 items-center justify-between gap-2 py-1.5">
          <a href={`https://solscan.io/account/${r.wallet}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-ink hover:underline">
            <span className="mr-1 font-sans text-muted">#{i + 1}</span>
            {shortAddr(r.wallet)}
          </a>
          <span className="shrink-0 text-right text-xs tabular-nums text-ink-2">
            {kind === 'proven' ? (
              <>
                <span className="text-up">+{r.pnlSol.toFixed(1)} SOL</span> · {Math.round(r.winRate * 100)}% · {r.sells} sells{r.holdMin !== null ? ` · holds ~${r.holdMin} min` : ''}
              </>
            ) : (
              <>
                <span className="text-down">{r.dumps} dumps</span> · {r.coins} coins{r.holdMin !== null ? ` · holds ~${r.holdMin} min` : ''}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WalletEngine() {
  const { data } = useApi<Book | null>('/api/wallet-book', 60_000);
  const [view, setView] = useState<'proven' | 'dumper'>('proven');
  const s = data?.stats;
  return (
    <Card title="Wallet engine" subtitle="Who is buying, not what the chart looks like. Built from every trade the bot sees, no extra API calls.">
      {s ? (
        s.enabled ? (
          <>
            <dl className="mb-4 grid grid-cols-4 gap-2 text-center">
              {([['Known', s.wallets], ['Proven', s.proven], ['Dumpers', s.dumpers], ['Bots', s.bots]] as const).map(([l, v]) => (
                <div key={l} className="min-w-0 rounded-xl bg-surface-2 px-2 py-2">
                  <dt className="truncate text-[11px] font-medium text-muted">{l}</dt>
                  <dd className="tabular mt-0.5 truncate font-semibold text-ink">{v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <Tabs className="mb-2" label="Wallet list" value={view} onChange={setView} tabs={[{ key: 'proven', label: 'Proven' }, { key: 'dumper', label: 'Known dumpers' }]} />
            <p className="mb-1 text-xs text-muted">{view === 'proven' ? 'Their buying adds points to a coin.' : 'Inside a coin = no buy; selling while we hold = out.'}</p>
            <List rows={(view === 'proven' ? data?.proven : data?.dumpers) ?? []} kind={view} />
          </>
        ) : (
          <Empty>Off. Switch it on under Controls → Rules → Wallet engine.</Empty>
        )
      ) : (
        <Empty>Loading…</Empty>
      )}
    </Card>
  );
}
