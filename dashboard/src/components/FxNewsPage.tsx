/**
 * v21 the News desk (/forex/news): the next market-moving event counting down, what the bot does about it, the live
 * headline feed (filter by currency, "big" only), and this week's calendar as a timeline in your own clock.
 * Display only; the bot's news rules live in calendar.ts / headlines.ts and are described in plain words here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, Chip, Stack, useStored } from './ui';
import { Icon } from './Icon';
import { CcyTag, agoWords, inWords, nextBig, useNews, type NewsEv, type NewsHead } from './NewsTape';
import { WorldCard } from './FxWorld';

const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'XAU', 'NDX', 'SPX'] as const;
type Ccy = (typeof CCYS)[number] | 'all';
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

/** which currencies the bot holds back on right now, and why (mirrors calendar.ts newsBlock + headlines.ts headlineBlock) */
export function pausedNow(events: NewsEv[], heads: NewsHead[], now: number): Array<{ ccy: string; why: string; until: number }> {
  const out = new Map<string, { ccy: string; why: string; until: number }>();
  for (const e of events) {
    if (e.impact === 'Holiday') {
      const d = new Date(e.t);
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      if (now >= e.t - 12 * 3_600_000 && now < end) out.set(e.ccy, { ccy: e.ccy, why: `bank holiday: ${e.title}`, until: end });
      continue;
    }
    const speech = /speak|testif|press conference|remarks/i.test(e.title);
    if (e.impact !== 'High' && !(e.impact === 'Medium' && speech)) continue;
    if (Math.abs(e.t - now) <= 30 * 60_000) {
      const prev = out.get(e.ccy);
      const until = e.t + 30 * 60_000;
      if (!prev || prev.until < until) out.set(e.ccy, { ccy: e.ccy, why: `${e.title} at ${time(e.t)}`, until });
    }
  }
  for (const h of heads) {
    if (h.severity !== 'high' || now - h.t > 30 * 60_000) continue;
    for (const c of h.ccys) {
      const until = h.t + 30 * 60_000;
      const prev = out.get(c);
      if (!prev || prev.until < until) out.set(c, { ccy: c, why: `headline: ${h.title.slice(0, 70)}`, until });
    }
  }
  return [...out.values()].sort((a, b) => a.until - b.until);
}

