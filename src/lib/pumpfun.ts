/**
 * Pump.fun program constants and event decoding.
 *
 * HOW PUMP.FUN EVENTS WORK
 * ------------------------
 * Pump.fun is an Anchor program. When something happens (a token is created,
 * someone buys/sells, a curve completes) it emits an "event". Anchor writes
 * events into the transaction logs as a line like:
 *
 *     Program data: G3KpTd7rY3YEAAAAUGVwZQ...   (base64)
 *
 * Decoded, that's:  [8-byte discriminator][Borsh-encoded fields]
 *
 * The discriminator is the first 8 bytes of sha256("event:<EventName>"), so we
 * can tell CreateEvent / TradeEvent / CompleteEvent apart without any IDL file.
 *
 * Newer Anchor programs can also emit events via a self-CPI ("emit_cpi"), where
 * the bytes live in an inner instruction instead of the logs. We support that
 * too (see decodeEventsFromInnerInstructions) as a fallback.
 *
 * Pump.fun has added fields to its events over time. The decoders read the
 * fields that have always existed, then read newer fields only if bytes remain,
 * so old and new program versions both decode.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { PumpCompleteEvent, PumpCreateEvent, PumpEvent, PumpTradeEvent } from '../config/types';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---------------------------------------------------------------------------
// Curve maths constants (fallbacks — we prefer values from the CreateEvent)
// ---------------------------------------------------------------------------

export const PUMP_TOKEN_DECIMALS = 6;
/** 1,000,000,000 tokens with 6 decimals. */
export const PUMP_DEFAULT_TOTAL_SUPPLY = 1_000_000_000_000_000n;
export const PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
export const PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n; // 30 SOL
export const PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

export const DISCRIMINATORS = {
  create: eventDiscriminator('CreateEvent'),
  trade: eventDiscriminator('TradeEvent'),
  complete: eventDiscriminator('CompleteEvent'),
} as const;

/** Anchor prefixes emit_cpi instruction data with this tag. */
export const EMIT_CPI_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

// ---------------------------------------------------------------------------
// Minimal Borsh reader
// ---------------------------------------------------------------------------

