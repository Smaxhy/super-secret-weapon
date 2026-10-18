/**
 * Deployer book (v11.10) — every creator wallet's track record, from data the bot already has (zero RPC):
 * launches (create events / Token rows), graduations (curve complete), launches that died fast (no trade for
 * 10 min with < 10 holders inside the first 30 min — the dead-launch sweep), rugs (RUG_DETECTED on its coins /
 * the rugger memory), peak market caps and the creators sharing its funder (funding-graph cache only).
 * `classifyDeployer` → serial / rugger / proven / new / mixed drives an entry rule for every strategy, Sniper
 * mode and the replay. In memory (≤ maxCreators, LRU by last launch); Redis HASH `dbook` (compact JSON per
 * creator) every minute + at stop; counts halve every `halfLifeDays`.
 */
import type { Redis } from 'ioredis';
import { DEFAULT_CONFIG } from '../config/default';
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('deployer-book');

export const DBOOK_KEY = 'dbook';
const DBOOK_META = 'dbook:meta';
const MAX_MINTS = 24;
const DAY_MS = 86_400_000;
const MAX_MCS = 12;
const DEAD_FAST_AGE_SEC = 30 * 60;
const DEAD_FAST_HOLDERS = 10;

export interface DeployerConfig {
  enabled: boolean;
  serialMinLaunches: number;
  serialDiedFastPct: number;
  provenMaxDiedFastPct: number;
  maxCreators: number;
  halfLifeDays: number;
  backfillDays: number;
  /** ≥ this many serial launchers share this creator's funder → no buy */
  linkedSerialFail: number;
  /** a creator that already launched this many OTHER coins in the last 24 h → no buy (1 = any second launch today) */
  maxLaunchesPerDay: number;
  /** a proven creator whose previous launch was ≥ this many days ago gets `points.quietProven` on top */
  quietDays: number;
  points: { proven: number; quietProven: number; elite?: number };
  /** v11.19: repeat graduators — the one selection signal with (vendor) evidence of a large effect; verified on our own
   *  data by the deployer study (Money tab). */
  elite?: { minGraduated: number; minBondRatePct: number; tradeWhenStrategyOff: boolean };
}

/** Compact per-creator record (short keys: stored as JSON per creator). */
export interface DeployerRec {
  /** launches */
  l: number;
  /** graduated (curve complete) */
  g: number;
  /** died fast */
  df: number;
  rugs: number;
  /** peak market caps (USD) of its coins, newest last */
  mcs: number[];
  first: number;
  last: number;
  /** its newest mints (and their launch times, same order) */
  mints: string[];
  lts: number[];
  /** funder (funding-graph cache); '' = unknown */
  f: string;
}

export type DeployerClass = 'serial' | 'rugger' | 'elite' | 'proven' | 'new' | 'mixed';

export interface DeployerView {
  class: DeployerClass;
  launches: number;
  graduated: number;
  diedFastPct: number;
  rugs: number;
  /** creators sharing this one's funder (cache only) */
  linked: number;
  linkedSerial: number;
  /** other coins this creator launched in the last 24 h */
  launchesToday: number;
  /** days since the launch before this coin (null = none known) */
  daysSinceLastLaunch: number | null;
  points: number;
  fails: string[];
  note: string;
}

export const emptyDeployer = (now = 0): DeployerRec => ({ l: 0, g: 0, df: 0, rugs: 0, mcs: [], first: now, last: now, mints: [], lts: [], f: '' });

export function deployerConfig(): DeployerConfig {
  const c = (getConfig() as { deployers?: Partial<DeployerConfig> }).deployers;
  return { ...(DEFAULT_CONFIG.deployers as DeployerConfig), ...(c ?? {}), points: { ...(DEFAULT_CONFIG.deployers as DeployerConfig).points, ...(c?.points ?? {}) } };
}

export const diedFastPct = (r: Pick<DeployerRec, 'l' | 'df'>): number => (r.l > 0 ? (r.df / r.l) * 100 : 0);

/** Pure: what kind of deployer is this? A rugger stays a rugger whatever else it did. */
export function classifyDeployer(r: DeployerRec | undefined | null, inRugMemory: boolean, c: Pick<DeployerConfig, 'serialMinLaunches' | 'serialDiedFastPct' | 'provenMaxDiedFastPct' | 'elite'>): DeployerClass {
  if (inRugMemory || (r && r.rugs >= 1)) return 'rugger';
  if (!r || r.l < 2) return 'new';
  const df = diedFastPct(r);
  if (r.l >= c.serialMinLaunches && r.g === 0 && df >= c.serialDiedFastPct) return 'serial';
  const el = c.elite;
  // elite = repeat graduator: ≥ minGraduated graduations AND a bond rate ≥ minBondRatePct (one lucky bond among 40 launches is not it)
  if (el && r.g >= el.minGraduated && (r.g / Math.max(1, r.l)) * 100 >= el.minBondRatePct && df <= c.provenMaxDiedFastPct) return 'elite';
  if (r.g >= 1 && df <= c.provenMaxDiedFastPct) return 'proven';
  return 'mixed';
}

