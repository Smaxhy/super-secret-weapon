/**
 * Forex (v12 → v15): the auto-bot (home), every market, every strategy on 10 currency pairs + gold + silver tested on
 * 1-minute, 15-minute, hourly and 4-hour candles (in-sample / unseen split, real spreads) and paper traded live from
 * the day the lab started. No real orders.
 */
import { FxFeeds } from '../components/FxFeeds';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FxBot } from '../components/FxBot';
import { FxNews, MarketClockBar } from '../components/FxNews';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from '../components/Icon';
import { FxTrade } from '../components/FxTrade';
import { OandaCard } from '../components/OandaCard';
import { MarketChart, type ChartDrawings } from '../components/MarketChart';
import { EXIT_SHORT, ExitsCard, FILTER_SHORT, FiltersCard, JudgeCard, MoodCard, NewsStudyCard, StrengthCard, TrendArrows, type ExitKind, type ExitSummary, type FilterKind, type FilterSummary, type JudgeReport, type MoodNow, type NewsStudy, type PortfolioReport, type StrengthNow } from '../components/FxInsights';
import { Badge, Button, Card, Chip, Drawer, Empty, ErrorBox, Loading, PageHeader, Row, Rows, Sparkline, Stack, StatTile, useStored } from '../components/ui';

interface RStats { n: number; winPct: number; avgR: number; medianR: number; pf: number | null; totalR: number; maxDdR: number }
interface Risk { riskPct: number; finalX: number; avgWeekPct: number; medianWeekPct: number; greenWeeksPct: number; bigWeeksPct: number; bestWeekPct: number; worstWeekPct: number; maxDdPct: number; blown: boolean; medianLeverage: number; weeks: number }
interface VariantRow { filter: FilterKind; inN: number; inAvgR: number; outN: number; outAvgR: number; outPf: number | null; allN: number }
interface ExitVariantRow extends Omit<VariantRow, 'filter'> { exit: ExitKind }
interface RowT { id: string; name: string; family: string; desc: string; tf: string; filter?: FilterKind; variants?: VariantRow[]; exit?: ExitKind; exitVariants?: ExitVariantRow[]; all: RStats; inSample: RStats; outSample: RStats; tradesPerWeek: number; risk: Risk[]; pairs: Array<{ pair: string } & RStats>; verdict: 'edge' | 'maybe' | 'no'; why: string; luck?: { pctl: number; twinsP90: number; twinPassPct: number } }
interface Trade { strategy: string; tf: string; pair: string; side: 1 | -1; entryT: number; exitT: number; entry: number; exit: number; r: number; reason: string; stop: number; stop0: number; target: number | null }
interface MarketNow { id: string; label: string; price: number; t: number; change24hPct: number; closes: number[]; trend: 'up' | 'down' | 'flat'; rsi: number; atrPips: number; firing: Array<{ id: string; name: string; tf: string; side: 1 | -1; allowed?: boolean; why?: string | null }>; openPaper: number; bars: number[][]; drawings: ChartDrawings; mtf?: { h1: number; h4: number; d1: number }; strength?: { base: string; quote: string; baseScore: number | null; quoteScore: number | null; gap: number | null }; risk?: number; heat?: Heatmap }
interface HeatLevel { price: number; kind: 'round' | 'half' | 'swing' | 'yesterday' | 'expiry'; label: string; weight: number; distAtr: number }
interface Heatmap { levels: HeatLevel[]; read: { positioning: number | null; carry: number | null; volF: number | null; hurst: number | null; long: number; short: number; of: number; why: string[] } }
interface ExtFeeds { dukascopy: { at: number; ids: Record<string, { bars: number; firstT: number | null; lastT: number | null; error: string | null }> } | null; spreadProfiles: string[]; macro: { cot: Array<{ ccy: string; score: number; net: number; asOf: number }>; rates: Array<{ ccy: string; rate: number }>; errors: string[]; at: number | null }; historyFrom: number }
interface PaperRow { id: string; name: string; tf: string; stats: RStats; risk1: Risk; open: number }
interface Report { at: number; durationMs: number; feed: Array<{ id: string; role?: 'traded' | 'strength' | 'mood'; bars: number; firstT: number | null; lastT: number | null; error: string | null }>; from: number | null; to: number | null; oosFrom: number | null; rows: RowT[]; markets?: MarketNow[]; paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] }; note: string; strength?: StrengthNow; mood?: MoodNow; filters?: FilterSummary[]; exits?: ExitSummary[]; judge?: JudgeReport | null; portfolio?: PortfolioReport | null; news?: NewsStudy | null; extFeeds?: ExtFeeds }
interface FastFeed { id: string; tf: '15m' | '1m'; bars: number; firstT: number | null; lastT: number | null; source: 'oanda' | 'yahoo' | null; error: string | null }
interface FastReport { at: number; durationMs: number; feed: FastFeed[]; spans: Record<'15m' | '1m', { from: number | null; to: number | null; oosFrom: number | null; markets: number }>; rows: RowT[]; paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] }; note: string }
interface Data { running: boolean; last: Report | null; fast?: FastReport | null }

