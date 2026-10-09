import { PnlChart, SignedBars } from '../components/Charts';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, StatTile } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { EXIT_LABEL, pct, STRATEGY_LABEL } from '../lib/format';
import type { PerformanceData } from '../lib/types';

export function Performance() {
  const { data: d, error, loading } = useApi<PerformanceData>('/api/performance', 30_000);
  if (loading && !d) return <Loading />;
  return (
    <>
      <PageHeader title="Performance" subtitle={d ? `${d.mode === 'PAPER' ? 'Paper trading' : 'Live trading'} results from ${d.trades} closed trades` : undefined} />
      {error && <ErrorBox message={error} />}
      {d && !d.trades && <Empty>No closed trades yet — charts appear after the first trade closes.</Empty>}
      {d && d.trades > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Total profit" value={<Pnl value={d.totalPnlSol} />} sub={`${pct((d.totalPnlSol / d.startingBalanceSol) * 100, 1, true)} of starting balance`} />
            <StatTile label="Win rate" value={pct(d.winRate, 0)} sub={`${d.wins} wins · ${d.losses} losses`} />
            <StatTile label="Avg win / avg loss" value={<span className="text-xl"><Pnl value={d.avgWinSol} /> <span className="text-muted">/</span> <Pnl value={d.avgLossSol} /></span>} />
            <StatTile label="Max drawdown" value={`−${d.maxDrawdownSol.toFixed(3)} SOL`} sub={`${d.maxDrawdownPct.toFixed(1)}% from peak`} />
          </div>

          <Card title="Cumulative profit" className="mt-4">
            <PnlChart points={d.cumulative} height={320} />
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title="Daily profit / loss">
              <SignedBars data={d.daily} labelKey="day" />
            </Card>
            <Card title="Profit by strategy">
              <SignedBars data={d.byStrategy.map((s) => ({ ...s, name: STRATEGY_LABEL[s.strategy] ?? s.strategy }))} labelKey="name" valueKey="pnlSol" />
              <ul className="mt-3 space-y-1 text-sm text-ink-2">
                {d.byStrategy.map((s) => (
                  <li key={s.strategy}>
                    {STRATEGY_LABEL[s.strategy] ?? s.strategy}: {s.trades} trades, {pct(s.winRate, 0)} win rate
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card title="Best trade">{d.best ? <BestWorst symbol={d.best.symbol} value={d.best.pnlSol} /> : '—'}</Card>
            <Card title="Worst trade">{d.worst ? <BestWorst symbol={d.worst.symbol} value={d.worst.pnlSol} /> : '—'}</Card>
            <Card title="Consistency">
              <div className="text-2xl font-semibold text-ink">{d.consistency?.toFixed(2) ?? '—'}</div>
              <p className="mt-1 text-sm text-ink-2">Average daily profit ÷ how much it swings. Above 0.5 is steady; below 0 means losing on average. Needs 2+ days.</p>
            </Card>
          </div>

          <Card title="How trades ended" className="mt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular">
                <thead>
                  <tr className="text-left text-ink-2">
                    <th className="pb-2 font-medium">Exit reason</th>
                    <th className="pb-2 font-medium">Trades</th>
                    <th className="pb-2 font-medium">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byExitReason.map((r) => (
                    <tr key={r.reason} className="border-t border-line">
                      <td className="py-2 text-ink">{EXIT_LABEL[r.reason] ?? r.reason}</td>
                      <td className="text-ink-2">{r.trades}</td>
                      <td>
                        <Pnl value={r.pnlSol} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function BestWorst({ symbol, value }: { symbol: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold text-ink">{symbol}</div>
      <Pnl value={value} className="text-xl" />
    </div>
  );
}
