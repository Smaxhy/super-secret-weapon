/** App chrome pieces: logo + name, PAPER/LIVE pill, and the footer shown on every page. */

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

/**
 * Footer ("bottom text") on every page. On phones it sits at the end of the
 * page content, above the fixed bottom nav (the wrapper adds room for it).
 */
export function AppFooter({ mode, connected, paused }: { mode: 'PAPER' | 'LIVE' | undefined; connected: boolean; paused?: boolean }) {
  const status = !connected ? { dot: 'bg-critical', text: 'Offline — reconnecting…' } : paused ? { dot: 'bg-warning', text: 'Connected · bot paused' } : { dot: 'bg-good', text: 'Connected · updating live' };
  return (
    <footer className="mx-auto mt-10 w-full max-w-7xl border-t border-line px-4 pt-4 text-xs leading-relaxed text-muted sm:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {mode === 'LIVE' ? (
            <strong className="text-down">Live trading — real money at risk.</strong>
          ) : (
            <span>
              <strong className="font-semibold text-ink-2">Paper trading</strong> — simulated money, not financial advice.
            </span>
          )}{' '}
          Data: PumpPortal + Solana · Prices update every ~2s.
        </p>
        <p className="inline-flex items-center gap-2" role="status">
          <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden="true" />
          {status.text}
        </p>
      </div>
      <p className="mt-1.5">Solbot · Pump.fun scanner, scorer &amp; trader · {new Date().getFullYear()}</p>
    </footer>
  );
}
