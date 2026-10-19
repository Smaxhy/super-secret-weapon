/**
 * App shell: login gate, navigation (sidebar on desktop — icons only on tablets, icon + label on wide
 * screens — and a bottom bar on phones), theme toggle and routes. Hash routing so GitHub Pages can
 * serve every page from one index.html.
 */
import { useEffect, useRef, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppFooter, Brand, ModePill } from './components/Brand';
import { Icon, type IconName } from './components/Icon';
import { InstallButton } from './components/InstallButton';
import { Toasts } from './components/Toasts';
import { useApi } from './hooks/useApi';
import { livePnl, useFxLive } from './hooks/useFxLive';
import { disconnectSocket, useBotUptime, useSocketStatus } from './hooks/useWebSocket';
import { useStreamRates } from './hooks/useStreamRates';
import { refreshAll } from './lib/refresh';
import { sol } from './lib/format';
import { getToken, setToken } from './lib/api';
import type { Overview as OverviewData } from './lib/types';
import { History } from './pages/History';
import { Learning } from './pages/Learning';
import { LiveFeed } from './pages/LiveFeed';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Performance } from './pages/Performance';
import { Positions } from './pages/Positions';
import { ScannerStats } from './pages/ScannerStats';
import { TokenDetail } from './pages/TokenDetail';
import { Wallets } from './pages/Wallets';
import { Controls } from './pages/Controls';
import { Strategies } from './pages/Strategies';
import { Shadow } from './pages/Shadow';
import { Brain } from './pages/Brain';
import { Forex } from './pages/Forex';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** One line for the phone "More" sheet. */
  desc: string;
}
/** Two workspaces, each with its own menu (room for more later). System pages are shared. */
type Ws = 'forex' | 'crypto';
type Group = { label: string; items: NavItem[] };
const SYSTEM: Group = {
  label: 'System',
  items: [
    { to: '/scanner', label: 'Scanner', icon: 'radar', desc: 'Bot health, data feeds, market' },
    { to: '/controls', label: 'Controls', icon: 'sliders', desc: 'Settings, rules, alerts, data feed' },
  ],
};
const WS: Record<Ws, { label: string; icon: IconName; home: string; groups: Group[]; phone: string[] }> = {
  forex: {
    label: 'Forex',
    icon: 'globe',
    home: '/forex',
    phone: ['/forex', '/forex/bot', '/forex/live', '/forex/lab'],
    groups: [
      {
        label: 'Trading',
        items: [
          { to: '/forex', label: 'Control room', icon: 'grid', desc: 'The bot in the middle: what it watches, reads, trades and decides, live' },
          { to: '/forex/bot', label: 'Auto-bot', icon: 'cpu', desc: 'Its trades, its plan, today\'s brief and every self-test' },
          { to: '/forex/live', label: 'Markets', icon: 'chart', desc: 'Every market, the bot\'s lines, signals and trades' },
          { to: '/forex/strategies', label: 'Strategies', icon: 'flask', desc: 'Every strategy tested on 1m, 15m, 1h and 4h charts' },
          { to: '/forex/lab', label: 'Lab', icon: 'sparkles', desc: 'Every test it runs on itself: what is live, what is still proving itself' },
          { to: '/forex/paper', label: 'Paper results', icon: 'clock', desc: 'Every strategy traded live since the start' },
          { to: '/forex/practice', label: 'Trade by hand', icon: 'bolt', desc: 'Optional: your own $1k practice account' },
          { to: '/forex/setup', label: 'Setup', icon: 'plug', desc: 'Price feed, markets, going live' },
        ],
      },
    ],
  },
  crypto: {
    label: 'Crypto',
    icon: 'layers',
    home: '/crypto',
    phone: ['/crypto', '/positions', '/history', '/performance'],
    groups: [
      {
        label: 'Trading',
        items: [
          { to: '/crypto', label: 'Overview', icon: 'home', desc: 'Profit, open trades, latest activity' },
          { to: '/positions', label: 'Positions', icon: 'layers', desc: 'What it holds right now' },
          { to: '/history', label: 'History', icon: 'clock', desc: 'Every closed trade' },
          { to: '/performance', label: 'Performance', icon: 'chart', desc: 'Charts, mistakes, money map, tests' },
        ],
      },
      {
        label: 'Lab',
        items: [
          { to: '/strategies', label: 'Strategies', icon: 'flask', desc: 'Chart strategies tested live' },
          { to: '/shadow', label: 'Shadow trades', icon: 'eye', desc: 'Coins it skipped, traded on paper' },
          { to: '/brain', label: 'Brain', icon: 'cpu', desc: 'Models, rules it found, tips' },
          { to: '/learning', label: 'Learning', icon: 'sparkles', desc: 'Score weights, coach, lessons' },
          { to: '/wallets', label: 'Wallets', icon: 'wallet', desc: 'KOLs, smart money, copy wallets' },
          { to: '/feed', label: 'Live feed', icon: 'bolt', desc: 'New coins as they launch' },
        ],
      },
    ],
  },
};
const wsOf = (path: string): Ws => (path.startsWith('/forex') ? 'forex' : 'crypto');
/** v18.2: the Scanner page is the CRYPTO bot's health — say so in the Forex workspace (its feeds live under Setup). */
const SYSTEM_FX: Group = { label: 'System', items: [{ to: '/scanner', label: 'Crypto scanner', icon: 'radar', desc: 'The crypto bot\'s health (forex feeds: Setup)' }, SYSTEM.items[1]!] };
const groupsOf = (ws: Ws): Group[] => [...WS[ws].groups, ws === 'forex' ? SYSTEM_FX : SYSTEM];
const NAV = [...WS.forex.groups, ...WS.crypto.groups, SYSTEM].flatMap((g) => g.items);
const EXACT = new Set(['/forex', '/crypto']);

