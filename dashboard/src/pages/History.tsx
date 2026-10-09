/** Trade history: filterable, sortable, exportable to CSV. */
import { useMemo, useState } from 'react';
import { TradeRow } from '../components/TradeRow';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, Select } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { EXIT_LABEL, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';

type SortKey = 'closedAt' | 'symbol' | 'strategy' | 'sizeSol' | 'entryPriceSol' | 'exitPriceSol' | 'pnlSol' | 'holdSeconds' | 'exitReason' | 'scoreAtEntry';
const COLUMNS: Array<[SortKey, string]> = [
  ['closedAt', 'Token'],
  ['strategy', 'Strategy'],
  ['sizeSol', 'Size'],
  ['entryPriceSol', 'Entry'],
  ['exitPriceSol', 'Exit'],
  ['pnlSol', 'P&L'],
  ['holdSeconds', 'Held'],
  ['exitReason', 'Exit reason'],
  ['scoreAtEntry', 'Score'],
];

export function History() {
  const [strategy, setStrategy] = useState('');
  const [outcome, setOutcome] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'closedAt', dir: -1 });

  const qs = new URLSearchParams({ limit: '2000', ...(strategy && { strategy }), ...(outcome && { outcome }), ...(exitReason && { exitReason }), ...(from && { from }), ...(to && { to: `${to}T23:59:59Z` }) }).toString();
  const { data, error, loading } = useApi<TradeRowData[]>(`/api/trades?${qs}`, 60_000, ['trade']);

  const rows = useMemo(() => {
    const r = [...(data ?? [])];
    r.sort((a, b) => {
      const av = a[sort.key] ?? '';
      const bv = b[sort.key] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
    return r;
  }, [data, sort]);

  const total = rows.reduce((s, r) => s + r.pnlSol, 0);

  function exportCsv() {
    const header = ['closed_at', 'symbol', 'mint', 'strategy', 'size_sol', 'entry_price_sol', 'exit_price_sol', 'pnl_sol', 'pnl_pct', 'hold_seconds', 'exit_reason', 'score_at_entry'];
    const lines = rows.map((r) => [r.closedAt, r.symbol, r.mint, r.strategy, r.sizeSol, r.entryPriceSol, r.exitPriceSol, r.pnlSol, r.pnlPct.toFixed(2), r.holdSeconds, r.exitReason, r.scoreAtEntry].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `solbot-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHeader
        title="Trade history"
        subtitle="Every completed trade. Click a column to sort."
        action={
          <button type="button" onClick={exportCsv} disabled={!rows.length} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            ⬇ Export CSV
          </button>
        }
      />
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Select label="Strategy" value={strategy} onChange={setStrategy} options={[['', 'All'], ...Object.entries(STRATEGY_LABEL)]} />
          <Select label="Result" value={outcome} onChange={setOutcome} options={[['', 'All'], ['win', 'Wins'], ['loss', 'Losses']]} />
          <Select label="Exit reason" value={exitReason} onChange={setExitReason} options={[['', 'All'], ...Object.entries(EXIT_LABEL)]} />
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-line bg-surface px-3 py-2 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-2">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-line bg-surface px-3 py-2 text-ink" />
          </label>
        </div>
        <div className="mt-3 text-sm text-ink-2">
          {rows.length} trades · total <Pnl value={total} />
        </div>
      </Card>
      {error && <ErrorBox message={error} />}
      {loading && !data ? (
        <Loading />
      ) : rows.length ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm tabular">
              <thead>
                <tr className="text-left text-ink-2">
                  {COLUMNS.map(([k, l]) => (
                    <th key={k} className="pb-2 pr-4 font-medium" aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="hover:text-ink" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>
                        {l} {sort.key === k ? (sort.dir === 1 ? '↑' : '↓') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{rows.map((t) => <TradeRow key={t.id} t={t} />)}</tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Empty>No trades match these filters.</Empty>
      )}
    </>
  );
}
