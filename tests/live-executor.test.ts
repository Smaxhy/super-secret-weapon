import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { DISC, ammAccounts, ammBuy, ammSell, computeBudget, curveBuyV2, curveSellV2, curveV2Accounts } from '../src/executor/live/instructions';
import { PUMP, PUMP_AMM, TOKEN_2022_PROGRAM, WSOL, ammPoolV2Pda } from '../src/executor/live/addresses';
import { DEFAULT_LIVE, buyPlan, confirmMatches, fillFromBalances, liveBlockers, liveEntryGuard, percentile, priorityFee, reconcile, sellMinOut, simCategory } from '../src/executor/live/guards';
import { parseSecret, redactSecret, loadWallet, resetWalletCache, shortAddress } from '../src/executor/live/wallet';
import { parseTipAccounts, pickSender } from '../src/executor/live/sender';
import { DryRunExecutor, simOkPct } from '../src/executor/live/dry-run';
import { LiveExecutor } from '../src/executor/live/live-executor';
import { lossLimitsApply } from '../src/executor/trader';
import { quoteBuy, quoteSell } from '../src/lib/pumpfun';
import type { Executor, Fill } from '../src/executor/types';

const pk = () => Keypair.generate().publicKey;
const curveAcc = () => ({ user: pk(), mint: pk(), baseTokenProgram: TOKEN_2022_PROGRAM, creator: pk(), isMayhem: false, feeRecipient: pk(), buybackFeeRecipient: pk() });

// The exact _BUY_V2_ACCOUNTS order (Chainstack platforms/pumpfun/instruction_builder.py).
const BUY_V2 = ['global', 'base_mint', 'quote_mint', 'base_token_program', 'quote_token_program', 'associated_token_program', 'fee_recipient', 'associated_quote_fee_recipient', 'buyback_fee_recipient', 'associated_quote_buyback_fee_recipient', 'bonding_curve', 'associated_base_bonding_curve', 'associated_quote_bonding_curve', 'user', 'associated_base_user', 'associated_quote_user', 'creator_vault', 'associated_creator_vault', 'sharing_config', 'global_volume_accumulator', 'user_volume_accumulator', 'associated_user_volume_accumulator', 'fee_config', 'fee_program', 'system_program', 'event_authority', 'program'];
const WRITABLE = new Set(['fee_recipient', 'associated_quote_fee_recipient', 'buyback_fee_recipient', 'associated_quote_buyback_fee_recipient', 'bonding_curve', 'associated_base_bonding_curve', 'associated_quote_bonding_curve', 'user', 'associated_base_user', 'associated_quote_user', 'creator_vault', 'associated_creator_vault', 'user_volume_accumulator', 'associated_user_volume_accumulator']);

describe('curve buy_v2 / sell_v2 (doc layouts)', () => {
  it('buy_v2 has the 27 accounts in the documented order, writable flags and the user as the only signer', () => {
    const a = curveAcc();
    const accs = curveV2Accounts(a, 'buy');
    expect(accs.map((x) => x.name)).toEqual(BUY_V2);
    for (const x of accs) expect(x.meta.isWritable).toBe(WRITABLE.has(x.name));
    expect(accs.filter((x) => x.meta.isSigner).map((x) => x.name)).toEqual(['user']);
    expect(accs.find((x) => x.name === 'quote_mint')!.meta.pubkey.equals(WSOL)).toBe(true);
  });
  it('sell_v2 is buy_v2 minus global_volume_accumulator (26)', () => {
    const accs = curveV2Accounts(curveAcc(), 'sell');
    expect(accs).toHaveLength(26);
    expect(accs.map((x) => x.name)).toEqual(BUY_V2.filter((n) => n !== 'global_volume_accumulator'));
  });
  it('buy_v2 data = discriminator + u64 amount + u64 max_sol_cost (24 bytes), after an idempotent ATA create', () => {
    const ixs = curveBuyV2(curveAcc(), 123_456_789n, 100_000_000n);
    expect(ixs).toHaveLength(2);
    const d = ixs[1]!.data;
    expect(ixs[1]!.programId.equals(PUMP)).toBe(true);
    expect([...d.subarray(0, 8)]).toEqual([184, 23, 238, 97, 103, 197, 211, 61]);
    expect(d.length).toBe(24);
    expect(d.readBigUInt64LE(8)).toBe(123_456_789n);
    expect(d.readBigUInt64LE(16)).toBe(100_000_000n);
  });
  it('sell_v2 data uses its discriminator; a full sale also closes the token account', () => {
    const ixs = curveSellV2(curveAcc(), 5n, 7n, true);
    expect([...ixs[0]!.data.subarray(0, 8)]).toEqual([...DISC.curveSellV2]);
    expect([...DISC.curveSellV2]).toEqual([93, 246, 130, 60, 231, 233, 64, 178]);
    expect(ixs).toHaveLength(2);
    expect(curveSellV2(curveAcc(), 5n, 7n, false)).toHaveLength(1);
  });
});