/** Forex | Crypto switch (remembered per device). */
function WorkspaceSwitch({ ws, compact = false }: { ws: Ws; compact?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className={`grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 ${compact ? 'text-xs' : 'text-sm'}`} role="tablist" aria-label="Desk">
      {(['forex', 'crypto'] as Ws[]).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={ws === k}
          onClick={() => {
            try {
              localStorage.setItem('ws', k);
            } catch {
              // ignore
            }
            navigate(WS[k].home);
          }}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-semibold transition-colors ${ws === k ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          <Icon name={WS[k].icon} size={compact ? 14 : 16} />
          <span className={compact ? '' : 'hidden lg:inline'}>{WS[k].label}</span>
        </button>
      ))}
    </div>
  );
}

/** v17.8: GET /api/forex/bot/status (older servers 404 → no pill). */
interface FxBotStatus { open: number; openPnlUsd: number; trades?: Array<{ id: string; pair: string; side: 1 | -1; pnlUsd: number; /** v17.9: exit price behind pnlUsd + USD per 1.0 move of it */ px?: number; pnlPerPx?: number }> }
const fxMoney = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x) >= 10_000 ? `${(Math.abs(x) / 1000).toFixed(1)}k` : Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2)}`;

/** v17.8: "● In 2 trades +$8.20" (sidebar) / "● 2 open +$8.20" (phone header) in the Forex workspace, links to the Auto-bot. Nothing when it holds no trade. */
function FxTradesPill({ st, variant }: { st: FxBotStatus | null; variant: 'sidebar' | 'phone' }) {
  const fx = useFxLive();
  if (!st || !(st.open > 0)) return null;
  // v17.9: the server's total moved by each trade's live P&L change (trades without pnlPerPx keep their number)
  const now = Date.now();
  const pnl = (Number.isFinite(st.openPnlUsd) ? st.openPnlUsd : 0) + (st.trades ?? []).reduce((s, t) => s + (Number.isFinite(t.pnlUsd) ? livePnl(t, fx, now) - t.pnlUsd : 0), 0);
  const tone = pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-ink-2';
  const label = `The forex bot is in ${st.open} trade${st.open === 1 ? '' : 's'}, open profit ${fxMoney(pnl)}`;
  const dot = (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
    </span>
  );
  if (variant === 'phone')
    return (
      // compact (the phone header is full): pulsing dot, how many trades, open P&L
      <NavLink to="/forex" end aria-label={label} title={label} className="ml-0.5 inline-flex min-h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-good/40 bg-good/10 px-2 py-1 text-xs font-semibold text-ink">
        {dot}
        {/* the word "open" goes on narrow phones so the Forex / Crypto switch keeps its room */}
        <span className="tabular">{st.open}<span className="max-[389px]:hidden"> open</span></span>
        <span className={`tabular ${tone}`}>{fxMoney(pnl)}</span>
      </NavLink>
    );
  return (
    <NavLink to="/forex" end aria-label={label} title={label} className="flex min-h-9 items-center justify-center gap-2 rounded-xl border border-good/40 bg-good/10 px-2 py-1.5 text-xs font-semibold text-ink hover:bg-good/15 lg:justify-start lg:px-3">
      {dot}
      <span className="lg:hidden tabular">{st.open}</span>
      <span className="hidden min-w-0 flex-1 truncate lg:inline">In {st.open === 1 ? 'a trade' : `${st.open} trades`}</span>
      <span className={`tabular hidden lg:inline ${tone}`}>{fxMoney(pnl)}</span>
    </NavLink>
  );
}

/** "/" opens the workspace used last (Forex by default). */
function Landing() {
  let ws: Ws = 'forex';
  try {
    if (localStorage.getItem('ws') === 'crypto') ws = 'crypto';
  } catch {
    // ignore
  }
  return <Navigate to={WS[ws].home} replace />;
}

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('solbot.theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('solbot.theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  return [theme, setTheme];
}

function useAuthed(): boolean {
  const [authed, setAuthed] = useState(() => !!getToken());
  useEffect(() => {
    const h = () => setAuthed(!!getToken());
    window.addEventListener('solbot-auth', h);
    return () => window.removeEventListener('solbot-auth', h);
  }, []);
  return authed;
}

const THEMES: Array<[Theme, string, IconName]> = [
  ['system', 'Auto', 'sparkles'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'eye'],
];

function ThemeSwitch({ theme, setTheme, compact = false }: { theme: Theme; setTheme: (t: Theme) => void; compact?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-0.5 rounded-lg border border-line bg-surface-2/70 p-0.5">
      {THEMES.map(([k, l, ic]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={theme === k}
          aria-label={l}
          title={l}
          onClick={() => setTheme(k)}
          className={`flex min-h-8 flex-1 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors duration-150 ${theme === k ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.18)]' : 'text-muted hover:text-ink'}`}
        >
          {compact ? <Icon name={ic} size={14} /> : l}
        </button>
      ))}
    </div>
  );
}

