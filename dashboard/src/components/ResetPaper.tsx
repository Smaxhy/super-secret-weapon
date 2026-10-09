/**
 * "Reset paper account": wipes all paper trades and positions (open ones too)
 * and starts again with a chosen fake balance. Learning data is kept.
 * Used inline on the Controls page and as a pop-up from the Overview hero.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { refreshAll } from '../lib/refresh';

export interface ResetResult {
  ok: true;
  positions: number;
  trades: number;
  closedOpen: number;
  startingBalanceSol: number;
  resetAt: string;
}

export const MIN_START = 0.1;
export const MAX_START = 1000;

export function ResetPaperForm({ defaultBalance = 10, onDone, onCancel }: { defaultBalance?: number; onDone?: (r: ResetResult) => void; onCancel?: () => void }) {
  const id = useId();
  const [balance, setBalance] = useState(String(defaultBalance));
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = Number(balance);
  const validBalance = Number.isFinite(n) && n >= MIN_START && n <= MAX_START;
  const ready = validBalance && confirm.trim().toUpperCase() === 'RESET' && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<ResetResult>('/api/controls/reset-paper', { method: 'POST', body: JSON.stringify({ confirm: 'RESET', startingBalanceSol: n }) });
      setMsg({ ok: true, text: `✓ Fresh start with ${r.startingBalanceSol} SOL — removed ${r.positions} positions and ${r.trades} trades.` });
      setConfirm('');
      refreshAll();
      onDone?.(r);
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">
        Deletes every paper trade and position (open ones are closed first), so profit, win rate, charts and history start from zero. What the bot has learned is kept.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-bal`} className="flex flex-col gap-1 text-sm text-ink-2">
          Start again with
          <span className="flex items-center gap-2">
            <input
              id={`${id}-bal`}
              type="number"
              inputMode="decimal"
              min={MIN_START}
              max={MAX_START}
              step="any"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink tabular"
              aria-invalid={!validBalance}
            />
            <span className="shrink-0 text-ink-2">SOL</span>
          </span>
          <span className={`text-xs ${validBalance ? 'text-muted' : 'text-down'}`}>Fake money, {MIN_START}–{MAX_START} SOL.</span>
        </label>
        <label htmlFor={`${id}-confirm`} className="flex flex-col gap-1 text-sm text-ink-2">
          Type RESET to confirm
          <input
            id={`${id}-confirm`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="RESET"
            className="w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink"
          />
        </label>
      </div>
      {msg && (
        <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${msg.ok ? 'border-good/40 bg-good/10 text-ink' : 'border-critical/40 bg-critical/10 text-ink'}`}>
          {msg.text}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!ready} className="rounded-xl bg-critical px-4 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Resetting…' : 'Reset paper account'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-xl border border-line px-4 py-3 font-semibold text-ink">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The same form in a pop-up (bottom sheet on phones). */
export function ResetPaperDialog({ open, onClose, defaultBalance }: { open: boolean; onClose: () => void; defaultBalance?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Reset paper account"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-2xl sm:p-6"
      >
        <h2 className="mb-3 text-lg font-semibold text-ink">Reset paper account</h2>
        <ResetPaperForm defaultBalance={defaultBalance} onDone={() => setTimeout(onClose, 1_200)} onCancel={onClose} />
      </div>
    </div>
  );
}