/** Pure: bond rate of a record, % of launches that graduated. */
export const bondRatePct = (r: DeployerRec | undefined | null): number => (r && r.l > 0 ? Math.round((r.g / r.l) * 1000) / 10 : 0);

/** Pure: other launches in the last 24 h and the gap to the launch before this coin. */
export function launchTiming(r: DeployerRec | undefined | null, currentMint: string | null, nowMs: number): { launchesToday: number; daysSinceLastLaunch: number | null } {
  if (!r) return { launchesToday: 0, daysSinceLastLaunch: null };
  const idx = currentMint ? r.mints.indexOf(currentMint) : -1;
  const own = idx >= 0 ? r.lts[idx] ?? null : null;
  let launchesToday = 0;
  let prev: number | null = null;
  for (let i = 0; i < r.lts.length; i++) {
    if (i === idx) continue;
    const t = r.lts[i]!;
    if (nowMs - t <= DAY_MS && t <= nowMs) launchesToday++;
    if ((own === null || t < own) && (prev === null || t > prev)) prev = t;
  }
  const ref = own ?? nowMs;
  return { launchesToday, daysSinceLastLaunch: prev === null ? null : Math.max(0, (ref - prev) / DAY_MS) };
}

/** Pure: the entry verdict for a coin by this deployer (rule strings + points + the buy-explanation note). */
export function deployerView(r: DeployerRec | undefined | null, o: { inRugMemory: boolean; linked: number; linkedSerial: number; currentMint?: string | null; nowMs?: number }, c: DeployerConfig): DeployerView {
  const cls = classifyDeployer(r, o.inRugMemory, c);
  const launches = Math.round(r?.l ?? 0);
  const graduated = Math.round(r?.g ?? 0);
  const rugs = Math.round(r?.rugs ?? 0);
  const df = r ? Math.round(diedFastPct(r)) : 0;
  const timing = launchTiming(r, o.currentMint ?? null, o.nowMs ?? Date.now());
  const fails: string[] = [];
  let points = 0;
  if (cls === 'serial') fails.push(`deployer: serial launcher (${launches} launches, 0 graduated, ${df}% died fast)`);
  if (cls === 'rugger') fails.push(`deployer: rugged before${rugs ? ` (${rugs}×)` : ''}`);
  if (o.linkedSerial >= c.linkedSerialFail && c.linkedSerialFail > 0) fails.push(`deployer: funded alongside ${o.linkedSerial} serial launchers`);
  if (c.maxLaunchesPerDay > 0 && timing.launchesToday >= c.maxLaunchesPerDay) fails.push(`deployer: already launched ${timing.launchesToday} other coin${timing.launchesToday === 1 ? '' : 's'} today (serial)`);
  if (cls === 'proven' && !fails.length) {
    points = c.points.proven;
    if (timing.daysSinceLastLaunch !== null && timing.daysSinceLastLaunch >= c.quietDays) points += c.points.quietProven;
  }
  if (cls === 'elite' && !fails.length) points = c.points.elite ?? c.points.proven + 4;
  const quiet = cls === 'proven' && timing.daysSinceLastLaunch !== null && timing.daysSinceLastLaunch >= c.quietDays ? `, quiet for ${Math.round(timing.daysSinceLastLaunch)} days` : '';
  const note =
    fails.length ? fails[0]!
    : cls === 'elite' ? `deployer: repeat graduator (${launches} launches, ${graduated} graduated, ${bondRatePct(r)}% bond rate)`
    : cls === 'proven' ? `deployer: proven (${launches} launches, ${graduated} graduated${quiet})`
    : cls === 'new' ? `deployer: ${launches === 0 ? 'first launch' : 'new'}`
    : `deployer: mixed record (${launches} launches, ${graduated} graduated, ${df}% died fast)`;
  return { class: cls, launches, graduated, diedFastPct: df, rugs, linked: o.linked, linkedSerial: o.linkedSerial, launchesToday: timing.launchesToday, daysSinceLastLaunch: timing.daysSinceLastLaunch === null ? null : Math.round(timing.daysSinceLastLaunch * 10) / 10, points, fails, note };
}

