/**
 * LIVE executor — real pump.fun / PumpSwap transactions from the dedicated bot wallet.
 *
 * Only constructed when every gate passed at startup (TRADING_MODE=LIVE, a wallet key in the VPS .env, the owner's
 * typed confirmation on Controls, enough balance — see live-mode.ts). On top of the trader's caps it enforces
 * `live.maxPositionSol` itself, keeps `live.reserveSol` for fees, puts the slippage limit ON CHAIN (max_sol_cost /
 * min_sol_output: a worse fill reverts and costs only fee + tip) and books the fill from the confirmed transaction's
 * real balances, not the quote.
 */
import type { Connection } from '@solana/web3.js';
import { moduleLogger } from '../../lib/logger';
import { recordEvent } from '../../lib/bot-events';
import { PUMP_TOKEN_DECIMALS } from '../../lib/pumpfun';
import type { BuyRequest, Executor, Fill, SellRequest } from '../types';
import { fillFromBalances } from './guards';
import type { Sender } from './sender';
import { liveConfig, type LiveTxBuilder, type PreparedTx } from './tx-builder';
import { redactSecret, type LiveWallet } from './wallet';

const log = moduleLogger('live-executor');

const failed = (error: string): Fill => ({ ok: false, status: 'FAILED', signature: null, solAmount: 0, tokenAmountRaw: 0n, priceSol: 0, feeSol: 0, error });

export class LiveExecutor implements Executor {
  readonly mode = 'LIVE' as const;
  private bal: { sol: number; at: number } | null = null;

  constructor(
    private readonly conn: Connection,
    private readonly builder: LiveTxBuilder,
    private readonly wallet: LiveWallet,
    private readonly sender: Sender,
    private readonly secret: string | undefined = process.env.WALLET_SECRET ?? process.env.BOT_WALLET_PRIVATE_KEY,
  ) {}

  get address(): string {
    return this.wallet.address;
  }

  /** Raw wallet SOL (no reserve taken off), cached 3 s. */
  async walletSol(): Promise<number> {
    if (this.bal && Date.now() - this.bal.at < 3_000) return this.bal.sol;
    const lamports = await this.conn.getBalance(this.wallet.publicKey, 'confirmed');
    this.bal = { sol: lamports / 1e9, at: Date.now() };
    return this.bal.sol;
  }

  async getBalanceSol(): Promise<number> {
    return Math.max(0, (await this.walletSol()) - liveConfig().reserveSol);
  }

  async buy(req: BuyRequest): Promise<Fill> {
    const c = liveConfig();
    const sol = Math.min(req.solAmount, c.maxPositionSol);
    try {
      const free = await this.getBalanceSol();
      if (sol > free) return failed(`live: ${sol.toFixed(3)} SOL needed, ${free.toFixed(3)} SOL free after the ${c.reserveSol} SOL fee reserve`);
      const prep = await this.builder.prepareBuy({ ...req, solAmount: sol }, this.wallet.publicKey);
      return await this.execute('BUY', req.mint, prep);
    } catch (e) {
      return failed(this.clean(e));
    }
  }

  async sell(req: SellRequest): Promise<Fill> {
    try {
      const prep = await this.builder.prepareSell(req, this.wallet.publicKey, true);
      return await this.execute('SELL', req.mint, prep);
    } catch (e) {
      return failed(this.clean(e));
    }
  }

  private clean(e: unknown): string {
    return redactSecret((e as Error)?.message ?? String(e), this.secret).slice(0, 300);
  }

