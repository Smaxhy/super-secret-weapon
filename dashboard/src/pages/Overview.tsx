import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResetPaperDialog } from '../components/ResetPaper';
import { HealthBanner } from '../components/SystemHealth';
import { UpdateCard } from '../components/UpdateCard';
import { PnlChart } from '../components/Charts';
import { TokenCard } from '../components/TokenCard';
import { McChange } from '../components/McCompare';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLivePositions } from '../hooks/useLivePositions';
import { ago, duration, EXIT_LABEL, mcSol, multiple, pct, pnl, sol, usd } from '../lib/format';
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
        subtitle={
          d ? (
            <>
              <span className="whitespace-nowrap">{d.mode === 'PAPER' ? '📝 Paper trading (fake money)' : '💸 LIVE trading'}</span>{' '}
              <span className="whitespace-nowrap">· running for {duration(d.uptimeSec)}</span>
            </>
          ) : undefined
        }
      />
      <HealthBanner />
      {o.error && <ErrorBox message={o.error} />}
      {d && (
        <>
          {/* Hero: the one number that matters most, then the supporting stats, then the curve. */}
          <section className="hero-glow rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6" aria-label="Profit summary">
            {/* Phones: big number on top, stats in a 2x2 grid below. Wide screens: side by side. */}
            <div className="grid gap-x-10 gap-y-5 xl:grid-cols-[auto_minmax(0,1fr)] xl:items-end">
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-ink-2">Total profit</div>
                  {d.mode === 'PAPER' && <HeroMenu startingBalanceSol={d.startingBalanceSol} />}
                </div>
                <div className="mt-1 break-words text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
                  <Pnl value={d.totalPnlSol} />
                </div>
                <div className="mt-1 text-sm text-muted">
                  {pct((d.totalPnlSol / d.startingBalanceSol) * 100, 1, true)} of the {sol(d.startingBalanceSol, 0)} start
                </div>
              </div>
              <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 border-t border-line pt-4 sm:gap-x-6 lg:grid-cols-4 xl:grid-cols-2 xl:border-t-0 xl:pt-0 2xl:grid-cols-4">
                <HeroStat label="Today" value={<Pnl value={d.todayPnlSol} />} sub="since 00:00 UTC" />
                <HeroStat label="Win rate" value={pct(d.winRate, 0)} sub={`${d.trades.toLocaleString()} closed trades`} />
                <HeroStat label={d.mode === 'PAPER' ? 'Paper balance' : 'Balance'} value={sol(d.balanceSol, 2)} />
                <HeroStat label="Open" value={`${d.openPositions} / ${d.maxPositions}`} sub={`${d.launchesToday.toLocaleString()} launches today`} />
              </dl>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Profit over time</h2>
                <Link to="/performance" className="text-sm text-accent hover:underline">
                  All charts →
                </Link>
              </div>
              {d.cumulative.length ? <PnlChart points={d.cumulative} height={240} /> : <Empty>No closed trades yet. The chart fills in as the bot paper trades.</Empty>}
            </div>
          </section>
        </>
      )}

      <OpenPreview />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Latest trades" action={<Link to="/history" className="text-sm text-accent hover:underline">History →</Link>}>
          {trades.data?.length ? (
            <ul className="divide-y divide-line">
              {trades.data.map((t) => (
                <li key={t.id}>
                  <Link to={`/token/${t.mint}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-surface-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-ink">{t.symbol}</div>
                      <div className="truncate text-sm text-muted">
                        {EXIT_LABEL[t.exitReason ?? ''] ?? t.exitReason} · peak {t.peakMultiple.toFixed(2)}× · {ago(t.closedAt)}
                      </div>
                    </div>
                    <div className="shrink-0 whitespace-nowrap text-right">
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
      <UpdateCard />
    </>
  );
}

/** Small "⋯" menu on the profit card — currently just "Reset paper account". */
function HeroMenu({ startingBalanceSol }: { startingBalanceSol: number }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Profit card options"
        onClick={() => setOpen((o) => !o)}
        className="-my-1 grid h-8 w-8 place-items-center rounded-full text-lg leading-none text-ink-2 hover:bg-surface-2"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-2xl">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setDialog(true);
              }}
              className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-down hover:bg-surface-2"
            >
              ↺ Reset paper account…
            </button>
          </div>
        </>
      )}
      <ResetPaperDialog open={dialog} onClose={() => setDialog(false)} defaultBalance={startingBalanceSol || 10} />
    </div>
  );
}

function HeroStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="tabular mt-0.5 break-words text-lg font-semibold leading-snug text-ink sm:text-xl [&>span]:whitespace-normal">{value}</dd>
      {sub && <dd className="truncate text-xs text-muted">{sub}</dd>}
    </div>
  );
}

/** Open positions at a glance: bought-at MC → MC now, live multiple and P&L. */
function OpenPreview() {
  const { positions } = useLivePositions();
  if (!positions?.length) return null;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          Open positions
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2">{positions.length}</span>
        </span>
      }
      className="mt-4"
      action={
        <Link to="/positions" className="text-sm text-accent hover:underline">
          Charts &amp; details →
        </Link>
      }
    >
      <ul className="divide-y divide-line">
        {positions.map((p) => {
          const m = p.multiple;
          const fresh = p.live && Date.now() - p.live.at < 6_000;
          return (
            <li key={p.id}>
              <Link to="/positions" className="-mx-2 flex items-center justify-between gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate font-semibold text-ink">
                    {p.symbol}
                    {fresh && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-label="live" />}
                  </div>
                  <div className="tabular truncate text-sm text-muted">
                    <span className="sr-only">Market cap bought at </span>
                    {p.mcEntryUsd !== null ? usd(p.mcEntryUsd) : mcSol(p.entryMarketCapSol)}
                    <span aria-hidden="true"> → </span>
                    <span className="sr-only"> now </span>
                    <span className="text-ink">{p.mcNowUsd !== null ? usd(p.mcNowUsd) : mcSol(p.mcNowSol)}</span> <McChange value={p.mcChangePct} className="text-xs" />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`tabular text-lg font-semibold ${m !== null && m >= 1 ? 'text-up' : 'text-down'}`}>{multiple(m)}</div>
                  <div className="tabular text-xs text-muted">{pnl(p.unrealizedPnlSol)}</div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
