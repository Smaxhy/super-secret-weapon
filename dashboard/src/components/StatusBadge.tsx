import type { ConnStatus } from '../lib/reconnect';

/** Status pill: icon + label + colour (never colour alone). */
export type FeedStatus = 'bought' | 'flagged' | 'interesting' | 'skipped' | 'pending';

const STYLES: Record<FeedStatus, { icon: string; label: string; cls: string }> = {
  bought: { icon: '✓', label: 'Bought', cls: 'bg-good/15 text-up border-good/40' },
  flagged: { icon: '✕', label: 'Dangerous', cls: 'bg-critical/15 text-down border-critical/40' },
  interesting: { icon: '★', label: 'Interesting', cls: 'bg-warning/15 text-ink border-warning/50' },
  skipped: { icon: '–', label: 'Skipped', cls: 'bg-surface-2 text-ink-2 border-line' },
  pending: { icon: '…', label: 'Checking', cls: 'bg-surface-2 text-ink-2 border-line' },
};

export function StatusBadge({ status }: { status: FeedStatus }) {
  const s = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}

export function BotStatusBadge({ status, paused, compact = false }: { status: ConnStatus; paused?: boolean; compact?: boolean }) {
  const state =
    status === 'offline'
      ? { dot: 'bg-critical', label: 'Offline' }
      : status === 'reconnecting'
        ? { dot: 'bg-warning animate-pulse', label: 'Reconnecting…' }
        : paused
          ? { dot: 'bg-warning', label: 'Paused' }
          : { dot: 'bg-good', label: 'Live' };
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-surface font-medium text-ink ${compact ? 'gap-1.5 px-2.5 py-1 text-xs' : 'gap-2 px-3 py-1 text-sm'}`} role="status">
      <span className={`${compact ? 'h-2 w-2' : 'h-2.5 w-2.5'} rounded-full ${state.dot}`} aria-hidden="true" />
      {state.label}
    </span>
  );
}
