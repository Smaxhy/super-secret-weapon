import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResetPaperDialog } from '../components/ResetPaper';
import { AddFundsDialog } from '../components/AddFunds';
import { HealthBanner } from '../components/SystemHealth';
import { PnlChart } from '../components/Charts';
import { PnlCalendar } from '../components/PnlCalendar';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { McChange } from '../components/McCompare';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl, Stack, Tabs } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLivePositions } from '../hooks/useLivePositions';
import { ago, duration, EXIT_LABEL, mcSol, multiple, pct, pnl, sol, usd } from '../lib/format';
import type { Detection, Overview as OverviewData, TradeRowData } from '../lib/types';

const RANGES = [
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: 'all', label: 'All' },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;
type Range = (typeof RANGES)[number]['key'];

export function Overview() {
  const [range, setRange] = useState<string>(() => {
    try {
      return localStorage.getItem('overview.range') ?? 'all';
    } catch {
      return 'all';
    }
  });
  // Calendar (open/closed remembered per device); a picked day replaces the timeframe for the chart + numbers.
  const [calOpen, setCalOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('overview.calendar') === '1';
    } catch {
      return false;
    }
  });
  const [day, setDay] = useState<string | null>(null);
  const toggleCal = () => {
    const next = !calOpen;
    setCalOpen(next);
    if (!next) setDay(null);
    try {
      localStorage.setItem('overview.calendar', next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const tz = new Date().getTimezoneOffset();
  const o = useApi<OverviewData>(day ? `/api/overview?day=${day}&tz=${tz}` : `/api/overview?range=${range}`, 15_000, ['trade', 'token']);
  const dayLabel = day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  const trades = useApi<TradeRowData[]>('/api/trades?limit=5', 30_000, ['trade']);
  const feed = useApi<Detection[]>('/api/detections?limit=6', 15_000, ['token', 'safety', 'evaluation']);

  if (o.loading && !o.data) return <Loading />;
  const d = o.data;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={d ? `${d.mode === 'PAPER' ? 'Paper trading' : 'Live trading'} · running for ${duration(d.uptimeSec)}` : undefined}
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
                  {pct((d.totalPnlSol / (d.startingBalanceSol + (d.addedSol ?? 0))) * 100, 1, true)} of the {sol(d.startingBalanceSol, 0)} start
                  {(d.addedSol ?? 0) > 0 ? ` + ${sol(d.addedSol ?? 0, 2)} added` : ''}
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
                <h2 className="text-sm font-semibold text-ink">{dayLabel ? `Profit on ${dayLabel}` : 'Profit over time'}</h2>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleCal}
                    aria-expanded={calOpen}
                    className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-sm font-medium ${calOpen ? 'border-accent text-accent' : 'border-line text-ink-2'}`}
                  >
                    {calOpen ? 'Close calendar' : 'Calendar'}
                  </button>
                  <Link to="/performance" className="text-sm font-medium text-accent">
                    All charts
                  </Link>
                </div>
              </div>
              {calOpen && (
                <div className="mb-3">
                  <PnlCalendar picked={day} onPick={setDay} />
                </div>
              )}
              {day && (
                <div className="mb-3 flex items-center gap-2 text-sm">
                  <span className="rounded-full bg-accent/10 px-3 py-1 font-medium text-accent">Showing {dayLabel}</span>
                  <button type="button" onClick={() => setDay(null)} className="text-ink-2 underline">
                    back to {RANGES.find((r) => r.key === range)?.label ?? 'All'}
                  </button>
                </div>
              )}
              <Tabs
                className="mb-3 sm:max-w-md"
                label="Timeframe"
                tabs={RANGES}
                value={(day ? '' : range) as Range}
                onChange={(k) => {
                  setDay(null);
                  setRange(k);
                  try {
                    localStorage.setItem('overview.range', k);
                  } catch {
                    /* ignore */
                  }
                }}
              />
              {d.window && (
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted">Profit</dt>
                    <dd className="font-semibold"><Pnl value={d.window.pnlSol} /></dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Wins</dt>
                    <dd className="font-semibold text-ink">{d.window.trades ? `${d.window.wins} / ${d.window.trades} (${pct(d.window.winRate, 0)})` : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Avg per trade</dt>
                    <dd className={`font-semibold ${(d.window.avgPct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{d.window.avgPct === null ? '—' : `${d.window.avgPct > 0 ? '+' : ''}${d.window.avgPct}%`}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Best / worst</dt>
                    <dd className="font-semibold text-ink">{d.window.bestPct === null ? '—' : `+${d.window.bestPct}% / ${d.window.worstPct}%`}</dd>
                  </div>
                </dl>
              )}
              {(d.window?.cumulative ?? d.cumulative).length ? (
                <PnlChart points={d.window?.cumulative ?? d.cumulative} height={210} />
              ) : (
                <Empty>{day ? 'No closed trades on this day.' : range === 'all' ? 'No closed trades yet. The chart fills in as the bot paper trades.' : 'No closed trades in this timeframe.'}</Empty>
              )}
            </div>
          </section>
        </>
      )}

      <Stack className="mt-4">
        <OpenPreview />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Latest trades" action={<Link to="/history" className="font-medium text-accent">See all</Link>}>
            {trades.data?.length ? (
              <ul className="-my-1 divide-y divide-line">
                {trades.data.map((t) => (
                  <li key={t.id}>
                    <Link to={`/token/${t.mint}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-ink">{t.symbol}</div>
                        <div className="truncate text-xs text-muted">
                          {EXIT_LABEL[t.exitReason ?? ''] ?? t.exitReason} · peak {t.peakMultiple.toFixed(2)}× · {ago(t.closedAt)}
                        </div>
                      </div>
                      <div className="shrink-0 whitespace-nowrap text-right">
                        <Pnl value={t.pnlSol} className="text-sm" />
                        <div className={`tabular text-xs ${t.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(t.pnlPct, 1, true)}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No trades yet.</Empty>
            )}
          </Card>
          <Card title="Just launched" action={<Link to="/feed" className="font-medium text-accent">Live feed</Link>}>
            {feed.data?.length ? (
              <ul className="-my-1 divide-y divide-line">
                {feed.data.slice(0, 5).map((t) => (
                  <li key={t.mint}>
                    <Link to={`/token/${t.mint}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-semibold text-ink">{t.symbol || '?'}</span>
                          <StatusBadge status={t.feedStatus} />
                        </div>
                        <div className="tabular truncate text-xs text-muted">
                          {ago(t.createdAt)}
                          {t.live ? ` · MC ${sol(t.live.marketCapSol, 1)} · ${t.live.holders} holders` : ''}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular font-semibold text-ink">{t.combinedScore !== null ? Math.round(t.combinedScore) : '—'}</div>
                        <div className="text-xs text-muted">score</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Waiting for launches…</Empty>
            )}
          </Card>
        </div>
      </Stack>
    </>
  );
}

/** Small "⋯" menu on the profit card — "Add paper SOL" and "Reset paper account". */
function HeroMenu({ startingBalanceSol }: { startingBalanceSol: number }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [add, setAdd] = useState(false);
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
        <Icon name="more" size={18} />
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
                setAdd(true);
              }}
              className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-2"
            >
              Add paper SOL…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setDialog(true);
              }}
              className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-down hover:bg-surface-2"
            >
              Reset paper account…
            </button>
          </div>
        </>
      )}
      <ResetPaperDialog open={dialog} onClose={() => setDialog(false)} defaultBalance={startingBalanceSol || 10} />
      <AddFundsDialog open={add} onClose={() => setAdd(false)} />
    </div>
  );
}

function HeroStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted">{label}</dt>
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
      action={
        <Link to="/positions" className="font-medium text-accent">
          Details
        </Link>
      }
    >
      <ul className="-my-1 divide-y divide-line">
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
                  <div className="tabular truncate text-xs text-muted">
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
