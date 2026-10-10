/**
 * Wallet analyzer (owner: "this wallet is in very high profit — check its trading patterns and how
 * to copy it with 10 SOL"). Reads the wallet's swap history from Solscan and works out:
 *   - how often it trades, how much per buy, which hours
 *   - per coin: buys / sells, SOL in / out, profit, hold time, sold in one go or in pieces
 *   - win rate, median win / loss, profit factor, best / worst coins
 *   - how fast it is (time between its first buy and first sell)
 *   - a COPY SIMULATION: the same trades with a fixed size, a worse entry and exit (we land
 *     1–2 s after it — the price has already moved) and real costs. That decides whether copying
 *     can work at all, before any SOL is risked.
 * Pure analysis (`analyzeSwaps`) + a cached fetcher (`walletReport`).
 * History source: Solscan (needs a plan level that includes wallet activity) or — default fallback —
 * the bot's own Solana RPC: each transaction's balance changes (SOL + token) give the swap, for any DEX.
 * Costs ~1 RPC credit per transaction (500 transactions ≈ 500 of Helius' 1M/month).
 */
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { solscanKey, walletSwaps, type SolscanSwap } from '../lib/solscan';
import { getConnection } from '../lib/solana';

const log = moduleLogger('wallet-report');

const SOL_MINTS = new Set(['So11111111111111111111111111111111111111112', 'So11111111111111111111111111111111111111111']);

export interface Swap {
  t: number;
  sig: string;
  mint: string;
  buy: boolean;
  sol: number;
  tokens: number;
}

