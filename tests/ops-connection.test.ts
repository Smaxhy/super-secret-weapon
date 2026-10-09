import { describe, expect, it, vi } from 'vitest';
import { ErrorBudget, isRecoverableError, triageUncaught } from '../src/lib/process-guard';
import { heartbeat, MAX_BUFFERED_BYTES, safeSend, type HeartbeatSocket } from '../src/api/websocket';

const sock = (over: Partial<HeartbeatSocket> = {}) => ({
  readyState: 1,
  OPEN: 1,
  bufferedAmount: 0,
  send: vi.fn(),
  ping: vi.fn(),
  terminate: vi.fn(),
  ...over,
});

describe('websocket heartbeat', () => {
  it('pings + sends hb while the client answers, terminates when it does not', () => {
    const s = sock();
    const st = { alive: true };
    expect(heartbeat(s, st, 1)).toBe(true);
    expect(s.ping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.send.mock.calls[0]![0] as string)).toEqual({ type: 'hb', data: { t: 1 } });
    expect(st.alive).toBe(false);
    // no pong arrived → next round terminates
    expect(heartbeat(s, st, 2)).toBe(false);
    expect(s.terminate).toHaveBeenCalled();
  });
  it('a pong in between keeps it alive', () => {
    const s = sock();
    const st = { alive: true };
    heartbeat(s, st);
    st.alive = true; // pong
    expect(heartbeat(s, st)).toBe(true);
    expect(s.terminate).not.toHaveBeenCalled();
  });
  it('stops on a closed socket', () => {
    expect(heartbeat(sock({ readyState: 3 }), { alive: true })).toBe(false);
  });
  it('safeSend skips backed-up or closed sockets', () => {
    expect(safeSend(sock(), 'x')).toBe(true);
    expect(safeSend(sock({ bufferedAmount: MAX_BUFFERED_BYTES + 1 }), 'x')).toBe(false);
    expect(safeSend(sock({ readyState: 2 }), 'x')).toBe(false);
    expect(safeSend(sock({ send: () => { throw new Error('closed'); } }), 'x')).toBe(false);
  });
});

describe('process guard', () => {
  it('classifies network blips as recoverable', () => {
    expect(isRecoverableError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRecoverableError(new Error('socket hang up'))).toBe(true);
    expect(isRecoverableError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }) }))).toBe(true);
    expect(isRecoverableError({ errorCode: 'P1001', message: 'db' })).toBe(true);
  });
  it('treats real bugs as fatal', () => {
    expect(isRecoverableError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
    expect(isRecoverableError('ECONNRESET')).toBe(false);
  });
  it('exits after too many recoverable errors in a minute', () => {
    const b = new ErrorBudget(3);
    const e = Object.assign(new Error('x'), { code: 'EPIPE' });
    expect([1, 2, 3].map((t) => triageUncaught(e, b, t))).toEqual(['continue', 'continue', 'continue']);
    expect(triageUncaught(e, b, 4)).toBe('exit');
    // a minute later the budget refills
    expect(triageUncaught(e, b, 70_000)).toBe('continue');
    expect(triageUncaught(new Error('bug'), b, 70_001)).toBe('exit');
  });
});
