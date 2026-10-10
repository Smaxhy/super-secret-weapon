/**
 * Vamp guard — copycat coins ("vamps"): a NEW mint launched with the same name / ticker as a coin
 * that is already running (or that we just made money on), to catch people who buy by ticker.
 * Owner: "you often make money on a coin, then you buy a vamp and lose it".
 *
 * Originals — Redis HASH `vamp:orig`, field = normalised ticker/name → {mint, symbol, mcUsd, at} —
 * are recorded from:
 *   - every coin the bot buys (from then on, other coins with that ticker are vamps of OURS),
 *   - bigger coins: the swing universe (watchlist, trending tabs, DexScreener trending, our own
 *     grown coins) with MC ≥ `minOriginalMcUsd`.
 * When two coins claim a ticker, the clearly bigger one (≥ 1.5× MC) is the original.
 * A coin whose ticker or name matches an original's — exactly, or after the usual vamp dressing
 * ("baby…", "…2", "…inu", "…ai", "real…", "…classic" …) — with a DIFFERENT mint is a vamp → no buy.
 * Originals expire after `keepDaysBig` (MC ≥ $100k) or `keepDaysSmall` days.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { normalizeId } from './social-analyzer';

const log = moduleLogger('vamp-guard');
const K_ORIG = 'vamp:orig';

export interface VampOriginal {
  mint: string;
  symbol: string;
  mcUsd: number | null;
  /** When it was recorded (ms). */
  at: number;
  /** traded = we bought it; big = a bigger coin (swing universe / trending). */
  why: 'traded' | 'big';
}

const PREFIXES = ['baby', 'mini', 'lil', 'little', 'real', 'the', 'official', 'og', 'new'];
const SUFFIXES = ['inu', 'ai', 'coin', 'token', 'classic', 'v2', '2', '20', '3', 'cto', 'onsol', 'sol', 'x'];

/** Exact keys an ORIGINAL is stored under: its normalised ticker and name. Pure. */
export function originalKeys(symbol: string, name: string, minLen = 3): string[] {
  return [...new Set([normalizeId(symbol), normalizeId(name)].filter((k) => k.length >= minLen))];
}

/**
 * Keys a CANDIDATE is looked up under: its exact ticker/name plus the core left after stripping
 * vamp dressing ("babyclude" → "clude", "clude2" → "clude", "realclude" → "clude"). Pure.
 */
export function candidateKeys(symbol: string, name: string, minLen = 3): string[] {
  const out = new Set<string>();
  for (const raw of [normalizeId(symbol), normalizeId(name)]) {
    if (raw.length < minLen) continue;
    out.add(raw);
    let core = raw;
    for (const p of PREFIXES) if (core.startsWith(p) && core.length - p.length >= minLen) core = core.slice(p.length);
    for (const s of SUFFIXES) if (core.endsWith(s) && core.length - s.length >= minLen) core = core.slice(0, -s.length);
    if (core !== raw) out.add(core);
  }
  return [...out];
}

const keepMs = (o: Pick<VampOriginal, 'mcUsd'>, c: { keepDaysBig: number; keepDaysSmall: number }) => ((o.mcUsd ?? 0) >= 100_000 ? c.keepDaysBig : c.keepDaysSmall) * 86_400_000;

/** Pure: does `next` take over the key from `cur`? (empty / expired / same mint / clearly bigger) */
export function replacesOriginal(cur: VampOriginal | null, next: VampOriginal, c: { keepDaysBig: number; keepDaysSmall: number }, now: number): boolean {
  if (!cur || now - cur.at > keepMs(cur, c)) return true;
  if (cur.mint === next.mint) return true;
  return (next.mcUsd ?? 0) >= 1.5 * Math.max(1, cur.mcUsd ?? 0);
}

/** Pure: the original this coin copies, or null. */
export function findVamp(mint: string, symbol: string, name: string, originals: ReadonlyMap<string, VampOriginal>, c: { keepDaysBig: number; keepDaysSmall: number; minKeyLength: number }, now: number): VampOriginal | null {
  for (const k of candidateKeys(symbol, name, c.minKeyLength)) {
    const o = originals.get(k);
    if (!o || o.mint === mint || now - o.at > keepMs(o, c)) continue;
    return o;
  }
  return null;
}

export class VampGuard {
  constructor(private readonly redis: Redis) {}

  private cfg() {
    return getConfig().vamp ?? DEFAULT_CONFIG.vamp;
  }

  /** Remember a coin as the original for its ticker / name (if it wins the key). Never throws. */
  async record(o: { mint: string; symbol: string; name: string; mcUsd: number | null; why: VampOriginal['why'] }, now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled) return;
    try {
      const keys = originalKeys(o.symbol, o.name, c.minKeyLength);
      if (!keys.length) return;
      const cur = await this.redis.hmget(K_ORIG, ...keys);
      const next: VampOriginal = { mint: o.mint, symbol: o.symbol, mcUsd: o.mcUsd, at: now, why: o.why };
      const writes: Record<string, string> = {};
      keys.forEach((k, i) => {
        const prev = cur[i] ? (JSON.parse(cur[i]!) as VampOriginal) : null;
        // A coin we already hold the key for keeps its bigger MC record.
        if (prev && prev.mint === next.mint) next.mcUsd = Math.max(prev.mcUsd ?? 0, next.mcUsd ?? 0) || next.mcUsd;
        if (replacesOriginal(prev, next, c, now)) writes[k] = JSON.stringify(next);
      });
      if (Object.keys(writes).length) await this.redis.hset(K_ORIG, writes);
    } catch (err) {
      log.debug({ mint: o.mint, err: (err as Error).message }, 'could not record original');
    }
  }

  /** Is this coin a vamp? Returns a reason, or null. A failed lookup counts as clean. */
  async check(mint: string, symbol: string, name: string, now = Date.now()): Promise<string | null> {
    const c = this.cfg();
    if (!c.enabled) return null;
    try {
      const keys = candidateKeys(symbol, name, c.minKeyLength);
      if (!keys.length) return null;
      const raw = await this.redis.hmget(K_ORIG, ...keys);
      const map = new Map<string, VampOriginal>();
      keys.forEach((k, i) => raw[i] && map.set(k, JSON.parse(raw[i]!) as VampOriginal));
      const o = findVamp(mint, symbol, name, map, c, now);
      if (!o) return null;
      const mc = o.mcUsd ? ` (MC $${Math.round(o.mcUsd).toLocaleString('en-US')})` : '';
      return `vamp: copies $${o.symbol}${mc} — ${o.why === 'traded' ? 'a coin we already traded' : 'the real coin'} is ${o.mint.slice(0, 4)}…${o.mint.slice(-4)}`;
    } catch {
      return null;
    }
  }

  /** Drop expired originals (call now and then). */
  async prune(now = Date.now()): Promise<number> {
    const c = this.cfg();
    const all = await this.redis.hgetall(K_ORIG);
    const dead = Object.entries(all)
      .filter(([, v]) => {
        try {
          const o = JSON.parse(v) as VampOriginal;
          return now - o.at > keepMs(o, c);
        } catch {
          return true;
        }
      })
      .map(([k]) => k);
    if (dead.length) await this.redis.hdel(K_ORIG, ...dead);
    return dead.length;
  }
}
