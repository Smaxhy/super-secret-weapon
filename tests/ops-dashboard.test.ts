import { describe, expect, it } from 'vitest';
import { backoffDelay, connStatus, OFFLINE_AFTER_MS, restartNote } from '../dashboard/src/lib/reconnect';

describe('dashboard reconnect rules', () => {
  it('backs off exponentially with jitter, capped at 30s', () => {
    expect(backoffDelay(0, 0.5)).toBe(1000);
    expect(backoffDelay(1, 0.5)).toBe(2000);
    expect(backoffDelay(3, 0.5)).toBe(8000);
    expect(backoffDelay(20, 1)).toBe(30_000);
    expect(backoffDelay(2, 0)).toBe(2800);
    expect(backoffDelay(2, 1)).toBe(5200);
  });
  it('shows Reconnecting for short blips and Offline only after 10s', () => {
    expect(connStatus(true, null, 0)).toBe('online');
    expect(connStatus(false, null, 0)).toBe('reconnecting');
    expect(connStatus(false, 1000, 1000 + OFFLINE_AFTER_MS)).toBe('reconnecting');
    expect(connStatus(false, 1000, 1001 + OFFLINE_AFTER_MS)).toBe('offline');
  });
  it('mentions a restart only in the first 10 minutes', () => {
    expect(restartNote(30)).toBe('Bot restarted just now');
    expect(restartNote(5 * 60 + 10)).toBe('Bot restarted 5m ago');
    expect(restartNote(600)).toBeNull();
    expect(restartNote(null)).toBeNull();
  });
});
