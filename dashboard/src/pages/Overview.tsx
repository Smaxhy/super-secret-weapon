/**
 * Overview — the command centre.
 *  Row 1: five headline tiles (total P&L, today, win rate, open / max, balance) with sparklines.
 *  Row 2: the profit curve with its timeframe (8 columns) + "Right now" (open trades, waiting signals, health).
 *  Row 3: today's activity feed (buys + sells, or new launches) + the daily-profit calendar.
 * Phones get the same order in one column, with sticky section headers.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AddFundsDialog } from '../components/AddFunds';
import { PnlChart } from '../components/Charts';
import type { DipRow } from '../components/DipWatch';
import { Icon } from '../components/Icon';
import { PnlCalendar } from '../components/PnlCalendar';
import { isFresh, LiveDot, PnlChip, posPct, RangeBar } from '../components/PositionRow';
import { ResetPaperDialog } from '../components/ResetPaper';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBanner, type SystemData } from '../components/SystemHealth';
import { AnimatedNumber, Badge, Card, Empty, ErrorBox, Loading, PageHeader, Pnl, SectionHeader, StatTile, Tabs, useStored } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLivePositions } from '../hooks/useLivePositions';
import { ago, duration, EXIT_LABEL, multiple, pct, pnl, sol, STRATEGY_LABEL } from '../lib/format';
import type { Detection, Overview as OverviewData, TradeRowData } from '../lib/types';

const RANGES = [
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: 'all', label: 'All' },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;
type Range = (typeof RANGES)[number]['key'];
const RANGE_KEYS = RANGES.map((r) => r.key);

export function Overview() {
  const [range, setRange] = useStored<Range>('overview.range', 'all', RANGE_KEYS);
  const [day, setDay] = useState<string | null>(null);
  const tz = new Date().getTimezoneOffset();
  const o = useApi<OverviewData>(day ? `/api/overview?day=${day}&tz=${tz}` : `/api/overview?range=${range}`, 15_000, ['trade', 'token']);
  const all = useApi<OverviewData>('/api/overview?range=all', 60_000, ['trade']);
  const dayLabel = day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;

  if (o.loading && !o.data) return <Loading />;
  const d = o.data;
  return (
    <>
      <PageHeader title="Overview" subtitle={d ? `${d.mode === 'PAPER' ? 'Paper trading' : 'Live trading'} · running for ${duration(d.uptimeSec)} · ${d.launchesToday.toLocaleString()} launches seen today` : undefined} />
      <HealthBanner />
      {o.error && <ErrorBox message={o.error} />}
      {d && (
        <div className="flex flex-col gap-6">
          <Kpis d={d} full={all.data ?? null} />

          <div className="grid gap-6 lg:grid-cols-12">
            <section className="flex min-w-0 flex-col gap-3 lg:col-span-8" aria-label="Profit over time">
              <SectionHeader
                sticky
                title={dayLabel ? `Profit on ${dayLabel}` : 'Profit over time'}
                description={day ? <button type="button" onClick={() => setDay(null)} className="text-accent-text hover:underline">Back to {RANGES.find((r) => r.key === range)?.label}</button> : 'Cumulative P&L after every fee'}
                action={d.mode === 'PAPER' ? <HeroMenu startingBalanceSol={d.startingBalanceSol} /> : undefined}
              />
              <Card>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <Tabs
                    className="w-full sm:w-[17rem]"
                    label="Timeframe"
                    tabs={RANGES}
                    value={(day ? '' : range) as Range}
                    onChange={(k) => {
                      setDay(null);
                      setRange(k);
                    }}
                  />
                  {d.window && (
                    <dl className="grid w-full grid-cols-2 gap-3 text-sm sm:w-auto sm:grid-cols-4 sm:gap-6">
                      <WindowStat label="Profit" value={<Pnl value={d.window.pnlSol} dp={2} />} />
                      <WindowStat label="Wins" value={d.window.trades ? `${d.window.wins}/${d.window.trades}` : '—'} />
                      <WindowStat label="Avg" value={d.window.avgPct === null ? '—' : <span className={d.window.avgPct >= 0 ? 'text-up' : 'text-down'}>{pct(d.window.avgPct, 1, true)}</span>} />
                      <WindowStat label="Best" value={d.window.bestPct === null ? '—' : <span className="text-up">{pct(d.window.bestPct, 0, true)}</span>} />
                    </dl>
                  )}
                </div>
                {(d.window?.cumulative ?? d.cumulative).length ? (
                  <PnlChart points={d.window?.cumulative ?? d.cumulative} height={280} compact />
                ) : (
                  <Empty>{day ? 'No closed trades on this day.' : range === 'all' ? 'No closed trades yet. The chart fills in as the bot trades.' : 'No closed trades in this timeframe.'}</Empty>
                )}
              </Card>
            </section>
            <section className="flex min-w-0 flex-col gap-3 lg:col-span-4" aria-label="Right now">
              <SectionHeader sticky title="Right now" description="Open trades, waiting signals, health" action={<Link to="/positions" className="text-sm font-medium text-accent-text hover:underline">Positions</Link>} />
              <RightNow maxPositions={d.maxPositions} />
            </section>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            <section className="flex min-w-0 flex-col gap-3 lg:col-span-7" aria-label="Today's activity">
              <Activity />
            </section>
            <section className="flex min-w-0 flex-col gap-3 lg:col-span-5" aria-label="Daily profit calendar">
              <SectionHeader sticky title="Daily profit" description={day ? `Chart above shows ${dayLabel}` : 'Tap a day to show it in the chart'} />
              <Card>
                <PnlCalendar picked={day} onPick={setDay} bare />
              </Card>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

/** Row 1: five tiles. Sparklines come from the all-time cumulative curve so they don't jump with the timeframe. */
function Kpis({ d, full }: { d: OverviewData; full: OverviewData | null }) {
  const base = full ?? d;
  const capital = base.startingBalanceSol + (base.addedSol ?? 0);
  const totalPct = capital > 0 ? (base.totalPnlSol / capital) * 100 : null;
  const curve = base.cumulative;
  const spark = curve.slice(-40).map((p) => p.pnl);
  const today = useMemo(() => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const pts = curve.filter((p) => new Date(p.t) >= start);
    const before = curve.filter((p) => new Date(p.t) < start).pop()?.pnl ?? 0;
    return [0, ...pts.map((p) => p.pnl - before)];
  }, [curve]);
  const winSpark = useMemo(() => {
    // Rolling win rate over the last 20 closes, sampled along the curve.
    const out: number[] = [];
    let prev = 0;
    const wins: number[] = [];
    for (const p of curve.slice(-60)) {
      wins.push(p.pnl > prev ? 1 : 0);
      prev = p.pnl;
      const w = wins.slice(-20);
      out.push(w.reduce((a, b) => a + b, 0) / w.length);
    }
    return out;
  }, [curve]);
  return (
    <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label="Total profit"
        value={<AnimatedNumber value={base.totalPnlSol} format={(v) => pnl(v, 2)} />}
        delta={totalPct}
        sub="of capital"
        spark={spark}
        tone={base.totalPnlSol > 0 ? 'up' : base.totalPnlSol < 0 ? 'down' : undefined}
      />
      <StatTile label="Today" value={<Pnl value={base.todayPnlSol} dp={2} />} sub="since 00:00 UTC" spark={today.length > 2 ? today : undefined} tone={base.todayPnlSol > 0 ? 'up' : base.todayPnlSol < 0 ? 'down' : undefined} />
      <StatTile label="Win rate" value={pct(base.winRate, 0)} sub={`${base.trades.toLocaleString()} closed trades`} spark={winSpark.length > 2 ? winSpark : undefined} />
      <StatTile label="Open trades" value={`${base.openPositions} / ${base.maxPositions}`} sub={base.paused || base.killSwitch ? 'buying paused' : 'slots in use'} tone={base.paused || base.killSwitch ? 'warn' : undefined} />
      <div className="col-span-2 sm:col-span-1">
        <StatTile label={base.mode === 'PAPER' ? 'Paper balance' : 'Balance'} value={sol(base.balanceSol, 2)} sub={`start ${sol(base.startingBalanceSol, 0)}${(base.addedSol ?? 0) > 0 ? ` + ${sol(base.addedSol ?? 0, 1)}` : ''}`} spark={curve.length > 1 ? [0, ...spark].map((v) => capital + v) : undefined} />
      </div>
    </section>
  );
}