export function FxNewsPage() {
  const { data, error } = useNews();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const [ccy, setCcy] = useStored<Ccy>('fx.news.ccy', 'all', ['all', ...CCYS]);
  const [bigOnly, setBigOnly] = useStored<'big' | 'all'>('fx.news.big', 'all', ['big', 'all']);
  const [impact, setImpact] = useStored<'high' | 'med' | 'all'>('fx.news.impact', 'high', ['high', 'med', 'all']);
  const heads = useMemo(() => (data?.headlines ?? []).slice().sort((a, b) => b.t - a.t), [data]);
  const events = data?.events ?? [];
  const big = nextBig(events, now);
  const paused = useMemo(() => pausedNow(events, heads, now), [events, heads, now]);
  const shown = heads.filter((h) => (ccy === 'all' || h.ccys.includes(ccy)) && (bigOnly === 'all' || h.severity === 'high'));
  const groups: Array<[string, NewsHead[]]> = [];
  for (const h of shown) {
    const age = now - h.t;
    const g = age < 3_600_000 ? 'Last hour' : age < 86_400_000 && new Date(h.t).getDate() === new Date(now).getDate() ? 'Earlier today' : age < 2 * 86_400_000 ? 'Yesterday' : 'Older';
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(h);
    else groups.push([g, [h]]);
  }
  const evs = events.filter((e) => e.t > now - 2 * 3_600_000 && (impact === 'all' ? true : impact === 'med' ? e.impact !== 'Low' : e.impact === 'High' || e.impact === 'Holiday')).sort((a, b) => a.t - b.t);
  const byDay: Array<[string, NewsEv[]]> = [];
  for (const e of evs) {
    const k = dayOf(e.t);
    const last = byDay[byDay.length - 1];
    if (last && last[0] === k) last[1].push(e);
    else byDay.push([k, [e]]);
  }
  const counts = Object.fromEntries(CCYS.map((c) => [c, heads.filter((h) => h.ccys.includes(c) && now - h.t < 86_400_000).length]));

  return (
    <Stack>
      {error && <p className="rounded-lg bg-critical/10 px-3 py-2 text-sm text-down">Couldn't load the news: {error}</p>}
      {/* the hero: what is coming, counting down */}
      <div className="card hero-glow card-accent p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-muted">Next big one</div>
            {big ? (
              <>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
                  <CcyTag ccy={big.ccy} className="h-7 px-2 text-sm" />
                  <span className="min-w-0">{big.title}</span>
                </div>
                <p className="mt-1 text-sm text-ink-2">
                  {time(big.t)} your time · {big.impact === 'Holiday' ? 'bank holiday: no trades on its pairs all day' : `no new trades on ${big.ccy} pairs from ${time(big.t - 30 * 60_000)} to ${time(big.t + 30 * 60_000)}`}
                  {big.forecast || big.previous ? ` · ${big.forecast ? `forecast ${big.forecast}` : ''}${big.forecast && big.previous ? ', ' : ''}${big.previous ? `last ${big.previous}` : ''}` : ''}
                </p>
              </>
            ) : (
              <p className="mt-0.5 text-lg font-semibold text-ink">Nothing big on the calendar{events.length ? ' this week' : ' yet'}.</p>
            )}
          </div>
          {big && (
            <div className={`shrink-0 rounded-2xl px-5 py-3 text-center ${big.t - now < 45 * 60_000 ? 'bg-critical/10' : 'bg-surface-2'}`} aria-live="polite">
              <div className={`tabular text-3xl font-semibold tracking-tight ${big.t - now < 45 * 60_000 ? 'text-down' : 'text-ink'}`}>{inWords(big.t - now).replace(/^in /, '')}</div>
              <div className="text-xs text-muted">until it lands</div>
            </div>
          )}
        </div>
        <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted"><Icon name="pause" size={13} /> The bot right now</div>
          {paused.length ? (
            <ul className="flex flex-wrap gap-2">
              {paused.map((p) => (
                <li key={p.ccy} className="inline-flex min-h-9 items-center gap-2 rounded-full bg-surface px-3 text-sm text-ink-2">
                  <CcyTag ccy={p.ccy} /> paused · {p.why} · until {time(p.until)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-2">No currency is paused for news. It opens nothing 30 minutes either side of a big release or a central-bank speech, for 30 minutes after a big headline, and all day on a bank holiday.</p>
          )}
          {data?.clock?.noNewTrades && <p className="mt-2 text-sm text-down">The trading week is closing: no new trades until Sunday evening.</p>}
        </div>
      </div>

      <WorldCard world={data?.world} now={now} />

      {/* the live feed */}
      <Card title="Live headlines" subtitle="ForexLive, FXStreet, DailyFX, Investing.com and the Fed / ECB / Bank of England press releases, read every 5 minutes. A red dot = the bot treats it as big (central banks, leaders, tariffs, surprises) and holds back on its currencies for half an hour.">
        <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter headlines">
          <Chip active={ccy === 'all'} onClick={() => setCcy('all')}>All</Chip>
          {CCYS.map((c) => <Chip key={c} active={ccy === c} onClick={() => setCcy(c)} count={counts[c] || null}>{c}</Chip>)}
          <span className="mx-1 h-6 w-px shrink-0 self-center bg-line" />
          <Chip active={bigOnly === 'big'} onClick={() => setBigOnly(bigOnly === 'big' ? 'all' : 'big')}>Big only</Chip>
        </div>
        {!heads.length ? (
          <p className="text-sm text-ink-2">No headlines yet. They appear a few minutes after the bot starts.</p>
        ) : !shown.length ? (
          <p className="text-sm text-ink-2">Nothing matches. Try another currency or switch "Big only" off.</p>
        ) : (
          <div className="space-y-4">
            {groups.map(([g, list]) => (
              <section key={g} aria-label={g}>
                <h3 className="mb-1 text-xs font-semibold text-muted">{g}</h3>
                <ul className="divide-y divide-line">
                  {list.slice(0, 40).map((h) => (
                    <li key={h.link + h.t}>
                      <a href={h.link} target="_blank" rel="noreferrer" className="flex min-h-12 items-start gap-3 py-2.5 hover:bg-surface-2/60 focus-visible:bg-surface-2/60 -mx-2 rounded-lg px-2">
                        <span className="mt-1.5 flex w-3 shrink-0 justify-center">{h.severity === 'high' ? <span className="h-2.5 w-2.5 rounded-full bg-critical" aria-label="big" /> : <span className="h-1.5 w-1.5 rounded-full bg-muted/50" aria-hidden="true" />}</span>
                        <span className="min-w-0 flex-1">
                          <span className={`block text-sm leading-snug ${h.severity === 'high' ? 'font-semibold text-ink' : 'text-ink'}`}>{h.title}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            <span>{agoWords(h.t, now)}</span>
                            <span>· {h.source}</span>
                            {h.ccys.map((c) => <CcyTag key={c} ccy={c} />)}
                            {h.why && <span className="text-down">· {h.why}</span>}
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {/* the calendar as a timeline */}
      <Card title="This week" subtitle="Central banks, data releases and holidays in your own clock. Dimmed = already out.">
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Chip active={impact === 'high'} onClick={() => setImpact('high')}>Big + holidays</Chip>
          <Chip active={impact === 'med'} onClick={() => setImpact('med')}>+ medium</Chip>
          <Chip active={impact === 'all'} onClick={() => setImpact('all')}>Everything</Chip>
        </div>
        {!data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !evs.length ? (
          <p className="text-sm text-ink-2">Nothing on the calendar at this level. It refreshes every hour.</p>
        ) : (
          <div className="space-y-4">
            {byDay.map(([day, list]) => (
              <section key={day} aria-label={day}>
                <h3 className="mb-1 text-xs font-semibold text-muted">{day}</h3>
                <ol className="relative ml-2 border-l border-line pl-4">
                  {list.map((e) => {
                    const past = e.t < now;
                    const soon = !past && e.t - now < 60 * 60_000;
                    return (
                      <li key={`${e.t}${e.ccy}${e.title}`} className={`relative py-2 ${past ? 'opacity-55' : ''}`}>
                        <span className={`absolute -left-[21px] top-3.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${e.impact === 'High' ? 'bg-critical' : e.impact === 'Holiday' ? 'bg-accent' : e.impact === 'Medium' ? 'bg-warning' : 'bg-muted/60'}`} aria-hidden="true" />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="tabular w-12 text-sm font-semibold text-ink">{time(e.t)}</span>
                          <CcyTag ccy={e.ccy} />
                          <span className="min-w-0 flex-1 text-sm text-ink">{e.title}</span>
                          {soon && <Badge tone="down">{inWords(e.t - now)}</Badge>}
                          {e.impact === 'Holiday' && <Badge tone="accent">holiday</Badge>}
                        </div>
                        {(e.forecast || e.previous) && <div className="ml-[3.75rem] text-xs text-muted">{e.forecast ? `forecast ${e.forecast}` : ''}{e.forecast && e.previous ? ' · ' : ''}{e.previous ? `last ${e.previous}` : ''}</div>}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Card>
    </Stack>
  );
}
