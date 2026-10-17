/** Trade history: filterable, sortable, exportable to CSV. */
import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { TradeCard, TradeRow } from '../components/TradeRow';
import { Button, Card, Empty, ErrorBox, inputCls, Loading, PageHeader, Pnl, Select } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { EXIT_LABEL, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';

type SortKey = 'closedAt' | 'symbol' | 'strategy' | 'sizeSol' | 'entryPriceSol' | 'exitPriceSol' | 'pnlSol' | 'peakMultiple' | 'holdSeconds' | 'exitReason' | 'scoreAtEntry';
const COLUMNS: Array<[SortKey, string, boolean]> = [
  ['closedAt', 'Token', false],
  ['strategy', 'Strategy', false],
  ['sizeSol', 'Size', true],
  ['entryPriceSol', 'Entry', true],
  ['exitPriceSol', 'Exit', true],
  ['pnlSol', 'P&L', true],
  ['peakMultiple', 'Max profit', true],
  ['holdSeconds', 'Held', true],
  ['exitReason', 'Exit reason', false],
  ['scoreAtEntry', 'Score', true],
];

export function History() {
  const [strategy, setStrategy] = useState('');
  const [outcome, setOutcome] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'closedAt', dir: -1 });
  const [showFilters, setShowFilters] = useState(false);
  const filtered = !!(strategy || outcome || exitReason || from || to);
  const clearFilters = () => {
    setStrategy('');
    setOutcome('');
    setExitReason('');
    setFrom('');
    setTo('');
  };

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
  const wins = rows.filter((r) => r.pnlSol > 0).length;

  function exportCsv() {
    const header = ['closed_at', 'symbol', 'mint', 'strategy', 'size_sol', 'entry_price_sol', 'exit_price_sol', 'pnl_sol', 'pnl_pct', 'peak_multiple', 'max_profit_sol', 'best_within_1h_multiple', 'hold_seconds', 'exit_reason', 'score_at_entry'];
    const lines = rows.map((r) => [r.closedAt, r.symbol, r.mint, r.strategy, r.sizeSol, r.entryPriceSol, r.exitPriceSol, r.pnlSol, r.pnlPct.toFixed(2), r.peakMultiple.toFixed(3), r.maxProfitSol.toFixed(4), r.bestWithin1hMultiple?.toFixed(3) ?? '', r.holdSeconds, r.exitReason, r.scoreAtEntry].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
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
        subtitle={
          <>
            {rows.length} trades{filtered ? ' (filtered)' : ''} · {rows.length ? `${Math.round((wins / rows.length) * 100)}% wins · ` : ''}total <Pnl value={total} />
          </>
        }
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowFilters((f) => !f)} aria-expanded={showFilters} className={`md:hidden ${filtered ? 'border-accent text-accent-text' : ''}`}>
              <Icon name="sliders" size={15} />
              Filters{filtered ? ' ·' : ''}
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Icon name="download" size={15} />
              CSV
            </Button>
          </div>
        }
      />
      <Card className={`mb-4 ${showFilters ? 'pop' : 'hidden md:block'}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Select label="Strategy" value={strategy} onChange={setStrategy} options={[['', 'All'], ...Object.entries(STRATEGY_LABEL)]} />
          <Select label="Result" value={outcome} onChange={setOutcome} options={[['', 'All'], ['win', 'Wins'], ['loss', 'Losses']]} />
          <Select label="Exit reason" value={exitReason} onChange={setExitReason} options={[['', 'All'], ...Object.entries(EXIT_LABEL)]} />
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </label>
        </div>
        {filtered && (
          <button type="button" onClick={clearFilters} className="mt-3 text-sm font-medium text-accent-text hover:underline">
            Clear filters
          </button>
        )}
      </Card>
      {error && <ErrorBox message={error} />}
      {loading && !data ? (
        <Loading />
      ) : rows.length ? (
        <>
          <ul className="stagger space-y-2.5 md:hidden">{rows.map((t) => <TradeCard key={t.id} t={t} />)}</ul>
          <Card className="hidden md:block" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm tabular">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    {COLUMNS.map(([k, l, right]) => (
                      <th key={k} className={`px-4 py-3 font-medium first:pl-5 ${right ? 'text-right' : ''}`} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                        <button type="button" className={`inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-ink ${sort.key === k ? 'text-ink' : ''}`} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>
                          {l}
                          {sort.key === k && <span aria-hidden="true">{sort.dir === 1 ? '↑' : '↓'}</span>}
                        </button>
                      </th>
                    ))}
                    <th className="py-3 pr-5 font-medium" aria-label="Explanation" />
                  </tr>
                </thead>
                <tbody className="[&>tr>td:first-child]:pl-5 [&>tr>td]:pl-4">{rows.map((t) => <TradeRow key={t.id} t={t} />)}</tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <Empty>No trades match these filters.</Empty>
      )}
    </>
  );
}