const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
const VERDICT: Record<RowT['verdict'], { label: string; tone: 'up' | 'warn' | 'neutral' }> = { edge: { label: 'Edge', tone: 'up' }, maybe: { label: 'Maybe', tone: 'warn' }, no: { label: 'No edge', tone: 'neutral' } };
type Section = 'live' | 'practice' | 'bot' | 'strategies' | 'paper' | 'setup';
const TITLES: Record<Section, { title: string; sub: string }> = {
  live: { title: 'Markets', sub: "Every market the bot watches: its trendlines, levels, signals and open trades." },
  practice: { title: 'Trade by hand', sub: 'Optional: your own $1,000 practice account. The auto-bot trades without you.' },
  bot: { title: 'Auto-bot', sub: 'Its own $1,000 account, traded by itself on 1-minute, 15-minute, hourly and 4-hour charts.' },
  strategies: { title: 'Strategies', sub: 'Every strategy tested on each chart with real spreads; the last 30% of each history kept unseen.' },
  paper: { title: 'Paper results', sub: 'Every strategy traded live on paper since the lab started: the real test.' },
  setup: { title: 'Setup', sub: 'Price feed, markets and the road to real money.' },
};

export function Forex() {
  const params = useParams();
  const section = ((['live', 'practice', 'strategies', 'paper', 'setup'] as const).find((x) => x === params.section) ?? 'bot') as Section;
  const navigate = useNavigate();
  const { data, error, reload } = useApi<Data>('/api/forex', 60_000);
  const [busy, setBusy] = useState(false);
  const running = !!data?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 4_000);
    return () => clearInterval(t);
  }, [running, reload]);
  const run = async () => {
    setBusy(true);
    try {
      await api('/api/forex/run', { method: 'POST', body: JSON.stringify({ refresh: true }) });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const r0 = data?.last ?? null;
  const fast = data?.fast ?? null;
  // v15: the 15-minute / 1-minute lab's rows and paper trades sit next to the hourly ones
  const r = useMemo<Report | null>(() => (r0 ? mergeFast(r0, fast) : null), [r0, fast]);
  const labNeeded = section === 'live' || section === 'strategies' || section === 'paper';
  return (
    <>
      <PageHeader
        title={TITLES[section].title}
        subtitle={TITLES[section].sub}
        action={labNeeded ? (
          <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void run()}>
            <Icon name="refresh" size={14} className={running ? 'animate-spin' : ''} />
            {running ? 'Updating…' : 'Update now'}
          </Button>
        ) : undefined}
      />
      {error && <ErrorBox message={error} />}
      {(section === 'live' || section === 'practice' || section === 'bot') && <div className="mb-4"><MarketClockBar /></div>}
      {section === 'practice' && <FxTrade />}
      {section === 'bot' && <FxBot />}
      {section === 'setup' && <Stack><FxFeeds /><OandaCard />{r && <Setup r={r} fast={fast} />}</Stack>}
      {labNeeded && !data && !error && <Loading kind="tiles" />}
      {labNeeded && data && !r && <Empty icon={<Icon name="globe" size={20} />}>{running ? 'First run: downloading 2 years of candles for 12 markets. About a minute.' : 'Not run yet. It starts by itself a minute after the bot starts, or press Update now.'}</Empty>}
      {labNeeded && r && (
        <Stack>
          <Summary r={r} />
          {section === 'live' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <StrengthCard s={r.strength} pairs={(r.markets ?? []).map((m) => m.id)} />
              <MoodCard m={r.mood} />
            </div>
          )}
          {section === 'live' && <FxNews />}
          {section === 'live' && <Markets r={r} onTrade={(id) => { try { localStorage.setItem('fx.pair', id); } catch { /* ignore */ } navigate('/forex/practice'); }} />}
          {section === 'strategies' && <JudgeCard j={r.judge} />}
          {section === 'strategies' && <FiltersCard f={r.filters} />}
          {section === 'strategies' && <ExitsCard e={r.exits} />}
          {section === 'strategies' && <Strategies r={r} />}
          {section === 'strategies' && <NewsStudyCard n={r.news} />}
          {section === 'paper' && <Paper r={r} />}
        </Stack>
      )}
    </>
  );
}

/** Hourly report + the fast charts' rows and paper trades (one list per page). */
function mergeFast(r: Report, f: FastReport | null): Report {
  if (!f) return r;
  return {
    ...r,
    rows: [...r.rows, ...f.rows],
    paper: { since: r.paper.since, rows: [...r.paper.rows, ...f.paper.rows].sort((a, b) => b.stats.totalR - a.stats.totalR), open: [...r.paper.open, ...f.paper.open].sort((a, b) => b.entryT - a.entryT), recent: [...r.paper.recent, ...f.paper.recent].sort((a, b) => b.exitT - a.exitT) },
    note: `${r.note} ${f.note}`,
  };
}

