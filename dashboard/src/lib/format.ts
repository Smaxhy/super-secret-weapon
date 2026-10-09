/** Number / time formatting used everywhere. SOL amounts in the UI are always SOL, never lamports. */

export const sol = (v: number | null | undefined, dp = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(dp)} SOL`);

/** Signed SOL for P&L: "+0.120 SOL" / "−0.050 SOL". */
export const pnl = (v: number | null | undefined, dp = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)} SOL`;

export const pct = (v: number | null | undefined, dp = 1, signed = false) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}%`;

export const num = (v: number | null | undefined, dp = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });

/** Tiny prices like 0.0000000412 → "4.12e-8". */
export const price = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v < 0.0001 ? v.toExponential(2) : v.toFixed(6));

export const multiple = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}×`);

export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return duration(s) + ' ago';
}

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export const STRATEGY_LABEL: Record<string, string> = {
  CURVE_SNIPE: 'Curve snipe',
  MIGRATION_MOMENTUM: 'Migration',
  SMART_MONEY_COPY: 'Smart money',
};

export const EXIT_LABEL: Record<string, string> = {
  TAKE_PROFIT: 'Take profit',
  TRAILING_STOP: 'Trailing stop',
  STOP_LOSS: 'Stop loss',
  RUG_DETECTED: 'Rug detected',
  STALE: 'No movement',
  MANUAL: 'Manual',
  KILL_SWITCH: 'Kill switch',
  CIRCUIT_BREAKER: 'Circuit breaker',
  MIGRATED: 'Migrated',
  COPY_EXIT: 'Copied wallet sold',
};
