/**
 * "Add paper SOL": tops up the fake balance WITHOUT a reset — trades, stats and everything the
 * bot learned stay. The top-up counts as money put in, not as profit.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { refreshAll } from '../lib/refresh';

const MAX_ADD = 1000;

export function AddFundsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [amount, setAmount] = useState('5');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setMsg(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 0.01 && n <= MAX_ADD;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ addedSol: number; totalAddedSol: number }>('/api/controls/add-funds', { method: 'POST', body: JSON.stringify({ sol: n }) });
      setMsg({ ok: true, text: `✓ Added ${r.addedSol} SOL (${r.totalAddedSol} SOL added since the last reset).` });
      refreshAll();
      setTimeout(onClose, 1_200);
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Add paper SOL"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-2xl sm:p-6"
      >
        <h2 className="mb-3 text-lg font-semibold text-ink">Add paper SOL</h2>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">Tops up the fake balance so the bot can keep trading. Nothing is deleted — trades, stats and everything it learned stay. The added SOL isn't counted as profit.</p>
          <label htmlFor={`${id}-amt`} className="flex flex-col gap-1 text-sm text-ink-2">
            Amount
            <span className="flex items-center gap-2">
              <input
                id={`${id}-amt`}
                type="number"
                inputMode="decimal"
                min={0.01}
                max={MAX_ADD}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink tabular"
                aria-invalid={!valid}
              />
              <span className="shrink-0 text-ink-2">SOL</span>
            </span>
            <span className={`text-xs ${valid ? 'text-muted' : 'text-down'}`}>Fake money, 0.01–{MAX_ADD} SOL.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {[1, 5, 10].map((v) => (
              <button key={v} type="button" onClick={() => setAmount(String(v))} className="rounded-full border border-line px-3 py-1 text-sm text-ink-2 hover:bg-surface-2">
                +{v} SOL
              </button>
            ))}
          </div>
          {msg && <p className={`text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm text-ink-2 hover:bg-surface-2">
              Cancel
            </button>
            <button type="submit" disabled={!valid || busy} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? 'Adding…' : 'Add SOL'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