const DIGITS = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
const STRAT_NAME = (r: Report, id: string) => r.rows.find((x) => x.id === id)?.name ?? id;

function Markets({ r, onTrade }: { r: Report; onTrade: (id: string) => void }) {
  const [open, setOpen] = useState<MarketNow | null>(null);
  const ms = r.markets ?? [];
  if (!ms.length) return <Empty icon={<Icon name="globe" size={20} />}>No market data yet. It fills in after the first hourly update.</Empty>;
  return (
    <Stack>
      <p className="text-sm text-ink-2">What the bot is watching right now, on the hourly chart. Updated {ago(new Date(r.at).toISOString())}. Tap a market to see its lines and trades.</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ms.map((m) => (
          <button key={m.id} type="button" onClick={() => setOpen(m)} className="card card-lift p-4 text-left">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-ink">{m.label}</div>
                <div className="tabular text-lg font-semibold text-ink">{m.price.toFixed(DIGITS(m.id))}</div>
              </div>
              <div className="text-right">
                <div className={`tabular text-sm font-semibold ${m.change24hPct >= 0 ? 'text-up' : 'text-down'}`}>{m.change24hPct >= 0 ? '+' : ''}{m.change24hPct}%</div>
                <div className="text-xs text-muted">24 h</div>
              </div>
            </div>
            <Sparkline points={m.closes} width={260} height={44} tone={m.change24hPct >= 0 ? 'up' : 'down'} className="mt-2 w-full" />
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <TrendArrows mtf={m.mtf} />
              <Badge tone={m.rsi >= 70 || m.rsi <= 30 ? 'warn' : 'neutral'}>RSI {m.rsi}</Badge>
              <Badge tone="neutral">{m.atrPips} pips/h</Badge>
              {m.openPaper > 0 && <Badge tone="accent">{m.openPaper} bot trade{m.openPaper > 1 ? 's' : ''}</Badge>}
              {m.drawings.lines.length > 0 && <Badge tone="neutral">{m.drawings.lines.length} trendline{m.drawings.lines.length > 1 ? 's' : ''}</Badge>}
            </div>
            {m.strength && m.strength.quoteScore !== null && (
              <div className="mt-2 text-xs text-ink-2">
                <StrengthLine m={m} />
              </div>
            )}
            {m.firing.length > 0 && (
              <div className="mt-1 text-xs text-ink-2">
                <span className="font-medium text-ink">Firing now:</span> {m.firing.slice(0, 3).map((f) => `${f.side === 1 ? '▲' : '▼'} ${f.name} (${f.tf})${f.allowed === false ? ', held back' : ''}`).join(' · ')}{m.firing.length > 3 ? ` · +${m.firing.length - 3} more` : ''}
              </div>
            )}
          </button>
        ))}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.label ?? ''} subtitle={open ? `${open.price.toFixed(DIGITS(open.id))} · hourly chart, last ${open.bars.length} hours` : ''} wide>
        {open && <MarketDetail m={open} r={r} onTrade={() => onTrade(open.id)} />}
      </Drawer>
    </Stack>
  );
}

