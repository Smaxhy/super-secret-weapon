/**
 * v19 Control room (owner: "the AI in the middle like a mastermind, a big screen, everything around it like a web,
 * other rooms where I can see what it's looking at, what it's doing, what it puts to work, with charts, diagnosed for
 * me, animated"). One page, live: the bot is the hub, eight rooms around it, each run by one of its desks (scout,
 * analyst, trader, risk desk, historian, news desk, decisions, crypto room). Display only — every number here is
 * already produced by the bot (/api/forex/bot, /api/forex, /api/forex/calendar, /api/forex/trades/read, /api/system,
 * /api/overview); nothing on this page places or changes a trade except the risk-mode buttons, which the Auto-bot page
 * already had.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useWidth } from '../hooks/useWidth';
import { liveOf, livePnl, useFxLive, type FxLive } from '../hooks/useFxLive';
import type { Overview } from '../lib/types';
import { fitBars, MarketChart, type ChartDrawings, type ChartTrade } from './MarketChart';
import { Icon, type IconName } from './Icon';
import { Badge, Button } from './ui';
import { ReadTrack, useTradeReads } from './FxTradeRead';
import { FxPnl, type PnlData } from './FxPnl';
import { useTab } from './ui';
import type { SystemData } from './SystemHealth';
import type { JudgeReport, RiskSummary, RollReport, SniperReport } from './FxInsights';

// ── the bot's own data (the same shapes the Auto-bot page reads) ──
interface Pos { id: string; pair: string; side: 1 | -1; entry: number; px: number; pnlPerPx?: number; marginUsd: number; leverage: number; stop: number | null; target: number | null; openedAt: number; pnlUsd: number; pnlPct: number; strategy?: string; riskPct?: number; tf?: string; locked?: boolean }
interface Closed { id: string; pair: string; side: 1 | -1; pnlUsd: number; reason: string; closedAt: number; strategy?: string; tf?: string }
interface Order { id: string; pair: string; side: 1 | -1; limit: number; kind: 'limit' | 'pullback'; expiresAt: number; strategy: string; tf?: string }
interface Acct { startUsd: number; balanceUsd: number; equityUsd: number; marginUsedUsd: number; freeMarginUsd: number; positions: Pos[]; closed: Closed[]; orders?: Order[] }
interface PlanSignal { tf: string; name: string; side: 1 | -1; verdict: string; tone: 'go' | 'wait' | 'no' }
interface PlanMarket { id: string; label: string; price: number | null; status: 'trading' | 'waiting' | 'blocked' | 'watching'; headline: string; lean: { side: 1 | -1 | 0; why: string }; signals: PlanSignal[]; blocks: string[] }
interface PlanLine { k: string; text: string; done?: boolean }
interface PlanTrade { id: string; pair: string; side: 1 | -1; strategy: string; name: string; tf: string; pnlUsd: number; lines: PlanLine[] }
interface RunNote { t: number; tf: string; signals: number; chosen: number; opened: number; skipped: number; waits: number; holding: number; note: string }
interface BotPlan { at: number; summary: string; next: Array<{ tf: string; at: number }>; markets: PlanMarket[]; trades: PlanTrade[]; timeline: RunNote[] }
type RiskMode = 'normal' | 'aggressive' | 'max';
interface RiskLimits { label: string; riskPct: number; leverage: number; maxOpen: number }
export interface WhyReport { at: number; orders?: { placed: number; filled: number; expired: number; cancelled: number }; hoursSinceOpen: number | null; openNow: number; ordersNow: number; marketOpen: boolean; window: { hours: number; checks: number; signals: number; chosen: number; opened: number; skipped: number; waits: number; lastCheckAt: number | null }; reasons: Array<{ kind: string; label: string; n: number; example: string }>; staleMarkets: string[]; verdict: string; hint: string | null; quiet: boolean }
export interface DeskArm { key: string; strategy: string; tf: string; prior: { n: number; totalR: number; pf: number | null }; own: { n: number; totalR: number }; mean: number; score: number; chosen: boolean }
export interface MarketDesk { id: string; arms: DeskArm[]; tradesToday: number; quota: number; lastTradeAt: number | null; pick: { key: string; why: string } | null; status: 'traded' | 'picked' | 'waiting' | 'idle'; says: string }
interface BotData { desks?: { at: number; desks: MarketDesk[] } | null; why?: WhyReport | null; labError?: { t: number; msg: string } | null; planError?: string | null; rolling?: RollReport | null; chooser?: string; names?: Record<string, string>; sniper?: SniperReport | null; riskMode?: RiskMode; riskModes?: Record<RiskMode, RiskLimits>; plan?: BotPlan | null; account: Acct | null; risk?: RiskSummary | null; judge?: JudgeReport | null; log: Array<{ t: number; e: string }>; chosen: string[]; dropped?: string[] }

// ── the hourly lab's market read ──
interface MarketNow { id: string; label: string; price: number; t: number; change24hPct: number; closes: number[]; trend: 'up' | 'down' | 'flat'; rsi: number; atrPips: number; firing: Array<{ id: string; name: string; tf: string; side: 1 | -1; allowed?: boolean; why?: string | null }>; bars: number[][]; drawings: ChartDrawings; mtf?: { h1: number; h4: number; d1: number }; strength?: { base: string; quote: string; gap: number | null } }
interface LabRow { id: string; name: string; tf: string; verdict: 'edge' | 'maybe' | 'no' }
interface LabData { running: boolean; last: { at: number; rows: LabRow[]; markets?: MarketNow[]; mood?: { score: number; label: string } | null } | null }

// ── news desk ──
interface Ev { t: number; ccy: string; title: string; impact: 'High' | 'Medium' | 'Low' | 'Holiday' }
interface Clock { open: boolean; minutesToChange: number; noNewTrades: boolean; flattenNow: boolean; sessions: string[] }
interface Head { t: number; title: string; link: string; source: string; ccys: string[]; severity: 'high' | 'normal' }
interface CalData { at: number; clock: Clock; events: Ev[]; headlines?: Head[] }

const dp = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
const usd = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pretty = (id: string) => (id.length === 6 ? `${id.slice(0, 3)}/${id.slice(3)}` : id);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const agoShort = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
/** the next hourly / 4-hour close + 90 s on the UTC grid (when the server's plan is missing) */
function localNext(now: number): { tf: string; at: number } {
  const H = 3_600_000;
  const grid = (period: number) => Math.floor((now - 90_000) / period) * period + period + 90_000;
  const h1 = grid(H);
  const h4 = grid(4 * H);
  return h4 <= h1 ? { tf: '4h', at: h4 } : { tf: '1h', at: h1 };
}