/** Pure: a record after `days` of fading (counts halve every halfLifeDays). */
export function decayDeployer(r: DeployerRec, days: number, halfLifeDays: number): DeployerRec {
  if (!(days > 0) || !(halfLifeDays > 0)) return r;
  const f = Math.pow(0.5, days / halfLifeDays);
  return { ...r, l: r.l * f, g: r.g * f, df: r.df * f, rugs: r.rugs * f };
}

/** Pure: which creators to evict (oldest last launch) so the book stays at `max`. */
export function deployerEvictions(entries: ReadonlyArray<[string, DeployerRec]>, max: number): string[] {
  if (entries.length <= max) return [];
  return [...entries].sort((a, b) => a[1].last - b[1].last).slice(0, entries.length - max).map(([w]) => w);
}

/** Pure: did a launch die fast? (the dead-launch sweep's numbers) */
export const diedFast = (ageSec: number, holders: number | null): boolean => ageSec <= DEAD_FAST_AGE_SEC && (holders ?? 0) < DEAD_FAST_HOLDERS;

export interface BackfillRow {
  creator: string;
  mint: string;
  createdAtMs: number;
  completedAtMs: number | null;
  rugged: boolean;
  /** last holder count the bot stored (null = unknown) */
  holders: number | null;
  peakMcUsd: number | null;
}

/** Seed an in-memory book from raw Redis HASH entries (replay: read-only). */
export function seedDeployers(book: DeployerBook, raw: Record<string, string>): number {
  let n = 0;
  for (const [w, s] of Object.entries(raw)) {
    try {
      const r = JSON.parse(s) as DeployerRec;
      if (typeof r.l === 'number' && typeof r.last === 'number') {
        const rec = { ...emptyDeployer(), ...r };
        if (!Array.isArray(rec.lts) || rec.lts.length !== rec.mints.length) rec.lts = rec.mints.map(() => rec.last);
        book.seed(w, rec);
        n++;
      }
    } catch {
      /* skip */
    }
  }
  return n;
}

export interface DeployerStats {
  enabled: boolean;
  creators: number;
  proven: number;
  serial: number;
  ruggers: number;
  mixed: number;
  launches: number;
}

export class DeployerBook {
  private readonly recs = new Map<string, DeployerRec>();
  private readonly dirty = new Set<string>();
  private readonly byFunder = new Map<string, Set<string>>();
  /** mints already counted as dead / graduated (bounded) */
  private readonly seenDead = new Set<string>();
  private readonly seenGrad = new Set<string>();
  private readonly seenLaunch = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastDecayDay = 0;
  private counts = { launches: 0 };
  /** creators flagged in the rugger memory (refreshed by the caller; cache so classify stays sync) */
  private readonly rugFlagged = new Set<string>();

  constructor(private readonly redis: Redis | null = null) {}

  get size(): number {
    return this.recs.size;
  }

  get(creator: string): DeployerRec | undefined {
    return this.recs.get(creator);
  }

  seed(creator: string, rec: DeployerRec): void {
    this.recs.set(creator, rec);
    if (rec.f) this.link(creator, rec.f);
  }

  private rec(creator: string, now: number): DeployerRec {
    let r = this.recs.get(creator);
    if (!r) {
      r = emptyDeployer(now);
      this.recs.set(creator, r);
      const max = deployerConfig().maxCreators;
      if (this.recs.size > max * 1.05) this.evict(max);
    }
    return r;
  }

  private bounded(set: Set<string>, v: string): boolean {
    if (set.has(v)) return false;
    set.add(v);
    if (set.size > 30_000) for (const x of set) { set.delete(x); if (set.size <= 20_000) break; }
    return true;
  }

  onLaunch(creator: string, mint: string, atMs = Date.now()): void {
    if (!creator || !mint || !deployerConfig().enabled || !this.bounded(this.seenLaunch, mint)) return;
    const r = this.rec(creator, atMs);
    r.l++;
    r.last = Math.max(r.last, atMs);
    if (r.first === 0 || atMs < r.first) r.first = atMs;
    const keep = r.mints.map((m, i) => [m, r.lts[i] ?? 0] as const).filter(([m]) => m !== mint);
    keep.push([mint, atMs]);
    keep.sort((a, b) => a[1] - b[1]);
    const tail = keep.slice(-MAX_MINTS);
    r.mints = tail.map(([m]) => m);
    r.lts = tail.map(([, t]) => t);
    this.counts.launches++;
    this.dirty.add(creator);
  }