/** Row 2 right: open trades (≤6), signals waiting for a dip / confirmation, health one-liners. */
function RightNow({ maxPositions }: { maxPositions: number }) {
  const { positions } = useLivePositions();
  const dips = useApi<DipRow[]>('/api/dip-watch', 10_000);
  const sys = useApi<SystemData>('/api/system', 30_000);
  const list = (positions ?? []).slice().sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
  const t = sys.data?.trading;
  const confirming = (t?.strategies ?? []).reduce((a, s) => a + s.confirming, 0);
  const waiting = dips.data ?? [];
  return (
    <Card padded={false}>
      <div className="px-4 pt-4 sm:px-5">
        <div className="mb-2 flex items-baseline justify-between text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          <span>Open</span>
          <span className="tabular normal-case tracking-normal">{list.length} of {maxPositions}</span>
        </div>
        {list.length ? (
          <ul className="-mx-2">
            {list.slice(0, 6).map((p) => (
              <li key={p.id}>
                <Link to="/positions" className="flex min-h-12 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-ink">{p.symbol}</span>
                      <span className="truncate text-xs text-muted">{STRATEGY_LABEL[p.strategy] ?? p.strategy}</span>
                      {isFresh(p) && <LiveDot />}
                    </div>
                    <div className="mt-1.5">
                      <RangeBar p={p} compact />
                    </div>
                  </div>
                  <div className="w-16 shrink-0 text-right">
                    <div className={`tabular font-semibold ${p.multiple !== null && p.multiple >= 1 ? 'text-up' : 'text-down'}`}>{multiple(p.multiple)}</div>
                    <PnlChip value={posPct(p)} />
                  </div>
                </Link>
              </li>
            ))}
            {list.length > 6 && <li className="px-2 py-1 text-xs text-muted">+{list.length - 6} more on Positions</li>}
          </ul>
        ) : (
          <p className="pb-2 text-sm text-ink-2">Not in any trade. It buys when a coin passes every rule.</p>
        )}
      </div>
      <div className="mt-3 border-t border-line px-4 py-3 sm:px-5">
        <div className="mb-2 flex items-baseline justify-between text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          <span>Waiting</span>
          <span className="tabular normal-case tracking-normal">{waiting.length} dip · {confirming} confirming</span>
        </div>
        {waiting.length ? (
          <ul className="space-y-1.5 text-sm">
            {waiting.slice(0, 3).map((w) => (
              <li key={`${w.mint}-${w.strategy}`} className="flex items-center justify-between gap-2">
                <Link to={`/token/${w.mint}`} className="min-w-0 truncate font-medium text-ink hover:underline">{w.symbol}</Link>
                <span className={`tabular shrink-0 text-xs ${w.inZone ? 'text-up' : 'text-muted'}`}>
                  {w.inZone ? 'in zone' : w.price ? `${((w.price / w.zoneHi - 1) * 100).toFixed(0)}% above` : 'waiting'} · {Math.floor(w.secondsLeft / 60)}:{String(w.secondsLeft % 60).padStart(2, '0')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">No signal waiting for a dip.</p>
        )}
      </div>
      <div className="border-t border-line px-4 py-3 sm:px-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Health</div>
        {sys.data ? (
          <ul className="space-y-1.5 text-sm">
            <HealthLine ok={!!t && t.lastHour.evaluated > 0} text={t ? `${t.lastHour.evaluated.toLocaleString()} coins checked, ${t.lastHour.buySignals} signals, ${t.lastHour.entries} bought (1 h)` : 'No buying stats yet'} />
            <HealthLine ok={!!t && t.minutesSinceEntry < 60} text={t?.lastEntryAt ? `Last buy ${duration(t.minutesSinceEntry * 60)} ago` : 'No buy since the start'} />
            <HealthLine ok={(sys.data.eventLoopLagMs ?? 0) < 1000} text={`Lag ${sys.data.eventLoopLagMs ?? '—'} ms · memory ${sys.data.memory.rssMb} MB`} />
            {sys.data.tape && <HealthLine ok={!sys.data.tape.enabled || sys.data.tape.perMin > 0} text={sys.data.tape.enabled ? `Tape ${sys.data.tape.perMin.toLocaleString()} trades/min` : 'Tape recorder off'} />}
          </ul>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
        <Link to="/scanner" className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-accent-text hover:underline">Bot health</Link>
      </div>
    </Card>
  );
}

function HealthLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2 text-ink-2">
      <Icon name={ok ? 'check' : 'alert'} size={15} className={`mt-0.5 ${ok ? 'text-good' : 'text-warning'}`} />
      <span className="min-w-0 break-words">{text}</span>
    </li>
  );
}

type Event = { key: string; at: string; kind: 'buy' | 'sell'; symbol: string; mint: string; strategy: string; detail: string; pnlSol?: number; pnlPct?: number };

/** Row 3 left: last 20 buys and sells (closed trades + open positions), or coins that just launched. */
function Activity() {
  const [tab, setTab] = useStored<'trades' | 'launches'>('overview.activity', 'trades', ['trades', 'launches']);
  const trades = useApi<TradeRowData[]>('/api/trades?limit=20', 30_000, ['trade']);
  const feed = useApi<Detection[]>(tab === 'launches' ? '/api/detections?limit=20' : null, 15_000, ['token', 'safety', 'evaluation']);
  const { positions } = useLivePositions();
  const events = useMemo<Event[]>(() => {
    const ev: Event[] = [];
    for (const t of trades.data ?? []) {
      if (t.closedAt) ev.push({ key: `s${t.id}`, at: t.closedAt, kind: 'sell', symbol: t.symbol, mint: t.mint, strategy: t.strategy, detail: `${EXIT_LABEL[t.exitReason ?? ''] ?? t.exitReason ?? 'Closed'} · peak ${t.peakMultiple.toFixed(2)}× · held ${duration(t.holdSeconds)}`, pnlSol: t.pnlSol, pnlPct: t.pnlPct });
      ev.push({ key: `b${t.id}`, at: t.openedAt, kind: 'buy', symbol: t.symbol, mint: t.mint, strategy: t.strategy, detail: `${sol(t.sizeSol, 2)}${t.scoreAtEntry !== null ? ` · score ${Math.round(t.scoreAtEntry)}` : ''}` });
    }
    for (const p of positions ?? []) ev.push({ key: `o${p.id}`, at: p.openedAt, kind: 'buy', symbol: p.symbol, mint: p.mint, strategy: p.strategy, detail: `${sol(p.sizeSol, 2)} · still open` });
    return ev.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20);
  }, [trades.data, positions]);
  return (
    <>
      <SectionHeader
        sticky
        title="Activity"
        description={tab === 'trades' ? 'Latest buys and sells' : 'Coins that just launched'}
        action={<Tabs label="Activity" className="w-[12rem]" tabs={[{ key: 'trades', label: 'Trades' }, { key: 'launches', label: 'Launches' }]} value={tab} onChange={setTab} />}
      />
      <Card padded={false}>
        {tab === 'trades' ? (
          events.length ? (
            <ol className="max-h-[36rem] divide-y divide-line overflow-y-auto">
              {events.map((e) => (
                <li key={e.key}>
                  <Link to={`/token/${e.mint}`} className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60 sm:px-5">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold ${e.kind === 'buy' ? 'bg-accent/12 text-accent-text' : (e.pnlSol ?? 0) >= 0 ? 'bg-good/12 text-up' : 'bg-critical/12 text-down'}`} aria-hidden="true">
                      {e.kind === 'buy' ? 'B' : 'S'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-semibold text-ink">{e.kind === 'buy' ? 'Bought' : 'Sold'} {e.symbol}</span>
                        <Badge>{STRATEGY_LABEL[e.strategy] ?? e.strategy}</Badge>
                      </div>
                      <div className="tabular truncate text-xs text-muted" title={e.detail}>{e.detail}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      {e.kind === 'sell' ? <Pnl value={e.pnlSol} className="text-sm" /> : <span className="text-sm text-ink-2">entry</span>}
                      <div className="tabular text-xs text-muted">{ago(e.at)}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <div className="p-4">
              <Empty>No trades yet.</Empty>
            </div>
          )
        ) : feed.data?.length ? (
          <ol className="max-h-[36rem] divide-y divide-line overflow-y-auto">
            {feed.data.map((t) => (
              <li key={t.mint}>
                <Link to={`/token/${t.mint}`} className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60 sm:px-5">
                  <div className="min-w-0 flex-1">
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
          </ol>
        ) : (
          <div className="p-4">
            <Empty action={<Link to="/feed" className="text-sm font-medium text-accent-text hover:underline">Open the live feed</Link>}>Waiting for launches…</Empty>
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-right sm:px-5">
          <Link to={tab === 'trades' ? '/history' : '/feed'} className="inline-flex min-h-9 items-center text-sm font-medium text-accent-text hover:underline">
            {tab === 'trades' ? 'All trades' : 'Live feed'}
          </Link>
        </div>
      </Card>
    </>
  );
}

/** "⋯" menu on the profit section — "Add paper SOL" and "Reset paper account". */
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
        aria-label="Paper account options"
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-10 place-items-center rounded-full border border-line-strong text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="menu" className="pop absolute right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-card-hover">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setAdd(true); }} className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-2">
              Add paper SOL…
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setDialog(true); }} className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-down hover:bg-surface-2">
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

function WindowStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="tabular mt-0.5 truncate font-semibold text-ink">{value}</dd>
    </div>
  );
}
