/**
 * Pure helpers for the WebSocket connection (no DOM), kept separate so the
 * rules are easy to read and test.
 */

/** Reconnect delay: exponential (1s, 2s, 4s … 30s max) with ±30% jitter so many tabs don't retry in lockstep. */
export function backoffDelay(attempt: number, rand: number = Math.random(), baseMs = 1_000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.7 + rand * 0.6; // 0.7 … 1.3
  return Math.round(Math.min(capMs, exp * jitter));
}

/** The server sends a heartbeat every 20s; no message at all for this long = dead socket. */
export const SILENT_TIMEOUT_MS = 45_000;
/** Only call it "Offline" after this long without a connection (short blips show "Reconnecting…"). */
export const OFFLINE_AFTER_MS = 10_000;

export type ConnStatus = 'online' | 'reconnecting' | 'offline';

/** What the badge should say, given whether we're connected and when we lost the connection. */
export function connStatus(connected: boolean, disconnectedSince: number | null, now: number): ConnStatus {
  if (connected) return 'online';
  if (disconnectedSince === null) return 'reconnecting';
  return now - disconnectedSince > OFFLINE_AFTER_MS ? 'offline' : 'reconnecting';
}

/** "restarted 3m ago" text when the bot process is younger than 10 minutes, else null. */
export function restartNote(uptimeSec: number | null | undefined): string | null {
  if (uptimeSec === null || uptimeSec === undefined || !Number.isFinite(uptimeSec) || uptimeSec >= 600) return null;
  if (uptimeSec < 60) return 'Bot restarted just now';
  return `Bot restarted ${Math.floor(uptimeSec / 60)}m ago`;
}
