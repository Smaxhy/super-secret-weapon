/**
 * Strategies: every chart strategy the bot knows (Fibonacci, EMA pullbacks, breakouts,
 * divergences, order flow …), explained in plain words, with its LIVE record — each one is
 * paper-tested on real coins against random entries. Only strategies that beat random entries
 * on enough trades get a say in real buys. Also the exit-setup lab.
 */
import { useMemo, useState } from 'react';
import { StrategyLab } from '../components/StrategyLab';
import { Badge, Chip, Drawer, Empty, ErrorBox, inputCls, Loading, PageHeader, Row as RowItem, Rows, SectionHeader, StatTile, Table, Tabs, Th, tdCls, theadCls, trCls, useStored } from '../components/ui';
import { useApi } from '../hooks/useApi';

interface Stats {
  id: string;
  name: string;
  n: number;
  winRate: number;
  avgPnlPct: number;
  medianPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  lowerPct: number;
}
interface Row extends Stats {
  family: string;
  summary: string;
  proven: boolean;
  /** v10.36: live by the owner's choice, not proven yet (older bots don't send it). */
  forcedLive?: boolean;
  edgePct: number | null;
  curve: Stats;
  amm: Stats;
  big?: Stats;
}
interface TaLabData {
  enabled: boolean;
  baseline: Stats | null;
  strategies: Row[];
  open: number;
  stats: { ticks: number; coinsLooked: number; signals: number; opened: number; lastTickMs: number };
  minTrades: number;
  minEdgePct: number;
}

const FAMILY: Record<string, string> = {
  fibonacci: 'Fibonacci',
  trend: 'Trend',
  momentum: 'Momentum',
  'mean-reversion': 'Mean reversion',
  breakout: 'Breakout',
  structure: 'Structure',
  pattern: 'Pattern',
  volume: 'Volume / order flow',
};
const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

type StatusKey = 'proven' | 'live' | 'testing' | 'none';
const statusOf = (r: Row, minTrades: number): StatusKey => (r.forcedLive ? 'live' : r.proven ? 'proven' : r.n < minTrades ? 'testing' : 'none');

function Status({ r, minTrades }: { r: Row; minTrades: number }) {
  const k = statusOf(r, minTrades);
  if (k === 'live') return <Badge tone="warn" title="Live by your choice, not proven yet">live, your choice</Badge>;
  if (k === 'proven') return <Badge tone="up" title="Used in real buys">proven</Badge>;
  if (k === 'testing') return <Badge>testing {r.n}/{minTrades}</Badge>;
  return <Badge tone="down">no edge yet</Badge>;
}

type SortKey = 'name' | 'n' | 'winRate' | 'avgPnlPct' | 'edgePct';

