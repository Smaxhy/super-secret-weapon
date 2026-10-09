/**
 * Smart-money discovery — find the wallets that actually make money, on their own.
 *
 * Every trade the bot sees (pump.fun curve + PumpSwap) updates that wallet's
 * position in that coin (SOL in, tokens held). When the wallet sells, the
 * realised profit of that sale (proceeds − average cost of the tokens sold) is
 * added to its record: total PnL, sells, winning sells, SOL put in.
 *
 * Fake "profits" are left out:
 *  - the coin's creator (a dev selling their own supply looks hugely profitable),
 *  - buys in the first `sniperWindowSec` after launch (snipers / bundles),
 *  - sells of tokens we never saw bought (no cost basis).
 * Records fade ×`decayPerDay` daily, so it reflects roughly the last week.
 *
 * Every `everyMin` the best wallets (enough sells, good win rate, solid PnL,
 * not a bot spraying thousands of tiny trades) become KOL wallets on the
 * Wallets page (source DISCOVERED, label "Smart #n"); ones that drop out are
 * paused. Wallets you added yourself only get their stats refreshed.
 */
import type { Redis } from 'ioredis';
import { getConfig } from '../config/runtime-config';
import { DEFAULT_CONFIG } from '../config/default';
import { recordEvent } from '../lib/bot-events';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const log = moduleLogger('wallet-pnl');
const POS_TTL = 12 * 3600;
const posCost = (mint: string) => `wpos:c:${mint}`;
const posTok = (mint: string) => `wpos:t:${mint}`;
const sniped = (mint: string) => `wpos:s:${mint}`;
const K = { pnl: 'wpnl:pnl', n: 'wpnl:n', w: 'wpnl:w', vol: 'wpnl:vol', day: 'wpnl:day' };
const MAX_WALLETS = 80_000;

export interface PnlTrade {
  mint: string;
  wallet: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  /** Seconds since the coin launched (null = unknown). */
  ageSec: number | null;
  creator: string | null;
}

export interface WalletRecord {
  wallet: string;
  pnlSol: number;
  sells: number;
  wins: number;
  investedSol: number;
}

export interface DiscoveryConfig {
  enabled: boolean;
  everyMin: number;
  top: number;
  minSells: number;
  maxSells: number;
  minWinRate: number;
  minPnlSol: number;
  minAvgPnlSol: number;
  sniperWindowSec: number;
  decayPerDay: number;
  weight: number;
}

/** Pure: the wallets worth following, best first. */
export function rankSmartWallets(rows: readonly WalletRecord[], c: Pick<DiscoveryConfig, 'minSells' | 'minWinRate' | 'minPnlSol' | 'minAvgPnlSol' | 'maxSells' | 'top'>): Array<WalletRecord & { winRate: number; avgPnlSol: number }> {
  return rows
    .filter((r) => r.sells >= c.minSells && r.sells <= c.maxSells && r.pnlSol >= c.minPnlSol)
    .map((r) => ({ ...r, winRate: r.wins / r.sells, avgPnlSol: r.pnlSol / r.sells }))
    .filter((r) => r.winRate >= c.minWinRate && r.avgPnlSol >= c.minAvgPnlSol)
    .sort((a, b) => b.pnlSol - a.pnlSol)
    .slice(0, c.top);
}

export class WalletPnl {
  private timer: NodeJS.Timeout | null = null;
  private stats = { trades: 0, sells: 0 };

  constructor(private readonly redis: Redis) {}

