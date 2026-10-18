/**
 * Performance — a report.
 *  - Sticky summary header: window (24h / 7d / all) + net, trades, win rate, profit factor, avg win / loss.
 *  - Section nav on the left (desktop) or tabs (phone): Results, Mistakes, Timing, Tests, AI.
 *  - Every section is two columns on wide screens: charts on the left, the rows that explain them on the right.
 */
import { useMemo } from 'react';
import { AiCoach } from '../components/AiCoach';
import { Backtest } from '../components/Backtest';
import { BestTimes } from '../components/BestTimes';
import { BotChanges } from '../components/BotChanges';
import { PnlChart, SignedBars } from '../components/Charts';
import { Icon } from '../components/Icon';
import { LossAutopsy } from '../components/LossAutopsy';
import { MoneyMap } from '../components/MoneyMap';
import { MoonshotCard } from '../components/MoonshotCard';
import { Replay } from '../components/Replay';
import { ScoreGap } from '../components/ScoreGap';
import { Tournament } from '../components/Tournament';
import { StrategyLab } from '../components/StrategyLab';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, Row, Rows, SectionHeader, Tabs, useStored, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { EXIT_LABEL, pct, STRATEGY_LABEL } from '../lib/format';
import type { Overview, PerformanceData } from '../lib/types';

const SECTIONS = [
  { key: 'results', label: 'Results', icon: <Icon name="chart" size={16} /> },
  { key: 'mistakes', label: 'Mistakes', icon: <Icon name="alert" size={16} /> },
  { key: 'money', label: 'Money', icon: <Icon name="radar" size={16} /> },
  { key: 'timing', label: 'Timing', icon: <Icon name="clock" size={16} /> },
  { key: 'tests', label: 'Tests', icon: <Icon name="flask" size={16} /> },
  { key: 'ai', label: 'AI', icon: <Icon name="sparkles" size={16} /> },
] as const;
type Section = (typeof SECTIONS)[number]['key'];
const WINDOWS = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: 'all', label: 'All' },
] as const;
type Win = (typeof WINDOWS)[number]['key'];

export function Performance() {
  const { data: d, error, loading } = useApi<PerformanceData>('/api/performance', 60_000, ['trade']);
  const [win, setWin] = useStored<Win>('performance.window', 'all', ['24h', '7d', 'all']);
  const w = useApi<Overview>(win === 'all' ? null : `/api/overview?range=${win}`, 60_000, ['trade']);
  const [section, setSection] = useTab<Section>('performance', SECTIONS.map((s) => s.key), 'results');
  if (loading && !d) return <Loading />;
  return (
    <>
      <PageHeader title="Performance" subtitle={d ? `${d.mode === 'PAPER' ? 'Paper' : 'Live'} results · ${d.trades.toLocaleString()} closed trades since the last stats reset` : undefined} />
      {error && <ErrorBox message={error} />}
      {d && (
        <Summary d={d} win={win} setWin={setWin} windowData={win === 'all' ? null : (w.data?.window ?? null)}>
          <Tabs className="hidden md:block" tabs={SECTIONS.map((x) => ({ key: x.key, label: x.label }))} value={section} onChange={setSection} label="Report sections" />
        </Summary>
      )}
      <div className="md:hidden">
        <Tabs sticky tabs={SECTIONS.map((x) => ({ key: x.key, label: x.label }))} value={section} onChange={setSection} label="Report sections" />
      </div>
      <div className="min-w-0">
        {section === 'results' && <Results d={d} />}
        {section === 'mistakes' && (
          <div className="flex flex-col gap-6">
            <ScoreGap />
            <LossAutopsy />
            <BotChanges />
          </div>
        )}
        {section === 'money' && <MoneyMap />}
        {section === 'timing' && <BestTimes />}
        {section === 'tests' && (
          <div className="flex flex-col gap-6">
            <Replay />
            <Tournament />
            <StrategyLab />
            <div className="grid gap-6 xl:grid-cols-2">
              <MoonshotCard />
              <Backtest />
            </div>
          </div>
        )}
        {section === 'ai' && <AiCoach />}
      </div>
    </>
  );
}

/** Per-trade P&L from a cumulative curve → net, win rate, profit factor, average win / loss. */
function statsFrom(curve: Array<{ pnl: number }>) {
  let prev = 0;
  const xs = curve.map((p) => {
    const v = p.pnl - prev;
    prev = p.pnl;
    return v;
  });
  const wins = xs.filter((x) => x > 0);
  const losses = xs.filter((x) => x <= 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n: xs.length,
    net: xs.reduce((a, b) => a + b, 0),
    winRate: xs.length ? (wins.length / xs.length) * 100 : null,
    pf: gl > 0 ? gw / gl : wins.length ? Infinity : null,
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
  };
}

