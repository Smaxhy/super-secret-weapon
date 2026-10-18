/**
 * Trade history.
 *  - Toolbar: dates, strategy, result, exit reason (folds into a sheet on phones), CSV export.
 *  - Summary strip that follows the filters: trades, win rate, net, average, best / worst.
 *  - Desktop: sticky-header sortable table; a row opens the details drawer (numbers + why it bought / sold).
 *  - Phone: trades grouped by day with sticky day headers and a P&L chip per row.
 *  - `?q=` (top-bar search) filters by symbol, name or mint.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PnlChip } from '../components/PositionRow';
import { TradeDetails, TradeListRow } from '../components/TradeRow';
import { Badge, Button, Drawer, Empty, ErrorBox, inputCls, Loading, PageHeader, Pnl, Select, Sheet, StatTile, Table, Th, tdCls, theadCls, trCls } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { duration, EXIT_LABEL, pct, price, sol, STRATEGY_LABEL } from '../lib/format';
import type { TradeRowData } from '../lib/types';

type SortKey = 'closedAt' | 'symbol' | 'strategy' | 'sizeSol' | 'entryPriceSol' | 'exitPriceSol' | 'pnlSol' | 'peakMultiple' | 'holdSeconds' | 'exitReason' | 'scoreAtEntry';

export function History() {
  const [strategy, setStrategy] = useState('');
  const [outcome, setOutcome] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'closedAt', dir: -1 });
  const [sheet, setSheet] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const filterCount = [strategy, outcome, exitReason, from, to].filter(Boolean).length;
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
    const r = (data ?? []).filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint.toLowerCase() === q);
    r.sort((a, b) => {
      const av = a[sort.key] ?? '';
      const bv = b[sort.key] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
    return r;
  }, [data, sort, q]);

  const sum = useMemo(() => {
    const n = rows.length;
    const total = rows.reduce((s, r) => s + r.pnlSol, 0);
    const wins = rows.filter((r) => r.pnlSol > 0).length;
    const avg = n ? rows.reduce((s, r) => s + r.pnlPct, 0) / n : null;
    const best = n ? Math.max(...rows.map((r) => r.pnlPct)) : null;
    const worst = n ? Math.min(...rows.map((r) => r.pnlPct)) : null;
    return { n, total, wins, avg, best, worst };
  }, [rows]);

  // Phone: group by the day it closed (newest first, whatever the table sort is).
  const days = useMemo(() => {
    const m = new Map<string, TradeRowData[]>();
    for (const t of [...rows].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))) {
      const k = t.closedAt ? new Date(t.closedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Open';
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [rows]);

  const opened = rows.find((r) => r.id === openId) ?? null;
  const th = (key: SortKey) => ({ active: sort.key === key, dir: sort.dir, onClick: () => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 })) });

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

  const filters = (
    <>
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
        From
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
        To
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
      </label>
      <Select label="Strategy" value={strategy} onChange={setStrategy} options={[['', 'All'], ...Object.entries(STRATEGY_LABEL)]} />
      <Select label="Result" value={outcome} onChange={setOutcome} options={[['', 'All'], ['win', 'Wins'], ['loss', 'Losses']]} />
      <Select label="Exit reason" value={exitReason} onChange={setExitReason} options={[['', 'All'], ...Object.entries(EXIT_LABEL)]} />
    </>
  );

  return (
    <>
      <PageHeader
        title="Trade history"
        subtitle={q ? <>Matching “{params.get('q')}” · <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => setParams({})}>clear</button></> : 'Every closed trade. Filters change the numbers below.'}
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSheet(true)} className={`md:hidden ${filterCount ? 'border-accent text-accent-text' : ''}`}>
              <Icon name="filter" size={15} />
              Filters{filterCount ? ` (${filterCount})` : ''}
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Icon name="download" size={15} />
              CSV
            </Button>
          </div>
        }
      />

      {/* Desktop toolbar */}
      <div className="card mb-4 hidden items-end gap-3 p-3 md:flex">
        <div className="grid flex-1 grid-cols-5 gap-3">{filters}</div>
        <Button variant="ghost" size="sm" onClick={clearFilters} disabled={!filterCount} className="mb-0.5">
          Clear
        </Button>
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Filter trades">
        <div className="grid grid-cols-2 gap-3">{filters}</div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={clearFilters} disabled={!filterCount}>Clear</Button>
          <Button className="flex-1" onClick={() => setSheet(false)}>Show {rows.length} trades</Button>
        </div>
      </Sheet>

      <section aria-label="Summary of these trades" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile compact label="Trades" value={sum.n.toLocaleString()} sub={filterCount || q ? 'matching the filters' : 'all closed trades'} />
        <StatTile compact label="Win rate" value={sum.n ? `${Math.round((sum.wins / sum.n) * 100)}%` : '—'} sub={`${sum.wins} wins · ${sum.n - sum.wins} losses`} />
        <StatTile compact label="Net" value={<Pnl value={sum.n ? sum.total : null} />} tone={sum.total > 0 ? 'up' : sum.total < 0 ? 'down' : undefined} sub="after every fee" />
        <StatTile compact label="Average" value={sum.avg === null ? '—' : <span className={sum.avg >= 0 ? 'text-up' : 'text-down'}>{pct(sum.avg, 1, true)}</span>} sub="per trade" />
        <div className="col-span-2 sm:col-span-1">
          <StatTile compact label="Best / worst" value={sum.best === null ? '—' : <span className="text-lg"><span className="text-up">{pct(sum.best, 0, true)}</span> <span className="text-muted">/</span> <span className="text-down">{pct(sum.worst, 0, true)}</span></span>} sub="single trade" />
        </div>
      </section>

      {error && <ErrorBox message={error} />}
      {loading && !data ? (
        <Loading kind="table" />
      ) : !rows.length ? (
        <Empty action={filterCount || q ? <Button variant="outline" size="sm" onClick={() => { clearFilters(); setParams({}); }}>Clear filters</Button> : undefined}>No trades match these filters.</Empty>
      ) : (
        <>
          {/* Phone: grouped by day */}
          <div className="flex flex-col gap-4 md:hidden">
            {days.map(([day, list]) => {
              const net = list.reduce((s, t) => s + t.pnlSol, 0);
              return (
                <section key={day} aria-label={day}>
                  <div className="glass sticky top-[var(--hdr)] z-[5] -mx-4 flex items-center justify-between px-4 py-2">
                    <span className="text-sm font-semibold text-ink">{day}</span>
                    <span className="tabular flex items-center gap-2 text-xs text-muted">
                      {list.length} trades <Pnl value={net} className="text-xs" />
                    </span>
                  </div>
                  <ul className="card divide-y divide-line overflow-hidden">
                    {list.map((t) => (
                      <TradeListRow key={t.id} t={t} onOpen={() => setOpenId(t.id)} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table minWidth={1040}>
              <thead className={theadCls}>
                <tr>
                  <Th {...th('closedAt')}>Coin · closed</Th>
                  <Th {...th('strategy')}>Strategy</Th>
                  <Th right {...th('sizeSol')}>Size</Th>
                  <Th right {...th('entryPriceSol')}>Entry</Th>
                  <Th right {...th('exitPriceSol')}>Exit</Th>
                  <Th right {...th('pnlSol')}>P&amp;L</Th>
                  <Th right {...th('peakMultiple')}>Peak</Th>
                  <Th right {...th('holdSeconds')}>Held</Th>
                  <Th {...th('exitReason')}>How it ended</Th>
                  <Th right {...th('scoreAtEntry')}>Score</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={`${trCls} cursor-pointer`} onClick={() => setOpenId(t.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(t.id)} tabIndex={0}>
                    <td className={tdCls}>
                      <Link to={`/token/${t.mint}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-ink underline-offset-2 hover:underline">{t.symbol}</Link>
                      <div className="text-xs text-muted">{t.closedAt ? new Date(t.closedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>
                    </td>
                    <td className={tdCls}><Badge>{STRATEGY_LABEL[t.strategy] ?? t.strategy}</Badge></td>
                    <td className={`${tdCls} text-right text-ink-2`}>{sol(t.sizeSol, 2)}</td>
                    <td className={`${tdCls} text-right text-ink-2`}>{price(t.entryPriceSol)}</td>
                    <td className={`${tdCls} text-right text-ink-2`}>{price(t.exitPriceSol)}</td>
                    <td className={`${tdCls} text-right`}>
                      <Pnl value={t.pnlSol} />
                      <div className="mt-0.5"><PnlChip value={t.pnlPct} /></div>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <span className={t.peakMultiple >= 1 ? 'text-up' : 'text-ink-2'}>{t.peakMultiple.toFixed(2)}×</span>
                      {t.bestWithin1hMultiple && t.bestWithin1hMultiple > t.peakMultiple * 1.05 && <div className="text-xs text-muted">later {t.bestWithin1hMultiple.toFixed(1)}×</div>}
                    </td>
                    <td className={`${tdCls} text-right text-ink-2`}>{duration(t.holdSeconds)}</td>
                    <td className={`${tdCls} text-ink-2`}>{t.exitReason ? (EXIT_LABEL[t.exitReason] ?? t.exitReason) : '—'}</td>
                    <td className={`${tdCls} text-right text-ink-2`}>{t.scoreAtEntry?.toFixed(0) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}

      <Drawer open={!!opened} onClose={() => setOpenId(null)} title={opened?.symbol ?? ''} subtitle={opened ? `${STRATEGY_LABEL[opened.strategy] ?? opened.strategy} · ${opened.closedAt ? new Date(opened.closedAt).toLocaleString() : ''}` : undefined}>
        {opened && <TradeDetails t={opened} />}
      </Drawer>
    </>
  );
}
