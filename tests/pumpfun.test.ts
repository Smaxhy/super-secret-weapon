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

import { DISCRIMINATORS as D, PUMP_AMM_PROGRAM_ID, WSOL_MINT } from '../src/lib/pumpfun';
import bs58 from 'bs58';

describe('PumpSwap events', () => {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const key = (k: string) => Buffer.from(bs58.decode(k));
  const ammLine = (b: Buffer) => `Program data: ${b.toString('base64')}`;
  const pool = randomKey();
  const token = randomKey();
  const user = randomKey();

  it('decodes CreatePoolEvent and buy/sell with post-trade reserves', () => {
    const create = Buffer.concat([D.ammCreatePool, u64(1_760_000_000n), Buffer.from([0, 0]), key(randomKey()), key(token), key(WSOL_MINT), Buffer.from([6, 9]),
      u64(1n), u64(1n), u64(206_900_000_000_000n), u64(84_990_000_000n), u64(0n), u64(0n), u64(0n), Buffer.from([255]), key(pool), key(randomKey()), key(randomKey()), key(randomKey())]);
    const tradeBody = (isBuy: boolean) => Buffer.concat([isBuy ? D.ammBuy : D.ammSell, u64(1_760_000_100n), u64(1_000_000_000_000n), u64(0n), u64(0n), u64(0n),
      u64(206_900_000_000_000n), u64(84_990_000_000n), u64(500_000_000n), u64(20n), u64(1_000_000n), u64(5n), u64(250_000n), u64(0n), u64(0n), key(pool), key(user), key(randomKey())]);
    const logs = [`Program ${PUMP_AMM_PROGRAM_ID} invoke [1]`, ammLine(create), ammLine(tradeBody(true)), ammLine(tradeBody(false)), `Program ${PUMP_AMM_PROGRAM_ID} success`];
    const evs = parsePumpLogs(logs).events;
    expect(evs[0]).toMatchObject({ kind: 'ammPool', pool, baseMint: token, quoteMint: WSOL_MINT, baseReserve: 206_900_000_000_000n, quoteReserve: 84_990_000_000n });
    expect(evs[1]).toMatchObject({ kind: 'ammTrade', pool, user, isBuy: true, baseAmount: 1_000_000_000_000n, quoteAmount: 500_000_000n, baseReserve: 205_900_000_000_000n, quoteReserve: 85_490_000_000n, feeLamports: 1_250_000n });
    expect(evs[2]).toMatchObject({ kind: 'ammTrade', isBuy: false, baseReserve: 207_900_000_000_000n, quoteReserve: 84_490_000_000n });
  });
});

import { decodeBondingCurveAccount } from '../src/lib/pumpfun';
describe('bonding curve account', () => {
  it('decodes reserves and the complete flag', () => {
    const b = Buffer.alloc(81);
    b.writeBigUInt64LE(900_000_000_000_000n, 8);
    b.writeBigUInt64LE(35_000_000_000n, 16);
    b.writeUInt8(1, 48);
    expect(decodeBondingCurveAccount(b)).toEqual({ virtualTokenReserves: 900_000_000_000_000n, virtualSolReserves: 35_000_000_000n, complete: true });
    expect(decodeBondingCurveAccount(Buffer.alloc(10))).toBeNull();
  });
});