export type RoomKey = 'scout' | 'analyst' | 'trader' | 'risk' | 'historian' | 'news' | 'decisions' | 'crypto' | 'pnl' | 'desks';
export const ROOMS: Record<RoomKey, { name: string; role: string; icon: IconName }> = {
  scout: { name: 'Scout', role: 'scans every market', icon: 'radar' },
  analyst: { name: 'Analyst', role: 'reads the chart it is on', icon: 'eye' },
  trader: { name: 'Trader', role: 'runs the open trades', icon: 'bolt' },
  risk: { name: 'Risk desk', role: 'sizes and caps every bet', icon: 'sliders' },
  historian: { name: 'Historian', role: 'grades every strategy', icon: 'flask' },
  news: { name: 'News desk', role: 'watches the calendar and headlines', icon: 'bell' },
  decisions: { name: 'Decisions', role: 'everything it just did', icon: 'cpu' },
  crypto: { name: 'Crypto room', role: 'the pump.fun data collector', icon: 'wallet' },
  pnl: { name: 'P&L', role: 'profit by day, week and month', icon: 'chart' },
  desks: { name: 'Market desks', role: 'one desk per market: ranks its strategies on that market from the lab and the bot\'s own fills', icon: 'globe' },
};

/** everything the control room (and the village) reads, in one place */
export interface CRData {
  bot: ReturnType<typeof useApi<BotData>>;
  lab: ReturnType<typeof useApi<LabData>>;
  cal: ReturnType<typeof useApi<CalData>>;
  sys: ReturnType<typeof useApi<SystemData>>;
  ov: ReturnType<typeof useApi<Overview>>;
  pnl: ReturnType<typeof useApi<PnlData>>;
  fx: FxLive;
  now: number;
  d: BotData | null;
  a: Acct | null;
  plan: BotPlan | null;
  positions: Pos[];
  orders: Order[];
  markets: MarketNow[];
  reads: Array<{ id: string; pair: string; read: import('./FxTradeRead').TradeReadT; ai: import('./FxTradeRead').AiReadT | null }>;
  names: Record<string, string>;
  focus: string | null;
  setPicked: (id: string | null) => void;
  fm: MarketNow | null;
  fp: PlanMarket | null;
  fpos: Pos[];
  open: boolean;
  next: { tf: string; at: number };
  livePnlAll: number;
  state: { word: string; tone: string };
  lastRun: RunNote | null;
  closest: Array<{ m: PlanMarket; s: PlanSignal }>;
}

export function useControlRoomData(): CRData {
  const bot = useApi<BotData>('/api/forex/bot', 5_000);
  const lab = useApi<LabData>('/api/forex', 60_000);
  const cal = useApi<CalData>('/api/forex/calendar', 60_000);
  const sys = useApi<SystemData>('/api/system', 15_000);
  const ov = useApi<Overview>('/api/overview', 30_000, ['trade']);
  const pnl = useApi<PnlData>(`/api/forex/pnl?acct=bot&tz=${new Date().getTimezoneOffset()}`, 30_000);
  const fx = useFxLive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const d = bot.data;
  const a = d?.account ?? null;
  const plan = d?.plan ?? null;
  const positions = a?.positions ?? [];
  const orders = a?.orders ?? [];
  const markets = lab.data?.last?.markets ?? [];
  const reads = useTradeReads('bot', positions.length > 0);
  const names = d?.names ?? {};

  // the market on the big screen: the owner's pick, else the first open trade, else the closest setup, else the first market
  const [picked, setPicked] = useState<string | null>(null);
  const closest = useMemo(() => (plan?.markets ?? []).flatMap((m) => m.signals.filter((s) => s.tone === 'wait').map((s) => ({ m, s }))), [plan]);
  const focus = picked ?? positions[0]?.pair ?? closest[0]?.m.id ?? markets[0]?.id ?? null;
  const fm = markets.find((m) => m.id === focus) ?? null;
  const fp = plan?.markets.find((m) => m.id === focus) ?? null;
  const fpos = positions.filter((p) => p.pair === focus);

  // the hub's state
  const open = cal.data?.clock?.open ?? true;
  const next = (plan?.next ?? []).filter((x) => x.at > now).sort((x, y) => x.at - y.at)[0] ?? localNext(now);
  const livePnlAll = positions.reduce((s, p) => s + livePnl(p, fx, now), 0);
  const state = !open ? { word: 'Market closed', tone: 'text-muted' } : positions.length ? { word: `In ${positions.length} trade${positions.length === 1 ? '' : 's'}`, tone: tone(livePnlAll) } : closest.length ? { word: 'Waiting on setups', tone: 'text-warning' } : { word: 'Scanning', tone: 'text-accent-text' };
  const lastRun = (plan?.timeline ?? []).slice().sort((x, y) => y.t - x.t)[0] ?? null;
  return { bot, lab, cal, sys, ov, pnl, fx, now, d, a, plan, positions, orders, markets, reads: reads.data?.trades ?? [], names, focus, setPicked, fm, fp, fpos, open, next, livePnlAll, state, lastRun, closest };
}

/** one room's "says" line + body, from the shared data (used by the control room grid and the village panels) */
export function roomView(k: RoomKey, x: CRData): { says: string; body: ReactNode } {
  const { d, a, plan, positions, orders, markets, fx, now, reads, names, focus, setPicked, fm, fp, livePnlAll } = x;
  switch (k) {
    case 'scout':
      return { says: scoutSays(plan, markets), body: <Scout markets={markets} plan={plan} fx={fx} now={now} focus={focus} onPick={setPicked} /> };
    case 'analyst':
      return { says: analystSays(fm, fp, names), body: <Analyst fm={fm} fp={fp} d={d} /> };
    case 'trader':
      return { says: traderSays(positions, orders, livePnlAll), body: <Trader positions={positions} orders={orders} fx={fx} now={now} reads={reads} onPick={setPicked} plan={plan} /> };
    case 'risk':
      return { says: riskSays(a, d?.risk ?? null, d?.riskMode ?? 'normal'), body: <RiskDesk a={a} risk={d?.risk ?? null} mode={d?.riskMode ?? 'normal'} modes={d?.riskModes} onMode={() => void x.bot.reload()} /> };
    case 'decisions':
      return { says: d?.log?.[0] ? `${agoShort(d.log[0].t, now)} ago: ${d.log[0].e}` : 'nothing logged yet', body: <Decisions log={d?.log ?? []} now={now} /> };
    case 'historian':
      return { says: historianSays(d, x.lab.data?.last?.rows ?? []), body: <Historian d={d} rows={x.lab.data?.last?.rows ?? []} names={names} /> };
    case 'news':
      return { says: newsSays(x.cal.data, now), body: <NewsDesk c={x.cal.data ?? null} now={now} /> };
    case 'crypto':
      return { says: cryptoSays(x.sys.data ?? null, x.ov.data ?? null), body: <CryptoRoom s={x.sys.data ?? null} o={x.ov.data ?? null} /> };
    case 'pnl':
      return { says: pnlSays(x.pnl.data ?? null), body: <FxPnl acct="bot" fallback={<p className="text-xs text-muted">No P&L report yet.</p>} /> };
    case 'desks':
      return { says: desksSays(d?.desks?.desks ?? []), body: <Desks desks={d?.desks?.desks ?? []} names={names} focus={focus} onPick={setPicked} now={now} /> };
  }
}

/** the hub card (the bot + its big screen) from the shared data */
export function HubView({ x }: { x: CRData }) {
  return <Hub d={x.d} state={x.state} next={x.next} now={x.now} lastRun={x.lastRun} open={x.open} error={x.bot.error} fm={x.fm} fp={x.fp} fpos={x.fpos} fx={x.fx} reads={x.reads} names={x.names} markets={x.markets} onPick={x.setPicked} picked={x.focus} pnl={x.pnl.data ?? null} />;
}

