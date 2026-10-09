/**
 * App shell: login gate, navigation (sidebar on desktop, bottom bar on
 * phones), theme toggle and routes. Uses hash routing so GitHub Pages can
 * serve every page from one index.html.
 */
import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AppFooter, Brand, ModePill } from './components/Brand';
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

const NAV = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/feed', label: 'Live feed', icon: '⚡' },
  { to: '/positions', label: 'Positions', icon: '▤' },
  { to: '/history', label: 'History', icon: '☰' },
  { to: '/performance', label: 'Performance', icon: '↗' },
  { to: '/wallets', label: 'Wallets', icon: '◈' },
  { to: '/learning', label: 'Learning', icon: '✦' },
  { to: '/scanner', label: 'Scanner', icon: '◉' },
  { to: '/controls', label: 'Controls', icon: '⚙' },
];
/** Phone bottom bar: the four pages you check most; the rest live under "More". */
const PHONE_MAIN = ['/', '/positions', '/history', '/feed'];

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, () => void] {
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
  const next = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  return [theme, next];
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

function Shell() {
  const [theme, nextTheme] = useTheme();
  const status = useSocketStatus();
  const botUptime = useBotUptime();
  const [more, setMore] = useState(false);
  // Mode (PAPER/LIVE) + paused state for the header pill and footer. Light poll; also refreshes on trades.
  const ov = useApi<OverviewData>('/api/overview', 60_000);
  const mode = ov.data?.mode;
  const paused = ov.data?.paused || ov.data?.killSwitch;
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 font-medium transition-colors ${isActive ? 'bg-accent/12 text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface p-4 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
        <div className="mb-6 flex items-center justify-between gap-2 px-2">
          <Brand />
          <ModePill mode={mode} />
        </div>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={linkCls}>
              <span aria-hidden="true" className="w-5 text-center">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <InstallButton />
          <BotStatusBadge status={status} paused={paused} />
          <button type="button" onClick={nextTheme} className="rounded-lg px-3 py-2 text-left text-sm text-ink-2 hover:bg-surface-2">
            Theme: {theme}
          </button>
          <button
            type="button"
            onClick={() => {
              disconnectSocket();
              setToken(null);
            }}
            className="rounded-lg px-3 py-2 text-left text-sm text-ink-2 hover:bg-surface-2"
          >
            Log out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="glass sticky top-0 z-20 flex items-center justify-between border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:hidden">
        <span className="flex items-center gap-2">
          <Brand size="sm" />
          <ModePill mode={mode} />
        </span>
        <div className="flex items-center gap-2">
          <InstallButton compact />
          <BotStatusBadge status={status} paused={paused} />
        </div>
      </header>

      {/* Page column: content, then the footer. The bottom padding keeps the footer
          (and everything else) clear of the fixed phone nav bar. */}
      <div className="flex min-w-0 flex-1 flex-col md:min-h-screen pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-6">
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pt-5 sm:px-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/feed" element={<LiveFeed />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/history" element={<History />} />
            <Route path="/performance" element={<Performance />} />
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

      {/* Mobile bottom nav: 4 main pages + More */}
      <nav className="glass fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Main">
        {NAV.filter((n) => PHONE_MAIN.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setMore(false)} className={({ isActive }) => `flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${isActive ? 'text-accent' : 'text-ink-2'}`}>
            <span aria-hidden="true" className="text-xl leading-none">{n.icon}</span>
            {n.label.split(' ')[0]}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${more ? 'text-accent' : 'text-ink-2'}`}>
          <span aria-hidden="true" className="text-xl leading-none">☰</span>
          More
        </button>
      </nav>
      {more && (
        <div className="fixed inset-0 z-10 bg-black/40 md:hidden" onClick={() => setMore(false)} aria-hidden="true">
          <div
            role="dialog"
            aria-label="More pages"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] rounded-t-2xl border-t border-line bg-surface p-3 shadow-2xl"
          >
            <div className="grid grid-cols-3 gap-2">
              {NAV.filter((n) => !PHONE_MAIN.includes(n.to)).map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setMore(false)} className={({ isActive }) => `flex flex-col items-center gap-1 rounded-xl border border-line py-3 text-sm font-medium ${isActive ? 'bg-accent text-white' : 'text-ink'}`}>
                  <span aria-hidden="true" className="text-xl">{n.icon}</span>
                  {n.label}
                </NavLink>
              ))}
              <button type="button" onClick={nextTheme} className="flex flex-col items-center gap-1 rounded-xl border border-line py-3 text-sm font-medium text-ink">
                <span aria-hidden="true" className="text-xl">◐</span>
                Theme: {theme}
              </button>
              <button
                type="button"
                onClick={() => {
                  disconnectSocket();
                  setToken(null);
                }}
                className="flex flex-col items-center gap-1 rounded-xl border border-line py-3 text-sm font-medium text-down"
              >
                <span aria-hidden="true" className="text-xl">⎋</span>
                Log out
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