  onGraduated(creator: string | null | undefined, mint: string, mcUsd: number | null = null, atMs = Date.now()): void {
    if (!creator || !this.bounded(this.seenGrad, mint)) return;
    const r = this.rec(creator, atMs);
    r.g++;
    if (mcUsd && mcUsd > 0) r.mcs = [...r.mcs, Math.round(mcUsd)].slice(-MAX_MCS);
    this.dirty.add(creator);
  }

  /** The dead-launch sweep: a coin forgotten with no life — counts as "died fast" inside the first 30 min. */
  onDead(creator: string | null | undefined, mint: string, ageSec: number, holders: number | null, atMs = Date.now()): void {
    if (!creator || !diedFast(ageSec, holders) || !this.bounded(this.seenDead, mint)) return;
    const r = this.rec(creator, atMs);
    r.df++;
    this.dirty.add(creator);
  }

  onRug(creator: string | null | undefined, atMs = Date.now()): void {
    if (!creator || creator.startsWith('(')) return;
    const r = this.rec(creator, atMs);
    r.rugs++;
    this.dirty.add(creator);
  }

  notePeakMc(creator: string | null | undefined, mcUsd: number, atMs = Date.now()): void {
    if (!creator || !(mcUsd > 0)) return;
    const r = this.rec(creator, atMs);
    const last = r.mcs[r.mcs.length - 1];
    if (last === undefined || mcUsd > last * 1.2) r.mcs = [...r.mcs, Math.round(mcUsd)].slice(-MAX_MCS);
    this.dirty.add(creator);
  }

  /** The creator's funder from the funding-graph cache (the evaluator passes what it already read). */
  noteFunder(creator: string, funder: string | null | undefined, atMs = Date.now()): void {
    if (!creator || !funder || funder === creator) return;
    const r = this.rec(creator, atMs);
    if (r.f === funder) return;
    r.f = funder;
    this.link(creator, funder);
    this.dirty.add(creator);
  }

  private link(creator: string, funder: string): void {
    let s = this.byFunder.get(funder);
    if (!s) {
      s = new Set();
      this.byFunder.set(funder, s);
    }
    s.add(creator);
  }

  /** Which of the given creators the rugger memory flags (the evaluator refreshes this; sync reads elsewhere). */
  setRugFlagged(creator: string, flagged: boolean): void {
    if (flagged) this.rugFlagged.add(creator);
    else this.rugFlagged.delete(creator);
    if (this.rugFlagged.size > 20_000) this.rugFlagged.clear();
  }

  /** Other creators sharing this one's funder, and how many of them are serial launchers. */
  linkedOf(creator: string): { linked: number; linkedSerial: number } {
    const f = this.recs.get(creator)?.f;
    if (!f) return { linked: 0, linkedSerial: 0 };
    const c = deployerConfig();
    let linked = 0, linkedSerial = 0;
    for (const other of this.byFunder.get(f) ?? []) {
      if (other === creator) continue;
      linked++;
      if (classifyDeployer(this.recs.get(other), this.rugFlagged.has(other), c) === 'serial') linkedSerial++;
    }
    return { linked, linkedSerial };
  }

  classOf(creator: string, inRugMemory = this.rugFlagged.has(creator)): DeployerClass {
    return classifyDeployer(this.recs.get(creator), inRugMemory, deployerConfig());
  }

  view(creator: string, inRugMemory = this.rugFlagged.has(creator), currentMint: string | null = null, nowMs = Date.now()): DeployerView {
    return deployerView(this.recs.get(creator), { inRugMemory, ...this.linkedOf(creator), currentMint, nowMs }, deployerConfig());
  }

  /** Pure-ish merge of history rows (Token table + rugged positions) — idempotent per mint. */
  backfillFrom(rows: readonly BackfillRow[], now = Date.now()): number {
    let n = 0;
    for (const x of rows) {
      if (!x.creator || x.creator.startsWith('(') || !x.mint) continue;
      if (this.seenLaunch.has(x.mint)) continue;
      this.onLaunch(x.creator, x.mint, x.createdAtMs);
      n++;
      if (x.completedAtMs) this.onGraduated(x.creator, x.mint, x.peakMcUsd, x.completedAtMs);
      else if (x.holders !== null && now - x.createdAtMs > DEAD_FAST_AGE_SEC * 1000 && diedFast(DEAD_FAST_AGE_SEC, x.holders)) this.onDead(x.creator, x.mint, DEAD_FAST_AGE_SEC, x.holders, x.createdAtMs);
      if (x.rugged) this.onRug(x.creator, x.createdAtMs);
      if (x.peakMcUsd && !x.completedAtMs) this.notePeakMc(x.creator, x.peakMcUsd, x.createdAtMs);
    }
    return n;
  }

