/** Wallets page: the wallet engine — every wallet's record from the trade stream (proven wallets, known dumpers). */
import { useApi } from '../hooks/useApi';
import { Card, Empty } from './ui';

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
        <li key={r.wallet} className="flex min-w-0 items-center justify-between gap-2 py-1.5">
          <a href={`https://solscan.io/account/${r.wallet}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-ink hover:underline">
            <span className="mr-1 font-sans text-muted">#{i + 1}</span>
            {shortAddr(r.wallet)}
          </a>
          <span className="shrink-0 tabular-nums text-ink-2">
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
  const s = data?.stats;
  return (
    <Card title="Wallet engine" subtitle="Who is buying, not what the chart looks like. Built from every trade the bot sees — no extra API calls.">
      {s ? (
        <>
          <p className="mb-2 text-xs text-muted">
            {s.enabled ? `${s.wallets.toLocaleString()} wallets known · ${s.proven} proven · ${s.dumpers} known dumpers · ${s.losers} losers · ${s.bots} bots · ${s.dumpEvents} dumps seen` : 'off (Controls → Rules → Wallet engine)'}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 font-medium text-ink">Proven wallets (their buying adds points)</div>
              <List rows={data?.proven ?? []} kind="proven" />
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Known dumpers (inside a coin = no buy; selling while we hold = out)</div>
              <List rows={data?.dumpers ?? []} kind="dumper" />
            </div>
          </div>
        </>
      ) : (
        <Empty>Loading…</Empty>
      )}
    </Card>
  );
}