function StrengthLine({ m }: { m: MarketNow }) {
  const st = m.strength!;
  const f = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`);
  const gap = st.gap ?? 0;
  const metal = m.id.startsWith('XA');
  const verdict = Math.abs(gap) < 0.15 ? 'no clear side' : gap > 0 ? `favours buying` : `favours selling`;
  return (
    <span>
      {metal ? <>USD strength <span className={tone(-(st.quoteScore ?? 0))}>{f(st.quoteScore)}</span></> : <>{st.base} <span className={tone(st.baseScore ?? 0)}>{f(st.baseScore)}</span> vs {st.quote} <span className={tone(st.quoteScore ?? 0)}>{f(st.quoteScore)}</span></>} · <span className={gap >= 0.15 ? 'text-up' : gap <= -0.15 ? 'text-down' : 'text-muted'}>{verdict}</span>
    </span>
  );
}

function MarketDetail({ m, r, onTrade }: { m: MarketNow; r: Report; onTrade: () => void }) {
  const [show, setShow] = useState({ lines: true, levels: true, ranges: true, trades: true });
  const trades = r.paper.open.filter((t) => t.pair === m.id && t.tf === '1h');
  const trades4h = r.paper.open.filter((t) => t.pair === m.id && t.tf === '4h');
  const all = [...trades, ...trades4h];
  const toggle = (k: keyof typeof show) => setShow({ ...show, [k]: !show[k] });
  return (
    <Stack>
      <div className="flex flex-wrap gap-1.5">
        <Chip active={show.lines} onClick={() => toggle('lines')}>Trendlines</Chip>
        <Chip active={show.levels} onClick={() => toggle('levels')}>Support / resistance</Chip>
        <Chip active={show.ranges} onClick={() => toggle('ranges')}>Yesterday + Asia range</Chip>
        <Chip active={show.trades} onClick={() => toggle('trades')}>Bot trades</Chip>
      </div>
      <div className="rounded-xl border border-line bg-surface p-2">
        <MarketChart bars={m.bars} drawings={m.drawings} trades={all.map((t) => ({ side: t.side, entryT: t.entryT, entry: t.entry, stop: t.stop, target: t.target, strategy: t.strategy }))} digits={DIGITS(m.id)} show={show} />
      </div>
      <p className="text-xs text-muted">Green lines = support (rising trendline or a floor price kept bouncing off), red = resistance; dashed = broken. Purple dots = yesterday's high / low, blue band = today's Asian session range. Blue line = a bot entry, dashed red / green = its stop / target.</p>
      {m.heat && <HeatmapBox m={m} />}
      <Button onClick={onTrade}>Trade {m.label} yourself</Button>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Bot's open paper trades</div>
          {!all.length ? <p className="text-sm text-ink-2">None on this market.</p> : (
            <Rows>
              {all.map((t) => (
                <Row key={`${t.strategy}:${t.tf}:${t.entryT}`} label={`${t.side === 1 ? 'Long' : 'Short'} · ${STRAT_NAME(r, t.strategy)} (${t.tf})`} sub={`in ${t.entry.toFixed(DIGITS(m.id))} · stop ${t.stop.toFixed(DIGITS(m.id))}${t.target !== null ? ` · target ${t.target.toFixed(DIGITS(m.id))}` : ' · trailing'} · ${ago(new Date(t.entryT).toISOString())}`} value={<span className={t.r >= 0 ? 'text-up' : 'text-down'}>{t.r >= 0 ? '+' : ''}{t.r.toFixed(2)}R</span>} />
              ))}
            </Rows>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">What it sees</div>
          <Rows>
            {m.drawings.lines.map((l, k) => (
              <Row key={`l${k}`} label={`${l.kind === 'support' ? 'Rising support' : 'Falling resistance'} trendline`} sub={`${l.touches} touches · ${l.broken ? 'just broken' : 'holding'}`} value={l.pNow.toFixed(DIGITS(m.id))} />
            ))}
            {m.drawings.levels.map((l, k) => (
              <Row key={`v${k}`} label={l.kind === 'support' ? 'Support level' : 'Resistance level'} sub={`${l.touches} swing points`} value={l.price.toFixed(DIGITS(m.id))} />
            ))}
            {m.mtf && <Row label="Trend on the bigger charts" sub="1-hour · 4-hour · daily (close and 20 EMA vs the 50 EMA)" value={<TrendArrows mtf={m.mtf} />} />}
            {m.strength && m.strength.quoteScore !== null && <Row label="Currency strength" sub="buy the stronger currency, sell the weaker" value={<span className="text-xs"><StrengthLine m={m} /></span>} />}
            {m.risk !== undefined && r.mood && <Row label="Market mood fit" sub={`buying ${m.label} is ${m.risk > 0.4 ? 'a risk-on trade' : m.risk < -0.4 ? 'a safe-haven trade' : 'mood-neutral'}`} value={<span className={r.mood.label === 'risk-off' ? 'text-down' : r.mood.label === 'risk-on' ? 'text-up' : 'text-muted'}>{r.mood.label}</span>} />}
            {m.firing.map((f) => (
              <Row key={`${f.id}:${f.tf}`} label={`${f.side === 1 ? 'Buy' : 'Sell'} signal: ${f.name}`} sub={`${f.tf} candle close${f.allowed === false && f.why ? ` · held back: ${f.why}` : ''}`} value={<span className={f.allowed === false ? 'text-muted' : f.side === 1 ? 'text-up' : 'text-down'}>{f.side === 1 ? '▲' : '▼'}</span>} />
            ))}
            {!m.drawings.lines.length && !m.drawings.levels.length && !m.firing.length && <Row label="Nothing notable" value="—" />}
          </Rows>
        </div>
      </div>
    </Stack>
  );
}

function Summary({ r }: { r: Report }) {
  const edges = r.rows.filter((x) => x.verdict === 'edge').length;
  const maybes = r.rows.filter((x) => x.verdict === 'maybe').length;
  const pTrades = r.paper.rows.reduce((a, x) => a + x.stats.n, 0);
  const pR = r.paper.rows.reduce((a, x) => a + x.stats.totalR, 0);
  const feedErr = r.feed.filter((f) => f.error).length;
  const traded = r.feed.filter((f) => (f.role ?? 'traded') === 'traded');
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile compact label="Pass on unseen data" value={`${edges}`} sub={`${maybes} maybe · ${r.rows.length} tested`} tone={edges ? 'up' : undefined} />
      <StatTile compact label="History tested" value={`${day(r.from)} → ${day(r.to)}`} sub={`last 30% unseen from ${day(r.oosFrom)}`} />
      <StatTile compact label="Paper since" value={day(r.paper.since)} sub={`${pTrades} closed · ${r.paper.open.length} open · ${signed(pR, 1)}R`} tone={pR > 0 ? 'up' : pR < 0 ? 'down' : undefined} />
      <StatTile compact label="Data" value={`${traded.filter((f) => f.bars > 0).length}/${traded.length} markets`} sub={feedErr ? `${feedErr} feeds failed to update` : `+ ${r.feed.length - traded.length} inputs · updated ${ago(new Date(r.at).toISOString())}`} tone={feedErr ? 'warn' : undefined} />
    </div>
  );
}

function Strategies({ r }: { r: Report }) {
  const [tf, setTf] = useStored<'all' | '1m' | '15m' | '1h' | '4h'>('fx.tf', 'all', ['all', '1m', '15m', '1h', '4h']);
  const [risk, setRisk] = useStored<'0.5' | '1' | '2' | '5'>('fx.risk', '1', ['0.5', '1', '2', '5']);
  const [open, setOpen] = useState<RowT | null>(null);
  const rows = useMemo(() => r.rows.filter((x) => tf === 'all' || x.tf === tf), [r, tf]);
  const ri = (x: RowT) => x.risk.find((k) => String(k.riskPct) === risk) ?? x.risk[1]!;
  return (
    <Card
      title="Every strategy, honestly scored"
      subtitle={`${r.note} R = the amount risked per trade. "Per week" uses ${risk}% of the account risked per trade, leverage capped at 50×.`}
      padded={false}
    >
      <div className="flex flex-wrap gap-1.5 px-4 pb-3 sm:px-5">
        {(['all', '1m', '15m', '1h', '4h'] as const).map((k) => (
          <Chip key={k} active={tf === k} onClick={() => setTf(k)}>{k === 'all' ? 'All' : k}</Chip>
        ))}
        <span className="mx-1 self-center text-xs text-muted">risk / trade</span>
        {(['0.5', '1', '2', '5'] as const).map((k) => (
          <Chip key={k} active={risk === k} onClick={() => setRisk(k)}>{k}%</Chip>
        ))}
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {rows.map((x) => {
          const k = ri(x);
          return (
            <li key={`${x.id}:${x.tf}`}>
              <button type="button" onClick={() => setOpen(x)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{x.name}</span>
                    <Badge tone="neutral">{x.tf}</Badge>
                    {x.filter && x.filter !== 'none' && <Badge tone="accent">{FILTER_SHORT[x.filter]}</Badge>}
                    {x.exit && x.exit !== 'designed' && <Badge tone="accent">{EXIT_SHORT[x.exit]}</Badge>}
                    <Badge tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].label}</Badge>
                    {x.luck && <Badge tone={x.luck.pctl >= 90 ? 'up' : 'neutral'} title="where its unseen result falls among 20 copies with the same exits that fire at random times">beats {Math.round(x.luck.pctl / 5)} of 20 random</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {x.all.n} trades · {x.all.winPct}% won · unseen {signed(x.outSample.avgR, 2)}R/trade · {x.tradesPerWeek}/week
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`tabular font-semibold ${tone(k.avgWeekPct)}`}>{signed(k.avgWeekPct)}%/wk</div>
                  <div className="text-xs text-muted">{k.blown ? 'wiped out' : `worst wk ${signed(k.worstWeekPct, 0)}%`}</div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.name} · ${open.tf}` : ''} subtitle={open?.desc} wide>
        {open && <Detail x={open} />}
      </Drawer>
    </Card>
  );
}