describe('PumpSwap buy / sell account counts (doc: buy 26 canonical / 25 not; sell 24/26 canonical, 23/25 not)', () => {
  const pool = (canonical: boolean, cashback: boolean) => ({ user: pk(), pool: pk(), mint: pk(), baseTokenProgram: TOKEN_2022_PROGRAM, poolBaseTokenAccount: pk(), poolQuoteTokenAccount: pk(), coinCreator: pk(), canonical, cashback, protocolFeeRecipient: pk(), buybackFeeRecipient: pk() });
  const q = pk();
  it('counts', () => {
    expect(ammAccounts(pool(true, false), 'buy', q)).toHaveLength(26);
    expect(ammAccounts(pool(false, false), 'buy', q)).toHaveLength(25);
    expect(ammAccounts(pool(true, false), 'sell', q)).toHaveLength(24);
    expect(ammAccounts(pool(true, true), 'sell', q)).toHaveLength(26);
    expect(ammAccounts(pool(false, false), 'sell', q)).toHaveLength(23);
    expect(ammAccounts(pool(false, true), 'sell', q)).toHaveLength(25);
  });
  it('pool-v2 only on a canonical pool; the buyback recipient + its quote ATA are always last', () => {
    const p = pool(true, false);
    const keys = ammAccounts(p, 'sell', q);
    expect(keys[keys.length - 3]!.pubkey.equals(ammPoolV2Pda(p.mint))).toBe(true);
    expect(keys[keys.length - 2]!.pubkey.equals(p.buybackFeeRecipient)).toBe(true);
    expect(keys[keys.length - 1]!.isWritable).toBe(true);
    expect(ammAccounts(pool(false, false), 'sell', q).some((k) => k.pubkey.equals(ammPoolV2Pda(p.mint)))).toBe(false);
  });
  it('buy data = disc + base_amount_out + max_quote_amount_in + track_volume byte; settles through a throwaway WSOL account', () => {
    const ixs = ammBuy(pool(true, false), 10n, 20n, 'a'.repeat(32));
    const swap = ixs.find((i) => i.programId.equals(PUMP_AMM))!;
    expect([...swap.data.subarray(0, 8)]).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
    expect(swap.data.length).toBe(25);
    expect(swap.data.readBigUInt64LE(8)).toBe(10n);
    expect(swap.data.readBigUInt64LE(16)).toBe(20n);
    expect(ixs).toHaveLength(5); // ATA create, open WSOL (create + init), swap, close WSOL
    const sell = ammSell(pool(true, false), 10n, 1n, 'b'.repeat(32), false).find((i) => i.programId.equals(PUMP_AMM))!;
    expect([...sell.data.subarray(0, 8)]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
    expect(sell.data.length).toBe(24);
  });
  it('compute budget: data-size limit first (discriminator 4) only when set', () => {
    expect(computeBudget(100_000, 50_000, 0)).toHaveLength(2);
    const withLimit = computeBudget(100_000, 50_000, 12_500_000);
    expect(withLimit[0]!.data[0]).toBe(4);
    expect(withLimit[0]!.data.readUInt32LE(1)).toBe(12_500_000);
  });
});

describe('limits and fees', () => {
  it('buy: max_sol_cost = the position size; tokens = the quote less the slippage tolerance', () => {
    const vs = 30_000_000_000n, vt = 1_073_000_000_000_000n;
    const p = buyPlan(100_000_000n, vs, vt, 125, 1500);
    expect(p.maxCostLamports).toBe(100_000_000n);
    expect(p.tokens).toBe((quoteBuy(100_000_000n, vs, vt, 125).tokensOut * 8500n) / 10_000n);
  });
  it('sell floor = the quote less the slippage tolerance', () => {
    expect(sellMinOut(1_000_000n, 30_000_000_000n, 1_000_000_000_000_000n, 125, 2000)).toBe((quoteSell(1_000_000n, 30_000_000_000n, 1_000_000_000_000_000n, 125).solOutLamports * 8000n) / 10_000n);
  });
  it('priority fee = percentile of recent fees, clamped', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 75)).toBe(8);
    expect(priorityFee([0, 0, 0], DEFAULT_LIVE)).toBe(DEFAULT_LIVE.minPriorityMicroLamports);
    expect(priorityFee([1e9, 2e9, 3e9, 4e9, 5e9], DEFAULT_LIVE)).toBe(DEFAULT_LIVE.maxPriorityMicroLamports);
    expect(priorityFee([20_000, 40_000, 60_000, 80_000, 100_000, 0, 0], DEFAULT_LIVE)).toBe(80_000);
  });
});

