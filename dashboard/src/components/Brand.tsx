/** App chrome pieces: logo + name, PAPER/LIVE pill, and the footer shown on every page. */
import { useEffect, useState } from 'react';
import { restartNote, type ConnStatus } from '../lib/reconnect';

/** Small logo mark (same chart glyph as the app icon) + "Solbot". */
export function Brand({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`${box} grid place-items-center rounded-lg bg-accent shadow-card`} aria-hidden="true">
        <svg viewBox="0 0 512 512" className="h-[62%] w-[62%]">
          <path d="M80 360l112-128 88 72 152-176" stroke="#fff" strokeWidth="56" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={`${size === 'sm' ? 'text-base' : 'text-lg'} font-bold tracking-tight text-ink`}>Solbot</span>
    </span>
  );
}

/** "PAPER" (simulated money) or "LIVE" (real money) — text label, so colour isn't the only cue. */
export function ModePill({ mode }: { mode: 'PAPER' | 'LIVE' | undefined }) {
  if (!mode) return null;
  const live = mode === 'LIVE';
  return (
    <span
      title={live ? 'Live trading with real money' : 'Paper trading: simulated money'}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold tracking-wider ${live ? 'border-critical/50 bg-critical/15 text-down' : 'border-accent/40 bg-accent/10 text-accent'}`}
    >
      {live ? '● LIVE' : 'PAPER'}
    </span>
  );
}

/** Footer on every page: one quiet line — connection, mode, last restart. */
export function AppFooter({ mode, status, paused, uptimeSec }: { mode: 'PAPER' | 'LIVE' | undefined; status: ConnStatus; paused?: boolean; uptimeSec?: number | null }) {
  // Re-render every 30s so "restarted Xm ago" stays current.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const st =
    status === 'offline'
      ? { dot: 'bg-critical', text: 'Offline, reconnecting' }
      : status === 'reconnecting'
        ? { dot: 'bg-warning', text: 'Reconnecting' }
        : paused
          ? { dot: 'bg-warning', text: 'Connected · paused' }
          : { dot: 'bg-good', text: 'Connected' };
  const restarted = restartNote(uptimeSec);
  return (
    <footer className="mx-auto mt-8 w-full max-w-7xl px-4 pb-2 text-center text-xs text-muted sm:px-6 md:text-left">
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-line pt-4 md:justify-between">
        <span className="inline-flex items-center gap-1.5" role="status">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} aria-hidden="true" />
          {st.text}
          {restarted && <span>· {restarted}</span>}
        </span>
        <span>{mode === 'LIVE' ? <strong className="font-semibold text-down">Live trading: real money at risk</strong> : 'Paper trading · simulated money · not financial advice'}</span>
      </div>
    </footer>
  );
}
