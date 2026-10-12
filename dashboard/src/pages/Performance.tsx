import { PnlChart, SignedBars } from '../components/Charts';
import { StrategyLab } from '../components/StrategyLab';
import { Backtest } from '../components/Backtest';
import { LossAutopsy } from '../components/LossAutopsy';
import { BestTimes } from '../components/BestTimes';
import { BotChanges } from '../components/BotChanges';
import { AiCoach } from '../components/AiCoach';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, Row, Rows, Stack, Stat, StatTile, Tabs, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { EXIT_LABEL, pct, STRATEGY_LABEL } from '../lib/format';
import type { PerformanceData } from '../lib/types';

const TABS = [
  { key: 'results', label: 'Results' },
  { key: 'mistakes', label: 'Mistakes' },
  { key: 'timing', label: 'Timing' },
  { key: 'tests', label: 'Tests' },
  { key: 'ai', label: 'AI' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export function Performance() {
  const { data: d, error, loading } = useApi<PerformanceData>('/api/performance', 60_000, ['trade']);
  const [tab, setTab] = useTab<Tab>('performance', TABS.map((t) => t.key), 'results');
  if (loading && !d) return <Loading />;
  return (
    <>
      <PageHeader title="Performance" subtitle={d ? `${d.mode === 'PAPER' ? 'Paper' : 'Live'} results · ${d.trades.toLocaleString()} closed trades` : undefined} />
      {error && <ErrorBox message={error} />}
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Performance sections" />
      {tab === 'results' && <Results d={d} />}
      {tab === 'mistakes' && (
        <Stack>
          <LossAutopsy />
          <BotChanges />
        </Stack>
      )}
      {tab === 'timing' && <BestTimes />}
      {tab === 'tests' && (
        <Stack>
          <StrategyLab />
          <Backtest />
        </Stack>
      )}
      {tab === 'ai' && <AiCoach />}
    </>
  );
}

function Results({ d }: { d: PerformanceData | null | undefined }) {
  if (!d) return null;
  if (!d.trades) return <Empty>No closed trades yet. Charts appear after the first trade closes.</Empty>;
  return (
    <Stack>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total profit" value={<Pnl value={d.totalPnlSol} />} sub={`${pct((d.totalPnlSol / (d.startingBalanceSol + (d.addedSol ?? 0))) * 100, 1, true)} of the money put in`} />
        <StatTile label="Win rate" value={pct(d.winRate, 0)} sub={`${d.wins} wins · ${d.losses} losses`} />
        <StatTile label="Avg win / loss" value={<span className="flex flex-col text-base leading-tight sm:text-lg"><Pnl value={d.avgWinSol} /><Pnl value={d.avgLossSol} /></span>} />
        <StatTile label="Max drawdown" value={`−${d.maxDrawdownSol.toFixed(3)} SOL`} sub={`${d.maxDrawdownPct.toFixed(1)}% from peak`} />
      </div>

      <Card title="Cumulative profit">
        <PnlChart points={d.cumulative} height={260} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Daily profit / loss">
          <SignedBars data={d.daily} labelKey="day" />
        </Card>
        <Card title="Profit by strategy">
          <SignedBars data={d.byStrategy.map((s) => ({ ...s, name: STRATEGY_LABEL[s.strategy] ?? s.strategy }))} labelKey="name" valueKey="pnlSol" />
          <Rows className="mt-3">
            {d.byStrategy.map((s) => (
              <Row key={s.strategy} label={STRATEGY_LABEL[s.strategy] ?? s.strategy} value={<Pnl value={s.pnlSol} />} sub={`${s.trades} trades · ${pct(s.winRate, 0)} win rate`} />
            ))}
          </Rows>
        </Card>
      </div>

      <Card title="Highlights">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Best trade" value={d.best ? <Pnl value={d.best.pnlSol} /> : '—'} sub={d.best?.symbol} />
          <Stat label="Worst trade" value={d.worst ? <Pnl value={d.worst.pnlSol} /> : '—'} sub={d.worst?.symbol} />
          <Stat label="Consistency" value={d.consistency?.toFixed(2) ?? '—'} sub="above 0.5 = steady" />
        </div>
        <p className="mt-3 text-xs text-muted">Consistency = average daily profit ÷ how much it swings (needs 2+ days; below 0 means losing on average).</p>
      </Card>

      <Card title="How trades ended">
        <Rows>
          {d.byExitReason.map((r) => (
            <Row key={r.reason} label={EXIT_LABEL[r.reason] ?? r.reason} sub={`${r.trades} trades`} value={<Pnl value={r.pnlSol} />} />
          ))}
        </Rows>
      </Card>
    </Stack>
  );
}
