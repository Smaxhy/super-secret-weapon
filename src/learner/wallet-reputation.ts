/**
 * Wallet reputation — the bot learns WHO tends to be early on winners.
 *
 * When a coin is scored, the wallets that bought it in the last 10 minutes are
 * remembered (Redis, 3h). When the coin's outcome is labelled an hour later,
 * every one of those wallets gets a win or a loss. Over thousands of coins this
 * finds "smart" wallets on its own (consistently early on winners), and the
 * crowd score rewards coins they are buying.
 *
 * Storage: two Redis hashes (wins, samples) plus totals, bounded to
 * MAX_WALLETS (the least-sampled are pruned). Counts decay a little each day
 * so wallets that stopped performing fade out.
 */
import type { Redis } from 'ioredis';

const K_W = 'wrep:w';
const K_N = 'wrep:n';
const K_TOT = 'wrep:tot';
const K_DAY = 'wrep:day';
const buyersKey = (evaluationId: string) => `wrep:buyers:${evaluationId}`;
export const MAX_WALLETS = 60_000;
const DECAY_PER_DAY = 0.97;
/** Samples before a wallet's record counts. */
export const MIN_SAMPLES = 4;
const PRIOR = 4;

export async function rememberBuyers(redis: Redis, evaluationId: string, wallets: readonly string[]): Promise<void> {
  if (!wallets.length) return;
  await redis.set(buyersKey(evaluationId), JSON.stringify(wallets.slice(0, 60)), 'EX', 3 * 3600);
}

/** The coin scored at `evaluationId` turned out a win / loss → credit its early buyers. Never throws. */
export async function learnFromLabel(redis: Redis, evaluationId: string, win: boolean, now = Date.now()): Promise<number> {
  try {
    const raw = await redis.get(buyersKey(evaluationId));
    if (!raw) return 0;
    const wallets = JSON.parse(raw) as string[];
    await maybeDecay(redis, now);
    const p = redis.multi();
    for (const w of wallets) {
      p.hincrbyfloat(K_N, w, 1);
      if (win) p.hincrbyfloat(K_W, w, 1);
    }
    p.hincrbyfloat(K_TOT, 'n', wallets.length);
    if (win) p.hincrbyfloat(K_TOT, 'w', wallets.length);
    p.del(buyersKey(evaluationId));
    await p.exec();
    if ((await redis.hlen(K_N)) > MAX_WALLETS * 1.2) await prune(redis);
    return wallets.length;
  } catch {
    return 0;
  }
}

/** Shrunk win rate (pulled toward the base rate when there are few samples). */
export function shrunk(w: number, n: number, base: number): number {
  return (w + PRIOR * base) / (n + PRIOR);
}

/**
 * Share (%) of these wallets with a proven record: ≥ MIN_SAMPLES coins and a
 * shrunk win rate at least double the base rate (and ≥ 25%). null = no data yet.
 */
export async function smartShare(redis: Redis, wallets: readonly string[]): Promise<{ pct: number | null; smart: number; known: number }> {
  if (!wallets.length) return { pct: null, smart: 0, known: 0 };
  try {
    const [ns, ws, tot] = await Promise.all([redis.hmget(K_N, ...wallets), redis.hmget(K_W, ...wallets), redis.hmget(K_TOT, 'n', 'w')]);
    const totN = Number(tot[0] ?? 0);
    if (totN < 200) return { pct: null, smart: 0, known: 0 };
    const base = Number(tot[1] ?? 0) / totN;
    let smart = 0;
    let known = 0;
    wallets.forEach((_, i) => {
      const n = Number(ns[i] ?? 0);
      if (n < MIN_SAMPLES) return;
      known++;
      const r = shrunk(Number(ws[i] ?? 0), n, base);
      if (r >= Math.max(0.25, base * 2)) smart++;
    });
    return { pct: (smart / wallets.length) * 100, smart, known };
  } catch {
    return { pct: null, smart: 0, known: 0 };
  }
}

/** Top wallets for the dashboard. */
export async function topWallets(redis: Redis, limit = 15): Promise<{ wallets: Array<{ wallet: string; winRate: number; n: number }>; baseRate: number; tracked: number }> {
  const [n, w, tot] = await Promise.all([redis.hgetall(K_N), redis.hgetall(K_W), redis.hmget(K_TOT, 'n', 'w')]);
  const base = Number(tot[0] ?? 0) > 0 ? Number(tot[1] ?? 0) / Number(tot[0]) : 0;
  const rows = Object.entries(n)
    .map(([wallet, nn]) => ({ wallet, n: Number(nn), winRate: shrunk(Number(w[wallet] ?? 0), Number(nn), base) }))
    .filter((r) => r.n >= MIN_SAMPLES)
    .sort((a, b) => b.winRate - a.winRate || b.n - a.n)
    .slice(0, limit)
    .map((r) => ({ ...r, winRate: Math.round(r.winRate * 1000) / 1000, n: Math.round(r.n * 10) / 10 }));
  return { wallets: rows, baseRate: Math.round(base * 1000) / 1000, tracked: Object.keys(n).length };
}

async function maybeDecay(redis: Redis, now: number): Promise<void> {
  const today = Math.floor(now / 86_400_000);
  const last = Number((await redis.get(K_DAY)) ?? 0);
  if (last >= today) return;
  if (!(await redis.set(`${K_DAY}:lock`, '1', 'EX', 300, 'NX'))) return;
  await redis.set(K_DAY, String(today));
  if (!last) return;
  const f = Math.pow(DECAY_PER_DAY, Math.min(30, today - last));
  const [n, w] = await Promise.all([redis.hgetall(K_N), redis.hgetall(K_W)]);
  const p = redis.multi();
  for (const [k, v] of Object.entries(n)) p.hset(K_N, k, (Number(v) * f).toFixed(3));
  for (const [k, v] of Object.entries(w)) p.hset(K_W, k, (Number(v) * f).toFixed(3));
  const tot = await redis.hmget(K_TOT, 'n', 'w');
  p.hset(K_TOT, 'n', (Number(tot[0] ?? 0) * f).toFixed(3), 'w', (Number(tot[1] ?? 0) * f).toFixed(3));
  await p.exec();
}

async function prune(redis: Redis): Promise<void> {
  const n = await redis.hgetall(K_N);
  const drop = Object.entries(n)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(0, Math.max(0, Object.keys(n).length - MAX_WALLETS))
    .map(([k]) => k);
  for (let i = 0; i < drop.length; i += 1000) {
    const chunk = drop.slice(i, i + 1000);
    await redis.hdel(K_N, ...chunk);
    await redis.hdel(K_W, ...chunk);
  }
}