  private async execute(side: 'BUY' | 'SELL', mint: string, prep: PreparedTx): Promise<Fill> {
    const c = liveConfig();
    const tipTo = this.sender.tipAccount();
    const tip = tipTo ? { to: tipTo, lamports: BigInt(Math.max(1_000_000, Math.round(c.tipLamports))) } : null;
    // First trade of a kind: measure its compute units on a simulation (and refuse to send if it would fail for any
    // reason other than funds), then reuse the measured figure.
    if (!this.builder.hasMeasured(prep.kind)) {
      const sim = await this.builder.simulate(await this.builder.toTransaction(prep, this.wallet.publicKey, tip, 1_400_000));
      if (sim.err) return failed(`simulation failed: ${JSON.stringify(sim.err).slice(0, 160)}`);
      this.builder.noteCu(prep.kind, sim.unitsConsumed);
    }
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = await this.builder.toTransaction(prep, this.wallet.publicKey, tip, this.builder.cuFor(prep.kind), blockhash);
    this.wallet.sign(tx);
    const raw = Buffer.from(tx.serialize());
    const signature = await this.sender.send(raw);
    this.bal = null;
    log.info({ mint, side, kind: prep.kind, signature, sender: this.sender.name }, `📤 live ${side} sent`);
    const status = await this.confirm(signature, lastValidBlockHeight, c.confirmTimeoutMs);
    if (status !== 'confirmed') {
      const msg = status === 'timeout' ? 'not confirmed in time — check the wallet (reconciliation will flag it)' : `transaction failed on chain: ${status}`;
      void recordEvent({ level: 'WARN', module: 'live', type: 'live_tx_failed', mint, message: `${side} ${mint.slice(0, 6)}… ${msg}`, data: { signature, kind: prep.kind } });
      return { ...failed(msg), signature };
    }
    return this.fillFrom(side, signature, prep, tip?.lamports ?? 0n, mint);
  }

  private async confirm(signature: string, lastValidBlockHeight: number, timeoutMs: number): Promise<'confirmed' | 'timeout' | string> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const st = (await this.conn.getSignatureStatuses([signature]).catch(() => null))?.value?.[0];
      if (st?.err) return JSON.stringify(st.err).slice(0, 160);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'confirmed';
      const height = await this.conn.getBlockHeight('confirmed').catch(() => 0);
      if (height > lastValidBlockHeight) return 'timeout';
      await new Promise((r) => setTimeout(r, 500));
    }
    return 'timeout';
  }

  /** Real fill from the confirmed transaction's balances (our wallet is the fee payer, index 0). */
  private async fillFrom(side: 'BUY' | 'SELL', signature: string, prep: PreparedTx, tipLamports: bigint, mint: string): Promise<Fill> {
    const tx = await this.conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const meta = tx?.meta;
    if (!meta) {
      // Landed but unreadable: book the plan so the position exists; reconciliation compares with the chain.
      const sol = Number(prep.limitLamports) / 1e9;
      return { ok: true, status: 'CONFIRMED', signature, solAmount: sol, tokenAmountRaw: prep.tokens, priceSol: prep.priceSol, feeSol: Number(tipLamports) / 1e9, error: 'fill read from the plan (transaction meta unavailable)' };
    }
    const owner = this.wallet.address;
    const tok = (list: typeof meta.preTokenBalances) => {
      const e = (list ?? []).find((b) => b.owner === owner && b.mint === mint);
      return e ? BigInt(e.uiTokenAmount.amount) : null;
    };
    const f = fillFromBalances(side, {
      preLamports: BigInt(meta.preBalances[0] ?? 0),
      postLamports: BigInt(meta.postBalances[0] ?? 0),
      feeLamports: BigInt(meta.fee),
      tipLamports,
      preTokens: tok(meta.preTokenBalances),
      postTokens: tok(meta.postTokenBalances),
    });
    const whole = Number(f.tokens) / 10 ** PUMP_TOKEN_DECIMALS;
    return { ok: f.tokens > 0n, status: 'CONFIRMED', signature, solAmount: f.solAmount, tokenAmountRaw: f.tokens, priceSol: whole > 0 ? f.solAmount / whole : prep.priceSol, feeSol: f.feeSol, ...(f.tokens > 0n ? {} : { error: 'confirmed but no token movement' }) };
  }
}