/** Pure: Solscan swap rows → SOL-for-token buys and sells (token-for-token swaps are skipped). */
export function toSwaps(rows: readonly SolscanSwap[]): Swap[] {
  const out: Swap[] = [];
  for (const r of rows) {
    const x = r.routers;
    if (!x?.token1 || !x.token2) continue;
    const a1 = Number(x.amount1) / 10 ** (x.token1_decimals ?? 0);
    const a2 = Number(x.amount2) / 10 ** (x.token2_decimals ?? 0);
    if (!(a1 > 0) || !(a2 > 0)) continue;
    if (SOL_MINTS.has(x.token1) && !SOL_MINTS.has(x.token2)) out.push({ t: r.block_time * 1000, sig: r.trans_id, mint: x.token2, buy: true, sol: a1, tokens: a2 });
    else if (!SOL_MINTS.has(x.token1) && SOL_MINTS.has(x.token2)) out.push({ t: r.block_time * 1000, sig: r.trans_id, mint: x.token1, buy: false, sol: a2, tokens: a1 });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface CoinTrade {
  mint: string;
  symbol: string | null;
  firstBuyAt: number;
  lastActionAt: number;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** Tokens still held (bought − sold, whole tokens). */
  tokensLeft: number;
  soldPct: number;
  pnlSol: number;
  pnlPct: number;
  /** First buy → first sell (seconds). null = never sold. */
  firstSellAfterSec: number | null;
  /** First buy → last sell (seconds). */
  holdSec: number | null;
  closed: boolean;
  /** Sold in more than one sell. */
  scaledOut: boolean;
  /** Bought more than once (added / averaged). */
  addedTo: boolean;
  /** Average sell price ÷ average buy price. */
  exitMultiple: number | null;
}

export interface CopySim {
  sizeSol: number;
  entrySlipPct: number;
  exitSlipPct: number;
  costPct: number;
  trades: number;
  wins: number;
  pnlSol: number;
  avgPct: number;
  medianPct: number;
  /** End balance starting from `bankrollSol`, one fixed-size trade per coin, in order. */
  bankrollSol: number;
  endBalanceSol: number;
  /** Worst drop from a high of the running balance (%). */
  maxDrawdownPct: number;
}

export interface WalletReport {
  address: string;
  generatedAt: string;
  swapsRead: number;
  from: string | null;
  to: string | null;
  coins: number;
  tradesPerDay: number;
  buysPerDay: number;
  medianBuySol: number;
  avgBuySol: number;
  closedCoins: number;
  winRatePct: number;
  realisedPnlSol: number;
  profitFactor: number | null;
  medianWinPct: number;
  medianLossPct: number;
  medianHoldMin: number | null;
  medianFirstSellSec: number | null;
  scaledOutPct: number;
  addedToPct: number;
  /** UTC hours with the most buys. */
  busiestHoursUtc: number[];
  style: string[];
  best: CoinTrade[];
  worst: CoinTrade[];
  recent: CoinTrade[];
  copy: CopySim[];
  verdict: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: per-coin round trips from chronological swaps. */
export function coinTrades(swaps: readonly Swap[], symbols: Record<string, string | undefined> = {}): CoinTrade[] {
  const by = new Map<string, Swap[]>();
  for (const s of swaps) by.set(s.mint, [...(by.get(s.mint) ?? []), s]);
  const out: CoinTrade[] = [];
  for (const [mint, xs] of by) {
    const buys = xs.filter((x) => x.buy);
    // Sells of tokens bought before the history window have no cost basis → skip the coin.
    if (!buys.length) continue;
    const firstBuy = buys[0]!.t;
    const sells = xs.filter((x) => !x.buy && x.t >= firstBuy);
    const solIn = buys.reduce((s, x) => s + x.sol, 0);
    const tokIn = buys.reduce((s, x) => s + x.tokens, 0);
    const tokOut = sells.reduce((s, x) => s + x.tokens, 0);
    const soldPct = tokIn > 0 ? Math.min(100, (tokOut / tokIn) * 100) : 0;
    // Profit on the part that was sold (the rest is still open — not counted as a loss or a win).
    const solOut = sells.reduce((s, x) => s + x.sol, 0);
    const costSold = solIn * (soldPct / 100);
    const pnlSol = solOut - costSold;
    const avgBuy = tokIn > 0 ? solIn / tokIn : 0;
    const avgSell = tokOut > 0 ? solOut / tokOut : 0;
    out.push({
      mint,
      symbol: symbols[mint] ?? null,
      firstBuyAt: firstBuy,
      lastActionAt: xs[xs.length - 1]!.t,
      buys: buys.length,
      sells: sells.length,
      solIn: r2(solIn),
      solOut: r2(solOut),
      tokensLeft: Math.max(0, tokIn - tokOut),
      soldPct: Math.round(soldPct),
      pnlSol: r2(pnlSol),
      pnlPct: costSold > 0 ? Math.round((pnlSol / costSold) * 1000) / 10 : 0,
      firstSellAfterSec: sells.length ? Math.round((sells[0]!.t - firstBuy) / 1000) : null,
      holdSec: sells.length ? Math.round((sells[sells.length - 1]!.t - firstBuy) / 1000) : null,
      closed: soldPct >= 95,
      scaledOut: sells.length > 1,
      addedTo: buys.length > 1,
      exitMultiple: avgBuy > 0 && avgSell > 0 ? r2(avgSell / avgBuy) : null,
    });
  }
  return out.sort((a, b) => a.firstBuyAt - b.firstBuyAt);
}

/**
 * Pure: what copying would have made. Each closed coin = one copy trade of `sizeSol`, entering
 * `entrySlipPct` worse and exiting `exitSlipPct` worse than the wallet did, minus `costPct`
 * (pool fees both ways + gas/tips as a % of size).
 */
export function simulateCopy(coins: readonly CoinTrade[], o: { sizeSol: number; entrySlipPct: number; exitSlipPct: number; costPct: number; bankrollSol: number }): CopySim {
  const closed = coins.filter((c) => c.closed && c.exitMultiple !== null);
  let bal = o.bankrollSol;
  let peak = bal;
  let dd = 0;
  const pcts: number[] = [];
  for (const c of closed) {
    const m = (c.exitMultiple! * (1 - o.exitSlipPct / 100)) / (1 + o.entrySlipPct / 100);
    const pct = (m - 1) * 100 - o.costPct;
    pcts.push(pct);
    bal += (o.sizeSol * pct) / 100;
    peak = Math.max(peak, bal);
    dd = Math.max(dd, peak > 0 ? ((peak - bal) / peak) * 100 : 0);
  }
  const pnl = bal - o.bankrollSol;
  return {
    sizeSol: o.sizeSol,
    entrySlipPct: o.entrySlipPct,
    exitSlipPct: o.exitSlipPct,
    costPct: o.costPct,
    trades: closed.length,
    wins: pcts.filter((p) => p > 0).length,
    pnlSol: r2(pnl),
    avgPct: pcts.length ? r2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0,
    medianPct: r2(median(pcts)),
    bankrollSol: o.bankrollSol,
    endBalanceSol: r2(bal),
    maxDrawdownPct: Math.round(dd * 10) / 10,
  };
}

/** Pure: the whole report from swaps. */
export function analyzeSwaps(address: string, swaps: readonly Swap[], symbols: Record<string, string | undefined>, now = Date.now(), bankrollSol = 10): WalletReport {
  const coins = coinTrades(swaps, symbols);
  const closed = coins.filter((c) => c.closed);
  const buys = swaps.filter((s) => s.buy);
  const spanDays = swaps.length >= 2 ? Math.max(1 / 24, (swaps[swaps.length - 1]!.t - swaps[0]!.t) / 86_400_000) : 1;
  const wins = closed.filter((c) => c.pnlSol > 0);
  const losses = closed.filter((c) => c.pnlSol <= 0);
  const grossWin = wins.reduce((s, c) => s + c.pnlSol, 0);
  const grossLoss = -losses.reduce((s, c) => s + c.pnlSol, 0);
  const hours = new Array(24).fill(0) as number[];
  for (const b of buys) hours[new Date(b.t).getUTCHours()]!++;
  const busiest = hours.map((n, h) => [h, n] as const).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, n]) => n > 0).map(([h]) => h);
  const holdMin = closed.map((c) => (c.holdSec ?? 0) / 60);
  const firstSell = coins.filter((c) => c.firstSellAfterSec !== null).map((c) => c.firstSellAfterSec!);
  const medBuy = median(buys.map((b) => b.sol));

  // Copy plans for a 10 SOL account: up to ~5 trades at once → 2 SOL; and a safer 1 SOL.
  // Landing 1–2 s after a fast wallet on pump.fun typically costs 3–8% on the entry.
  const sims = [
    { sizeSol: 1, entrySlipPct: 3, exitSlipPct: 2 },
    { sizeSol: 1, entrySlipPct: 6, exitSlipPct: 4 },
    { sizeSol: 2, entrySlipPct: 6, exitSlipPct: 4 },
  ].map((o) => simulateCopy(coins, { ...o, costPct: 2.5 + (0.003 / o.sizeSol) * 100, bankrollSol }));

  const style: string[] = [];
  const medHold = holdMin.length ? median(holdMin) : null;
  const medFirst = firstSell.length ? median(firstSell) : null;
  if (medFirst !== null && medFirst < 60) style.push(`very fast: first sell ${Math.round(medFirst)} s after buying (median) — a sniper / scalper, hard to copy`);
  else if (medHold !== null && medHold < 15) style.push(`scalper: holds ~${medHold.toFixed(0)} min`);
  else if (medHold !== null) style.push(`holds ~${medHold.toFixed(0)} min per coin`);
  const scaled = coins.filter((c) => c.sells > 0);
  const scaledPct = scaled.length ? (scaled.filter((c) => c.scaledOut).length / scaled.length) * 100 : 0;
  style.push(scaledPct >= 50 ? `sells in pieces (${scaledPct.toFixed(0)}% of coins)` : 'usually sells everything at once');
  const addedPct = coins.length ? (coins.filter((c) => c.addedTo).length / coins.length) * 100 : 0;
  if (addedPct >= 40) style.push(`adds to positions often (${addedPct.toFixed(0)}% of coins)`);
  if (closed.length) style.push(`wins ${Math.round((wins.length / closed.length) * 100)}% — median win +${median(wins.map((c) => c.pnlPct)).toFixed(0)}%, median loss ${median(losses.map((c) => c.pnlPct)).toFixed(0)}%`);

  const bestSim = [...sims].sort((a, b) => b.pnlSol - a.pnlSol)[0]!;
  const realistic = sims[1]!;
  let verdict: string;
  if (closed.length < 15) verdict = `Only ${closed.length} finished trades in the history read — not enough to judge. Read more pages.`;
  else if (realistic.pnlSol > 0 && realistic.medianPct > 0) verdict = `Copyable: even entering 6% worse and exiting 4% worse, ${realistic.trades} copied trades of ${realistic.sizeSol} SOL would have made ${realistic.pnlSol} SOL (median ${realistic.medianPct}%).`;
  else if (bestSim.pnlSol > 0) verdict = `Only works with a near-instant copy (${bestSim.entrySlipPct}% worse entry): ${bestSim.pnlSol} SOL; at a realistic 1–2 s delay it loses ${realistic.pnlSol} SOL. Better as a signal than to copy blindly.`;
  else verdict = `Not copyable: its profit comes from speed / timing we can't match — copying would have lost ${realistic.pnlSol} SOL. Use its buys as a signal only.`;

  return {
    address,
    generatedAt: new Date(now).toISOString(),
    swapsRead: swaps.length,
    from: swaps.length ? new Date(swaps[0]!.t).toISOString() : null,
    to: swaps.length ? new Date(swaps[swaps.length - 1]!.t).toISOString() : null,
    coins: coins.length,
    tradesPerDay: r2(swaps.length / spanDays),
    buysPerDay: r2(buys.length / spanDays),
    medianBuySol: r2(medBuy),
    avgBuySol: r2(buys.length ? buys.reduce((s, b) => s + b.sol, 0) / buys.length : 0),
    closedCoins: closed.length,
    winRatePct: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    realisedPnlSol: r2(coins.reduce((s, c) => s + c.pnlSol, 0)),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    medianWinPct: r2(median(wins.map((c) => c.pnlPct))),
    medianLossPct: r2(median(losses.map((c) => c.pnlPct))),
    medianHoldMin: medHold !== null ? r2(medHold) : null,
    medianFirstSellSec: medFirst,
    scaledOutPct: Math.round(scaledPct),
    addedToPct: Math.round(addedPct),
    busiestHoursUtc: busiest,
    style,
    best: [...closed].sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 5),
    worst: [...closed].sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 5),
    recent: [...coins].sort((a, b) => b.lastActionAt - a.lastActionAt).slice(0, 15),
    copy: sims,
    verdict,
  };
}

