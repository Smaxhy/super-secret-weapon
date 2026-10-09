/** DexScreener trending coins (Scanner page): rank, MC, 1h volume / change, DEX paid, tracked by the bot. */
import { useApi } from '../hooks/useApi';
import { Card, Empty } from './ui';

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
  tracked: boolean;
  dexPaid: { paid: boolean; cto: boolean } | null;
}

const k = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

export function DexTrending() {
  const { data, error } = useApi<{ trending: Row[]; updatedAt: string | null; error: string | null }>('/api/dexscreener', 60_000);
  return (
    <Card title="DexScreener trending" className="mt-4">
      <p className="mb-2 text-sm text-ink-2">
        Solana coins getting the most attention on DexScreener (boosted / profiled, ranked by 1h volume, trades and move). Tracked coins that start trending get checked
        right away; DEX paid and trending add points to the score.
      </p>
      {(error || data?.error) && <p className="text-sm text-down">{error ?? data?.error}</p>}
      {data && data.trending.length > 0 ? (
        <ul className="divide-y divide-line text-sm">
          {data.trending.slice(0, 20).map((c) => (
            <li key={c.mint} className="flex min-w-0 items-center justify-between gap-2 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-6 shrink-0 tabular-nums text-muted">#{c.rank}</span>
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
              <span className="shrink-0 text-right tabular-nums text-ink-2">
                {k(c.marketCapUsd)} · vol {k(c.volumeH1Usd)} ·{' '}
                <span className={c.priceChangeH1Pct >= 0 ? 'text-up' : 'text-down'}>
                  {c.priceChangeH1Pct >= 0 ? '+' : ''}
                  {c.priceChangeH1Pct.toFixed(0)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Loading from DexScreener…</Empty>
      )}
    </Card>
  );
}
