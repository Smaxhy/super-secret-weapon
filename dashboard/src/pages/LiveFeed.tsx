/** Real-time scrolling feed of every detected token. */
import { useCallback, useEffect, useState } from 'react';
import { TokenCard } from '../components/TokenCard';
import type { FeedStatus } from '../components/StatusBadge';
import { Chip, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useBotEvents, type BotEvent } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import type { Detection } from '../lib/types';

const FILTERS: Array<[FeedStatus | 'all', string]> = [
  ['all', 'All'],
  ['bought', '✓ Bought'],
  ['interesting', '★ Interesting'],
  ['flagged', '✕ Dangerous'],
  ['skipped', '– Skipped'],
];

export function LiveFeed() {
  const [items, setItems] = useState<Detection[]>([]);
  const [filter, setFilter] = useState<FeedStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api<Detection[]>('/api/detections?limit=150'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => !paused && void load(), 15_000); // refresh live metrics
    return () => clearInterval(t);
  }, [load, paused]);

  const onEvent = useCallback(
    (e: BotEvent) => {
      if (paused) return;
      const d = e.data as Record<string, unknown>;
      if (e.type === 'token') {
        setItems((prev) =>
          [
            { mint: String(d.mint), name: String(d.name), symbol: String(d.symbol), creator: String(d.creator), createdAt: String(d.createdAt), status: 'ACTIVE', safetyScore: null, safetyHardFail: null, combinedScore: null, feedStatus: 'pending' as const, live: null },
            ...prev.filter((p) => p.mint !== d.mint),
          ].slice(0, 300),
        );
      } else if (e.type === 'safety') {
        setItems((prev) => prev.map((p) => (p.mint === d.mint ? { ...p, safetyScore: Number(d.score), safetyHardFail: Boolean(d.hardFail), feedStatus: d.hardFail ? 'flagged' : p.feedStatus === 'pending' ? 'skipped' : p.feedStatus } : p)));
      } else if (e.type === 'evaluation') {
        const score = Number(d.score);
        setItems((prev) => prev.map((p) => (p.mint === d.mint ? { ...p, combinedScore: score, feedStatus: p.feedStatus === 'bought' || p.feedStatus === 'flagged' ? p.feedStatus : score >= 60 ? 'interesting' : 'skipped' } : p)));
      } else if (e.type === 'trade' && d.side === 'BUY') {
        setItems((prev) => prev.map((p) => (p.mint === d.mint ? { ...p, feedStatus: 'bought' } : p)));
      }
    },
    [paused],
  );
  useBotEvents(onEvent);

  const shown = filter === 'all' ? items : items.filter((i) => i.feedStatus === filter);
  return (
    <>
      <PageHeader
        title="Live feed"
        subtitle="Every new Pump.fun token as the bot sees it. Click one for the full breakdown."
        action={
          <button type="button" onClick={() => setPaused((p) => !p)} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2" aria-pressed={paused}>
            {paused ? '▶ Resume feed' : '⏸ Pause feed'}
          </button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter">
        {FILTERS.map(([k, l]) => (
          <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>
            {l}
          </Chip>
        ))}
      </div>
      {error && <ErrorBox message={error} />}
      {loading ? <Loading /> : shown.length ? <div className="flex flex-col gap-2">{shown.map((d) => <TokenCard key={d.mint} d={d} />)}</div> : <Empty>Nothing here yet.</Empty>}
    </>
  );
}
