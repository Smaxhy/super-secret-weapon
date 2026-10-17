import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePumpSwapPool, effectiveQuoteReserve, reservesAgree } from '../src/lib/pumpswap-pool';
import { decodeBondingCurveAccount } from '../src/lib/pumpfun';
import { poolOf } from '../src/executor/paper-trader';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const DEFAULT_PK = '11111111111111111111111111111111';

/** Pool account per the Chainstack protocol doc: coin_creator @211, is_mayhem @243, virtual_quote_reserves i128 @245. */
function poolBuf(o: { size: number; coinCreator?: PublicKey; virtual?: bigint; mayhem?: boolean }): Buffer {
  const b = Buffer.alloc(o.size);
  b.writeUInt16LE(0, 9);
  key(1).toBuffer().copy(b, 11);
  key(2).toBuffer().copy(b, 43); // base_mint
  key(3).toBuffer().copy(b, 75); // quote_mint
  key(4).toBuffer().copy(b, 107);
  key(5).toBuffer().copy(b, 139);
  key(6).toBuffer().copy(b, 171);
  b.writeBigUInt64LE(123_456n, 203);
  if (o.coinCreator) o.coinCreator.toBuffer().copy(b, 211);
  if (o.size >= 261) {
    b.writeUInt8(o.mayhem ? 1 : 0, 243);
    const v = o.virtual ?? 0n;
    b.writeBigUInt64LE(BigInt.asUintN(64, v), 245);
    b.writeBigInt64LE(v >> 64n, 253);
  }
  return b;
}

describe('PumpSwap pool account (v11.8)', () => {
  it('301-byte live pool: coin_creator set → canonical, signed virtual quote reserve read as i128', () => {
    const p = decodePumpSwapPool(poolBuf({ size: 301, coinCreator: key(7), virtual: 5_000_000_000n, mayhem: true }))!;
    expect(p.size).toBe(301);
    expect(p.baseMint).toBe(key(2).toBase58());
    expect(p.quoteMint).toBe(key(3).toBase58());
    expect(p.poolQuoteTokenAccount).toBe(key(6).toBase58());
    expect(p.lpSupply).toBe(123_456n);
    expect(p.coinCreator).toBe(key(7).toBase58());
    expect(p.canonical).toBe(true);
    expect(p.isMayhemMode).toBe(true);
    expect(p.virtualQuoteReserves).toBe(5_000_000_000n);
    const neg = decodePumpSwapPool(poolBuf({ size: 301, coinCreator: key(7), virtual: -3_000_000_000n }))!;
    expect(neg.virtualQuoteReserves).toBe(-3_000_000_000n);
  });
  it('old 245-byte layout: no virtual field; default coin_creator → not canonical', () => {
    const p = decodePumpSwapPool(poolBuf({ size: 245 }))!;
    expect(p.virtualQuoteReserves).toBeNull();
    expect(p.isMayhemMode).toBeNull();
    expect(p.coinCreator).toBe(DEFAULT_PK);
    expect(p.canonical).toBe(false);
    expect(decodePumpSwapPool(Buffer.alloc(100))).toBeNull();
  });
  it('effective reserve = vault + virtual (signed), never below 0; agreement within 5%', () => {
    expect(effectiveQuoteReserve(10_000_000_000n, 5_000_000_000n)).toBe(15_000_000_000n);
    expect(effectiveQuoteReserve(10_000_000_000n, -3_000_000_000n)).toBe(7_000_000_000n);
    expect(effectiveQuoteReserve(10_000_000_000n, null)).toBe(10_000_000_000n);
    expect(effectiveQuoteReserve(1_000n, -5_000n)).toBe(0n);
    expect(reservesAgree(104n, 100n)).toBe(true);
    expect(reservesAgree(106n, 100n)).toBe(false);
    expect(reservesAgree(0n, 100n)).toBe(false);
  });
});

/** BondingCurve per the doc: complete @48, creator @49, is_mayhem @81, quote_mint @83, creator_fee_bps @115, is_holder_reward @124. */
function curveBuf(size: number, o: { feeBps?: bigint; holder?: boolean } = {}): Buffer {
  const b = Buffer.alloc(size);
  b.writeBigUInt64LE(1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(30_000_000_000n, 16);
  if (size >= 81) key(9).toBuffer().copy(b, 49);
  if (size >= 115) key(3).toBuffer().copy(b, 83);
  if (size >= 125) {
    b.writeBigUInt64LE(o.feeBps ?? 0n, 115);
    b.writeUInt8(o.holder ? 1 : 0, 124);
  }
  return b;
}

describe('bonding curve account: create_v2 fields (v11.8)', () => {
  it('125 bytes: creator fee + holder reward; 151 / 256 decode the same way; short accounts → null fee', () => {
    const v2 = decodeBondingCurveAccount(curveBuf(125, { feeBps: 30n, holder: true }))!;
    expect(v2.virtualSolReserves).toBe(30_000_000_000n);
    expect(v2.creator).toBe(key(9).toBase58());
    expect(v2.quoteMint).toBe(key(3).toBase58());
    expect(v2.creatorFeeBps).toBe(30);
    expect(v2.isHolderReward).toBe(true);
    const old = decodeBondingCurveAccount(curveBuf(151))!;
    expect(old.creatorFeeBps).toBe(0);
    expect(old.isHolderReward).toBe(false);
    expect(decodeBondingCurveAccount(curveBuf(256, { feeBps: 50n }))!.creatorFeeBps).toBe(50);
    const short = decodeBondingCurveAccount(curveBuf(49))!;
    expect(short.creatorFeeBps).toBeNull();
    expect(short.creator).toBeUndefined();
  });
  it('the curve fee the paper trader charges includes the on-chain creator fee', () => {
    const curve = { initialVirtualSolReserves: 30_000_000_000n, initialVirtualTokenReserves: 1_073_000_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, totalSupply: 1_000_000_000_000_000n };
    const base = { ammBaseReserve: null, ammQuoteReserve: null, curve, complete: false, virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n };
    const p = { curveFeeBps: 125, ammFeeBps: 30 };
    expect(poolOf({ ...base, creatorFeeBps: 30 }, p)!.feeBps).toBe(155);
    expect(poolOf({ ...base, creatorFeeBps: null }, p)!.feeBps).toBe(125);
    expect(poolOf(base, p)!.feeBps).toBe(125);
  });
});
