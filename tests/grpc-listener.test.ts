import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from '../src/lib/pumpfun';
import { eventsFromTx, subscribeRequest } from '../src/scanner/grpc-listener';
import { dataLine, encodeTrade, pumpInvoke, pumpSuccess, randomKey } from './helpers';

describe('Yellowstone gRPC stream (off until a paid endpoint is set)', () => {
  const mint = randomKey();
  const logs = [pumpInvoke(), dataLine(encodeTrade({ mint, sol: 500_000_000n, tokens: 17_000_000_000_000n, isBuy: true, user: randomKey(), ts: 1_760_000_000, vSol: 31_000_000_000n, vTok: 1_030_000_000_000_000n })), pumpSuccess()];

  it('decodes the same pump.fun events as the free log stream, signature as base58', () => {
    const sig = new Uint8Array(64).fill(7);
    const r = eventsFromTx({ signature: sig, slot: '123', failed: false, logs })!;
    expect(r.signature).toBe(bs58.encode(sig));
    expect(r.slot).toBe(123);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.kind).toBe('trade');
  });
  it('ignores failed transactions', () => {
    expect(eventsFromTx({ signature: 'x', slot: 1, failed: true, logs })).toBeNull();
  });
  it('subscribes to successful pump.fun + PumpSwap transactions only', () => {
    const req = subscribeRequest(1) as { transactions: Record<string, { failed: boolean; vote: boolean; accountInclude: string[] }>; commitment: number };
    expect(req.transactions.pump!.accountInclude).toEqual([PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]);
    expect(req.transactions.pump!.failed).toBe(false);
    expect(req.transactions.pump!.vote).toBe(false);
    expect(req.commitment).toBe(1);
  });
});
