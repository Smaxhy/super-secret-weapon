/** Small shared building blocks. */
import type { ReactNode } from 'react';
import { pnl } from '../lib/format';

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="min-w-0 break-words text-base font-semibold text-ink">{title}</h2>}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Big headline number with a label underneath. */
export function StatTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink';
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <div className="break-words text-sm leading-snug text-ink-2">{label}</div>
      <div className={`tabular mt-1 break-words text-lg font-semibold leading-tight sm:text-2xl ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
    </div>
  );
}

/** Signed P&L in up/down text colour, with an arrow so colour isn't the only cue. */
export function Pnl({ value, dp = 3, className = '' }: { value: number | null | undefined; dp?: number; className?: string }) {
  if (value === null || value === undefined) return <span className={`text-muted ${className}`}>—</span>;
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-ink-2';
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '';
  return (
    <span className={`tabular whitespace-nowrap font-medium ${tone} ${className}`}>
      {arrow && <span aria-hidden="true" className="mr-1 text-[0.7em]">{arrow}</span>}
      {pnl(value, dp)}
    </span>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-w-full">
        <h1 className="break-words text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-pretty text-ink-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{children}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-4 rounded-lg border border-critical/40 bg-critical/10 px-4 py-3 text-ink">
      <strong className="text-critical">⚠ Problem:</strong> {message}
    </div>
  );
}

export function Loading() {
  return <div className="py-10 text-center text-ink-2" role="status">Loading…</div>;
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:bg-surface-2'}`}
    >
      {children}
    </button>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-ink-2">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-surface px-3 py-2 text-ink">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
