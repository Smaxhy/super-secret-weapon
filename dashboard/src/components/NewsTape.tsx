/**
 * v21 live news tape: the newest headlines roll across the top of the Forex home (and the News page) like a wire
 * ticker, with the next market-moving event counting down at the front. Headlines come from the bot's own feed
 * (ForexLive + FXStreet, read every 5 minutes) through /api/forex/calendar, re-read here every minute. The tape pauses
 * when you point at it or tab into it; under prefers-reduced-motion it is a plain horizontal list you scroll yourself.
 * Screen readers get a short static list instead of the moving one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { Icon } from './Icon';
import { wsBase } from '../lib/ws';

export interface NewsEv { t: number; ccy: string; title: string; impact: 'High' | 'Medium' | 'Low' | 'Holiday'; forecast?: string; previous?: string }
export interface NewsClock { open: boolean; minutesToChange: number; noNewTrades: boolean; flattenNow: boolean; sessions: string[] }
export interface NewsHead { t: number; title: string; link: string; source: string; ccys: string[]; severity: 'high' | 'normal'; why?: string | null }
export interface NewsData { at: number; clock?: NewsClock; events: NewsEv[]; headlines?: NewsHead[]; world?: import('./FxWorld').WorldView | null }

/** the calendar + headlines, re-read every minute */
export function useNews(refreshMs = 60_000) {
  return useApi<NewsData>('/api/forex/calendar', refreshMs);
}

/** the next event that moves markets (High impact or a bank holiday), or null */
export function nextBig(events: NewsEv[] | undefined, now: number): NewsEv | null {
  return (events ?? []).filter((e) => e.t > now && (e.impact === 'High' || e.impact === 'Holiday')).sort((a, b) => a.t - b.t)[0] ?? null;
}

/** "in 2 h 05 m" / "in 12 m" / "now" */
export function inWords(ms: number): string {
  if (ms <= 60_000) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `in ${h} h ${String(r).padStart(2, '0')} min` : `in ${h} h`;
  return `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

export const agoWords = (t: number, now: number): string => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};

/** v21: a currency as a small coloured tag (one colour per currency, so a glance tells USD news from JPY news) */
const CCY_TONE: Record<string, string> = {
  USD: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  EUR: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  GBP: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  JPY: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  AUD: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  NZD: 'bg-lime-500/15 text-lime-700 dark:text-lime-300',
  CAD: 'bg-red-500/15 text-red-700 dark:text-red-300',
  CHF: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  XAU: 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-300',
  XAG: 'bg-zinc-400/20 text-zinc-700 dark:text-zinc-300',
  NDX: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  SPX: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  DJI: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  RUT: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
};
export function CcyTag({ ccy, className = '' }: { ccy: string; className?: string }) {
  return <span className={`inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-semibold leading-none ${CCY_TONE[ccy] ?? 'bg-surface-3 text-ink-2'} ${className}`}>{ccy}</span>;
}

/** headlines newer than the last time this device looked at the tape get a short glow */
function useSeen(key = 'fx.news.seenAt'): [number, () => void] {
  const [seen] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(key) ?? 0) || 0;
    } catch {
      return 0;
    }
  });
  const mark = () => {
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {
      /* ignore */
    }
  };
  return [seen, mark];
}

export function NewsTape({ compact = false }: { compact?: boolean }) {
  const { data } = useNews();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const [seen, markSeen] = useSeen();
  useEffect(() => {
    const t = setTimeout(markSeen, 20_000);
    return () => clearTimeout(t);
  }, [markSeen]);
  const heads = useMemo(() => (data?.headlines ?? []).slice().sort((a, b) => b.t - a.t).slice(0, compact ? 8 : 14), [data, compact]);
  const big = nextBig(data?.events, now);
  const ref = useRef<HTMLDivElement>(null);
  if (!data) return null;
  const items = heads.map((h, i) => (
    <a key={`${h.link}${h.t}`} href={h.link} target="_blank" rel="noreferrer" className={`tape-item inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 ${h.t > seen ? 'tape-new' : ''}`} title={`${h.source} · ${new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}>
      {h.severity === 'high' ? <span className="h-2 w-2 shrink-0 rounded-full bg-critical" aria-label="big" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted/60" aria-hidden="true" />}
      <span className="text-muted">{agoWords(h.t, now)}</span>
      <span className={`max-w-[60vw] truncate ${h.severity === 'high' ? 'font-semibold text-ink' : 'text-ink-2'}`}>{h.title}</span>
      {h.ccys.slice(0, 2).map((c) => <CcyTag key={`${i}${c}`} ccy={c} />)}
    </a>
  ));
  return (
    <div className="tape relative flex items-stretch overflow-hidden rounded-xl border border-line bg-surface" role="region" aria-label="Live news">
      {/* the front chip: what is coming next, counting down */}
      <Link to={`${wsBase()}/news`} className={`z-10 flex shrink-0 items-center gap-2 border-r border-line bg-surface-2 px-3 text-sm font-semibold ${big && big.t - now < 45 * 60_000 ? 'border-l-4 border-l-critical text-down' : 'text-ink'}`} title={big ? `${big.ccy} ${big.title}` : 'Open the news desk'}>
        <Icon name="bell" size={15} />
        {big ? (
          <span className="whitespace-nowrap">
            <span className="hidden sm:inline">{big.impact === 'Holiday' ? 'Holiday' : 'Next big one'} </span>
            <CcyTag ccy={big.ccy} className="mx-0.5" /> {inWords(big.t - now)}
          </span>
        ) : (
          <span className="whitespace-nowrap">News</span>
        )}
      </Link>
      {/* the moving part (hidden from screen readers; the static list below carries the same items) */}
      <div ref={ref} className="tape-track no-scrollbar relative flex min-w-0 flex-1 items-center overflow-hidden" aria-hidden="true">
        {heads.length ? (
          <div className="tape-roll flex items-center gap-1 pl-2" style={{ animationDuration: `${Math.max(30, heads.length * 7)}s` }}>
            {items}
            {items.map((el, i) => <span key={`dup${i}`} className="contents">{el}</span>)}
          </div>
        ) : (
          <span className="px-3 text-sm text-muted">No headlines yet. The bot reads ForexLive and FXStreet every 5 minutes.</span>
        )}
      </div>
      <ul className="sr-only">
        {heads.slice(0, 6).map((h) => (
          <li key={`sr${h.t}`}>{agoWords(h.t, now)}: {h.title}{h.ccys.length ? ` (${h.ccys.join(', ')})` : ''}</li>
        ))}
      </ul>
    </div>
  );
}
