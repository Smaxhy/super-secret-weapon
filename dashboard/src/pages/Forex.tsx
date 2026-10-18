/**
 * Forex lab (v12): every forex strategy on 10 currency pairs + gold + silver, tested on ~2 years of hourly candles
 * (in-sample / unseen split, real spreads) and paper traded live from the day the lab started. No real orders.
 */
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from '../components/Icon';
import { Badge, Button, Card, Chip, Drawer, Empty, ErrorBox, Loading, PageHeader, Row, Rows, Stack, StatTile, Tabs, useStored, useTab } from '../components/ui';

interface RStats { n: number; winPct: number; avgR: number; medianR: number; pf: number | null; totalR: number; maxDdR: number }
interface Risk { riskPct: number; finalX: number; avgWeekPct: number; medianWeekPct: number; greenWeeksPct: number; bigWeeksPct: number; bestWeekPct: number; worstWeekPct: number; maxDdPct: number; blown: boolean; medianLeverage: number; weeks: number }
interface RowT { id: string; name: string; family: string; desc: string; tf: '1h' | '4h'; all: RStats; inSample: RStats; outSample: RStats; tradesPerWeek: number; risk: Risk[]; pairs: Array<{ pair: string } & RStats>; verdict: 'edge' | 'maybe' | 'no'; why: string }
interface Trade { strategy: string; tf: string; pair: string; side: 1 | -1; entryT: number; exitT: number; entry: number; exit: number; r: number; reason: string }
interface PaperRow { id: string; name: string; tf: string; stats: RStats; risk1: Risk; open: number }
interface Report { at: number; durationMs: number; feed: Array<{ id: string; bars: number; firstT: number | null; lastT: number | null; error: string | null }>; from: number | null; to: number | null; oosFrom: number | null; rows: RowT[]; paper: { since: number; rows: PaperRow[]; open: Trade[]; recent: Trade[] }; note: string }
interface Data { running: boolean; last: Report | null }

const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
const VERDICT: Record<RowT['verdict'], { label: string; tone: 'up' | 'warn' | 'neutral' }> = { edge: { label: 'Edge', tone: 'up' }, maybe: { label: 'Maybe', tone: 'warn' }, no: { label: 'No edge', tone: 'neutral' } };
const SECTIONS = [
  { key: 'strategies', label: 'Strategies' },
  { key: 'paper', label: 'Paper' },
  { key: 'setup', label: 'Setup' },
] as const;
type Section = (typeof SECTIONS)[number]['key'];

export function Forex() {
  const { data, error, reload } = useApi<Data>('/api/forex', 60_000);
  const [section, setSection] = useTab<Section>('forex', SECTIONS.map((s) => s.key), 'strategies');
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
  const r = data?.last ?? null;
  return (
    <>
      <PageHeader
        title="Forex"
        subtitle="Currency pairs, gold and silver. Every strategy tested on 2 years of hourly candles with real spreads, then paper traded live. No real money yet."
        action={
          <Button size="sm" disabled={busy || running} onClick={() => void run()}>
            <Icon name="refresh" size={14} />
            {running ? 'Running…' : 'Update now'}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}
      {!data && !error && <Loading kind="tiles" />}
      {data && !r && <Empty icon={<Icon name="globe" size={20} />}>{running ? 'First run: downloading 2 years of candles for 12 markets. About a minute.' : 'Not run yet. It starts by itself a minute after the bot starts, or press Update now.'}</Empty>}
      {r && (
        <Stack>
          <Summary r={r} />
          <Tabs sticky tabs={SECTIONS.map((x) => ({ key: x.key, label: x.label }))} value={section} onChange={setSection} label="Forex sections" />
          {section === 'strategies' && <Strategies r={r} />}
          {section === 'paper' && <Paper r={r} />}
          {section === 'setup' && <Setup r={r} />}
        </Stack>
      )}
    </>
  );
}

function Summary({ r }: { r: Report }) {
  const edges = r.rows.filter((x) => x.verdict === 'edge').length;
  const maybes = r.rows.filter((x) => x.verdict === 'maybe').length;
  const pTrades = r.paper.rows.reduce((a, x) => a + x.stats.n, 0);
  const pR = r.paper.rows.reduce((a, x) => a + x.stats.totalR, 0);
  const feedErr = r.feed.filter((f) => f.error).length;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile compact label="Pass on unseen data" value={`${edges}`} sub={`${maybes} maybe · ${r.rows.length} tested`} tone={edges ? 'up' : undefined} />
      <StatTile compact label="History tested" value={`${day(r.from)} → ${day(r.to)}`} sub={`last 30% unseen from ${day(r.oosFrom)}`} />
      <StatTile compact label="Paper since" value={day(r.paper.since)} sub={`${pTrades} closed · ${r.paper.open.length} open · ${signed(pR, 1)}R`} tone={pR > 0 ? 'up' : pR < 0 ? 'down' : undefined} />
      <StatTile compact label="Data" value={`${r.feed.filter((f) => f.bars > 0).length}/${r.feed.length} markets`} sub={feedErr ? `${feedErr} failed to update` : `updated ${ago(new Date(r.at).toISOString())}`} tone={feedErr ? 'warn' : undefined} />
    </div>
  );
}

function Strategies({ r }: { r: Report }) {
  const [tf, setTf] = useStored<'all' | '1h' | '4h'>('fx.tf', 'all', ['all', '1h', '4h']);
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
        {(['all', '1h', '4h'] as const).map((k) => (
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
                    <Badge tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].label}</Badge>
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

function Setup({ r }: { r: Report }) {
  return (
    <Stack>
      <Card title="Markets and costs" subtitle="Hourly candles from Yahoo Finance (free, about 2 years back). Spreads are typical retail costs, charged on every trade.">
        <Rows>
          {r.feed.map((f) => (
            <Row key={f.id} label={f.id} value={f.error ? <span className="text-down">failed</span> : `${f.bars.toLocaleString()} bars`} sub={f.error ? f.error : `${day(f.firstT)} → ${day(f.lastT)}`} />
          ))}
        </Rows>
      </Card>
      <Card title="Going live" subtitle="Not connected yet, on purpose.">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
          <li>Let the paper results run for at least 2–4 weeks.</li>
          <li>Only strategies marked Edge that also make money on paper are candidates.</li>
          <li>Then connect an account (on-chain perps like Hyperliquid / Ostium, or a broker API) and start at the smallest size.</li>
        </ol>
      </Card>
    </Stack>
  );
}
