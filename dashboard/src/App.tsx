/**
 * App shell: login gate, navigation (sidebar on desktop, bottom bar on
 * phones), theme toggle and routes. Uses hash routing so GitHub Pages can
 * serve every page from one index.html.
 */
import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { InstallButton } from './components/InstallButton';
import { Toasts } from './components/Toasts';
import { BotStatusBadge } from './components/StatusBadge';
import { disconnectSocket, useSocketStatus } from './hooks/useWebSocket';
import { getToken, setToken } from './lib/api';
import { History } from './pages/History';
import { LiveFeed } from './pages/LiveFeed';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Performance } from './pages/Performance';
import { Positions } from './pages/Positions';
import { ScannerStats } from './pages/ScannerStats';
import { TokenDetail } from './pages/TokenDetail';

const NAV = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/feed', label: 'Live feed', icon: '⚡' },
  { to: '/positions', label: 'Positions', icon: '▤' },
  { to: '/history', label: 'History', icon: '☰' },
  { to: '/performance', label: 'Performance', icon: '↗' },
  { to: '/scanner', label: 'Scanner', icon: '◉' },
];

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
  const connected = useSocketStatus();
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 font-medium ${isActive ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface p-4 md:flex">
        <div className="mb-6 px-2 text-lg font-bold text-ink">Solbot</div>
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
          <BotStatusBadge connected={connected} />
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
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:hidden">
        <span className="text-lg font-bold">Solbot</span>
        <div className="flex items-center gap-2">
          <InstallButton compact />
          <BotStatusBadge connected={connected} />
          <button type="button" onClick={nextTheme} aria-label={`Theme: ${theme}`} className="rounded-lg border border-line px-2.5 py-1 text-base leading-none">
            ◐
          </button>
          <button
            type="button"
            onClick={() => {
              disconnectSocket();
              setToken(null);
            }}
            aria-label="Log out"
            className="rounded-lg border border-line px-2.5 py-1 text-base leading-none"
          >
            ⎋
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:pb-10">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/feed" element={<LiveFeed />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/history" element={<History />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/scanner" element={<ScannerStats />} />
          <Route path="/token/:mint" element={<TokenDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <Toasts />

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${isActive ? 'text-accent' : 'text-ink-2'}`}>
            <span aria-hidden="true" className="text-lg leading-none">{n.icon}</span>
            {n.label.split(' ')[0]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function App() {
  const authed = useAuthed();
  return <HashRouter>{authed ? <Shell /> : <Login />}</HashRouter>;
}
