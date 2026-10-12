/** Small shared building blocks: cards, headers, tabs, stats, rows and states — one look across every page. */
import { useState, type ReactNode } from 'react';
import { pnl } from '../lib/format';
import { Icon } from './Icon';

export function Card({ title, subtitle, action, children, className = '' }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="break-words text-[15px] font-semibold leading-snug text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-pretty text-[13px] leading-snug text-muted">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0 text-sm">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Vertical stack with the standard gap between cards. */
export function Stack({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-w-0 flex-col gap-4 ${className}`}>{children}</div>;
}

/** Small uppercase label above a group of rows or stats. */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted ${className}`}>{children}</div>;
}

/** Headline number with a label (used in grids). */
export function StatTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink';
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-3.5 shadow-card sm:p-4">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className={`tabular mt-1 break-words text-lg font-semibold leading-tight sm:text-xl ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/** Label + value inside a card (no box of its own). */
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink';
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={`tabular mt-0.5 break-words font-semibold leading-snug ${color}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Key/value list with hairline dividers — the default way to show "name … number" lines. */
export function Rows({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={`divide-y divide-line text-sm ${className}`}>{children}</ul>;
}
export function Row({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'muted' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'muted' ? 'text-muted' : 'text-ink';
  return (
    <li className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="break-words text-ink-2">{label}</div>
        {sub && <div className="break-words text-xs text-muted">{sub}</div>}
      </div>
      <div className={`tabular shrink-0 text-right font-medium ${color}`}>{value}</div>
    </li>
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
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-2 sm:mb-5">
      <div className="min-w-0 max-w-full">
        <h1 className="break-words text-[22px] font-bold leading-tight tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-pretty text-sm leading-snug text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-ink-2">{children}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-xl border border-critical/40 bg-critical/10 px-3.5 py-3 text-sm text-ink">
      <Icon name="alert" size={18} className="mt-px text-critical" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/** Placeholder blocks while a page loads (keeps the layout from jumping). */
export function Loading() {
  return (
    <div className="space-y-3 py-2" role="status" aria-label="Loading">
      <div className="h-6 w-40 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-28 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-20 animate-pulse rounded-2xl bg-surface-2" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:bg-surface-2'}`}
    >
      {children}
    </button>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface TabDef<K extends string> {
  key: K;
  label: string;
  badge?: ReactNode;
}

/**
 * Segmented tabs. `sticky` pins them under the phone header while the page scrolls (page-level sections);
 * without it they're an inline switch (e.g. a timeframe picker). Scrolls sideways when the labels don't fit.
 */
export function Tabs<K extends string>({ tabs, value, onChange, sticky = false, label = 'Sections', className = '' }: { tabs: ReadonlyArray<TabDef<K>>; value: K; onChange: (k: K) => void; sticky?: boolean; label?: string; className?: string }) {
  const bar = (
    <div role="tablist" aria-label={label} className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${on ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-ink-2 hover:text-ink'}`}
          >
            {t.label}
            {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className={`rounded-full px-1.5 text-[11px] font-semibold leading-4 ${on ? 'bg-accent/12 text-accent' : 'bg-surface text-muted'}`}>{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
  if (!sticky) return <div className={className}>{bar}</div>;
  return <div className={`sticky top-[var(--hdr)] z-10 -mx-4 mb-4 bg-page/90 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 md:top-0 ${className}`}>{bar}</div>;
}

/** Tab state remembered per device (`tab.<id>` in localStorage). */
export function useTab<K extends string>(id: string, keys: readonly K[], fallback: K): [K, (k: K) => void] {
  const [tab, setTab] = useState<K>(() => {
    try {
      const v = localStorage.getItem(`tab.${id}`) as K | null;
      return v && keys.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (k: K) => {
    setTab(k);
    try {
      localStorage.setItem(`tab.${id}`, k);
    } catch {
      /* private mode */
    }
    window.scrollTo({ top: 0 });
  };
  return [tab, set];
}
