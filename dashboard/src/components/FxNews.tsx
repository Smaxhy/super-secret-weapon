/** Forex market clock (open / closed, sessions) + this week's news, central banks and bank holidays. */
import { useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { Badge, Card, Chip, useStored } from './ui';

interface Ev { t: number; ccy: string; title: string; impact: 'High' | 'Medium' | 'Low' | 'Holiday'; forecast: string; previous: string }
interface Clock { open: boolean; minutesToChange: number; noNewTrades: boolean; flattenNow: boolean; sessions: string[] }
interface Head { t: number; title: string; link: string; source: string; ccys: string[]; severity: 'high' | 'normal'; why: string | null }
interface Data { at: number; clock: Clock; events: Ev[]; headlines?: Head[] }

const dur = (m: number) => (m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function MarketClockBar() {
  const { data } = useApi<Data>('/api/forex/calendar', 60_000);
  const c = data?.clock;
  if (!c) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-2xl border px-4 py-3 text-sm ${c.open ? 'border-good/40 bg-good/5' : 'border-line bg-surface-2/50'}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${c.open ? 'bg-good' : 'bg-muted'}`} />
      <span className="font-semibold text-ink">{c.open ? 'Forex is open' : 'Forex is closed (weekend)'}</span>
      <span className="text-ink-2">· {c.open ? `closes in ${dur(c.minutesToChange)}` : `opens in ${dur(c.minutesToChange)}`}</span>
      {c.sessions.map((s) => (
        <Badge key={s} tone="accent">{s}</Badge>
      ))}
      {c.open && c.noNewTrades && <Badge tone="warn">bot: no new trades before the weekly close</Badge>}
    </div>
  );
}

export function FxNews() {
  const { data } = useApi<Data>('/api/forex/calendar', 5 * 60_000);
  const [lvl, setLvl] = useStored<'high' | 'med' | 'all'>('fx.news', 'high', ['high', 'med', 'all']);
  const [tab, setTab] = useStored<'cal' | 'heads'>('fx.newsTab', 'heads', ['cal', 'heads']);
  const heads = data?.headlines ?? [];
  const evs = useMemo(() => (data?.events ?? []).filter((e) => (lvl === 'all' ? true : lvl === 'med' ? e.impact !== 'Low' : e.impact === 'High' || e.impact === 'Holiday')), [data, lvl]);
  const now = Date.now();
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of evs) {
      const k = new Date(e.t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      (m.get(k) ?? m.set(k, []).get(k)!).push(e);
    }
    return [...m.entries()];
  }, [evs]);
  return (
    <Card title="News, speeches, central banks and holidays" subtitle="The auto-bot opens nothing on a pair 30 min either side of high-impact news or a speech for its currencies, for 30 min after a big live headline, on a bank holiday, or after a sudden price shock. Times in your clock.">
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Chip active={tab === 'heads'} onClick={() => setTab('heads')}>Live headlines</Chip>
        <Chip active={tab === 'cal'} onClick={() => setTab('cal')}>Calendar</Chip>
        <span className="mx-1 h-5 w-px self-center bg-line" />
        <Chip active={lvl === 'high'} onClick={() => setLvl('high')}>High impact + holidays</Chip>
        <Chip active={lvl === 'med'} onClick={() => setLvl('med')}>+ Medium</Chip>
        <Chip active={lvl === 'all'} onClick={() => setLvl('all')}>Everything</Chip>
      </div>
      {tab === 'heads' && (
        !heads.length ? <p className="text-sm text-ink-2">No headlines yet (checked every 5 minutes).</p> : (
          <ul className="flex max-h-[28rem] flex-col divide-y divide-line overflow-y-auto pr-1">
            {heads.filter((h) => lvl === 'all' || h.severity === 'high' || (lvl === 'med' && h.ccys.length)).slice(0, 60).map((h) => (
              <li key={h.link + h.t} className="flex items-start gap-3 py-2">
                <span className="tabular w-12 shrink-0 pt-0.5 text-xs text-muted">{new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <a href={h.link} target="_blank" rel="noreferrer" className="min-w-0 flex-1 text-sm text-ink hover:underline">{h.title}</a>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {h.severity === 'high' && <Badge tone="down">big</Badge>}
                  {h.ccys.map((c) => <Badge key={c} tone="neutral">{c}</Badge>)}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
      {tab === 'cal' && (!data ? <p className="text-sm text-muted">Loading…</p> : !evs.length ? <p className="text-sm text-ink-2">Nothing on the calendar yet (it refreshes hourly).</p> : (
        <div className="flex max-h-[28rem] flex-col gap-4 overflow-y-auto pr-1">
          {byDay.map(([day, list]) => (
            <div key={day}>
              <div className="mb-1 text-xs font-semibold text-muted">{day}</div>
              <ul className="divide-y divide-line">
                {list.map((e) => (
                  <li key={`${e.t}${e.ccy}${e.title}`} className={`flex items-center gap-3 py-2 ${e.t < now ? 'opacity-55' : ''}`}>
                    <span className="tabular w-12 shrink-0 text-xs text-muted">{new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <Badge tone={e.impact === 'High' ? 'down' : e.impact === 'Holiday' ? 'accent' : e.impact === 'Medium' ? 'warn' : 'neutral'}>{e.ccy}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.title}</span>
                    {(e.forecast || e.previous) && <span className="hidden shrink-0 text-xs text-muted sm:inline">{e.forecast ? `fc ${e.forecast}` : ''}{e.previous ? ` · prev ${e.previous}` : ''}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