describe('wallet key handling', () => {
  const kp = Keypair.generate();
  const b58 = bs58.encode(kp.secretKey);
  it('base58 and JSON byte array give the same wallet', () => {
    expect(parseSecret(b58).publicKey.equals(kp.publicKey)).toBe(true);
    expect(parseSecret(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('a bad secret errors without echoing it', () => {
    const bad = b58.slice(0, 40);
    try {
      parseSecret(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
    }
  });
  it('redaction strips the secret and secret-shaped strings from text', () => {
    expect(redactSecret(`oops ${b58} leaked`, b58)).not.toContain(b58);
    expect(redactSecret(`oops ${b58} leaked`, undefined)).not.toContain(b58);
    expect(redactSecret(`k=${JSON.stringify([...kp.secretKey])}`, undefined)).not.toContain(String(kp.secretKey[5]) + ',' + String(kp.secretKey[6]));
  });
  it('no secret → no wallet; the dashboard only ever sees first4…last4', () => {
    resetWalletCache();
    expect(loadWallet({}).wallet).toBeNull();
    resetWalletCache();
    const w = loadWallet({ WALLET_SECRET: b58 }).wallet!;
    expect(w.short).toBe(shortAddress(kp.publicKey.toBase58()));
    expect(w.short).not.toBe(w.address);
    expect(JSON.stringify(w)).not.toContain(b58);
    resetWalletCache();
  });
});

describe('every refusal', () => {
  const base = { envMode: 'LIVE', hasWallet: true, walletError: null, enabledAt: '2026-10-18T00:00:00Z', balanceSol: 3, senderReady: true, senderWhy: null };
  it('live needs TRADING_MODE=LIVE, a wallet, a sender, the confirmation and enough balance', () => {
    expect(liveBlockers(base, DEFAULT_LIVE)).toEqual([]);
    expect(liveBlockers({ ...base, envMode: 'PAPER' }, DEFAULT_LIVE)[0]).toMatch(/TRADING_MODE/);
    expect(liveBlockers({ ...base, hasWallet: false, walletError: null }, DEFAULT_LIVE)[0]).toMatch(/WALLET_SECRET/);
    expect(liveBlockers({ ...base, enabledAt: null }, DEFAULT_LIVE)[0]).toMatch(/not confirmed/);
    expect(liveBlockers({ ...base, balanceSol: 0.1 }, DEFAULT_LIVE)[0]).toMatch(/minimum/);
    expect(liveBlockers({ ...base, senderReady: false, senderWhy: 'no tips' }, DEFAULT_LIVE)[0]).toBe('no tips');
  });
  it('confirmation = exactly the wallet address\'s first 4 characters', () => {
    expect(confirmMatches('AbCd', 'AbCdEfGh123')).toBe(true);
    expect(confirmMatches('abcd', 'AbCdEfGh123')).toBe(false);
    expect(confirmMatches('', 'AbCdEfGh123')).toBe(false);
    expect(confirmMatches('AbCd', null)).toBe(false);
  });
  it('live caps on top of the normal ones: max open, max SOL per trade, the minimum', () => {
    expect(liveEntryGuard({ openLive: 2, size: 0.1, minPositionSol: 0.05, balance: 5 }, DEFAULT_LIVE)).toEqual({ refuse: 'live: max 2 trades open' });
    expect(liveEntryGuard({ openLive: 0, size: 1, minPositionSol: 0.05, balance: 5 }, DEFAULT_LIVE)).toEqual({ size: 0.1 });
    expect('refuse' in liveEntryGuard({ openLive: 0, size: 1, minPositionSol: 0.05, balance: 0.02 }, DEFAULT_LIVE)).toBe(true);
  });
  it('daily loss limit + cool-off always apply in LIVE, whatever the paper setting says', () => {
    expect(lossLimitsApply('LIVE', true)).toBe(true);
    expect(lossLimitsApply('LIVE', undefined)).toBe(true);
    expect(lossLimitsApply('PAPER', true)).toBe(false);
    expect(lossLimitsApply('PAPER', false)).toBe(true);
  });
});

describe('reconciliation flags, never fixes', () => {
  it('a balance off by more than the tolerance → review; an unexplained token → orphan', () => {
    const r = reconcile([{ id: 'p1', mint: 'M1', tokenAmountRaw: 1_000_000n, remainingPct: 50 }, { id: 'p2', mint: 'M2', tokenAmountRaw: 1_000n, remainingPct: 100 }], new Map([['M1', 500_000n], ['M2', 900n], ['M3', 42n]]), 2);
    expect(r.mismatches.map((m) => m.id)).toEqual(['p2']);
    expect(r.orphans).toEqual([{ mint: 'M3', amount: 42n }]);
    expect(Object.keys(r)).toEqual(['mismatches', 'orphans']);
  });
});

describe('fills from real balances', () => {
  it('buy: SOL spent excludes network fee, tip and the new token account\'s rent', () => {
    const f = fillFromBalances('BUY', { preLamports: 2_000_000_000n, postLamports: 2_000_000_000n - 100_000_000n - 5_000n - 1_000_000n - 2_039_280n, feeLamports: 5_000n, tipLamports: 1_000_000n, preTokens: null, postTokens: 3_000_000n });
    expect(f.solAmount).toBeCloseTo(0.1, 9);
    expect(f.tokens).toBe(3_000_000n);
    expect(f.feeSol).toBeCloseTo(0.001005, 9);
  });
  it('sell: SOL received adds back fees and leaves out the closed account\'s rent', () => {
    const f = fillFromBalances('SELL', { preLamports: 1_000_000_000n, postLamports: 1_000_000_000n + 150_000_000n - 5_000n - 1_000_000n + 2_039_280n, feeLamports: 5_000n, tipLamports: 1_000_000n, preTokens: 3_000_000n, postTokens: null });
    expect(f.solAmount).toBeCloseTo(0.15, 9);
    expect(f.tokens).toBe(3_000_000n);
  });
  it('simulation categories: ok / funds-only / error', () => {
    expect(simCategory(null, [])).toBe('ok');
    expect(simCategory({ InstructionError: [3, { Custom: 1 }] }, ['Program log: Error: insufficient lamports'])).toBe('funds');
    expect(simCategory({ InstructionError: [3, { Custom: 6053 }] }, ['BuybackFeeRecipientNotAuthorized'])).toBe('error');
    expect(simOkPct({ n: 4, ok: 1, funds: 2 })).toBe(75);
  });
});

describe('senders', () => {
  it('Helius Sender needs tip accounts; shield and plain RPC need nothing', () => {
    const rpc = vi.fn(async () => 'sig');
    expect(pickSender({ LIVE_SENDER_URL: 'https://s.example' }, rpc).ready).toBe(false);
    const tip = pk().toBase58();
    const s = pickSender({ LIVE_SENDER_URL: 'https://s.example', LIVE_TIP_ACCOUNTS: `${tip}, nonsense` }, rpc);
    expect(s.ready).toBe(true);
    expect(s.sender.tipAccount()!.toBase58()).toBe(tip);
    expect(pickSender({ LIVE_SHIELD_URL: 'https://shield.example' }, rpc).sender.name).toBe('shield');
    expect(pickSender({}, rpc).sender.name).toBe('rpc');
    expect(parseTipAccounts('x, y')).toEqual([]);
  });
});

const paperFill: Fill = { ok: true, status: 'SIMULATED', signature: null, solAmount: 0.1, tokenAmountRaw: 5n, priceSol: 0.02, feeSol: 0.001 };
const fakeRedis = () => {
  const calls: unknown[][] = [];
  const chain = { hincrby: (...a: unknown[]) => (calls.push(['hincrby', ...a]), chain), lpush: (...a: unknown[]) => (calls.push(['lpush', ...a]), chain), ltrim: () => chain, exec: async () => [] };
  return { calls, redis: { multi: () => chain } };
};

describe('paper dry run', () => {
  it('returns the paper fill unchanged, simulates in the background, and a build failure is recorded — never thrown', async () => {
    const paper: Executor = { mode: 'PAPER', getBalanceSol: async () => 10, buy: async () => paperFill, sell: async () => paperFill };
    const builder = { prepareBuy: vi.fn(async () => { throw new Error('mint not found'); }), prepareSell: vi.fn(), toTransaction: vi.fn(), simulate: vi.fn(), noteCu: vi.fn() };
    const { calls, redis } = fakeRedis();
    const dry = new DryRunExecutor(paper, builder as never, redis as never, null);
    expect(dry.mode).toBe('PAPER');
    expect(await dry.buy({ mint: pk().toBase58(), solAmount: 0.1, maxSlippageBps: 500 })).toBe(paperFill);
    await new Promise((r) => setTimeout(r, 10));
    expect(builder.prepareBuy).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c[0] === 'hincrby' && c[2] === 'error')).toBe(true);
  });
});

describe('live executor (no network: fake connection, builder and sender)', () => {
  const wallet = (() => {
    const kp = Keypair.generate();
    return { publicKey: kp.publicKey, address: kp.publicKey.toBase58(), short: 'x', sign: vi.fn() };
  })();
  const prep = { kind: 'curve-buy' as const, ixs: [], writable: [], tokens: 5_000_000n, priceSol: 0.00002, limitLamports: 100_000_000n, userTokenBalance: null };
  const conn = (lamports: number) => ({
    getBalance: vi.fn(async () => lamports),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000 })),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] })),
    getBlockHeight: vi.fn(async () => 10),
    getTransaction: vi.fn(async () => ({ meta: { preBalances: [2_000_000_000], postBalances: [2_000_000_000 - 100_000_000 - 5_000 - 2_039_280], fee: 5_000, preTokenBalances: [], postTokenBalances: [{ owner: wallet.address, mint: 'MINT', uiTokenAmount: { amount: '5000000' } }] } })),
  });
  const builder = () => ({ hasMeasured: () => true, cuFor: () => 100_000, noteCu: vi.fn(), simulate: vi.fn(), prepareBuy: vi.fn(async () => prep), prepareSell: vi.fn(async () => ({ ...prep, kind: 'curve-sell' })), toTransaction: vi.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) })) });
  const sender = () => ({ name: 'rpc', tipAccount: () => null, send: vi.fn(async () => 'SIG') });

  it('refuses before sending when the wallet can\'t pay (fee reserve kept)', async () => {
    const s = sender();
    const ex = new LiveExecutor(conn(60_000_000) as never, builder() as never, wallet as never, s as never, 'not-a-secret');
    const f = await ex.buy({ mint: 'MINT', solAmount: 0.1, maxSlippageBps: 500 });
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/free after/);
    expect(s.send).not.toHaveBeenCalled();
  });
  it('caps every buy at live.maxPositionSol and books the fill from the confirmed transaction', async () => {
    const b = builder();
    const s = sender();
    const ex = new LiveExecutor(conn(3_000_000_000) as never, b as never, wallet as never, s as never, 'not-a-secret');
    const f = await ex.buy({ mint: 'MINT', solAmount: 1, maxSlippageBps: 500 });
    expect(b.prepareBuy.mock.calls[0]![0].solAmount).toBe(DEFAULT_LIVE.maxPositionSol);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(wallet.sign).toHaveBeenCalled();
    expect(f).toMatchObject({ ok: true, status: 'CONFIRMED', signature: 'SIG', tokenAmountRaw: 5_000_000n });
    expect(f.solAmount).toBeCloseTo(0.1, 9);
  });
  it('an error message never carries the wallet secret', async () => {
    const secret = bs58.encode(Keypair.generate().secretKey);
    const b = builder();
    b.prepareBuy = vi.fn(async () => { throw new Error(`boom ${secret}`); });
    const ex = new LiveExecutor(conn(3_000_000_000) as never, b as never, wallet as never, sender() as never, secret);
    const f = await ex.buy({ mint: 'MINT', solAmount: 0.1, maxSlippageBps: 500 });
    expect(f.error).not.toContain(secret);
  });
});

describe('PublicKey sanity', () => {
  it('WSOL is the native mint', () => expect(WSOL.equals(new PublicKey('So11111111111111111111111111111111111111112'))).toBe(true));
});
