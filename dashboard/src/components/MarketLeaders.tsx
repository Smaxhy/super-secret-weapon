/** "What's working now": top coins (ours + DexScreener) and the narratives they share. */
import { useApi } from '../hooks/useApi';
import { Card, Empty } from './ui';

interface Data {
  leaders: Array<{ mint: string; symbol: string; source: 'own' | 'dexscreener'; volume1h: number; priceChangeH1Pct: number | null; marketCapUsd: number | null }>;
  narratives: Array<{ word: string; leaders: number }>;
  updatedAt: string | null;
}

export function MarketLeadersCard() {
  const { data } = useApi<Data>('/api/market-leaders', 60_000);
  return (
    <Card title="What's working now" className="mt-4">
      <p className="mb-2 text-sm text-ink-2">Top coins of the last hour (our biggest-volume coins + DexScreener trending). Words they share are hot narratives — new coins matching them score higher.</p>
      {data && data.narratives.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {data.narratives.map((n) => (
            <span key={n.word} className="rounded-full border border-line px-2.5 py-0.5 text-sm text-ink">
              🔥 {n.word} <span className="text-muted">×{n.leaders}</span>
            </span>
          ))}
        </div>
      )}
      {data && data.leaders.length > 0 ? (
        <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
          {data.leaders.slice(0, 16).map((l) => (
            <li key={l.mint} className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-1">
              <span className="truncate font-medium text-ink">{l.symbol}</span>
              <span className="shrink-0 tabular-nums text-ink-2">
                {l.source === 'own' ? `${l.volume1h.toFixed(0)} SOL/1h` : `$${Math.round(l.volume1h / 1000)}k/1h`}
                {l.priceChangeH1Pct !== null && (
                  <span className={l.priceChangeH1Pct >= 0 ? 'text-up' : 'text-down'}>
                    {' '}
                    {l.priceChangeH1Pct >= 0 ? '+' : ''}
                    {l.priceChangeH1Pct.toFixed(0)}%
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Builds up over the first few minutes after a restart.</Empty>
      )}
    </Card>
  );
}
