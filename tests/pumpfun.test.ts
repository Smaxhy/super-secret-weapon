import { describe, expect, it } from 'vitest';
import {
  bondingCurvePct,
  curveLiquiditySol,
  curvePriceSol,
  decodeEventsFromInnerInstructions,
  marketCapSol,
  parsePumpLogs,
  PUMP_PROGRAM_ID,
} from '../src/lib/pumpfun';
import { dataLine, emitCpiData, encodeComplete, encodeCreate, encodeTrade, pumpInvoke, pumpSuccess, randomKey } from './helpers';

const mint = randomKey();
const dev = randomKey();
const curve = randomKey();
const create = { name: 'Test Coin', symbol: 'TEST', uri: 'https://ipfs.io/ipfs/abc', mint, bondingCurve: curve, user: dev, creator: dev, timestamp: 1_760_000_000 };

describe('parsePumpLogs', () => {
  it('decodes a create + dev buy transaction', () => {
    const logs = [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      pumpInvoke(1),
      'Program log: Instruction: CreateV2',
      dataLine(encodeCreate(create)),
      pumpSuccess(),
      pumpInvoke(1),
      'Program log: Instruction: Buy',
      dataLine(encodeTrade({ mint, sol: 1_000_000_000n, tokens: 34_612_903_225_806n, isBuy: true, user: dev, ts: create.timestamp, vSol: 31_000_000_000n, vTok: 1_038_387_096_774_194n })),
      pumpSuccess(),
    ];
    const r = parsePumpLogs(logs);
    expect(r.sawCreateInstruction).toBe(true);
    expect(r.decodeErrors).toBe(0);
    expect(r.events).toHaveLength(2);
    const [c, t] = r.events;
    expect(c).toMatchObject({ kind: 'create', name: 'Test Coin', symbol: 'TEST', mint, creator: dev, timestamp: create.timestamp });
    expect(c?.kind === 'create' && c.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(t).toMatchObject({ kind: 'trade', mint, isBuy: true, user: dev, solAmount: 1_000_000_000n, feeLamports: 2n });
  });

  it('decodes the legacy (short) CreateEvent layout', () => {
    const r = parsePumpLogs([pumpInvoke(), 'Program log: Instruction: Create', dataLine(encodeCreate(create, true)), pumpSuccess()]);
    expect(r.events[0]).toMatchObject({ kind: 'create', mint, creator: dev });
  });

  it('ignores identically-named events emitted by OTHER programs', () => {
    const other = randomKey();
    const logs = [
      `Program ${other} invoke [1]`,
      dataLine(encodeTrade({ mint, sol: 1n, tokens: 1n, isBuy: true, user: dev, ts: 1, vSol: 1n, vTok: 1n })),
      // pump CPI'd from another program: depth 2, should be decoded
      pumpInvoke(2),
      dataLine(encodeComplete({ user: dev, mint, bondingCurve: curve, ts: 5 })),
      pumpSuccess(),
      // back in the other program — ignored again
      dataLine(encodeTrade({ mint, sol: 1n, tokens: 1n, isBuy: false, user: dev, ts: 1, vSol: 1n, vTok: 1n })),
      `Program ${other} success`,
    ];
    const r = parsePumpLogs(logs);
    expect(r.events).toEqual([{ kind: 'complete', user: dev, mint, bondingCurve: curve, timestamp: 5 }]);
  });

  it('flags a create instruction whose event is missing (truncated logs)', () => {
    const r = parsePumpLogs([pumpInvoke(), 'Program log: Instruction: Create', 'Log truncated']);
    expect(r.sawCreateInstruction).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.events).toHaveLength(0);
  });

  it('counts corrupt event data as a decode error instead of throwing', () => {
    const bad = encodeCreate(create).subarray(0, 20);
    const r = parsePumpLogs([pumpInvoke(), dataLine(bad), pumpSuccess()]);
    expect(r.decodeErrors).toBe(1);
  });
});

describe('emit_cpi fallback', () => {
  it('decodes events from inner instruction data', () => {
    const evs = decodeEventsFromInnerInstructions([emitCpiData(encodeCreate(create)), 'notbase58!!', emitCpiData(Buffer.from('short'))]);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'create', mint });
  });
  it('uses the real program id', () => expect(PUMP_PROGRAM_ID).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
});

describe('curve maths', () => {
  it('starts at ~28 SOL market cap and 0% progress', () => {
    const price = curvePriceSol(30_000_000_000n, 1_073_000_000_000_000n);
    expect(marketCapSol(price, 1_000_000_000_000_000n)).toBeCloseTo(27.96, 1);
    expect(bondingCurvePct(1_073_000_000_000_000n)).toBe(0);
    expect(curveLiquiditySol(30_000_000_000n)).toBe(0);
  });
  it('reports 100% when all real tokens are sold', () => {
    expect(bondingCurvePct(279_900_000_000_000n)).toBe(100);
  });
  it('is ~50% half way through', () => {
    expect(bondingCurvePct(1_073_000_000_000_000n - 396_550_000_000_000n)).toBeCloseTo(50, 5);
  });
});
