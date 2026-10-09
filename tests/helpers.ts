/** Test helpers: build Borsh-encoded Pump.fun events exactly like the program does. */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { DISCRIMINATORS, EMIT_CPI_TAG, PUMP_PROGRAM_ID } from '../src/lib/pumpfun';

export const randomKey = () => Keypair.generate().publicKey.toBase58();

class W {
  parts: Buffer[] = [];
  str(s: string) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); this.parts.push(l, b); return this; }
  key(k: string) { this.parts.push(Buffer.from(bs58.decode(k))); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this; }
  bool(v: boolean) { this.parts.push(Buffer.from([v ? 1 : 0])); return this; }
  done() { return Buffer.concat(this.parts); }
}

export function encodeCreate(o: { name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string; timestamp: number }, legacy = false): Buffer {
  const w = new W().str(o.name).str(o.symbol).str(o.uri).key(o.mint).key(o.bondingCurve).key(o.user);
  if (!legacy) {
    w.key(o.creator).i64(BigInt(o.timestamp))
      .u64(1_073_000_000_000_000n).u64(30_000_000_000n).u64(793_100_000_000_000n).u64(1_000_000_000_000_000n)
      .key('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb').bool(false);
  }
  return Buffer.concat([DISCRIMINATORS.create, w.done()]);
}

export function encodeTrade(o: { mint: string; sol: bigint; tokens: bigint; isBuy: boolean; user: string; ts: number; vSol: bigint; vTok: bigint }): Buffer {
  const w = new W().key(o.mint).u64(o.sol).u64(o.tokens).bool(o.isBuy).key(o.user).i64(BigInt(o.ts)).u64(o.vSol).u64(o.vTok)
    // newer fields: real reserves, fee recipient, fee bps, fee, creator, creator fee bps, creator fee
    .u64(0n).u64(0n).key(randomKey()).u64(95n).u64(1n).key(randomKey()).u64(5n).u64(1n);
  return Buffer.concat([DISCRIMINATORS.trade, w.done()]);
}

export function encodeComplete(o: { user: string; mint: string; bondingCurve: string; ts: number }): Buffer {
  return Buffer.concat([DISCRIMINATORS.complete, new W().key(o.user).key(o.mint).key(o.bondingCurve).i64(BigInt(o.ts)).done()]);
}

export const dataLine = (b: Buffer) => `Program data: ${b.toString('base64')}`;
export const pumpInvoke = (depth = 1) => `Program ${PUMP_PROGRAM_ID} invoke [${depth}]`;
export const pumpSuccess = () => `Program ${PUMP_PROGRAM_ID} success`;
export const emitCpiData = (ev: Buffer) => bs58.encode(Buffer.concat([EMIT_CPI_TAG, ev]));