function Detail({ x }: { x: RowT }) {
  return (
    <Stack>
      <p className={`rounded-xl border p-3 text-sm ${x.verdict === 'edge' ? 'border-good/40 bg-good/5 text-ink' : 'border-line bg-surface-2/40 text-ink-2'}`}>
        <span className="font-semibold">{VERDICT[x.verdict].label}:</span> {x.why}
      </p>
      <div className="grid grid-cols-3 gap-3">
        <StatTile compact label="All" value={`${signed(x.all.avgR, 2)}R`} sub={`${x.all.n} · PF ${x.all.pf ?? '∞'}`} tone={x.all.avgR > 0 ? 'up' : 'down'} />
        <StatTile compact label="First 70%" value={`${signed(x.inSample.avgR, 2)}R`} sub={`${x.inSample.n} · PF ${x.inSample.pf ?? '∞'}`} tone={x.inSample.avgR > 0 ? 'up' : 'down'} />
        <StatTile compact label="Unseen 30%" value={`${signed(x.outSample.avgR, 2)}R`} sub={`${x.outSample.n} · PF ${x.outSample.pf ?? '∞'}`} tone={x.outSample.avgR > 0 ? 'up' : 'down'} />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">What a week looks like, by risk per trade</div>
        <div className="overflow-x-auto">
          <table className="tabular w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Risk</th>
                <th className="py-1 text-right font-medium">Avg week</th>
                <th className="py-1 text-right font-medium">Median</th>
                <th className="py-1 text-right font-medium">Green</th>
                <th className="py-1 text-right font-medium">+10%+ wks</th>
                <th className="py-1 text-right font-medium">Worst</th>
                <th className="py-1 text-right font-medium">Max drop</th>
                <th className="py-1 text-right font-medium">End</th>
              </tr>
            </thead>
            <tbody>
              {x.risk.map((k) => (
                <tr key={k.riskPct} className="border-t border-line">
                  <td className="py-1.5 text-ink">{k.riskPct}% <span className="text-xs text-muted">({k.medianLeverage}×)</span></td>
                  <td className={`py-1.5 text-right ${tone(k.avgWeekPct)}`}>{signed(k.avgWeekPct)}%</td>
                  <td className={`py-1.5 text-right ${tone(k.medianWeekPct)}`}>{signed(k.medianWeekPct)}%</td>
                  <td className="py-1.5 text-right text-ink-2">{k.greenWeeksPct}%</td>
                  <td className="py-1.5 text-right text-ink-2">{k.bigWeeksPct}%</td>
                  <td className="py-1.5 text-right text-down">{signed(k.worstWeekPct, 0)}%</td>
                  <td className="py-1.5 text-right text-ink-2">−{k.maxDdPct}%</td>
                  <td className={`py-1.5 text-right font-semibold ${k.blown ? 'text-down' : tone(k.finalX - 1)}`}>{k.blown ? 'wiped' : `${k.finalX}×`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted">Leverage in brackets = the typical position size needed for that risk. Over 2 years, compounded, with every losing streak included.</p>
      </div>
      {x.variants && x.variants.length > 1 && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Checks tried (picked on the first 70% only)</div>
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium">Check</th>
                  <th className="py-1 text-right font-medium">First 70%</th>
                  <th className="py-1 text-right font-medium">Unseen 30%</th>
                  <th className="py-1 text-right font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {x.variants.map((v) => (
                  <tr key={v.filter} className={`border-t border-line ${v.filter === (x.filter ?? 'none') ? 'font-semibold' : ''}`}>
                    <td className="py-1.5 text-ink">{v.filter === 'none' ? 'No check' : FILTER_SHORT[v.filter]}{v.filter === (x.filter ?? 'none') ? ' ✓' : ''}</td>
                    <td className={`py-1.5 text-right ${tone(v.inAvgR)}`}>{signed(v.inAvgR, 2)}R <span className="text-xs font-normal text-muted">({v.inN})</span></td>
                    <td className={`py-1.5 text-right ${tone(v.outAvgR)}`}>{signed(v.outAvgR, 2)}R <span className="text-xs font-normal text-muted">({v.outN})</span></td>
                    <td className="py-1.5 text-right text-ink-2">{v.allN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {x.exitVariants && x.exitVariants.length > 1 && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Exits tried (with its check, picked on the first 70% only)</div>
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium">Exit</th>
                  <th className="py-1 text-right font-medium">First 70%</th>
                  <th className="py-1 text-right font-medium">Unseen 30%</th>
                  <th className="py-1 text-right font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {x.exitVariants.map((v) => (
                  <tr key={v.exit} className={`border-t border-line ${v.exit === (x.exit ?? 'designed') ? 'font-semibold' : ''}`}>
                    <td className="py-1.5 text-ink">{v.exit === 'designed' ? 'As designed' : EXIT_SHORT[v.exit]}{v.exit === (x.exit ?? 'designed') ? ' ✓' : ''}</td>
                    <td className={`py-1.5 text-right ${tone(v.inAvgR)}`}>{signed(v.inAvgR, 2)}R <span className="text-xs font-normal text-muted">({v.inN})</span></td>
                    <td className={`py-1.5 text-right ${tone(v.outAvgR)}`}>{signed(v.outAvgR, 2)}R <span className="text-xs font-normal text-muted">({v.outN})</span></td>
                    <td className="py-1.5 text-right text-ink-2">{v.allN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">By market</div>
        <Rows>
          {x.pairs.map((p) => (
            <Row key={p.pair} label={p.pair} value={<span className={tone(p.totalR)}>{signed(p.totalR, 1)}R</span>} sub={p.n ? `${p.n} trades · ${p.winPct}% won · PF ${p.pf ?? '∞'}` : 'no trades'} />
          ))}
        </Rows>
      </div>
    </Stack>
  );
}

function Paper({ r }: { r: Report }) {
  const p = r.paper;
  const active = p.rows.filter((x) => x.stats.n || x.open);
  return (
    <Stack>
      <Card title="Paper results since the lab started" subtitle={`Trades opened after ${day(p.since)} only: none of these candles existed when the rules were written. This is the real test.`} padded={false}>
        {!active.length ? (
          <p className="px-4 pb-4 text-sm text-ink-2 sm:px-5">No paper trades closed yet. Most strategies trade a few times a week per market; give it a few days.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {active.map((x) => (
              <li key={`${x.id}:${x.tf}`} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{x.name}</span>
                    <Badge tone="neutral">{x.tf}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{x.stats.n} closed · {x.stats.winPct}% won · {x.open} open</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`tabular font-semibold ${tone(x.stats.totalR)}`}>{signed(x.stats.totalR, 1)}R</div>
                  <div className="text-xs text-muted">{signed((x.risk1.finalX - 1) * 100, 1)}% at 1% risk</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Open paper trades" subtitle="Updated every hour on the candle close.">
        {!p.open.length ? <p className="text-sm text-ink-2">None open.</p> : <TradeList ts={p.open} open />}
      </Card>
      <Card title="Latest closed paper trades">
        {!p.recent.length ? <p className="text-sm text-ink-2">None yet.</p> : <TradeList ts={p.recent.slice(0, 40)} />}
      </Card>
    </Stack>
  );
}

function TradeList({ ts, open = false }: { ts: Trade[]; open?: boolean }) {
  return (
    <Rows>
      {ts.map((t) => (
        <Row
          key={`${t.strategy}:${t.tf}:${t.pair}:${t.entryT}`}
          label={`${t.side === 1 ? 'Long' : 'Short'} ${t.pair}`}
          sub={`${t.strategy} · ${t.tf} · ${open ? `since ${ago(new Date(t.entryT).toISOString())}` : `${t.reason} · ${ago(new Date(t.exitT).toISOString())}`}`}
          value={<span className={tone(t.r)}>{signed(t.r, 2)}R</span>}
        />
      ))}
    </Rows>
  );
}

const KIND_TONE: Record<HeatLevel['kind'], string> = { round: 'bg-accent', half: 'bg-accent/50', swing: 'bg-warning', yesterday: 'bg-ink-2', expiry: 'bg-up' };

/** v16: where orders are likely to sit near the price, and what the quant engines read right now. */
function HeatmapBox({ m }: { m: MarketNow }) {
  const h = m.heat!;
  const d = DIGITS(m.id);
  const above = h.levels.filter((l) => l.distAtr > 0);
  const below = h.levels.filter((l) => l.distAtr <= 0);
  const row = (l: HeatLevel) => (
    <div key={`${l.kind}:${l.price}`} className="flex items-center gap-2 py-1 text-sm">
      <span className="w-20 shrink-0 tabular text-ink">{l.price.toFixed(d)}</span>
      <span className="h-2 shrink-0 rounded-full" style={{ width: `${Math.round(l.weight * 14)}px` }}>
        <span className={`block h-2 rounded-full ${KIND_TONE[l.kind]}`} />
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{l.label}</span>
      <span className="shrink-0 text-xs text-muted">{l.distAtr > 0 ? '+' : ''}{l.distAtr.toFixed(1)} ATR</span>
    </div>
  );
  const r = h.read;
  const pos = r.positioning;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Heatmap: where orders likely sit</div>
      <p className="mb-2 text-xs text-muted">Big round numbers (stops cluster just beyond, take-profits at them), swing levels the price respected, yesterday's high / low and today's big option expiries (10:00 New York cut). Longer bar = more orders tend to sit there.</p>
      <div>{above.map(row)}</div>
      <div className="my-1 flex items-center gap-2 text-sm font-semibold text-ink"><span className="w-20 tabular">{m.price.toFixed(d)}</span><span className="h-px flex-1 bg-line-strong" /><span className="text-xs text-muted">price now</span></div>
      <div>{below.map(row)}</div>
      <Rows className="mt-3">
        <Row label="Hedge-fund positioning (CFTC)" sub="−2 = very short the pair … +2 = very long; crowded sides get squeezed" value={pos === null ? <span className="text-muted">no data</span> : <span className={Math.abs(pos) >= 1.2 ? 'text-warning' : 'text-ink'}>{pos > 0 ? '+' : ''}{pos.toFixed(2)}</span>} />
        <Row label="Carry (interest-rate gap)" sub="what holding a long earns (+) or costs (−) per year" value={r.carry === null ? <span className="text-muted">no rates feed</span> : <span className={tone(r.carry)}>{r.carry > 0 ? '+' : ''}{r.carry.toFixed(2)}%</span>} />
        <Row label="Volatility forecast" sub="above 1 = moves expected to get bigger, below 1 = calmer" value={r.volF === null ? '—' : `${r.volF.toFixed(2)}×`} />
        <Row label="Trend or chop (Hurst)" sub="above 0.5 = moves continue, below 0.5 = they snap back" value={r.hurst === null ? '—' : r.hurst.toFixed(2)} />
        <Row label="Sniper checks right now" sub={r.why.length ? r.why.join(' · ') : 'none agree'} value={<span className="text-xs">long {r.long} / short {r.short} of {r.of}</span>} />
      </Rows>
    </div>
  );
}

function Setup({ r, fast }: { r: Report; fast: FastReport | null }) {
  const x = r.extFeeds;
  return (
    <Stack>
      {x && (
        <Card title="Extra data: history, real spreads, positioning, interest rates" subtitle="All free, no account. Dukascopy (bank-grade candles, open-source dukascopy-node) gives years more history for the honest test and the real spread at each hour of the day; the CFTC report shows hedge funds' positions in the currency futures every week; the BIS publishes the central banks' policy rates (carry). Option expiries come from ForexLive's daily post.">
          <Rows>
            <Row label="Test history starts" value={day(x.historyFrom)} sub="Yahoo gives about 2 years; Dukascopy adds older years for the currency pairs" />
            <Row label="Dukascopy history" value={x.dukascopy ? `${Object.values(x.dukascopy.ids).filter((v) => v.bars > 0).length}/${Object.keys(x.dukascopy.ids).length} markets` : <span className="text-muted">first download a few minutes after start</span>} sub={x.dukascopy ? `${Object.values(x.dukascopy.ids).reduce((a, v) => a + v.bars, 0).toLocaleString()} hourly bars · ${Object.values(x.dukascopy.ids).filter((v) => v.error).length} failed · updated ${ago(new Date(x.dukascopy.at).toISOString())}` : undefined} />
            <Row label="Real spread by hour" value={`${x.spreadProfiles.length} markets`} sub="the backtest charges the measured hour-of-day shape (never cheaper than a retail spread)" />
            <Row label="Hedge-fund positioning (CFTC)" value={x.macro.cot.length ? `${x.macro.cot.length} currencies` : <span className="text-muted">no data yet</span>} sub={x.macro.cot.map((c) => `${c.ccy} ${c.score > 0 ? '+' : ''}${c.score}`).join(' · ') || undefined} />
            <Row label="Central-bank rates (BIS)" value={x.macro.rates.length ? `${x.macro.rates.length} currencies` : <span className="text-muted">no data yet</span>} sub={x.macro.rates.map((c) => `${c.ccy} ${c.rate}%`).join(' · ') || undefined} />
            {x.macro.errors.map((e, k) => <Row key={k} label={<span className="text-down">Feed problem</span>} value="" sub={e} />)}
          </Rows>
        </Card>
      )}
      {fast && (
        <Card title="15-minute and 1-minute candles" subtitle={`From OANDA when connected (deeper history, 1-minute checks every minute), else Yahoo (60 days of 15-minute, up to 3 weeks of 1-minute, checked every 2 minutes). The server keeps collecting them. Last test ${ago(new Date(fast.at).toISOString())}.`}>
          <Rows>
            {(['15m', '1m'] as const).map((tf) => {
              const fs = fast.feed.filter((x) => x.tf === tf);
              const err = fs.filter((x) => x.error).length;
              const sp = fast.spans[tf];
              return <Row key={tf} label={`${tf} chart`} value={err ? <span className="text-down">{err} failed</span> : `${fs.reduce((a, x) => a + x.bars, 0).toLocaleString()} bars`} sub={sp.from !== null ? `${day(sp.from)} → ${day(sp.to)} · unseen from ${day(sp.oosFrom)} · ${sp.markets} markets · ${fs[0]?.source ?? 'no source yet'}` : 'not enough candles yet'} />;
            })}
          </Rows>
        </Card>
      )}
      <Card title="Markets and costs" subtitle="Hourly candles from Yahoo Finance (free, about 2 years back; Dukascopy adds older years, see above). Spreads are typical retail costs shaped by the measured hour of day, charged on every trade. The extra crosses only feed the strength meter; the dollar index, yields, S&P futures, VIX and oil feed the market mood.">
        <Rows>
          {r.feed.map((f) => (
            <Row key={`${f.role ?? 'traded'}:${f.id}`} label={<>{f.id} {f.role === 'strength' ? <Badge tone="neutral">strength meter</Badge> : f.role === 'mood' ? <Badge tone="neutral">market mood</Badge> : null}</>} value={f.error ? <span className="text-down">failed</span> : `${f.bars.toLocaleString()} bars`} sub={f.error ? f.error : `${day(f.firstT)} → ${day(f.lastT)}`} />
          ))}
        </Rows>
      </Card>
      <Card title="Going live with your own money (no broker)" subtitle="On-chain perps: you trade from your own crypto wallet in USDC, nobody holds your money, you withdraw yourself. Not connected yet, on purpose.">
        <Rows>
          <Row label="gTrade (Gains Network)" sub="Arbitrum / Base / Polygon · USDC · forex 10–1000× · about 0.034% round trip + a borrowing fee · public TypeScript SDK · closed at weekends" value={<Badge tone="up">first choice</Badge>} />
          <Row label="Ostium (Arbitrum)" sub="USDC · forex 100–200× · 3–5 bps to open · Python SDK · July 2026: $23.8M drained via fake oracle prices; trading reopened" value={<Badge tone="warn">riskier</Badge>} />
          <Row label="Hyperliquid (HIP-3 markets)" sub="USDC · EUR/USD, GBP/USD, USD/JPY, gold from third-party deployers · ~0.07–0.09% taker" value={<Badge tone="neutral">possible</Badge>} />
        </Rows>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
          <li>Practice here first, and let the paper results run 2–4 weeks.</li>
          <li>Only strategies marked Edge that also win on paper are candidates for the bot.</li>
          <li>Then: a NEW wallet with a small amount of USDC, the bot connected to gTrade, smallest size, leverage capped.</li>
          <li>Check each venue's terms for your country first. No position held over the weekend (prices gap at the open).</li>
        </ol>
      </Card>
    </Stack>
  );
}
