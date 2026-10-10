/**
 * Positions — what you're invested in right now, at a glance.
 *  - Summary: open trades, SOL in trades, unrealised and banked P&L.
 *  - Tabs: "Invested now" (every open trade as one compact row — tap one for its chart and details),
 *    "Bigger coins" (the swing list + your swing watchlist) and "Waiting for a dip".
 * The chosen tab and sort are remembered on this device.
 */
import { useState } from 'react';
import { DipWatch, type DipRow } from '../components/DipWatch';
import { PositionRow } from '../components/PositionRow';
import { SwingCoins, type SwingData } from '../components/SwingCoins';
import { Chip, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLivePositions, type LivePosition } from '../hooks/useLivePositions';
import { sol } from '../lib/format';
import type { Overview } from '../lib/types';

type Tab = 'invested' | 'bigger' | 'dips';
type Sort = 'newest' | 'best' | 'worst';
type Group = 'all' | 'small' | 'big';

function useStored<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && allowed.includes(s) ? s : initial;
    } catch {
      return initial;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch {
      /* private mode */
    }
  };
  return [v, set];
}

const isBig = (p: LivePosition) => p.strategy === 'SWING';

export function Positions() {
  const { positions, error, loading, reload } = useLivePositions();
  const swing = useApi<SwingData>('/api/swing', 20_000);
  const dips = useApi<DipRow[]>('/api/dip-watch', 5_000);
  const ov = useApi<Overview>('/api/overview', 30_000, ['trade']);
  const [tab, setTab] = useStored<Tab>('solbot.positionsTab', 'invested', ['invested', 'bigger', 'dips']);
  const [sort, setSort] = useStored<Sort>('solbot.positionsSort', 'newest', ['newest', 'best', 'worst']);
  const [group, setGroup] = useStored<Group>('solbot.positionsGroup', 'all', ['all', 'small', 'big']);

  const list = positions ?? [];
  const inSol = list.reduce((s, p) => s + (p.sizeSol * p.remainingPct) / 100, 0);
  const unreal = list.reduce((s, p) => s + (p.unrealizedPnlSol ?? 0), 0);
  const banked = list.reduce((s, p) => s + p.realizedPnlSol, 0);
  const swingLive = (swing.data?.coins ?? []).filter((c) => c.live).length;
  const bigOpen = list.filter(isBig).length;

  const shown = list
    .filter((p) => (group === 'all' ? true : group === 'big' ? isBig(p) : !isBig(p)))
    .slice()
    .sort((a, b) => (sort === 'newest' ? new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime() : sort === 'best' ? (b.multiple ?? 0) - (a.multiple ?? 0) : (a.multiple ?? 0) - (b.multiple ?? 0)));

  // [tab, label, short label for phones, count]
  const tabs: Array<[Tab, string, string, number | null]> = [
    ['invested', 'Invested now', 'Invested', list.length],
    ['bigger', 'Bigger coins', 'Bigger', swingLive],
    ['dips', 'Waiting for a dip', 'Dips', dips.data?.length ?? 0],
  ];

  return (
    <>
      <PageHeader title="Positions" subtitle="What the bot is invested in right now. Prices update live on every trade." />

      {/* Summary — always visible */}
      <section aria-label="Invested now summary" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Summary label="Open trades" value={`${list.length}${ov.data ? ` / ${ov.data.maxPositions}` : ''}`} sub={bigOpen ? `${bigOpen} on bigger coins` : undefined} />
        <Summary label="In trades" value={sol(inSol, 2)} sub={ov.data ? `${sol(ov.data.balanceSol, 2)} free` : undefined} />
        <Summary label="Unrealised" value={<Pnl value={list.length ? unreal : null} />} sub="if sold now, after fees" />
        <Summary label="Banked" value={<Pnl value={list.length ? banked : null} />} sub="partial sells on open trades" />
      </section>

      {/* Tabs */}
      <div role="tablist" aria-label="Positions" className="mb-4 grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface p-1">
        {tabs.map(([k, label, short, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-sm font-semibold transition-colors sm:px-3 ${tab === k ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2'}`}
          >
            <span className="truncate sm:hidden">{short}</span>
            <span className="hidden truncate sm:inline">{label}</span>
            {n !== null && <span className={`shrink-0 rounded-full px-1.5 text-xs ${tab === k ? 'bg-white/25' : 'bg-surface-2 text-ink-2'}`}>{n}</span>}
          </button>
        ))}
      </div>

      {tab === 'invested' && (
        <>
          {error && <ErrorBox message={error} />}
          {list.length > 1 && (
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
                <Chip active={group === 'all'} onClick={() => setGroup('all')}>All</Chip>
                <Chip active={group === 'small'} onClick={() => setGroup('small')}>New coins</Chip>
                <Chip active={group === 'big'} onClick={() => setGroup('big')}>Bigger</Chip>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-sm text-ink-2">
                <span className="hidden sm:inline">Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                  <option value="newest">Newest</option>
                  <option value="best">Best first</option>
                  <option value="worst">Worst first</option>
                </select>
              </label>
            </div>
          )}
          {loading && !positions ? (
            <Loading />
          ) : !list.length ? (
            <Empty>Not invested in anything right now. The bot buys when a coin passes every rule — the Bigger coins tab shows the swing coins it's watching.</Empty>
          ) : !shown.length ? (
            <Empty>No open trades in this group.</Empty>
          ) : (
            <ul className="grid items-start gap-3 xl:grid-cols-2">
              {shown.map((p) => (
                <PositionRow key={p.id} p={p} onSold={() => void reload()} />
              ))}
            </ul>
          )}
        </>
      )}

      {tab === 'bigger' && <SwingCoins data={swing.data} reload={swing.reload} />}
      {tab === 'dips' && <DipWatch rows={dips.data} />}
    </>
  );
}

function Summary({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-card">
      <div className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-0.5 truncate text-lg font-semibold text-ink">{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