  private evict(max: number): void {
    for (const w of deployerEvictions([...this.recs.entries()], max)) {
      const r = this.recs.get(w);
      if (r?.f) this.byFunder.get(r.f)?.delete(w);
      this.recs.delete(w);
      this.dirty.delete(w);
      if (this.redis) void this.redis.hdel(DBOOK_KEY, w).catch(() => undefined);
    }
  }

  stats(): DeployerStats {
    const c = deployerConfig();
    let proven = 0, serial = 0, ruggers = 0, mixed = 0;
    for (const [w, r] of this.recs) {
      const k = classifyDeployer(r, this.rugFlagged.has(w), c);
      if (k === 'proven') proven++;
      else if (k === 'serial') serial++;
      else if (k === 'rugger') ruggers++;
      else if (k === 'mixed') mixed++;
    }
    return { enabled: c.enabled, creators: this.recs.size, proven, serial, ruggers, mixed, launches: this.counts.launches };
  }

  /** Best proven creators (by graduations, then peak MC) / worst serial launchers (by launches). */
  top(kind: 'proven' | 'serial' | 'rugger' | 'elite', n = 10): Array<{ creator: string; rec: DeployerRec; class: DeployerClass }> {
    const c = deployerConfig();
    const xs = [...this.recs.entries()].map(([creator, rec]) => ({ creator, rec, class: classifyDeployer(rec, this.rugFlagged.has(creator), c) })).filter((x) => x.class === kind);
    xs.sort((a, b) => (kind === 'proven' || kind === 'elite' ? b.rec.g - a.rec.g || Math.max(...b.rec.mcs, 0) - Math.max(...a.rec.mcs, 0) : kind === 'serial' ? b.rec.l - a.rec.l : b.rec.rugs - a.rec.rugs));
    return xs.slice(0, n);
  }

  decay(now = Date.now()): void {
    const day = Math.floor(now / 86_400_000);
    if (this.lastDecayDay === 0) {
      this.lastDecayDay = day;
      return;
    }
    const days = day - this.lastDecayDay;
    if (days <= 0) return;
    const hl = deployerConfig().halfLifeDays;
    for (const [w, r] of this.recs) {
      this.recs.set(w, decayDeployer(r, days, hl));
      this.dirty.add(w);
    }
    this.lastDecayDay = day;
  }

  /** Where the backfill stopped last time (ms), so restarts never double-count. */
  async backfilledUntil(): Promise<number> {
    if (!this.redis) return 0;
    return Number((await this.redis.hget(DBOOK_META, 'until').catch(() => null)) ?? 0) || 0;
  }

  async markBackfilled(untilMs: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.hset(DBOOK_META, 'until', String(untilMs)).catch(() => undefined);
  }

  async load(): Promise<number> {
    if (!this.redis) return 0;
    try {
      const [all, meta] = await Promise.all([this.redis.hgetall(DBOOK_KEY), this.redis.hget(DBOOK_META, 'day')]);
      seedDeployers(this, all);
      for (const m of [...this.recs.values()].flatMap((r) => r.mints)) this.seenLaunch.add(m);
      this.lastDecayDay = Number(meta ?? 0) || 0;
      log.info({ creators: this.recs.size }, '🏗️ deployer book loaded');
      return this.recs.size;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'deployer book load failed');
      return 0;
    }
  }

  async persist(now = Date.now()): Promise<number> {
    if (!this.redis || !this.dirty.size) return 0;
    this.decay(now);
    const ws = [...this.dirty];
    this.dirty.clear();
    try {
      for (let i = 0; i < ws.length; i += 2000) {
        const pipe = this.redis.pipeline();
        const chunk: Record<string, string> = {};
        for (const w of ws.slice(i, i + 2000)) {
          const r = this.recs.get(w);
          if (r) chunk[w] = JSON.stringify(r);
        }
        if (Object.keys(chunk).length) pipe.hset(DBOOK_KEY, chunk);
        pipe.hset(DBOOK_META, 'day', String(this.lastDecayDay));
        await pipe.exec();
      }
      return ws.length;
    } catch (err) {
      for (const w of ws) this.dirty.add(w);
      log.warn({ err: (err as Error).message }, 'deployer book persist failed');
      return 0;
    }
  }

  start(): void {
    this.decay();
    this.timer = setInterval(() => void this.persist(), 60_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.persist();
  }
}