const logOut = () => {
  disconnectSocket();
  setToken(null);
};

/** Icon-only theme cycle for the phone header. */
function ThemeCycle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const idx = THEMES.findIndex(([k]) => k === theme);
  const next = THEMES[(idx + 1) % THEMES.length]!;
  return (
    <button type="button" onClick={() => setTheme(next[0])} aria-label={`Theme: ${THEMES[idx]?.[1] ?? 'Auto'} — switch to ${next[1]}`} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink">
      <Icon name={THEMES[idx]?.[2] ?? 'sun'} size={19} />
    </button>
  );
}

/** Name + one-line purpose per route, for the desktop top bar. */
function pageMeta(pathname: string): { title: string; desc: string } {
  if (pathname.startsWith('/token/')) return { title: 'Coin', desc: 'One coin: price, safety, score and what the bot did' };
  const n = [...NAV].sort((x, y) => y.to.length - x.to.length).find((x) => (EXACT.has(x.to) ? pathname === x.to : pathname.startsWith(x.to)));
  return n ? { title: n.label, desc: n.desc } : { title: 'Solbot', desc: '' };
}

/** Search box in the top bar: a coin symbol, a mint or a wallet → the right page, filtered. */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  const term = q.trim();
  const addr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(term);
  const go = (to: string) => {
    setOpen(false);
    setQ('');
    navigate(to);
  };
  const enc = encodeURIComponent(term);
  const options: Array<{ label: string; sub: string; to: string; icon: IconName }> = term
    ? [
        ...(addr ? [{ label: 'Open coin page', sub: 'if this is a coin address', to: `/token/${term}`, icon: 'radar' as IconName }] : []),
        { label: 'Trades', sub: 'History filtered by this coin', to: `/history?q=${enc}`, icon: 'clock' },
        { label: 'Open positions', sub: 'What it holds that matches', to: `/positions?q=${enc}`, icon: 'layers' },
        { label: 'Wallets', sub: 'KOLs and smart money that match', to: `/wallets?q=${enc}`, icon: 'wallet' },
      ]
    : [];
  return (
    <div ref={box} className="relative w-full max-w-[18rem] lg:max-w-[22rem]">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (options[0]) go(options[0].to);
        }}
      >
        <label className="flex min-h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm text-muted transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
          <Icon name="search" size={16} />
          <span className="sr-only">Search coins, mints or wallets</span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            placeholder="Search coin, mint or wallet"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted"
          />
        </label>
      </form>
      {open && options.length > 0 && (
        <ul role="listbox" aria-label="Search in" className="pop absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-card-hover">
          {options.map((o) => (
            <li key={o.to}>
              <button type="button" role="option" aria-selected="false" onClick={() => go(o.to)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left hover:bg-surface-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-text">
                  <Icon name={o.icon} size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{o.label}</span>
                  <span className="block truncate text-xs text-muted">{o.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Online / paused / reconnecting + live stream speed. */
function StatusChip({ status, paused, tpm }: { status: string; paused?: boolean; tpm: number | null }) {
  const online = status === 'online';
  const st = !online ? (status === 'reconnecting' ? { dot: 'animate-pulse bg-warning', t: 'Reconnecting' } : { dot: 'bg-critical', t: 'Offline' }) : paused ? { dot: 'bg-warning', t: 'Paused' } : { dot: 'bg-good', t: 'Online' };
  return (
    <span role="status" className="inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-3 text-sm font-medium text-ink" title={tpm !== null ? `${tpm.toLocaleString()} trades a minute on the stream` : undefined}>
      <span className={`h-2 w-2 rounded-full ${st.dot}`} aria-hidden="true" />
      {st.t}
      {online && tpm !== null && (
        <span className="tabular hidden border-l border-line pl-2 text-xs font-normal text-muted lg:inline">
          {tpm >= 1000 ? `${(tpm / 1000).toFixed(1)}k` : tpm}/min
        </span>
      )}
    </span>
  );
}

function Shell() {
  const [theme, setTheme] = useTheme();
  const status = useSocketStatus();
  const botUptime = useBotUptime();
  const tpm = useStreamRates().tradesPerMin;
  const [more, setMore] = useState(false);
  const [spin, setSpin] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMore(false), [pathname]);
  // Mode (PAPER/LIVE), paused state and balance for the top bar and footer. Light poll; also refreshes on trades.
  const ov = useApi<OverviewData>('/api/overview', 60_000, ['trade']);
  const mode = ov.data?.mode;
  const paused = ov.data?.paused || ov.data?.killSwitch;
  const ws = wsOf(pathname);
  // v18.3: the desk's colour — every component reads the accent tokens, so the whole app recolours with the desk
  useEffect(() => {
    document.documentElement.setAttribute('data-ws', ws);
  }, [ws]);
  // v17.8: is the forex bot in a trade (Forex workspace only; an error / older server → no pill)
  const fxSt = useApi<FxBotStatus>(ws === 'forex' ? '/api/forex/bot/status' : null, 15_000);
  const fxStatus = ws === 'forex' && !fxSt.error ? fxSt.data : null;
  const GROUPS = groupsOf(ws);
  const PHONE_MAIN = WS[ws].phone;
  const wsNav = GROUPS.flatMap((g) => g.items);
  const inMore = wsNav.some((n) => !PHONE_MAIN.includes(n.to) && (EXACT.has(n.to) ? pathname === n.to : pathname.startsWith(n.to)));
  const online = status === 'online';
  const meta = pageMeta(pathname);
  const refresh = () => {
    refreshAll();
    setSpin(true);
    setTimeout(() => setSpin(false), 700);
  };
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `group relative flex min-h-10 items-center gap-3 rounded-xl px-2.5 text-sm font-medium transition-colors duration-150 lg:px-3 ${isActive ? 'bg-accent/12 text-accent-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:p-2">
        Skip to content
      </a>

      {/* Desktop sidebar: icons only on tablets, icon + label from lg. */}
      <aside className="hidden w-[4.5rem] shrink-0 flex-col border-r border-line bg-surface px-2 py-4 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto lg:w-60 lg:px-3">
        <div className="mb-6 flex items-center justify-center gap-2 px-1 lg:justify-between lg:px-2">
          <Brand compact />
          <span className="hidden lg:inline-flex">
            <ModePill mode={mode} />
          </span>
        </div>
        <div className="mb-5 px-0.5">
          <WorkspaceSwitch ws={ws} />
          {fxStatus && fxStatus.open > 0 && (
            <div className="mt-2">
              <FxTradesPill st={fxStatus} variant="sidebar" />
            </div>
          )}
        </div>
        <nav className="flex flex-col gap-5" aria-label="Main">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="mb-1.5 hidden px-3 text-xs font-semibold text-muted lg:block">{g.label}</div>
              <div className="mb-1.5 mx-auto h-px w-6 bg-line lg:hidden" aria-hidden="true" />
              <div className="flex flex-col gap-0.5">
                {g.items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={EXACT.has(n.to)} className={linkCls} title={n.label}>
                    {({ isActive }) => (
                      <>
                        {isActive && <span aria-hidden="true" className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />}
                        <span className="grid h-9 w-9 shrink-0 place-items-center lg:h-auto lg:w-auto">
                          <Icon name={n.icon} size={19} strokeWidth={isActive ? 2.1 : 1.8} />
                        </span>
                        <span className="hidden truncate lg:inline">{n.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <span className="hidden lg:block">
            <InstallButton />
          </span>
          <button type="button" onClick={logOut} title="Log out" className="flex min-h-10 items-center justify-center gap-2 rounded-xl px-2.5 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink lg:justify-start">
            <Icon name="logout" size={17} />
            <span className="hidden lg:inline">Log out</span>
          </button>
        </div>
      </aside>

      {/* Phone top bar (fixed height so sticky tabs can sit right under it) */}
      <header className="glass desk-band sticky top-0 z-20 h-[var(--hdr)] border-b border-line pt-[env(safe-area-inset-top)] md:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceSwitch ws={ws} compact />
          </span>
          <div className="flex items-center gap-0.5">
            <InstallButton compact />
            <button type="button" onClick={refresh} aria-label="Refresh everything" className="grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink">
              <Icon name="refresh" size={19} className={spin ? 'animate-spin' : ''} />
            </button>
            <ThemeCycle theme={theme} setTheme={setTheme} />
            {/* v17.8: in the Forex workspace the "in a trade" pill takes the status pill's place while the bot is online */}
            {online && fxStatus && fxStatus.open > 0 ? (
              <FxTradesPill st={fxStatus} variant="phone" />
            ) : (
              <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink" role="status">
                <span className={`h-2 w-2 rounded-full ${online ? (paused ? 'bg-warning' : 'bg-good') : status === 'reconnecting' ? 'animate-pulse bg-warning' : 'bg-critical'}`} aria-hidden="true" />
                {online ? (paused ? 'Paused' : 'Online') : status === 'reconnecting' ? 'Wait' : 'Offline'}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Page column: desktop top bar, content, then the footer. Bottom padding keeps clear of the phone tab bar. */}
      <div className="flex min-w-0 flex-1 flex-col pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:min-h-screen md:pb-6">
        <header className="glass desk-band sticky top-0 z-20 hidden h-16 items-center gap-4 border-b border-line px-6 md:flex">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2" aria-hidden="true">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-semibold text-accent-text"><Icon name={WS[ws].icon} size={12} />{WS[ws].label} desk</span>
              <span className="truncate text-lg font-bold leading-tight tracking-tight text-ink">{meta.title}</span>
            </div>
            <div className="hidden truncate text-xs text-muted lg:block">{meta.desc}</div>
          </div>
          <GlobalSearch />
          <StatusChip status={status} paused={paused} tpm={tpm} />
          {ov.data && (
            <span className="hidden min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-3 text-sm xl:inline-flex" title={mode === 'PAPER' ? 'Paper balance (simulated money)' : 'Wallet balance'}>
              <Icon name="wallet" size={15} className="text-muted" />
              <span className="tabular font-semibold text-ink">{sol(ov.data.balanceSol, 2)}</span>
            </span>
          )}
          <button type="button" onClick={refresh} aria-label="Refresh everything" title="Refresh everything" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line text-ink-2 hover:bg-surface-2 hover:text-ink">
            <Icon name="refresh" size={17} className={spin ? 'animate-spin' : ''} />
          </button>
          <div className="w-[6.5rem] shrink-0">
            <ThemeSwitch theme={theme} setTheme={setTheme} compact />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pt-4 sm:px-6 md:pt-6 lg:px-8">
          <div key={pathname} className="page-enter">
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/crypto" element={<Overview />} />
              <Route path="/forex" element={<Forex />} />
              <Route path="/forex/:section" element={<Forex />} />
              <Route path="/feed" element={<LiveFeed />} />
              <Route path="/positions" element={<Positions />} />
              <Route path="/history" element={<History />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/strategies" element={<Strategies />} />
              <Route path="/shadow" element={<Shadow />} />
              <Route path="/brain" element={<Brain />} />
              <Route path="/wallets" element={<Wallets />} />
              <Route path="/learning" element={<Learning />} />
              <Route path="/controls" element={<Controls />} />
              <Route path="/scanner" element={<ScannerStats />} />
              <Route path="/token/:mint" element={<TokenDetail />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
        <AppFooter mode={mode} status={status} paused={paused} uptimeSec={botUptime ?? ov.data?.uptimeSec} />
      </div>

      <Toasts />

      {/* Phone tab bar: 4 main pages + More */}
      <nav className="glass fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Main">
        {PHONE_MAIN.map((to) => wsNav.find((n) => n.to === to)!).map((n) => (
          <NavLink key={n.to} to={n.to} end={EXACT.has(n.to)} className={({ isActive }) => `flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 ${isActive && !more ? 'text-accent-text' : 'text-muted'}`}>
            {({ isActive }) => (
              <>
                <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors duration-150 ${isActive && !more ? 'bg-accent/15' : ''}`}>
                  <Icon name={n.icon} size={21} strokeWidth={isActive && !more ? 2.1 : 1.8} />
                </span>
                {n.label}
              </>
            )}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 ${more || inMore ? 'text-accent-text' : 'text-muted'}`}>
          <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors duration-150 ${more || inMore ? 'bg-accent/15' : ''}`}>
            <Icon name="grid" size={20} strokeWidth={more || inMore ? 2.1 : 1.8} />
          </span>
          More
        </button>
      </nav>

      {/* Phone "More" sheet: every other page, grouped, plus theme and log out */}
      {more && (
        <div className="fade-in fixed inset-0 z-30 bg-black/55 md:hidden" onClick={() => setMore(false)} aria-hidden="true">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More pages"
            onClick={(e) => e.stopPropagation()}
            className="sheet-up absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl border-t border-line bg-page px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl"
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-ink">More</h2>
              <button type="button" onClick={() => setMore(false)} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-ink-2">
                <Icon name="x" size={16} />
              </button>
            </div>
            {GROUPS.map((g) => {
              const items = g.items.filter((n) => !PHONE_MAIN.includes(n.to));
              if (!items.length) return null;
              return (
                <div key={g.label} className="mb-4">
                  <div className="mb-1.5 px-1 text-xs font-semibold text-muted">{g.label}</div>
                  <div className="card divide-y divide-line overflow-hidden">
                    {items.map((n) => (
                      <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex min-h-14 items-center gap-3 px-3.5 py-3 transition-colors duration-150 ${isActive ? 'bg-accent/8' : 'active:bg-surface-2'}`}>
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-text">
                          <Icon name={n.icon} size={19} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-ink">{n.label}</span>
                          <span className="block truncate text-xs text-muted">{n.desc}</span>
                        </span>
                        <Icon name="chevron" size={16} className="text-muted" />
                      </NavLink>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="mb-1.5 px-1 text-xs font-semibold text-muted">App</div>
            <div className="card divide-y divide-line overflow-hidden">
              <div className="flex min-h-14 items-center gap-3 px-3.5 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2">
                  <Icon name="sun" size={19} />
                </span>
                <span className="flex-1 font-medium text-ink">Theme</span>
                <div className="w-44">
                  <ThemeSwitch theme={theme} setTheme={setTheme} />
                </div>
              </div>
              <button type="button" onClick={logOut} className="flex min-h-14 w-full items-center gap-3 px-3.5 py-3 text-left active:bg-surface-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-critical/12 text-down">
                  <Icon name="logout" size={19} />
                </span>
                <span className="flex-1 font-medium text-down">Log out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const authed = useAuthed();
  return <HashRouter>{authed ? <Shell /> : <Login />}</HashRouter>;
}