/**
 * Pure: one transaction → a swap by `wallet` (SOL for exactly one token or back), from its balance
 * changes. Wrapped SOL counts as SOL; the network fee isn't part of the trade. null = not a swap.
 */
export function swapFromTx(tx: Pick<VersionedTransactionResponse, 'blockTime' | 'meta' | 'transaction'>, wallet: string): Swap | null {
  const meta = tx.meta;
  if (!meta || meta.err || !tx.blockTime) return null;
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  let sol = ((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0) + (i === 0 ? meta.fee : 0)) / 1e9;
  const tok = new Map<string, number>();
  const add = (b: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }, sign: 1 | -1) => {
    if (b.owner !== wallet) return;
    const v = (b.uiTokenAmount.uiAmount ?? 0) * sign;
    if (SOL_MINTS.has(b.mint)) sol += v;
    else tok.set(b.mint, (tok.get(b.mint) ?? 0) + v);
  };
  for (const b of meta.postTokenBalances ?? []) add(b, 1);
  for (const b of meta.preTokenBalances ?? []) add(b, -1);
  const changed = [...tok.entries()].filter(([, v]) => Math.abs(v) > 1e-9);
  if (changed.length !== 1) return null;
  const [mint, d] = changed[0]!;
  const sig = tx.transaction.signatures[0] ?? '';
  if (d > 0 && sol < -1e-6) return { t: tx.blockTime * 1000, sig, mint, buy: true, sol: -sol, tokens: d };
  if (d < 0 && sol > 1e-6) return { t: tx.blockTime * 1000, sig, mint, buy: false, sol, tokens: -d };
  return null;
}