function Summary({ d, win, setWin, windowData, children }: { d: PerformanceData; win: Win; setWin: (w: Win) => void; windowData: Overview['window'] | null; children?: React.ReactNode }) {
  const s = useMemo(() => statsFrom(win === 'all' ? d.cumulative : (windowData?.cumulative ?? [])), [d, win, windowData]);
  return (
    <section aria-label="Summary" className="glass z-[6] md:sticky md:top-[var(--hdr)] -mx-4 mb-6 border-b border-line px-4 py-3 sm:-mx-6 sm:px-6 md:mx-0 md:rounded-2xl md:border md:px-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
        <Tabs className="w-full shrink-0 sm:w-56" label="Window" tabs={WINDOWS} value={win} onChange={setWin} />
        <dl className="grid flex-1 grid-cols-3 gap-x-4 gap-y-2 xl:grid-cols-6">
          <Num label="Net" value={<Pnl value={s.n ? s.net : null} dp={3} />} />
          <Num label="Trades" value={s.n.toLocaleString()} />
          <Num label="Win rate" value={pct(s.winRate, 0)} />
          <Num label="Profit factor" value={s.pf === null ? '—' : s.pf === Infinity ? '∞' : s.pf.toFixed(2)} tone={s.pf !== null && s.pf < 1 ? 'down' : s.pf !== null && s.pf >= 1.2 ? 'up' : undefined} />
          <Num label="Avg win" value={<Pnl value={s.avgWin} />} />
          <Num label="Avg loss" value={<Pnl value={s.avgLoss} />} />
        </dl>
      </div>
      {children && <div className="mt-3 hidden border-t border-line pt-3 md:block">{children}</div>}
    </section>
  );
}

function Num({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`tabular mt-0.5 truncate text-sm font-semibold sm:text-base ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function Results({ d }: { d: PerformanceData | null | undefined }) {
  if (!d) return null;
  if (!d.trades) return <Empty>No closed trades yet. Charts appear after the first trade closes.</Empty>;
  const strategies = d.byStrategy.map((s) => ({ ...s, name: STRATEGY_LABEL[s.strategy] ?? s.strategy }));
  const exits = d.byExitReason.map((r) => ({ ...r, name: EXIT_LABEL[r.reason] ?? r.reason }));
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="Results" description="Cumulative profit, day by day, and where it came from." />
      <div className="grid gap-6 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-8">
          <Card title="Cumulative profit" subtitle="After every fee, one point per closed trade">
            <PnlChart points={d.cumulative} height={280} />
          </Card>
          <Card title="Daily profit / loss">
            <SignedBars data={d.daily} labelKey="day" height={200} />
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Profit by strategy">
              <SignedBars data={strategies} labelKey="name" valueKey="pnlSol" height={200} />
            </Card>
            <Card title="Profit by how trades ended">
              <SignedBars data={exits} labelKey="name" valueKey="pnlSol" height={200} />
            </Card>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-4">
          <Card title="Highlights">
            <Rows>
              <Row label="Best trade" sub={d.best?.symbol} value={d.best ? <Pnl value={d.best.pnlSol} /> : '—'} />
              <Row label="Worst trade" sub={d.worst?.symbol} value={d.worst ? <Pnl value={d.worst.pnlSol} /> : '—'} />
              <Row label="Max drawdown" sub={`${d.maxDrawdownPct.toFixed(1)}% from the peak`} value={<span className="text-down">−{d.maxDrawdownSol.toFixed(3)} SOL</span>} />
              <Row label="Consistency" sub="daily average ÷ swing; above 0.5 = steady" value={d.consistency?.toFixed(2) ?? '—'} />
              <Row label="Wins / losses" sub={`${pct(d.winRate, 0)} win rate`} value={`${d.wins} / ${d.losses}`} />
            </Rows>
          </Card>
          <Card title="By strategy">
            <Rows>
              {[...d.byStrategy].sort((a, b) => b.pnlSol - a.pnlSol).map((s) => (
                <Row key={s.strategy} label={STRATEGY_LABEL[s.strategy] ?? s.strategy} value={<Pnl value={s.pnlSol} />} sub={`${s.trades} trades · ${pct(s.winRate, 0)} wins`} />
              ))}
            </Rows>
          </Card>
          <Card title="How trades ended">
            <Rows>
              {[...d.byExitReason].sort((a, b) => b.trades - a.trades).map((r) => (
                <Row key={r.reason} label={EXIT_LABEL[r.reason] ?? r.reason} sub={`${r.trades} trades`} value={<Pnl value={r.pnlSol} />} />
              ))}
            </Rows>
          </Card>
        </div>
      </div>
    </div>
  );
}