export function ControlRoom() {
  const x = useControlRoomData();
  const { positions, markets, closest } = x;

  // the web: lines from the hub to every room (desktop only)
  const [wrapRef, wrapW] = useWidth<HTMLDivElement>();
  const hubRef = useRef<HTMLDivElement>(null);
  const roomRefs = useRef<Partial<Record<RoomKey, HTMLDivElement | null>>>({});
  const [lines, setLines] = useState<Array<{ k: RoomKey; x1: number; y1: number; x2: number; y2: number }>>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const hub = hubRef.current;
    if (!wrap || !hub || wrapW < 1024) {
      setLines([]);
      return;
    }
    const measure = () => {
      const W = wrap.getBoundingClientRect();
      const H = hub.getBoundingClientRect();
      const cx = H.left - W.left + H.width / 2;
      const cy = H.top - W.top + H.height / 2;
      const out: typeof lines = [];
      for (const k of Object.keys(ROOMS) as RoomKey[]) {
        const el = roomRefs.current[k];
        if (!el) continue;
        const R = el.getBoundingClientRect();
        const rx = R.left - W.left + R.width / 2;
        const ry = R.top - W.top + R.height / 2;
        // aim at the room's nearest edge, not its centre, so the line stops at the card
        const ex = rx < cx ? R.right - W.left : rx > cx + R.width / 2 ? R.left - W.left : rx;
        const ey = Math.abs(rx - cx) > R.width / 2 ? Math.min(Math.max(cy, R.top - W.top + 24), R.bottom - W.top - 24) : ry < cy ? R.bottom - W.top : R.top - W.top;
        out.push({ k, x1: cx, y1: cy, x2: ex, y2: ey });
      }
      setLines(out);
      setBox({ w: W.width, h: W.height });
    };
    measure();
    const t = setInterval(measure, 2_000);
    return () => clearInterval(t);
  }, [wrapW, wrapRef, positions.length, markets.length, closest.length]);

  const bind = (k: RoomKey) => (el: HTMLDivElement | null) => {
    roomRefs.current[k] = el;
  };
  const place: Record<RoomKey, string> = {
    scout: 'lg:col-span-3 lg:col-start-1 lg:row-start-1',
    analyst: 'lg:col-span-3 lg:col-start-10 lg:row-start-1',
    trader: 'lg:col-span-3 lg:col-start-1 lg:row-start-2',
    risk: 'lg:col-span-3 lg:col-start-10 lg:row-start-2',
    decisions: 'lg:col-span-3 lg:col-start-1 lg:row-start-3',
    historian: 'lg:col-span-3 lg:col-start-4 lg:row-start-3',
    news: 'lg:col-span-3 lg:col-start-7 lg:row-start-3',
    crypto: 'lg:col-span-3 lg:col-start-10 lg:row-start-3',
    pnl: 'lg:col-span-6 lg:col-start-7 lg:row-start-4',
    desks: 'lg:col-span-6 lg:col-start-1 lg:row-start-4',
  };
  const keys = Object.keys(ROOMS) as RoomKey[];
  const [roomTab, setRoomTab] = useTab<RoomKey>('cr.room', keys, 'pnl');
  const phone = wrapW > 0 && wrapW < 1024;

  return (
    <div ref={wrapRef} className="relative">
      {lines.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 z-0" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
          {lines.map((l) => (
            <g key={l.k}>
              <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="cr-web" />
              <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="cr-flow" />
            </g>
          ))}
        </svg>
      )}
      {phone ? (
        <div className="space-y-3">
          <HubView x={x} />
          <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Rooms">
            {(['pnl', ...keys.filter((k) => k !== 'pnl')] as RoomKey[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={roomTab === k} onClick={() => setRoomTab(k)} className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${roomTab === k ? 'bg-accent text-on-accent' : 'bg-surface-2 text-ink-2'}`}>
                <Icon name={ROOMS[k].icon} size={14} />{ROOMS[k].name}
              </button>
            ))}
          </div>
          {(() => {
            const v = roomView(roomTab, x);
            return <Room k={roomTab} bind={bind} says={v.says}>{v.body}</Room>;
          })()}
        </div>
      ) : (
      <div className="relative z-10 grid gap-4 lg:grid-cols-12 lg:grid-rows-[auto_auto_auto_auto] lg:gap-5">
        {/* ── the hub: the bot in the middle with its big screen ── */}
        <div ref={hubRef} className="order-first lg:order-none lg:col-span-6 lg:col-start-4 lg:row-span-2 lg:row-start-1">
          <HubView x={x} />
        </div>
        {keys.map((k) => {
          const v = roomView(k, x);
          return (
            <Room key={k} k={k} bind={bind} className={place[k]} says={v.says}>
              {v.body}
            </Room>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ───────────────────────────── the hub ─────────────────────────────
function Hub({ d, state, next, now, lastRun, open, error, fm, fp, fpos, fx, reads, names, markets, onPick, picked, pnl }: { d: BotData | null; state: { word: string; tone: string }; next: { tf: string; at: number }; now: number; lastRun: RunNote | null; open: boolean; error: string | null; fm: MarketNow | null; fp: PlanMarket | null; fpos: Pos[]; fx: FxLive; reads: Array<{ id: string; pair: string; read: import('./FxTradeRead').TradeReadT; ai: import('./FxTradeRead').AiReadT | null }>; names: Record<string, string>; markets: MarketNow[]; onPick: (id: string) => void; picked: string | null; pnl: PnlData | null }) {
  const [chartRef, chartW] = useWidth<HTMLDivElement>();
  const live = fm ? liveOf(fx, fm.id, 15_000, now) : null;
  const price = live?.mid ?? fm?.price ?? null;
  const trades: ChartTrade[] = fpos.map((p) => ({ side: p.side, entryT: p.openedAt, entry: p.entry, stop: p.stop, target: p.target, strategy: p.strategy ?? '' }));
  const digits = fm ? dp(fm.id) : 5;
  const read = fpos[0] ? reads.find((r) => r.id === fpos[0]!.id) ?? null : null;
  const a = d?.account ?? null;
  const equity = a?.equityUsd ?? null;
  const dayPnl = a ? a.closed.filter((c) => now - c.closedAt < 86_400_000).reduce((s, c) => s + c.pnlUsd, 0) : 0;
  return (
    <div className="card hero-glow card-accent relative overflow-hidden p-4 sm:p-5">
      {/* the mastermind */}
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
        <div className="relative grid h-24 w-24 shrink-0 place-items-center">
          <span className="cr-ring absolute inset-0 rounded-full border-2 border-accent/50" />
          <span className="cr-ring absolute inset-0 rounded-full border-2 border-accent/40" style={{ animationDelay: '0.9s' }} />
          <span className="cr-ring absolute inset-0 rounded-full border-2 border-accent/30" style={{ animationDelay: '1.8s' }} />
          <div className={`cr-breathe grid h-16 w-16 place-items-center rounded-full bg-accent text-on-accent shadow-lg ${open ? '' : 'opacity-60'}`}>
            <Icon name="cpu" size={30} strokeWidth={1.6} />
          </div>
          <span className={`absolute right-1 top-1 h-3 w-3 rounded-full ${open ? 'cr-blink bg-good' : 'bg-muted'}`} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <div className="text-xs font-semibold text-muted">Forex bot · control room</div>
          <div className={`text-2xl font-semibold tracking-tight ${state.tone}`}>{state.word}</div>
          <p className="mt-1 text-sm text-ink-2">{d?.plan?.summary ?? (error ? `Couldn't reach the bot: ${error}` : d?.planError ? `No plan right now: ${d.planError}` : 'Waiting for its first look since the restart.')}</p>
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-2 text-center sm:grid-cols-1 sm:text-right">
          <div>
            <div className="text-xs text-muted">Next look</div>
            <div className="tabular text-base font-semibold text-ink">{mmss(next.at - now)}</div>
            <div className="text-xs text-muted">{clock(next.at)} · {next.tf}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Account</div>
            <div className="tabular text-base font-semibold text-ink">{equity !== null ? `$${equity.toFixed(0)}` : '—'}</div>
            <div className={`text-xs ${tone(dayPnl)}`}>{usd(dayPnl)} today</div>
          </div>
          <div>
            <div className="text-xs text-muted">Last check</div>
            <div className="tabular text-base font-semibold text-ink">{lastRun ? agoShort(lastRun.t, now) : '—'}</div>
            <div className="text-xs text-muted">{lastRun ? `${lastRun.signals} fired · ${lastRun.opened} opened` : 'none yet'}</div>
          </div>
        </div>
      </div>
      {d?.labError && <p className="mt-3 rounded-lg bg-critical/10 px-3 py-2 text-xs text-down">Last hourly test failed {agoShort(d.labError.t, now)} ago: {d.labError.msg}</p>}
      {d?.why && <WhyLine why={d.why} />}

      {/* P&L strip: the money, always on the home */}
      {pnl?.periods && (
        <div className="mt-4 grid grid-cols-4 gap-1.5 sm:gap-2">
          {([['Today', pnl.periods.today], ['Week', pnl.periods.week], ['Month', pnl.periods.month], ['All time', pnl.periods.all]] as const).map(([label, p]) => (
            <div key={label} className="rounded-lg bg-surface-2 px-2 py-1.5 text-center">
              <div className="text-[11px] text-muted">{label}</div>
              <div className={`tabular text-sm font-semibold sm:text-base ${tone(p.pnlUsd)}`}>{usd(p.pnlUsd)}</div>
              <div className="truncate text-[10px] text-muted">{p.trades ? `${p.trades} trade${p.trades === 1 ? '' : 's'} · ${p.trades ? Math.round((p.wins / p.trades) * 100) : 0}% won` : 'no trades'}</div>
            </div>
          ))}
        </div>
      )}

      {/* the big screen */}
      <div className="cr-screen relative mt-4 overflow-hidden rounded-xl border border-line bg-surface-2">
        <span className="cr-scanline pointer-events-none absolute left-0 right-0 h-px bg-accent/40" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-xs font-semibold text-muted">On screen</span>
          <div className="no-scrollbar flex flex-1 gap-1 overflow-x-auto">
            {markets.map((m) => {
              const inTrade = fpos.length > 0 && m.id === picked ? true : false;
              const st = m.id === picked;
              return (
                <button key={m.id} type="button" onClick={() => onPick(m.id)} className={`min-h-7 shrink-0 rounded-full px-2.5 text-xs font-medium transition-colors ${st ? 'bg-accent text-on-accent' : 'bg-surface text-ink-2 hover:bg-surface-3'}`} aria-pressed={st}>
                  {pretty(m.id)}{inTrade ? ' ●' : ''}
                </button>
              );
            })}
          </div>
        </div>
        <div ref={chartRef}>
        {fm ? (
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-2">
              <span className="text-lg font-semibold text-ink">{pretty(fm.id)}</span>
              <span className={`tabular text-lg ${live ? 'text-ink' : 'text-ink-2'}`}>{price !== null ? price.toFixed(digits) : '—'}</span>
              <span className={`text-xs ${tone(fm.change24hPct)}`}>{fm.change24hPct >= 0 ? '+' : ''}{fm.change24hPct.toFixed(2)}% 24 h</span>
              {live && <Badge tone="up">live</Badge>}
              {fp && <Badge tone={fp.status === 'trading' ? 'up' : fp.status === 'waiting' ? 'warn' : fp.status === 'blocked' ? 'down' : 'neutral'}>{fp.status === 'trading' ? 'in a trade' : fp.status}</Badge>}
              <span className="text-xs text-muted">{fm.trend === 'up' ? 'uptrend' : fm.trend === 'down' ? 'downtrend' : 'sideways'} · RSI {Math.round(fm.rsi)} · ATR {fm.atrPips.toFixed(fm.id.includes('JPY') || fm.id.startsWith('XA') ? 0 : 1)} pips{fm.strength?.gap != null ? ` · strength ${fm.strength.gap >= 0 ? '+' : ''}${fm.strength.gap.toFixed(2)}` : ''}</span>
            </div>
            <div className="px-1 pb-1">
              {chartW > 0 && <MarketChart bars={fitBars(fm.bars, chartW, 7)} drawings={fm.drawings} trades={trades} digits={digits} height={chartW < 640 ? 280 : 360} width={chartW - 10} live={price} timeAxis interactive tradeLabels={trades.length > 0} entryMarker={trades.length > 0} />}
            </div>
            {read && (
              <div className="border-t border-line px-3 py-2">
                <div className="mb-1 text-xs font-semibold text-muted">The trade it is in here · {read.read.label}</div>
                <ReadTrack r={read.read} />
                {read.ai && <p className="mt-1 text-xs text-ink-2"><span className="font-semibold">AI read:</span> {read.ai.headline}</p>}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
              {fp && fp.lean.side !== 0 && <Badge tone={fp.lean.side === 1 ? 'up' : 'down'} title={fp.lean.why}>{fp.lean.side === 1 ? 'leans long' : 'leans short'}</Badge>}
              {(fp?.signals ?? []).slice(0, 4).map((s, i) => (
                <Badge key={i} tone={s.tone === 'go' ? 'up' : s.tone === 'wait' ? 'warn' : 'neutral'} title={s.verdict}>{s.name} ({s.tf}) {s.side === 1 ? '▲' : '▼'}</Badge>
              ))}
              {fp && fp.signals.length === 0 && <span className="text-xs text-muted">Nothing fired on the newest candles here.</span>}
              {fp?.blocks.map((b, i) => <Badge key={`b${i}`} tone="down">{b}</Badge>)}
            </div>
          </div>
        ) : (
          <div className="grid h-64 place-items-center text-sm text-muted">{markets.length ? 'Pick a market above.' : 'The first market read arrives after the hourly test.'}</div>
        )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <Link to="/forex/bot" className="text-accent-text hover:underline">Full Auto-bot page</Link>
        <Link to="/forex/live" className="text-accent-text hover:underline">All markets</Link>
        <Link to="/forex/lab" className="text-accent-text hover:underline">Lab</Link>
        <Link to="/forex/village" className="text-accent-text hover:underline">The village</Link>
        <span>{Object.keys(names).length ? `${d?.chosen.length ?? 0} strategy × chart combinations live` : ''}</span>
      </div>
    </div>
  );
}

// ───────────────────────────── a room ─────────────────────────────
function Room({ k, bind, className = '', says, children }: { k: RoomKey; bind: (k: RoomKey) => (el: HTMLDivElement | null) => void; className?: string; says: string; children: ReactNode }) {
  const r = ROOMS[k];
  return (
    <div ref={bind(k)} className={`card cr-room flex flex-col p-3 sm:p-4 ${className}`}>
      <div className="mb-2 flex items-start gap-2.5">
        <div className="cr-breathe grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text">
          <Icon name={r.icon} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink">{r.name}</span>
            <span className="truncate text-xs text-muted">{r.role}</span>
          </div>
          <p className="truncate text-xs text-ink-2" title={says}>{says}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

// ───────────────────────────── why no trades ─────────────────────────────
/** v19.4: one amber line when the bot has been quiet 3 h+ with the market open; tap for every reason it held back */
export function WhyLine({ why, always = false }: { why: WhyReport; always?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!why.quiet && !always) return null;
  const tone = why.quiet ? 'border-warning/40 bg-warning/10' : 'border-line bg-surface-2';
  return (
    <div className={`mt-3 rounded-lg border px-3 py-2 text-xs text-ink ${tone}`} role={why.quiet ? 'status' : undefined}>
      <div className="flex items-start gap-2">
        <span className="font-semibold">{why.quiet ? 'Why no trades?' : 'Trading check'}</span>
        <span className="min-w-0 flex-1 text-ink-2">{why.verdict}</span>
        <button type="button" className="shrink-0 text-accent-text hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'less' : 'details'}</button>
      </div>
      {why.hint && <p className="mt-1 text-ink-2">{why.hint}</p>}
      {open && (
        <div className="mt-2 space-y-1 text-ink-2">
          <p>Last {why.window.hours} h: {why.window.checks} checks · {why.window.signals} signals · {why.window.chosen} from strategies it trades · {why.window.opened} opened · {why.window.skipped} skipped · {why.window.waits} waited.</p>
          {why.reasons.length ? (
            <ul className="space-y-0.5">
              {why.reasons.map((r) => (
                <li key={r.kind} className="flex gap-2"><span className="tabular w-8 shrink-0 text-right font-semibold text-ink">{r.n}×</span><span className="min-w-0"><span>{r.label}</span><span className="block truncate text-muted" title={r.example}>e.g. {r.example}</span></span></li>
              ))}
            </ul>
          ) : <p>No wait or skip recorded in the window.</p>}
          {why.staleMarkets.length > 0 && <p>Lagging feeds: {why.staleMarkets.join(', ')}.</p>}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── market desks ─────────────────────────────
export function desksSays(desks: MarketDesk[]): string {
  if (!desks.length) return 'the desks open after the next hourly check';
  const traded = desks.filter((d) => d.status === 'traded').length;
  const picked = desks.filter((d) => d.status === 'picked').length;
  const waiting = desks.filter((d) => d.status === 'waiting').length;
  const study = desks.length > 0 && desks.every((d) => d.quota === 0);
  return `${traded} of ${desks.length} markets traded today${picked ? ` · ${picked} taking a learning trade` : ''}${waiting ? ` · ${waiting} waiting for a ${study ? 'proven ' : ''}setup` : ''}${study ? ' · desks study only' : ''}`;
}
export function DeskTile({ d, names, active, onPick }: { d: MarketDesk; names: Record<string, string>; active: boolean; onPick: (id: string) => void }) {
  const top = d.arms[0];
  const tone = d.status === 'traded' ? 'bg-good' : d.status === 'picked' ? 'cr-blink bg-warning' : d.status === 'waiting' ? 'bg-muted/50' : 'bg-critical/60';
  const word = d.status === 'traded' ? (d.quota ? `${d.tradesToday}/${d.quota} today` : `${d.tradesToday} today`) : d.status === 'picked' ? 'taking one' : d.status === 'waiting' ? (d.quota ? `0/${d.quota} today` : 'watching') : 'no record';
  return (
    <button type="button" onClick={() => onPick(d.id)} className={`rounded-lg border p-2 text-left transition-colors hover:bg-surface-2 ${active ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`} title={d.says}>
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
        <span className="text-xs font-semibold text-ink">{pretty(d.id)}</span>
        <span className="ml-auto text-[10px] text-muted">{word}</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-ink-2">{top ? `${names[top.strategy] ?? top.strategy} · ${top.tf}` : 'no strategy has a record here'}</div>
      {top && <div className="text-[10px] text-muted">{top.mean >= 0 ? '+' : ''}{top.mean.toFixed(2)}R · {top.prior.n} paper · {top.own.n} own</div>}
    </button>
  );
}
export function DeskDetail({ d, names, now }: { d: MarketDesk; names: Record<string, string>; now: number }) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-ink-2">{d.says}{d.lastTradeAt ? ` · last trade here ${agoShort(d.lastTradeAt, now)} ago` : ' · never traded here'}</p>
      {d.pick && <p className="rounded-lg bg-warning/10 px-2 py-1 text-ink">{d.pick.why}</p>}
      <table className="w-full text-left">
        <thead className="text-[10px] text-muted"><tr><th className="font-semibold">#</th><th className="font-semibold">Strategy · chart</th><th className="text-right font-semibold">Mean R</th><th className="text-right font-semibold">Score</th><th className="text-right font-semibold">Paper</th><th className="text-right font-semibold">Own</th></tr></thead>
        <tbody>
          {d.arms.map((a, i) => (
            <tr key={a.key} className="border-t border-line">
              <td className="py-1 text-muted">{i + 1}</td>
              <td className="py-1 text-ink">{names[a.strategy] ?? a.strategy} · {a.tf}{a.chosen && <Badge tone="up" className="ml-1">traded</Badge>}</td>
              <td className={`tabular py-1 text-right ${tone(a.mean)}`}>{a.mean >= 0 ? '+' : ''}{a.mean.toFixed(2)}</td>
              <td className="tabular py-1 text-right text-ink-2">{a.score.toFixed(2)}</td>
              <td className="tabular py-1 text-right text-muted">{a.prior.n}</td>
              <td className="tabular py-1 text-right text-muted">{a.own.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted">Mean R = the lab's record on this market blended with the bot's own fills here (own count double), shrunk by 10 break-even trades. Score adds a bonus for strategies tried rarely here, so the desk keeps learning. {d.quota ? 'One learning trade a day at half size when nothing else traded here.' : 'Strict mode: the desk ranks and studies only — the bot trades nothing here until a strategy passes the unseen exam.'}</p>
    </div>
  );
}
function Desks({ desks, names, focus, onPick, now }: { desks: MarketDesk[]; names: Record<string, string>; focus: string | null; onPick: (id: string) => void; now: number }) {
  if (!desks.length) return <p className="text-xs text-muted">The desks open after the next hourly check.</p>;
  const f = desks.find((d) => d.id === focus) ?? null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {desks.map((d) => <DeskTile key={d.id} d={d} names={names} active={focus === d.id} onPick={onPick} />)}
      </div>
      {f && (
        <div className="rounded-lg border border-line bg-surface-2 p-2">
          <div className="mb-1 text-xs font-semibold text-ink">{pretty(f.id)} desk</div>
          <DeskDetail d={f} names={names} now={now} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── P&L ─────────────────────────────
function pnlSays(p: PnlData | null): string {
  if (!p?.periods) return 'no P&L report yet';
  return `today ${usd(p.periods.today.pnlUsd)} · week ${usd(p.periods.week.pnlUsd)} · month ${usd(p.periods.month.pnlUsd)} · open ${usd(p.openPnlUsd)}`;
}

// ───────────────────────────── scout ─────────────────────────────
function scoutSays(plan: BotPlan | null, markets: MarketNow[]): string {
  if (!markets.length) return 'waiting for the first market read';
  const long = plan?.markets.filter((m) => m.lean.side === 1).length ?? 0;
  const short = plan?.markets.filter((m) => m.lean.side === -1).length ?? 0;
  const waiting = plan?.markets.filter((m) => m.status === 'waiting').length ?? 0;
  return `${markets.length} markets on watch · ${long} lean long · ${short} lean short${waiting ? ` · ${waiting} close to a setup` : ''}`;
}
function Scout({ markets, plan, fx, now, focus, onPick }: { markets: MarketNow[]; plan: BotPlan | null; fx: FxLive; now: number; focus: string | null; onPick: (id: string) => void }) {
  const prev = useRef<Record<string, number>>({});
  const flash = useRef<Record<string, 'tick-up' | 'tick-down' | ''>>({});
  if (!markets.length) return <p className="text-xs text-muted">Nothing yet.</p>;
  const pm = new Map((plan?.markets ?? []).map((m) => [m.id, m]));
  const order = (id: string) => (pm.get(id)?.status === 'trading' ? 0 : pm.get(id)?.status === 'waiting' ? 1 : 2);
  const sorted = markets.slice().sort((x, y) => order(x.id) - order(y.id) || x.id.localeCompare(y.id));
  return (
    <ul className="divide-y divide-line">
      {sorted.map((m) => {
        const t = liveOf(fx, m.id, 15_000, now);
        const px = t?.mid ?? m.price;
        const was = prev.current[m.id];
        if (was !== undefined && px !== was) flash.current[m.id] = px > was ? 'tick-up' : 'tick-down';
        prev.current[m.id] = px;
        const p = pm.get(m.id);
        const st = p?.status ?? 'watching';
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onPick(m.id)} className={`flex w-full items-center gap-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${focus === m.id ? 'bg-accent-soft' : ''}`} aria-pressed={focus === m.id}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${st === 'trading' ? 'cr-blink bg-good' : st === 'waiting' ? 'bg-warning' : st === 'blocked' ? 'bg-critical' : 'bg-muted/50'}`} aria-hidden="true" />
              <span className="w-[4.6rem] shrink-0 text-xs font-semibold text-ink">{pretty(m.id)}</span>
              <span key={`${m.id}:${px}`} className={`tabular shrink-0 text-xs text-ink-2 ${flash.current[m.id] ?? ''}`}>{px.toFixed(dp(m.id))}</span>
              <span className={`ml-auto shrink-0 text-xs ${p?.lean.side === 1 ? 'text-up' : p?.lean.side === -1 ? 'text-down' : 'text-muted'}`}>{p?.lean.side === 1 ? '▲ long' : p?.lean.side === -1 ? '▼ short' : '· flat'}</span>
              <span className="w-14 shrink-0 text-right text-xs text-muted">{st === 'trading' ? 'in trade' : st === 'waiting' ? 'waiting' : st === 'blocked' ? 'paused' : ''}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── analyst ─────────────────────────────
function analystSays(fm: MarketNow | null, fp: PlanMarket | null, names: Record<string, string>): string {
  if (!fm) return 'no chart on the screen yet';
  const wait = fp?.signals.find((s) => s.tone === 'wait');
  if (wait) return `${pretty(fm.id)}: ${wait.name} wants ${wait.side === 1 ? 'a long' : 'a short'} — ${wait.verdict}`;
  const go = fp?.signals.find((s) => s.tone === 'go');
  if (go) return `${pretty(fm.id)}: ${go.name} — ${go.verdict}`;
  const fired = fm.firing.find((f) => f.allowed) ?? fm.firing[0];
  if (fired) return `${pretty(fm.id)}: ${names[fired.id] ?? fired.name} fired on the ${fired.tf} — ${fired.allowed ? 'allowed' : fired.why ?? 'held back'}`;
  return `${pretty(fm.id)}: ${fm.trend === 'flat' ? 'sideways' : fm.trend === 'up' ? 'uptrend' : 'downtrend'}, RSI ${Math.round(fm.rsi)}${fp?.lean.side ? `, ${fp.lean.why}` : ''} — nothing to do yet`;
}
function Analyst({ fm, fp, d }: { fm: MarketNow | null; fp: PlanMarket | null; d: BotData | null }) {
  if (!fm) return <p className="text-xs text-muted">Pick a market on the big screen.</p>;
  const arrow = (x: number) => (x > 0 ? <span className="text-up">▲</span> : x < 0 ? <span className="text-down">▼</span> : <span className="text-muted">–</span>);
  const lines = (fm.drawings?.lines ?? []).filter((l) => !l.broken);
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-2 text-center">
        <div><div className="text-muted">1h</div><div className="text-sm">{fm.mtf ? arrow(fm.mtf.h1) : '—'}</div></div>
        <div><div className="text-muted">4h</div><div className="text-sm">{fm.mtf ? arrow(fm.mtf.h4) : '—'}</div></div>
        <div><div className="text-muted">Day</div><div className="text-sm">{fm.mtf ? arrow(fm.mtf.d1) : '—'}</div></div>
      </div>
      <Line k="Lean">{fp ? (fp.lean.side === 0 ? 'no lean' : `${fp.lean.side === 1 ? 'long' : 'short'} — ${fp.lean.why}`) : '—'}</Line>
      <Line k="Structure">{lines.length ? `${lines.filter((l) => l.kind === 'support').length} rising support, ${lines.filter((l) => l.kind === 'resistance').length} falling resistance line${lines.length === 1 ? '' : 's'} respected` : 'no clean trendline right now'}; {fm.drawings?.levels?.length ?? 0} level{(fm.drawings?.levels?.length ?? 0) === 1 ? '' : 's'} where swings cluster</Line>
      <Line k="Signals now">{fp && fp.signals.length ? fp.signals.slice(0, 5).map((s) => `${s.name} ${s.tf} ${s.side === 1 ? '▲' : '▼'}: ${s.verdict}`).join(' · ') : 'nothing fired on the newest candles'}</Line>
      <Line k="Judge">{d?.judge ? (d.judge.active ? `on — it keeps the best ${Math.round(d.judge.keepPct)}% of signals (AUC ${d.judge.auc?.toFixed(2) ?? '—'})` : `off — ${d.judge.why}`) : '—'}</Line>
      {fp?.blocks.length ? <Line k="Held back">{fp.blocks.join(' · ')}</Line> : null}
    </div>
  );
}
function Line({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-[4.6rem] shrink-0 font-semibold text-muted">{k}</span>
      <span className="min-w-0 flex-1 text-ink-2">{children}</span>
    </div>
  );
}

// ───────────────────────────── trader ─────────────────────────────
function traderSays(positions: Pos[], orders: Order[], pnl: number): string {
  if (positions.length) return `${positions.length} open · ${usd(pnl)} live${orders.length ? ` · ${orders.length} order${orders.length === 1 ? '' : 's'} resting` : ''}`;
  if (orders.length) return `${orders.length} resting order${orders.length === 1 ? '' : 's'} waiting for the price to come to it`;
  return 'flat — nothing open, waiting for a setup that passes every check';
}
function Trader({ positions, orders, fx, now, reads, onPick, plan }: { positions: Pos[]; orders: Order[]; fx: FxLive; now: number; reads: Array<{ id: string; read: import('./FxTradeRead').TradeReadT }>; onPick: (id: string) => void; plan: BotPlan | null }) {
  if (!positions.length && !orders.length) return <p className="text-xs text-muted">No open trades. The next candle close is the next chance.</p>;
  return (
    <ul className="space-y-2">
      {positions.map((p) => {
        const pnl = livePnl(p, fx, now);
        const r = reads.find((x) => x.id === p.id)?.read ?? null;
        const pt = plan?.trades.find((t) => t.id === p.id);
        const nextLine = pt?.lines.find((l) => !l.done)?.text ?? null;
        return (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p.pair)} className="w-full rounded-lg bg-surface-2 p-2 text-left hover:bg-surface-3">
              <div className="flex items-center gap-2 text-xs">
                <span className={`font-semibold ${p.side === 1 ? 'text-up' : 'text-down'}`}>{p.side === 1 ? 'LONG' : 'SHORT'}</span>
                <span className="font-semibold text-ink">{pretty(p.pair)}</span>
                <span className="text-muted">{p.tf ?? ''}</span>
                <span className={`tabular ml-auto font-semibold ${tone(pnl)}`}>{usd(pnl)}</span>
              </div>
              {r && (
                <div className="mt-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className={`h-full ${r.pips.now >= 0 ? 'bg-good' : 'bg-critical'}`} style={{ width: `${Math.max(2, Math.min(100, r.progressPct ?? 0))}%` }} />
                  </div>
                  <div className="mt-0.5 flex justify-between text-[11px] text-muted"><span>{r.label}</span><span>{r.progressPct !== null ? `${Math.round(r.progressPct)}% to target` : ''}</span></div>
                </div>
              )}
              <div className="mt-1 text-[11px] text-ink-2">{pt?.name ?? p.strategy ?? ''}{nextLine ? ` · next: ${nextLine}` : ''}{p.locked ? ' · profit locked' : ''}</div>
            </button>
          </li>
        );
      })}
      {orders.map((o) => (
        <li key={o.id} className="rounded-lg border border-dashed border-line-strong p-2 text-xs">
          <span className={`font-semibold ${o.side === 1 ? 'text-up' : 'text-down'}`}>{o.side === 1 ? 'BUY' : 'SELL'}</span> <span className="font-semibold text-ink">{pretty(o.pair)}</span> resting at <span className="tabular">{o.limit.toFixed(dp(o.pair))}</span> ({o.kind}) · until {clock(o.expiresAt)}
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── risk desk ─────────────────────────────
function expList(risk: RiskSummary | null | undefined): RiskSummary['exposure'] { return Array.isArray(risk?.exposure) ? risk.exposure : []; }
function riskSays(a: Acct | null, risk: RiskSummary | null, mode: RiskMode): string {
  if (!a) return 'no account yet';
  const top = expList(risk).slice().sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct))[0];
  return `${mode} mode · $${a.equityUsd.toFixed(0)} equity · ${risk ? `${risk.openRiskPct.toFixed(1)}% at risk` : '—'}${top && Math.abs(top.pct) > 0.05 ? ` · most on ${top.ccy} ${top.pct >= 0 ? '+' : ''}${top.pct.toFixed(1)}%` : ''}`;
}
function RiskDesk({ a, risk, mode, modes, onMode }: { a: Acct | null; risk: RiskSummary | null; mode: RiskMode; modes?: Record<RiskMode, RiskLimits>; onMode: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (m: RiskMode) => {
    setBusy(true);
    try {
      await api('/api/forex/bot/mode', { method: 'POST', body: JSON.stringify({ mode: m }) });
      onMode();
    } finally {
      setBusy(false);
    }
  };
  if (!a) return <p className="text-xs text-muted">No account yet.</p>;
  const exp = expList(risk).filter((e) => Math.abs(e.pct) > 0.01).sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct)).slice(0, 6);
  const cap = risk?.capPct ?? 2.2;
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-3 gap-1 text-center">
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Equity</div><div className="tabular font-semibold text-ink">${a.equityUsd.toFixed(0)}</div></div>
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Free margin</div><div className="tabular font-semibold text-ink">${a.freeMarginUsd.toFixed(0)}</div></div>
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Drawdown</div><div className="tabular font-semibold text-ink">{risk ? `${risk.ddPct.toFixed(1)}%` : '—'}</div></div>
      </div>
      {exp.length ? (
        <div className="space-y-1">
          {exp.map((e) => (
            <div key={e.ccy} className="flex items-center gap-2">
              <span className="w-8 font-semibold text-ink">{e.ccy}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"><div className={`h-full ${e.pct >= 0 ? 'bg-good' : 'bg-critical'}`} style={{ width: `${Math.min(100, (Math.abs(e.pct) / cap) * 100)}%` }} /></div>
              <span className={`tabular w-12 text-right ${e.pct >= 0 ? 'text-up' : 'text-down'}`}>{e.pct >= 0 ? '+' : ''}{e.pct.toFixed(1)}%</span>
            </div>
          ))}
          <div className="text-[11px] text-muted">bars fill at the {cap}% per-currency cap</div>
        </div>
      ) : (
        <p className="text-muted">No currency exposure right now.</p>
      )}
      {modes && (
        <div className="grid grid-cols-3 gap-1">
          {(['normal', 'aggressive', 'max'] as RiskMode[]).map((m) => (
            <Button key={m} size="sm" variant={mode === m ? 'primary' : 'outline'} disabled={busy} onClick={() => void set(m)} className="min-w-0 px-1 leading-tight" title={`${modes[m].label}: ${modes[m].riskPct}% a trade at ${modes[m].leverage}×, up to ${modes[m].maxOpen} open`}>
              <span className="block truncate text-[11px]">{modes[m].label}</span>
              <span className="block text-[10px] opacity-80">{modes[m].riskPct}% · {modes[m].leverage}×</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── decisions ─────────────────────────────
function Decisions({ log, now }: { log: Array<{ t: number; e: string }>; now: number }) {
  if (!log.length) return <p className="text-xs text-muted">No decisions logged yet.</p>;
  return (
    <ul className="cr-feed max-h-56 space-y-1 overflow-y-auto pr-1 text-xs">
      {log.slice(0, 40).map((l, i) => (
        <li key={`${l.t}:${i}`} className="flex gap-2 fade-in">
          <span className="tabular w-8 shrink-0 text-muted">{agoShort(l.t, now)}</span>
          <span className="text-ink-2">{l.e}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── historian ─────────────────────────────
function historianSays(d: BotData | null, rows: LabRow[]): string {
  if (!d) return 'no grades yet';
  const edge = rows.filter((r) => r.verdict === 'edge').length;
  const maybe = rows.filter((r) => r.verdict === 'maybe').length;
  return `${d.chosen.length} combinations trade · ${edge} graded Edge, ${maybe} Maybe · picker ${d.rolling?.active ? 'on' : 'learning'} · judge ${d.judge?.active ? 'on' : 'off'} · sniper ${d.sniper?.active ? 'armed' : 'off'}`;
}
function Historian({ d, rows, names }: { d: BotData | null; rows: LabRow[]; names: Record<string, string> }) {
  if (!d) return <p className="text-xs text-muted">Waiting for the lab.</p>;
  const live = d.chosen.slice(0, 8);
  const paused = d.rolling?.thisWeek?.paused ?? [];
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="mb-1 font-semibold text-muted">Put to work now</div>
        <div className="flex flex-wrap gap-1">
          {live.map((k) => {
            const [id, tf] = k.split(':');
            const v = rows.find((r) => r.id === id && r.tf === tf)?.verdict;
            return <Badge key={k} tone={v === 'edge' ? 'up' : v === 'maybe' ? 'warn' : 'neutral'}>{names[id ?? ''] ?? id} · {tf}</Badge>;
          })}
          {d.chosen.length > 8 && <span className="text-muted">+{d.chosen.length - 8} more</span>}
          {!d.chosen.length && <span className="text-muted">none yet</span>}
        </div>
      </div>
      <Line k="Picker">{d.rolling ? (d.rolling.active ? 'on — re-picks the list every Sunday from the last 26 weeks' : `off — ${d.rolling.why}`) : '—'}</Line>
      {paused.length > 0 && <Line k="Resting">{paused.map((p) => `${names[p.key.split(':')[0] ?? ''] ?? p.key} (PF ${p.pf ?? '—'})`).join(', ')}</Line>}
      {(d.dropped ?? []).length > 0 && <Line k="Dropped">{(d.dropped ?? []).slice(0, 4).map((k) => names[k.split(':')[0] ?? ''] ?? k).join(', ')}{(d.dropped ?? []).length > 4 ? ` +${(d.dropped ?? []).length - 4}` : ''} — lost money in its own account</Line>}
      <Line k="Sniper">{d.sniper ? (d.sniper.active ? `armed at ${d.sniper.k}+ checks` : 'off until it proves itself on unseen data') : '—'}</Line>
    </div>
  );
}

// ───────────────────────────── news desk ─────────────────────────────
function newsSays(c: CalData | null | undefined, now: number): string {
  if (!c) return 'no calendar yet';
  const next = (c.events ?? []).filter((e) => e.t > now && (e.impact === 'High' || e.impact === 'Holiday')).sort((x, y) => x.t - y.t)[0];
  const hot = (c.headlines ?? []).filter((h) => h.severity === 'high' && now - h.t < 3_600_000).length;
  const parts = [!c.clock ? 'market clock unknown' : c.clock.open ? `market open · ${(c.clock.sessions ?? []).join(' + ') || 'quiet hours'}` : `market closed · opens in ${mmss(c.clock.minutesToChange * 60_000)}`];
  if (next) parts.push(`next big one: ${next.ccy} ${next.title} in ${mmss(next.t - now)}`);
  if (hot) parts.push(`${hot} hot headline${hot === 1 ? '' : 's'} this hour`);
  return parts.join(' · ');
}
function NewsDesk({ c, now }: { c: CalData | null; now: number }) {
  if (!c) return <p className="text-xs text-muted">Waiting for the calendar.</p>;
  const ev = (c.events ?? []).filter((e) => e.t > now - 30 * 60_000 && e.impact !== 'Low').sort((x, y) => x.t - y.t).slice(0, 5);
  const heads = (c.headlines ?? []).slice().sort((x, y) => y.t - x.t).slice(0, 4);
  return (
    <div className="space-y-2 text-xs">
      {c.clock?.noNewTrades && <Badge tone="warn">no new trades — the week is closing</Badge>}
      <div>
        <div className="mb-1 font-semibold text-muted">Coming up</div>
        {ev.length ? (
          <ul className="space-y-0.5">
            {ev.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="tabular w-10 shrink-0 text-muted">{clock(e.t)}</span>
                <Badge tone={e.impact === 'High' || e.impact === 'Holiday' ? 'down' : 'warn'}>{e.ccy}</Badge>
                <span className="truncate text-ink-2">{e.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Nothing that moves markets in the next hours.</p>
        )}
      </div>
      {heads.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-muted">Headlines</div>
          <ul className="space-y-0.5">
            {heads.map((h, i) => (
              <li key={i} className="flex gap-2">
                <span className="tabular w-8 shrink-0 text-muted">{agoShort(h.t, now)}</span>
                <a href={h.link} target="_blank" rel="noreferrer" className={`truncate hover:underline ${h.severity === 'high' ? 'font-semibold text-down' : 'text-ink-2'}`}>{h.title}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── crypto room ─────────────────────────────
function cryptoSays(s: SystemData | null, o: Overview | null): string {
  if (!s && !o) return 'no crypto data yet';
  const h = s?.trading?.lastHour;
  return `${h ? `${h.evaluated} coins checked, ${h.buySignals} signals, ${h.entries} bought in the last hour` : 'checker stats missing'}${o ? ` · ${o.openPositions ?? 0} open · ${(o.todayPnlSol ?? 0) >= 0 ? '+' : ''}${(o.todayPnlSol ?? 0).toFixed(2)} SOL today` : ''}`;
}
function CryptoRoom({ s, o }: { s: SystemData | null; o: Overview | null }) {
  if (!s && !o) return <p className="text-xs text-muted">Waiting for the crypto bot.</p>;
  const v = s?.checker?.verdict ?? null;
  const ok = v ? /^scoring/.test(v) : null;
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-3 gap-1 text-center">
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Checked / h</div><div className="tabular font-semibold text-ink">{s?.trading?.lastHour?.evaluated ?? '—'}</div></div>
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Open</div><div className="tabular font-semibold text-ink">{o ? `${o.openPositions ?? 0}${o.maxPositions ? `/${o.maxPositions}` : ''}` : '—'}</div></div>
        <div className="rounded-lg bg-surface-2 p-1.5"><div className="text-muted">Today</div><div className={`tabular font-semibold ${o ? tone(o.todayPnlSol) : 'text-ink'}`}>{o ? `${o.todayPnlSol >= 0 ? '+' : ''}${o.todayPnlSol.toFixed(2)} SOL` : '—'}</div></div>
      </div>
      {v && <p className={ok ? 'text-ink-2' : 'text-down'}>{v}</p>}
      {s?.trading?.summary && <p className="text-muted">{s.trading.summary}</p>}
      <div className="flex gap-3">
        <Link to="/crypto" className="text-accent-text hover:underline">Crypto desk</Link>
        <Link to="/scanner" className="text-accent-text hover:underline">Bot health</Link>
      </div>
    </div>
  );
}