export function Strategies() {
  const { data, error, loading } = useApi<TaLabData>('/api/ta-lab', 30_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tf, setTf] = useStored<'all' | '15s' | '5s' | '1m'>('strategies.tf', 'all', ['all', '15s', '5s', '1m']);
  const [status, setStatus] = useStored<'all' | StatusKey>('strategies.status', 'all', ['all', 'proven', 'live', 'testing', 'none']);
  const [family, setFamily] = useState<string>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'avgPnlPct', dir: -1 });
  const tfOf = (id: string) => (id.endsWith('@5s') ? '5s' : id.endsWith('@1m') ? '1m' : '15s');
  const minTrades = data?.minTrades ?? 60;
  const shown = useMemo(() => {
    const val = (r: Row) => (sort.key === 'name' ? r.name.toLowerCase() : sort.key === 'edgePct' ? (r.edgePct ?? -999) : sort.key === 'n' ? r.n : r.n ? r[sort.key] : -999);
    return (data?.strategies ?? [])
      .filter((r) => tf === 'all' || tfOf(r.id) === tf)
      .filter((r) => status === 'all' || statusOf(r, minTrades) === status)
      .filter((r) => family === 'all' || r.family === family)
      .sort((a, b) => {
        const av = val(a);
        const bv = val(b);
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
  }, [data, tf, status, family, sort, minTrades]);
  if (loading && !data) return <Loading />;
  const all = data?.strategies ?? [];
  const count = (k: StatusKey) => all.filter((r) => statusOf(r, minTrades) === k).length;
  const families = [...new Set(all.map((r) => r.family))];
  const opened = all.find((r) => r.id === openId) ?? null;
  const th = (key: SortKey) => ({ active: sort.key === key, dir: sort.dir, onClick: () => setSort((x) => ({ key, dir: x.key === key ? (x.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 })) });
  return (
    <>
      <PageHeader title="Strategies" subtitle="Chart strategies paper-tested on live coins. Only ones that beat random entries get a say in real buys." />
      {error && <ErrorBox message={error} />}
      {data && !data.enabled && <Empty>The chart-strategy lab is switched off (config: ta.labEnabled).</Empty>}
      {data?.enabled && (
        <div className="flex flex-col gap-6">
          <section aria-label="Lab summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile compact label="Tests running" value={all.length.toLocaleString()} sub="strategy × timeframe" />
            <StatTile compact label="Proven" value={count('proven')} sub="used in real buys" tone={count('proven') ? 'up' : undefined} />
            <StatTile compact label="Open test trades" value={data.open.toLocaleString()} sub={`${data.stats.signals.toLocaleString()} signals so far`} />
            <StatTile compact label="Random entry" value={data.baseline?.n ? <span className={tone(data.baseline.avgPnlPct)}>{signed(data.baseline.avgPnlPct)}</span> : '—'} sub={data.baseline?.n ? `the yardstick · ${data.baseline.n} tests` : 'collecting'} />
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title="Scorecard" description={`Proven = ${minTrades}+ tests, makes money and beats random entries by ${data.minEdgePct}+ points per trade. Tap a row for what it looks for.`} />
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto" role="group" aria-label="Status">
                <Chip active={status === 'all'} onClick={() => setStatus('all')} count={all.length}>All</Chip>
                <Chip active={status === 'proven'} onClick={() => setStatus('proven')} count={count('proven')}>Proven</Chip>
                {count('live') > 0 && <Chip active={status === 'live'} onClick={() => setStatus('live')} count={count('live')}>Live (your choice)</Chip>}
                <Chip active={status === 'testing'} onClick={() => setStatus('testing')} count={count('testing')}>Testing</Chip>
                <Chip active={status === 'none'} onClick={() => setStatus('none')} count={count('none')}>No edge</Chip>
              </div>
              <div className="flex items-center gap-2">
                <select aria-label="Family" value={family} onChange={(e) => setFamily(e.target.value)} className={`${inputCls} min-h-10 py-1`}>
                  <option value="all">Every family</option>
                  {families.map((f) => (
                    <option key={f} value={f}>{FAMILY[f] ?? f}</option>
                  ))}
                </select>
                <Tabs className="w-[15rem]" label="Candle timeframe" value={tf} onChange={setTf} tabs={[{ key: 'all', label: 'All' }, { key: '15s', label: '15s' }, { key: '5s', label: '5s' }, { key: '1m', label: '1m' }]} />
              </div>
            </div>
            {!shown.length ? (
              <Empty action={<button type="button" className="text-sm font-medium text-accent-text hover:underline" onClick={() => { setStatus('all'); setFamily('all'); setTf('all'); }}>Show all</button>}>No strategy matches these filters.</Empty>
            ) : (
              <>
                <ul className="card divide-y divide-line overflow-hidden md:hidden">
                  {shown.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setOpenId(r.id)} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2.5 text-left active:bg-surface-2/60">
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{r.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                            {FAMILY[r.family] ?? r.family}
                            <Status r={r} minTrades={minTrades} />
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className={`tabular block text-sm font-semibold ${r.n ? tone(r.avgPnlPct) : 'text-muted'}`}>{r.n ? signed(r.avgPnlPct) : '—'}</span>
                          <span className="tabular block text-xs text-muted">{r.n ? `${r.n} · ${r.winRate.toFixed(0)}% wins` : 'no tests'}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
                  <Table minWidth={760}>
                    <thead className={theadCls}>
                      <tr>
                        <Th {...th('name')}>Strategy</Th>
                        <Th>Family</Th>
                        <Th right {...th('n')}>Tests</Th>
                        <Th right {...th('winRate')}>Win rate</Th>
                        <Th right {...th('avgPnlPct')}>Avg / trade</Th>
                        <Th right {...th('edgePct')}>vs random</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.id} tabIndex={0} className={`${trCls} cursor-pointer`} onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(r.id)}>
                          <td className={`${tdCls} font-medium text-ink`}>{r.name}</td>
                          <td className={`${tdCls} text-ink-2`}>{FAMILY[r.family] ?? r.family}</td>
                          <td className={`${tdCls} text-right text-ink-2`}>{r.n}</td>
                          <td className={`${tdCls} text-right text-ink-2`}>{r.n ? `${r.winRate.toFixed(0)}%` : '—'}</td>
                          <td className={`${tdCls} text-right font-medium ${r.n ? tone(r.avgPnlPct) : 'text-muted'}`}>{r.n ? signed(r.avgPnlPct) : '—'}</td>
                          <td className={`${tdCls} text-right ${r.edgePct === null ? 'text-muted' : tone(r.edgePct)}`}>{r.edgePct === null ? '—' : signed(r.edgePct)}</td>
                          <td className={tdCls}><Status r={r} minTrades={minTrades} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            )}
          </section>
          <StrategyLab />
        </div>
      )}

      <Drawer open={!!opened} onClose={() => setOpenId(null)} title={opened?.name ?? ''} subtitle={opened ? `${FAMILY[opened.family] ?? opened.family} · ${tfOf(opened.id)} candles` : undefined}>
        {opened && (
          <div className="flex flex-col gap-5 text-sm">
            <div className="flex items-center gap-2"><Status r={opened} minTrades={minTrades} /></div>
            <p className="leading-relaxed text-ink">{opened.summary}</p>
            <div className="grid grid-cols-3 gap-3">
              <Big label="Avg / trade" value={opened.n ? <span className={tone(opened.avgPnlPct)}>{signed(opened.avgPnlPct)}</span> : '—'} />
              <Big label="Win rate" value={opened.n ? `${opened.winRate.toFixed(0)}%` : '—'} />
              <Big label="vs random" value={opened.edgePct === null ? '—' : <span className={tone(opened.edgePct)}>{signed(opened.edgePct)}</span>} />
            </div>
            <Rows>
              <RowItem label="Tests" value={opened.n} sub={`${minTrades} needed to judge`} />
              <RowItem label="Median" value={opened.n ? signed(opened.medianPnlPct) : '—'} />
              <RowItem label="Avg win / loss" value={opened.n ? `${signed(opened.avgWinPct)} / ${signed(opened.avgLossPct)}` : '—'} />
              <RowItem label="On the curve" value={opened.curve.n ? signed(opened.curve.avgPnlPct) : '—'} sub={`${opened.curve.n} tests`} />
              <RowItem label="Migrated coins" value={opened.amm.n ? signed(opened.amm.avgPnlPct) : '—'} sub={`${opened.amm.n} tests`} />
              {opened.big && <RowItem label="Bigger coins (swing exits)" value={opened.big.n ? signed(opened.big.avgPnlPct) : '—'} sub={`${opened.big.n} tests`} />}
            </Rows>
          </div>
        )}
      </Drawer>
    </>
  );
}

function Big({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className="tabular mt-1 truncate text-lg font-semibold leading-tight text-ink">{value}</div>
    </div>
  );
}
