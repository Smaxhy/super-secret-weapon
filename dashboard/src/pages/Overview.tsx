import { Link } from 'react-router-dom';
import { PnlChart } from '../components/Charts';
import { TokenCard } from '../components/TokenCard';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, StatTile } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, duration, EXIT_LABEL, pct, sol } from '../lib/format';
import type { Detection, Overview as OverviewData, TradeRowData } from '../lib/types';

export function Overview() {
  const o = useApi<OverviewData>('/api/overview', 15_000, ['trade', 'token']);
  const trades = useApi<TradeRowData[]>('/api/trades?limit=5', 30_000, ['trade']);
  const feed = useApi<Detection[]>('/api/detections?limit=6', 15_000, ['token', 'safety', 'evaluation']);

  if (o.loading && !o.data) return <Loading />;
  const d = o.data;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={d ? `${d.mode === 'PAPER' ? '📝 Paper trading (fake money)' : '💸 LIVE trading'} · running for ${duration(d.uptimeSec)}` : undefined}
      />
      {o.error && <ErrorBox message={o.error} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label={d.mode === 'PAPER' ? 'Paper balance' : 'Wallet balance'} value={sol(d.balanceSol, 2)} sub={`started with ${sol(d.startingBalanceSol, 0)}`} />
            <StatTile label="Total profit" value={<Pnl value={d.totalPnlSol} />} sub={pct((d.totalPnlSol / d.startingBalanceSol) * 100, 1, true) + ' of start'} />
            <StatTile label="Today" value={<Pnl value={d.todayPnlSol} />} sub="since 00:00 UTC" />
            <StatTile label="Win rate" value={pct(d.winRate, 0)} sub={`${d.trades} closed trades`} />
            <StatTile label="Open positions" value={`${d.openPositions} / ${d.maxPositions}`} sub={`${d.launchesToday.toLocaleString()} launches today`} />
          </div>

          <Card title="Profit over time" className="mt-4" action={<Link to="/performance" className="text-sm text-accent hover:underline">All charts →</Link>}>
            {d.cumulative.length ? <PnlChart points={d.cumulative} /> : <Empty>No closed trades yet. The chart fills in as the bot paper trades.</Empty>}
          </Card>
        </>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Latest trades" action={<Link to="/history" className="text-sm text-accent hover:underline">History →</Link>}>
          {trades.data?.length ? (
            <ul className="divide-y divide-line">
              {trades.data.map((t) => (
                <li key={t.id}>
                  <Link to={`/token/${t.mint}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-surface-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-ink">{t.symbol}</div>
                      <div className="text-sm text-muted">
                        {EXIT_LABEL[t.exitReason ?? ''] ?? t.exitReason} · {ago(t.closedAt)}
                      </div>
                    </div>
                    <div className="text-right">
                      <Pnl value={t.pnlSol} />
                      <div className={`text-sm ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No trades yet.</Empty>
          )}
        </Card>
        <Card title="Just launched" action={<Link to="/feed" className="text-sm text-accent hover:underline">Live feed →</Link>}>
          <div className="flex flex-col gap-2">{feed.data?.map((t) => <TokenCard key={t.mint} d={t} />)}</div>
          {feed.data && !feed.data.length && <Empty>Waiting for launches…</Empty>}
        </Card>
      </div>
    </>
  );
}
