/**
 * App shell: login gate, navigation (sidebar on desktop, bottom bar on
 * phones), theme toggle and routes. Uses hash routing so GitHub Pages can
 * serve every page from one index.html.
 */
import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppFooter, Brand, ModePill } from './components/Brand';
import { Icon, type IconName } from './components/Icon';
import { InstallButton } from './components/InstallButton';
import { Toasts } from './components/Toasts';
import { BotStatusBadge } from './components/StatusBadge';
import { useApi } from './hooks/useApi';
import { disconnectSocket, useBotUptime, useSocketStatus } from './hooks/useWebSocket';
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

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** One line for the phone "More" sheet. */
  desc: string;
}
/** Pages grouped by what they're for (sidebar sections on desktop, the "More" sheet on phones). */
const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Trading',
    items: [
      { to: '/', label: 'Overview', icon: 'home', desc: 'Profit, open trades, latest activity' },
      { to: '/positions', label: 'Positions', icon: 'layers', desc: 'What it holds right now' },
      { to: '/history', label: 'History', icon: 'clock', desc: 'Every closed trade' },
      { to: '/feed', label: 'Live feed', icon: 'bolt', desc: 'New coins as they launch' },
    ],
  },
  {
    label: 'Results',
    items: [
      { to: '/performance', label: 'Performance', icon: 'chart', desc: 'Charts, mistakes, best times, tests' },
      { to: '/strategies', label: 'Strategies', icon: 'flask', desc: 'Chart strategies tested live' },
      { to: '/shadow', label: 'Shadow trades', icon: 'eye', desc: 'Coins it skipped, traded on paper' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/brain', label: 'Brain', icon: 'cpu', desc: 'Models, rules it found, tips' },
      { to: '/learning', label: 'Learning', icon: 'sparkles', desc: 'Score weights, coach, lessons' },
      { to: '/wallets', label: 'Wallets', icon: 'wallet', desc: 'KOLs, smart money, copy wallets' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/scanner', label: 'Scanner', icon: 'radar', desc: 'Bot health, market, trending' },
      { to: '/controls', label: 'Controls', icon: 'sliders', desc: 'Settings, rules, alerts, data feed' },
    ],
  },
];
const NAV = GROUPS.flatMap((g) => g.items);
/** Phone bottom bar: the four pages you check most; the rest live under "More". */
const PHONE_MAIN = ['/', '/positions', '/history', '/performance'];

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

const THEMES: Array<[Theme, string]> = [
  ['system', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

function ThemeSwitch({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {THEMES.map(([k, l]) => (
        <button key={k} type="button" role="radio" aria-checked={theme === k} onClick={() => setTheme(k)} className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium ${theme === k ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-ink-2'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

const logOut = () => {
  disconnectSocket();
  setToken(null);
};

function Shell() {
  const [theme, setTheme] = useTheme();
  const status = useSocketStatus();
  const botUptime = useBotUptime();
  const [more, setMore] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMore(false), [pathname]);
  // Mode (PAPER/LIVE) + paused state for the header pill and footer. Light poll; also refreshes on trades.
  const ov = useApi<OverviewData>('/api/overview', 60_000);
  const mode = ov.data?.mode;
  const paused = ov.data?.paused || ov.data?.killSwitch;
  const inMore = NAV.some((n) => n.to !== '/' && !PHONE_MAIN.includes(n.to) && pathname.startsWith(n.to));
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-accent/12 text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
        <div className="mb-5 flex items-center justify-between gap-2 px-2">
          <Brand />
          <ModePill mode={mode} />
        </div>
        <nav className="flex flex-col gap-4" aria-label="Main">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.label}</div>
              <div className="flex flex-col gap-0.5">
                {g.items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.to === '/'} className={linkCls}>
                    <Icon name={n.icon} size={18} />
                    {n.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <InstallButton />
          <BotStatusBadge status={status} paused={paused} />
          <ThemeSwitch theme={theme} setTheme={setTheme} />
          <button type="button" onClick={logOut} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-2 hover:bg-surface-2">
            <Icon name="logout" size={16} />
            Log out
          </button>
        </div>
      </aside>

      {/* Phone top bar (fixed height so sticky tabs can sit right under it) */}
      <header className="glass sticky top-0 z-20 h-[var(--hdr)] border-b border-line pt-[env(safe-area-inset-top)] md:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <span className="flex min-w-0 items-center gap-2">
            <Brand size="sm" />
            <ModePill mode={mode} />
          </span>
          <div className="flex items-center gap-2">
            <InstallButton compact />
            <BotStatusBadge status={status} paused={paused} compact />
          </div>
        </div>
      </header>

      {/* Page column: content, then the footer. The bottom padding keeps everything clear of the phone tab bar. */}
      <div className="flex min-w-0 flex-1 flex-col pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:min-h-screen md:pb-6">
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pt-4 sm:px-6 md:pt-6">
          <Routes>
            <Route path="/" element={<Overview />} />
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
        </main>
        <AppFooter mode={mode} status={status} paused={paused} uptimeSec={botUptime ?? ov.data?.uptimeSec} />
      </div>

      <Toasts />

      {/* Phone tab bar: 4 main pages + More */}
      <nav className="glass fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Main">
        {NAV.filter((n) => PHONE_MAIN.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${isActive && !more ? 'text-accent' : 'text-ink-2'}`}>
            {({ isActive }) => (
              <>
                <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${isActive && !more ? 'bg-accent/12' : ''}`}>
                  <Icon name={n.icon} size={21} strokeWidth={isActive && !more ? 2.1 : 1.8} />
                </span>
                {n.label}
              </>
            )}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={`flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${more || inMore ? 'text-accent' : 'text-ink-2'}`}>
          <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${more || inMore ? 'bg-accent/12' : ''}`}>
            <Icon name="grid" size={20} strokeWidth={more || inMore ? 2.1 : 1.8} />
          </span>
          More
        </button>
      </nav>

      {/* Phone "More" sheet: every other page, grouped, plus theme and log out */}
      {more && (
        <div className="fixed inset-0 z-30 bg-black/45 md:hidden" onClick={() => setMore(false)} aria-hidden="true">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More pages"
            onClick={(e) => e.stopPropagation()}
            className="sheet-up absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl border-t border-line bg-page px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl"
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" aria-hidden="true" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-ink">More</h2>
              <button type="button" onClick={() => setMore(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-ink-2">
                <Icon name="x" size={16} />
              </button>
            </div>
            {GROUPS.map((g) => {
              const items = g.items.filter((n) => !PHONE_MAIN.includes(n.to));
              if (!items.length) return null;
              return (
                <div key={g.label} className="mb-4">
                  <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.label}</div>
                  <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                    {items.map((n) => (
                      <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex items-center gap-3 px-3.5 py-3 ${isActive ? 'bg-accent/8' : 'active:bg-surface-2'}`}>
                        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/12 text-accent">
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
            <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">App</div>
            <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="flex items-center gap-3 px-3.5 py-3">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-surface-2 text-ink-2">
                  <Icon name="sun" size={19} />
                </span>
                <span className="flex-1 font-medium text-ink">Theme</span>
                <div className="w-44">
                  <ThemeSwitch theme={theme} setTheme={setTheme} />
                </div>
              </div>
              <button type="button" onClick={logOut} className="flex w-full items-center gap-3 px-3.5 py-3 text-left active:bg-surface-2">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-critical/12 text-down">
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
