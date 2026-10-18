/** DexScreener trending coins (Scanner page): last hour or last 5 minutes, MC, volume / change, DEX paid, tracked by the bot. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { Card, Empty, Tabs } from './ui';

interface Row {
  mint: string;
  symbol: string;
  rank: number;
  volumeH1Usd: number;
  priceChangeH1Pct: number;
  marketCapUsd: number | null;
  boosts: number;
  url: string | null;
  pump: boolean;
  volumeM5Usd?: number;
  priceChangeM5Pct?: number;
  hot5mRank?: number | null;
  tracked: boolean;
  dexPaid: { paid: boolean; cto: boolean } | null;
}

const k = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

export function DexTrending() {
  const { data, error } = useApi<{ trending: Row[]; updatedAt: string | null; error: string | null }>('/api/dexscreener', 30_000);
  const [win, setWin] = useState<'m5' | 'h1'>('m5');
  const rows =
    win === 'm5'
      ? (data?.trending ?? []).filter((c) => c.hot5mRank != null).sort((a, b) => (a.hot5mRank ?? 0) - (b.hot5mRank ?? 0))
      : (data?.trending ?? []).filter((c) => c.rank <= 30);
  return (
    <Card title="DexScreener" subtitle={data?.updatedAt ? `Checked every 30 s · updated ${new Date(data.updatedAt).toLocaleTimeString()}` : 'Checked every 30 s'} action={<Tabs label="DexScreener window" className="w-[11rem]" tabs={[{ key: 'm5', label: '5 min' }, { key: 'h1', label: '1 hour' }]} value={win} onChange={setWin} />}>
      {(error || data?.error) && <p className="text-sm text-down">{error ?? data?.error}</p>}
      {data && rows.length > 0 ? (
        <ul className="divide-y divide-line text-sm">
          {rows.slice(0, 15).map((c) => (
            <li key={c.mint} className="flex min-h-11 min-w-0 items-center justify-between gap-2 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-6 shrink-0 tabular-nums text-muted">#{win === 'm5' ? c.hot5mRank : c.rank}</span>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="truncate font-semibold text-ink hover:underline">
                    {c.symbol}
                  </a>
                ) : (
                  <span className="truncate font-semibold text-ink">{c.symbol}</span>
                )}
                {c.dexPaid?.paid && <span className="shrink-0 rounded border border-line px-1 text-xs text-up">DEX paid</span>}
                {!c.dexPaid?.paid && c.dexPaid?.cto && <span className="shrink-0 rounded border border-line px-1 text-xs text-ink-2">CTO</span>}
                {c.tracked && <span className="shrink-0 text-xs text-accent" title="the bot is watching this coin">● tracked</span>}
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums text-ink-2">
                <Change pct={win === 'm5' ? (c.priceChangeM5Pct ?? 0) : c.priceChangeH1Pct} />
                <span className="block text-[11px] text-muted">{k(c.marketCapUsd)} · vol {k(win === 'm5' ? (c.volumeM5Usd ?? 0) : c.volumeH1Usd)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{data ? (win === 'm5' ? 'Nothing popping in the last 5 minutes right now.' : 'Nothing trending.') : 'Loading from DexScreener…'}</Empty>
      )}
    </Card>
  );
}

function Change({ pct }: { pct: number }) {
  return (
    <span className={pct >= 0 ? 'text-up' : 'text-down'}>
      {pct >= 0 ? '+' : ''}
      {pct.toFixed(0)}%
    </span>
  );
}
