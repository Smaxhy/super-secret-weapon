/** Pop-up notices for trades as they happen (any page). */
import { useCallback, useState } from 'react';
import { useBotEvents, type BotEvent } from '../hooks/useWebSocket';

interface Toast {
  id: number;
  text: string;
  why?: string | null;
  tone: 'up' | 'down' | 'neutral';
}

let nextId = 1;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const onEvent = useCallback((e: BotEvent) => {
    if (e.type !== 'trade') return;
    const d = e.data as { side: string; symbol?: string; mint: string; amountSol: number; reason: string; pnlSol?: number; mode: string; peakMultiple?: number; closed?: boolean; totalPnlSol?: number; explanation?: string | null };
    const name = d.symbol ?? d.mint.slice(0, 6);
    const tag = d.mode === 'PAPER' ? '📝' : '💸';
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} SOL`;
    const text =
      d.side === 'SELL' && d.closed && d.totalPnlSol !== undefined
        ? `${tag} Closed ${name}: ${signed(d.totalPnlSol)} total · max profit ${d.peakMultiple ? `${((d.peakMultiple - 1) * 100).toFixed(0)}% (${d.peakMultiple.toFixed(2)}×)` : '—'}`
        : d.side === 'BUY'
        ? `${tag} Bought ${name} for ${d.amountSol.toFixed(3)} SOL`
        : `${tag} Sold ${name}: ${d.pnlSol !== undefined ? `${d.pnlSol >= 0 ? '+' : '−'}${Math.abs(d.pnlSol).toFixed(3)} SOL` : ''} (${d.reason.split(':')[0]?.toLowerCase().replace(/_/g, ' ')})`;
    const tone = d.side === 'BUY' ? 'neutral' : ((d.closed ? d.totalPnlSol : d.pnlSol) ?? 0) >= 0 ? 'up' : 'down';
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, text, tone, why: d.explanation }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 9_000);
    if (navigator.vibrate) navigator.vibrate(40);
  }, []);
  useBotEvents(onEvent);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[max(4rem,calc(env(safe-area-inset-top)+3.5rem))] z-40 flex flex-col items-center gap-2 px-4 md:top-4 md:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto w-full max-w-sm rounded-xl border bg-surface px-4 py-3 text-sm font-medium shadow-lg ${t.tone === 'up' ? 'border-good/50 text-up' : t.tone === 'down' ? 'border-critical/50 text-down' : 'border-line text-ink'}`}
        >
          {t.text}
          {t.why && <div className="mt-1 text-xs font-normal leading-snug text-ink-2">{t.why}</div>}
        </div>
      ))}
    </div>
  );
}