/** Reads Borsh primitives from a buffer, left to right. Throws if it runs out of bytes. */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private need(n: number): void {
    if (this.remaining < n) throw new RangeError(`borsh: need ${n} bytes, have ${this.remaining}`);
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): string {
    this.need(32);
    const v = bs58.encode(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  string(): string {
    const len = this.u32();
    if (len > 10_000) throw new RangeError(`borsh: implausible string length ${len}`);
    this.need(len);
    const v = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    // Some tokens pad names with NUL bytes — strip them.
    return v.replace(/\0/g, '').trim();
  }
}

// ---------------------------------------------------------------------------
// Event decoders
// ---------------------------------------------------------------------------

function decodeCreate(r: BorshReader): PumpCreateEvent {
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  // Fields below were added in later program versions.
  const creator = r.remaining >= 32 ? r.pubkey() : user;
  const timestamp = r.remaining >= 8 ? Number(r.i64()) : Math.floor(Date.now() / 1000);
  const hasReserves = r.remaining >= 32;
  const virtualTokenReserves = hasReserves ? r.u64() : PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES;
  const virtualSolReserves = hasReserves ? r.u64() : PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES;
  const realTokenReserves = hasReserves ? r.u64() : PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES;
  const tokenTotalSupply = hasReserves ? r.u64() : PUMP_DEFAULT_TOTAL_SUPPLY;
  const tokenProgram = r.remaining >= 32 ? r.pubkey() : undefined;
  return {
    kind: 'create',
    name,
    symbol,
    uri,
    mint,
    bondingCurve,
    user,
    creator,
    timestamp,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    tokenTotalSupply,
    tokenProgram,
  };
}

function decodeTrade(r: BorshReader): PumpTradeEvent {
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  const timestamp = Number(r.i64());
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const hasReal = r.remaining >= 16;
  const realSolReserves = hasReal ? r.u64() : undefined;
  const realTokenReserves = hasReal ? r.u64() : undefined;
  // fee_recipient, fee_basis_points, fee, creator, creator_fee_basis_points, creator_fee
  let feeLamports: bigint | undefined;
  if (r.remaining >= 48) {
    r.pubkey();
    r.u64();
    feeLamports = r.u64();
    if (r.remaining >= 48) {
      r.pubkey();
      r.u64();
      feeLamports += r.u64();
    }
  }
  return {
    kind: 'trade',
    mint,
    solAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    feeLamports,
  };
}

function decodeComplete(r: BorshReader): PumpCompleteEvent {
  return {
    kind: 'complete',
    user: r.pubkey(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    timestamp: Number(r.i64()),
  };
}

/**
 * Decode one event from raw bytes ([discriminator][fields]).
 * Returns null for events we don't care about or bytes that don't parse.
 */
export function decodeEventBytes(data: Buffer): PumpEvent | null {
  if (data.length < 8) return null;
  const disc = data.subarray(0, 8);
  const r = new BorshReader(data.subarray(8));
  try {
    if (disc.equals(DISCRIMINATORS.create)) return decodeCreate(r);
    if (disc.equals(DISCRIMINATORS.trade)) return decodeTrade(r);
    if (disc.equals(DISCRIMINATORS.complete)) return decodeComplete(r);
  } catch {
    // Truncated / unexpected layout. The caller counts these as decode errors.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (success|failed)/;
const DATA_PREFIX = 'Program data: ';

export interface ParsedLogs {
  events: PumpEvent[];
  /** True if the logs show a Pump.fun create instruction ran. */
  sawCreateInstruction: boolean;
  /** "Program data:" lines from Pump.fun that we could not decode. */
  decodeErrors: number;
  /** Solana truncates very long logs; events after that point are lost. */
  truncated: boolean;
}

/**
 * Pull every Pump.fun event out of a transaction's log lines.
 *
 * We track the program call stack ("invoke" pushes, "success"/"failed" pops)
 * so we only decode "Program data:" lines that Pump.fun itself wrote. Other
 * programs in the same transaction can emit events with the same Anchor name
 * (lots of launchpads have a "TradeEvent") but a different byte layout.
 */
export function parsePumpLogs(logs: readonly string[]): ParsedLogs {
  const stack: string[] = [];
  const events: PumpEvent[] = [];
  let sawCreateInstruction = false;
  let decodeErrors = 0;
  let truncated = false;

  for (const line of logs) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    if (line === 'Log truncated') {
      truncated = true;
      continue;
    }
    if (stack[stack.length - 1] !== PUMP_PROGRAM_ID) continue;

    if (line === 'Program log: Instruction: Create' || line === 'Program log: Instruction: CreateV2') {
      sawCreateInstruction = true;
    } else if (line.startsWith(DATA_PREFIX)) {
      const bytes = Buffer.from(line.slice(DATA_PREFIX.length), 'base64');
      const known =
        bytes.length >= 8 &&
        (bytes.subarray(0, 8).equals(DISCRIMINATORS.create) ||
          bytes.subarray(0, 8).equals(DISCRIMINATORS.trade) ||
          bytes.subarray(0, 8).equals(DISCRIMINATORS.complete));
      if (!known) continue; // some other Pump.fun event we don't use
      const ev = decodeEventBytes(bytes);
      if (ev) events.push(ev);
      else decodeErrors++;
    }
  }
  return { events, sawCreateInstruction, decodeErrors, truncated };
}

/**
 * Fallback for emit_cpi-style events: decode them from a transaction's inner
 * instructions. `innerInstructionData` is the base58 `data` of every inner
 * instruction whose program is Pump.fun.
 */
export function decodeEventsFromInnerInstructions(innerInstructionData: readonly string[]): PumpEvent[] {
  const out: PumpEvent[] = [];
  for (const b58 of innerInstructionData) {
    let raw: Buffer;
    try {
      raw = Buffer.from(bs58.decode(b58));
    } catch {
      continue;
    }
    if (raw.length < 16 || !raw.subarray(0, 8).equals(EMIT_CPI_TAG)) continue;
    const ev = decodeEventBytes(raw.subarray(8));
    if (ev) out.push(ev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curve maths
// ---------------------------------------------------------------------------

export interface CurveParams {
  initialVirtualSolReserves: bigint;
  initialVirtualTokenReserves: bigint;
  initialRealTokenReserves: bigint;
  totalSupply: bigint;
}

export const DEFAULT_CURVE_PARAMS: CurveParams = {
  initialVirtualSolReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
  initialVirtualTokenReserves: PUMP_DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
  initialRealTokenReserves: PUMP_DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  totalSupply: PUMP_DEFAULT_TOTAL_SUPPLY,
};

/** Price of one whole token, in SOL, from the curve's virtual reserves. */
export function curvePriceSol(virtualSolReserves: bigint, virtualTokenReserves: bigint): number {
  if (virtualTokenReserves === 0n) return 0;
  const sol = Number(virtualSolReserves) / 1e9;
  const tokens = Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS;
  return sol / tokens;
}

/** Market cap in SOL = price × total supply. */
export function marketCapSol(priceSol: number, totalSupply: bigint): number {
  return priceSol * (Number(totalSupply) / 10 ** PUMP_TOKEN_DECIMALS);
}

/**
 * How full the bonding curve is, 0-100.
 * Real token reserves = virtual reserves minus the fixed "virtual" offset.
 */
export function bondingCurvePct(virtualTokenReserves: bigint, p: CurveParams = DEFAULT_CURVE_PARAMS): number {
  const offset = p.initialVirtualTokenReserves - p.initialRealTokenReserves;
  const real = virtualTokenReserves - offset;
  if (p.initialRealTokenReserves === 0n) return 0;
  const sold = Number(p.initialRealTokenReserves - real) / Number(p.initialRealTokenReserves);
  return Math.max(0, Math.min(100, sold * 100));
}

/** Real SOL sitting in the curve (i.e. liquidity), in SOL. */
export function curveLiquiditySol(virtualSolReserves: bigint, p: CurveParams = DEFAULT_CURVE_PARAMS): number {
  const real = virtualSolReserves - p.initialVirtualSolReserves;
  return real > 0n ? Number(real) / 1e9 : 0;
}

/** True if the string is a valid base58 Solana address. */
export function isValidPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trade quotes (constant-product maths, same as the on-chain program)
// ---------------------------------------------------------------------------

/**
 * Tokens received for `solInLamports` spent on the curve.
 * The fee (in basis points) is taken from the SOL before it hits the curve.
 */
export function quoteBuy(
  solInLamports: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  feeBps: number,
): { tokensOut: bigint; feeLamports: bigint } {
  const feeLamports = (solInLamports * BigInt(feeBps)) / 10_000n;
  const net = solInLamports - feeLamports;
  if (net <= 0n) return { tokensOut: 0n, feeLamports };
  const tokensOut = (virtualTokenReserves * net) / (virtualSolReserves + net);
  return { tokensOut, feeLamports };
}

/** SOL received (after fee) for selling `tokensIn` raw tokens into the curve. */
export function quoteSell(
  tokensIn: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  feeBps: number,
): { solOutLamports: bigint; feeLamports: bigint } {
  if (tokensIn <= 0n) return { solOutLamports: 0n, feeLamports: 0n };
  const gross = (virtualSolReserves * tokensIn) / (virtualTokenReserves + tokensIn);
  const feeLamports = (gross * BigInt(feeBps)) / 10_000n;
  return { solOutLamports: gross - feeLamports, feeLamports };
}