/** The wallet's last `maxTx` transactions from our own RPC → swaps (batched, rate-limited). */
async function rpcSwaps(address: string, maxTx: number): Promise<Swap[]> {
  const conn = getConnection();
  const key = new PublicKey(address);
  const sigs: string[] = [];
  let before: string | undefined;
  while (sigs.length < maxTx) {
    const page = await conn.getSignaturesForAddress(key, { limit: Math.min(1000, maxTx - sigs.length), ...(before ? { before } : {}) });
    if (!page.length) break;
    sigs.push(...page.filter((x) => !x.err).map((x) => x.signature));
    before = page[page.length - 1]!.signature;
    if (page.length < 1000) break;
  }
  const out: Swap[] = [];
  const opts = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as const;
  let batched = true;
  for (let i = 0; i < sigs.length; i += 50) {
    const chunk = sigs.slice(i, i + 50);
    let txs: Array<VersionedTransactionResponse | null> = [];
    if (batched) {
      try {
        txs = await conn.getTransactions(chunk, opts);
      } catch (err) {
        // Some plans (e.g. free tiers) refuse batch requests → one by one (same credit cost).
        log.info({ err: (err as Error).message }, 'batch getTransactions refused — fetching one by one');
        batched = false;
      }
    }
    if (!batched) {
      for (let j = 0; j < chunk.length; j += 5) txs.push(...(await Promise.all(chunk.slice(j, j + 5).map((sg) => conn.getTransaction(sg, opts).catch(() => null)))));
    }
    for (const tx of txs) {
      const s = tx ? swapFromTx(tx, address) : null;
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const CACHE_SEC = 30 * 60;

/** Read the last `pages` × 100 swaps (Solscan) / transactions (RPC) and analyse. Cached 30 min per wallet + pages. */
export async function walletReport(address: string, pages = 5, refresh = false): Promise<WalletReport & { cached: boolean; source?: string }> {
  const n = Math.max(1, Math.min(10, Math.round(pages)));
  const key = `wreport:${address}:${n}`;
  if (!refresh) {
    const hit = await redis.get(key);
    if (hit) return { ...(JSON.parse(hit) as WalletReport), cached: true };
  }
  const symbols: Record<string, string | undefined> = {};
  let swaps: Swap[] | null = null;
  let source: 'solscan' | 'rpc' = 'rpc';
  // Solscan first when a key is set; its wallet-activity endpoint needs a higher plan level —
  // any refusal falls back to our own RPC.
  if (solscanKey() && (await redis.get('solscan:noActivity')) === null) {
    try {
      const rows: SolscanSwap[] = [];
      for (let p = 1; p <= n; p++) {
        const page = await walletSwaps(address, p);
        rows.push(...page.swaps);
        for (const [m, t] of Object.entries(page.tokens)) symbols[m] = t.token_symbol ?? t.token_name;
        if (page.swaps.length < 100) break; // no more history
      }
      swaps = toSwaps(rows);
      source = 'solscan';
    } catch (err) {
      const msg = (err as Error).message;
      log.info({ err: msg }, 'Solscan unavailable for wallet history — using RPC');
      // Plan doesn't include it → don't spend a call asking again for a day.
      if (/upgrade|unauthori|level/i.test(msg)) await redis.set('solscan:noActivity', msg.slice(0, 200), 'EX', 86_400);
    }
  }
  if (!swaps) swaps = await rpcSwaps(address, n * 100);
  // Names from our own database (free).
  const unknown = [...new Set(swaps.map((x) => x.mint))].filter((m) => !symbols[m]);
  if (unknown.length) for (const t of await prisma.token.findMany({ where: { mint: { in: unknown } }, select: { mint: true, symbol: true } })) symbols[t.mint] = t.symbol;
  const report = { ...analyzeSwaps(address, swaps, symbols), source };
  await redis.set(key, JSON.stringify(report), 'EX', CACHE_SEC);
  return { ...report, cached: false };
}