  start(): void {
    const every = Math.max(5, this.cfg().everyMin) * 60_000;
    setTimeout(() => void this.promote(), 10 * 60_000).unref?.();
    this.timer = setInterval(() => void this.promote(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private cfg(): DiscoveryConfig {
    return getConfig().discovery ?? DEFAULT_CONFIG.discovery;
  }

  /** Feed every trade (curve + PumpSwap). Never throws. */
  async onTrade(t: PnlTrade): Promise<void> {
    const c = this.cfg();
    if (!c.enabled || !(t.sol > 0) || !(t.tokens > 0) || (t.creator && t.wallet === t.creator)) return;
    this.stats.trades++;
    try {
      if (t.isBuy) {
        if (t.ageSec !== null && t.ageSec <= c.sniperWindowSec) {
          await this.redis.multi().hset(sniped(t.mint), t.wallet, '1').expire(sniped(t.mint), POS_TTL).exec();
          return;
        }
        await this.redis
          .multi()
          .hincrbyfloat(posCost(t.mint), t.wallet, t.sol)
          .hincrbyfloat(posTok(t.mint), t.wallet, t.tokens)
          .expire(posCost(t.mint), POS_TTL)
          .expire(posTok(t.mint), POS_TTL)
          .exec();
        return;
      }
      const res = (await this.redis.pipeline().hget(posCost(t.mint), t.wallet).hget(posTok(t.mint), t.wallet).hexists(sniped(t.mint), t.wallet).exec()) ?? [];
      const cost = Number(res[0]?.[1] ?? 0);
      const tok = Number(res[1]?.[1] ?? 0);
      const snipe = Number(res[2]?.[1] ?? 0) === 1;
      if (snipe || !(tok > 0) || !(cost > 0)) return; // sniper, or tokens we never saw bought
      const frac = Math.min(1, t.tokens / tok);
      const basis = cost * frac;
      const pnl = t.sol - basis;
      this.stats.sells++;
      await this.maybeDecay();
      await this.redis
        .multi()
        .hincrbyfloat(posCost(t.mint), t.wallet, -basis)
        .hincrbyfloat(posTok(t.mint), t.wallet, -Math.min(t.tokens, tok))
        .hincrbyfloat(K.pnl, t.wallet, pnl)
        .hincrbyfloat(K.n, t.wallet, 1)
        .hincrbyfloat(K.w, t.wallet, pnl > 0 ? 1 : 0)
        .hincrbyfloat(K.vol, t.wallet, basis)
        .exec();
    } catch {
      /* best effort */
    }
  }

  async records(): Promise<WalletRecord[]> {
    const [pnl, n, w, vol] = await Promise.all([this.redis.hgetall(K.pnl), this.redis.hgetall(K.n), this.redis.hgetall(K.w), this.redis.hgetall(K.vol)]);
    return Object.keys(n).map((wallet) => ({ wallet, pnlSol: Number(pnl[wallet] ?? 0), sells: Number(n[wallet] ?? 0), wins: Number(w[wallet] ?? 0), investedSol: Number(vol[wallet] ?? 0) }));
  }

  /** Leaderboard for the dashboard (whether or not promoted). */
  async leaderboard(limit = 25): Promise<Array<WalletRecord & { winRate: number; avgPnlSol: number }>> {
    const c = this.cfg();
    return rankSmartWallets(await this.records(), { ...c, top: limit });
  }

  /** Turn the best wallets into KOL wallets; pause discovered ones that dropped out. */
  async promote(): Promise<number> {
    const c = this.cfg();
    if (!c.enabled) return 0;
    try {
      const rows = await this.records();
      if (rows.length > MAX_WALLETS) await this.prune(rows);
      const best = rankSmartWallets(rows, c);
      const keep = new Set(best.map((b) => b.wallet));
      const existing = new Map((await prisma.trackedWallet.findMany({ where: { address: { in: [...keep] } } })).map((w) => [w.address, w]));
      let added = 0;
      for (const [i, b] of best.entries()) {
        const notes = `auto-found: ${b.pnlSol >= 0 ? '+' : ''}${b.pnlSol.toFixed(1)} SOL, ${Math.round(b.winRate * 100)}% wins over ${Math.round(b.sells)} sells (~7d)`;
        const ex = existing.get(b.wallet);
        if (ex && ex.source === 'MANUAL') {
          await prisma.trackedWallet.update({ where: { address: b.wallet }, data: { score14d: b.pnlSol, winRate: b.winRate } });
          continue;
        }
        if (!ex) added++;
        await prisma.trackedWallet.upsert({
          where: { address: b.wallet },
          update: { kind: 'KOL', active: true, label: `Smart #${i + 1}`, score14d: b.pnlSol, winRate: b.winRate, notes },
          create: { address: b.wallet, kind: 'KOL', source: 'DISCOVERED', label: `Smart #${i + 1}`, weight: c.weight, score14d: b.pnlSol, winRate: b.winRate, notes },
        });
      }
      const paused = await prisma.trackedWallet.updateMany({ where: { source: 'DISCOVERED', kind: 'KOL', active: true, address: { notIn: [...keep] } }, data: { active: false } });
      // Auto-found wallets that stayed out of the top for a week are removed.
      await prisma.trackedWallet.deleteMany({ where: { source: 'DISCOVERED', active: false, updatedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
      // Your own wallets: refresh their stats too.
      const manual = await prisma.trackedWallet.findMany({ where: { source: 'MANUAL' }, select: { address: true } });
      const byWallet = new Map(rows.map((r) => [r.wallet, r]));
      for (const m of manual) {
        const r = byWallet.get(m.address);
        if (r && r.sells > 0) await prisma.trackedWallet.update({ where: { address: m.address }, data: { score14d: r.pnlSol, winRate: r.wins / r.sells } });
      }
      if (added || paused.count) {
        void recordEvent({ module: 'wallet-pnl', type: 'smart_wallets', message: `Smart-money list: ${best.length} wallets (${added} new, ${paused.count} dropped)` });
      }
      log.info({ smart: best.length, added, dropped: paused.count, tracked: rows.length, ...this.stats }, '🧠 smart-money wallets updated');
      return added;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'smart-money promotion failed');
      return 0;
    }
  }

  private async maybeDecay(now = Date.now()): Promise<void> {
    const today = Math.floor(now / 86_400_000);
    const last = Number((await this.redis.get(K.day)) ?? 0);
    if (last >= today) return;
    if (!(await this.redis.set(`${K.day}:lock`, '1', 'EX', 600, 'NX'))) return;
    await this.redis.set(K.day, String(today));
    if (!last) return;
    const f = Math.pow(this.cfg().decayPerDay, Math.min(30, today - last));
    for (const key of [K.pnl, K.n, K.w, K.vol]) {
      const all = await this.redis.hgetall(key);
      const p = this.redis.multi();
      for (const [w, v] of Object.entries(all)) p.hset(key, w, (Number(v) * f).toFixed(4));
      await p.exec();
    }
  }

  /** Keep the record small: drop the least active wallets. */
  private async prune(rows: WalletRecord[]): Promise<void> {
    const drop = [...rows]
      .sort((a, b) => a.sells + Math.abs(a.pnlSol) - (b.sells + Math.abs(b.pnlSol)))
      .slice(0, rows.length - MAX_WALLETS)
      .map((r) => r.wallet);
    for (let i = 0; i < drop.length; i += 1000) {
      const chunk = drop.slice(i, i + 1000);
      for (const key of [K.pnl, K.n, K.w, K.vol]) await this.redis.hdel(key, ...chunk);
    }
  }
}
