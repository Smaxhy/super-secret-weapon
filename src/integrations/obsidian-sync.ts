/**
 * Obsidian shared brain — the bot's notebook, read and written by the owner AND the bot.
 *
 * When `OBSIDIAN_VAULT_PATH` is set (env or BotConfig `obsidian.vaultPath`) the bot keeps a vault (layout in
 * obsidian-notes.ts): trade logs + one note per closed trade, one note per coin it took seriously, one per notable
 * wallet (proven / dumper / deployer sniper), one per strategy, one per day, and the AI coach's memory, insights,
 * diary and tip replies — all linked with wikilinks so the graph view shows coins ↔ wallets ↔ trades ↔ strategies.
 * The owner writes in `00 Inbox/` only: Tips.md lines become brain tips, Notes.md is read before every AI review.
 *
 * Nothing here touches the hot path: evaluations and trades are queued in memory and written by a 10-minute flush
 * (trade logs and diary entries are written as they happen — rare). File counts are capped.
 * On the VPS the vault is /vault (= /root/bot/obsidian); the owner's PC copies it every 10 minutes.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { moduleLogger } from '../lib/logger';
import { bus, type BusEvent } from '../lib/bus';
import type { WalletRec, WalletClass } from '../learner/wallet-book';
import {
  DIRS, coinFile, coinNote, dailyNote, dashboardNote, dayOf, deployerEvictionsForNotes, deployerNote, diaryEntryText, diaryHeader, howToNote, indexNote, inboxKey, insightsNote, memoryNote,
  parseInbox, strategyNote, tipRepliesNote, tradeLogHeader, tradeLogLine, tradeNote, walletEvictions, walletNote, withinDailyCap,
  type CoinState, type DeployerState, type DiaryEntry, type NotableWallet, type Note, type TipView, type WalletState,
} from './obsidian-notes';
import type { DeployerClass, DeployerRec } from '../learner/deployer-book';

const log = moduleLogger('obsidian');

export interface ObsidianConfig {
  enabled: boolean;
  vaultPath: string;
  inbox?: { enabled: boolean; pollSec: number };
  maxCoinNotesPerDay?: number;
  maxWalletNotes?: number;
  /** skipped coins get a note only when their score is within this many points of the bar */
  minSkippedScoreMargin?: number;
}

interface TradeEvent {
  type: 'entry' | 'exit';
  mint: string;
  symbol?: string;
  strategy: string;
  sizeSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  exitReason?: string;
  explanation?: string;
  score?: number;
  marketCapUsd?: number;
  multiple?: number;
  closed?: boolean;
}

type BusTrade = Extract<BusEvent, { type: 'trade' }>['data'];
export interface PositionInfo { strategy: string; sizeSol: number; score?: number | null; mcUsd?: number | null; openedAtMs?: number | null }

/** Where the notes get their facts (wired in index.ts); every source is optional. */
export interface ObsidianSources {
  closedSince?: (sinceMs: number) => Promise<Array<{ symbol: string | null; strategy: string; pnlSol: number; sizeSol: number }>>;
  positionFor?: (mint: string) => Promise<PositionInfo | null>;
  strategies?: () => Array<{ strategy: string; trades: number; winRate: number; avgPnl: number; totalPnl: number; verdict?: string; topSkips?: string[] }>;
  insights?: () => Promise<Array<{ text: string; confidence?: number; at?: string }>>;
  walletRec?: (wallet: string) => WalletRec | undefined;
  walletClass?: (wallet: string) => WalletClass;
  /** the book's current best proven / worst dumpers (so wallet notes exist even without a coin event) */
  topWallets?: () => Array<{ wallet: string; cls: WalletClass }>;
  tips?: () => Promise<TipView[]>;
  addTip?: (text: string) => Promise<unknown>;
  changesSince?: (sinceMs: number) => Promise<Array<{ at: string; source: string; what: string; why: string }>>;
  /** Redis INCR on a daily counter (the coin-note cap) */
  incrDaily?: (key: string) => Promise<number>;
  /** Redis SADD → true when the member is new (inbox dedupe) */
  markSeen?: (key: string, member: string) => Promise<boolean>;
  memory?: () => Promise<string[]>;
  sniperRules?: () => string[];
  /** v11.10: the deployer book's record for a creator (refreshed when its note is written) */
  deployerRec?: (creator: string) => DeployerRec | undefined;
}

export interface EvaluationEvent {
  mint: string;
  symbol: string | null;
  name: string | null;
  strategy: string;
  decision: 'BUY' | 'SKIP' | 'REJECT';
  score: number;
  threshold: number;
  reasons: string[];
  mcUsd: number | null;
  migrated: boolean;
  firstSeenMs: number;
  /** distinct buyers in the crowd log (classified here through the wallet book) */
  buyerWallets: string[];
  deployerSniperWallets: string[];
  crowdNote: string | null;
  dumpCrew: boolean;
  provenCrowd: boolean;
  /** v11.10 deployer history */
  creator?: string | null;
  deployerClass?: string | null;
  deployerNote?: string | null;
  /** v11.11: a Telegram link anywhere in the socials / description */
  telegram?: boolean;
}

/** Pure: the bus's trade event (one 'event' with type 'trade') → a journal line. */
export function tradeFromBus(d: BusTrade, pos: PositionInfo | null): TradeEvent {
  const entry = d.side.toUpperCase() === 'BUY';
  const sizeSol = pos?.sizeSol ?? (entry ? d.amountSol : undefined);
  return {
    type: entry ? 'entry' : 'exit',
    mint: d.mint,
    symbol: d.symbol,
    strategy: pos?.strategy ?? 'unknown',
    sizeSol,
    pnlSol: entry ? undefined : d.pnlSol,
    pnlPct: !entry && d.pnlSol !== undefined && sizeSol ? (d.pnlSol / sizeSol) * 100 : undefined,
    exitReason: entry ? undefined : d.reason,
    explanation: d.explanation ?? undefined,
    score: pos?.score ?? undefined,
    marketCapUsd: pos?.mcUsd ?? undefined,
    multiple: d.peakMultiple,
    closed: d.closed,
  };
}

const MAX_COIN_STATES = 3000;
const WALLET_REFRESH_MS = 60 * 60_000;
const MAX_DEPLOYER_NOTES = 1000;

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

export class ObsidianSync {
  private readonly vault: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private readonly coins = new Map<string, CoinState>();
  private readonly dirtyCoins = new Set<string>();
  private readonly wallets = new Map<string, WalletState>();
  private readonly dirtyWallets = new Set<string>();
  private readonly deployers = new Map<string, DeployerState>();
  private readonly dirtyDeployers = new Set<string>();
  /** trade note paths per day (for the day note) */
  private readonly tradeNotes = new Map<string, string[]>();
  private readonly counts = { coins: 0, wallets: 0, trades: 0 };
  private lastDiaryMs = 0;
  private flushing = false;

  constructor(private readonly cfg: ObsidianConfig, private readonly sources: ObsidianSources = {}) {
    this.vault = cfg.vaultPath;
  }

  get enabled(): boolean {
    return this.cfg.enabled && !!this.vault;
  }

  async start(b: typeof bus, flushEveryMs = 10 * 60_000, firstAfterMs = 20_000): Promise<void> {
    if (!this.enabled) return;
    for (const d of Object.values(DIRS)) await ensureDir(path.join(this.vault, d));
    await ensureDir(path.join(this.vault, DIRS.inbox));
    await this.write(dashboardNote());
    await this.write(howToNote());
    await this.writeIndex();
    b.on('event', (ev: BusEvent) => {
      if (ev.type !== 'trade') return;
      void this.onBusTrade(ev.data).catch((e) => log.warn({ err: (e as Error).message }, 'obsidian trade write failed'));
    });
    this.timer = setInterval(() => void this.flush(), flushEveryMs);
    setTimeout(() => void this.flush(), firstAfterMs);
    const ib = this.cfg.inbox ?? { enabled: true, pollSec: 60 };
    if (ib.enabled && this.sources.addTip && this.sources.markSeen) {
      this.inboxTimer = setInterval(() => void this.pollInbox(), Math.max(15, ib.pollSec) * 1000);
      setTimeout(() => void this.pollInbox(), 10_000);
    }
    log.info({ vault: this.vault }, 'obsidian shared brain started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inboxTimer) { clearInterval(this.inboxTimer); this.inboxTimer = null; }
  }

  // ───────────────────────────── evaluations → coin + wallet notes ─────────────────────────────
  /** Called by the evaluator (synchronous, no I/O): coins it wanted or nearly wanted get a note on the next flush. */
  onEvaluation(ev: EvaluationEvent, now = Date.now()): void {
    if (!this.enabled) return;
    const margin = this.cfg.minSkippedScoreMargin ?? 10;
    const wanted = ev.decision === 'BUY';
    if (!wanted && !(ev.decision === 'SKIP' && ev.score >= ev.threshold - margin)) return;
    const existing = this.coins.get(ev.mint);
    if (!existing) {
      // New coin note today → counts against the daily cap (Redis so a restart doesn't reset it).
      void this.admit(ev, now).catch(() => undefined);
      return;
    }
    this.mergeCoin(existing, ev, now);
  }

  private async admit(ev: EvaluationEvent, now: number): Promise<void> {
    const n = this.sources.incrDaily ? await this.sources.incrDaily(`obs:coins:${dayOf(now)}`) : this.counts.coins + 1;
    if (!withinDailyCap(n, this.cfg.maxCoinNotesPerDay ?? 300)) return;
    if (this.coins.has(ev.mint)) return this.mergeCoin(this.coins.get(ev.mint)!, ev, now);
    const c: CoinState = {
      mint: ev.mint, symbol: ev.symbol, name: ev.name, strategies: [], firstSeenMs: ev.firstSeenMs || now, mcUsd: ev.mcUsd, migrated: ev.migrated,
      verdict: 'skipped', score: null, threshold: null, why: '', crowdNote: null, dumpCrew: false, provenCrowd: false, wallets: [], trades: [], days: [], updatedMs: now,
    };
    this.coins.set(ev.mint, c);
    if (this.coins.size > MAX_COIN_STATES) {
      const oldest = [...this.coins.values()].sort((a, b) => a.updatedMs - b.updatedMs).slice(0, this.coins.size - MAX_COIN_STATES);
      for (const o of oldest) { this.coins.delete(o.mint); this.dirtyCoins.delete(o.mint); }
    }
    this.mergeCoin(c, ev, now);
  }

  private mergeCoin(c: CoinState, ev: EvaluationEvent, now: number): void {
    if (!c.strategies.includes(ev.strategy)) c.strategies.push(ev.strategy);
    if (c.verdict !== 'bought' && (ev.decision === 'BUY' || c.score === null || ev.score > c.score)) {
      if (ev.decision === 'BUY' && c.verdict === 'skipped') c.verdict = 'signal';
      c.score = ev.score;
      c.threshold = ev.threshold;
      c.why = ev.reasons[0] ?? c.why;
    }
    if (ev.symbol) c.symbol = ev.symbol;
    if (ev.name) c.name = ev.name;
    if (ev.mcUsd !== null) c.mcUsd = ev.mcUsd;
    c.migrated = c.migrated || ev.migrated;
    c.crowdNote = ev.crowdNote ?? c.crowdNote;
    c.dumpCrew = c.dumpCrew || ev.dumpCrew;
    c.provenCrowd = c.provenCrowd || ev.provenCrowd;
    if (ev.creator) c.creator = ev.creator;
    if (ev.telegram !== undefined) c.telegram = ev.telegram;
    if (ev.deployerClass) {
      c.deployerClass = ev.deployerClass;
      c.deployerNote = ev.deployerNote ?? c.deployerNote ?? null;
      if (ev.creator && (ev.deployerClass === 'proven' || ev.deployerClass === 'serial' || ev.deployerClass === 'rugger')) this.touchDeployer(ev.creator, ev.deployerClass, `${DIRS.coins}/${coinFile(c.symbol, c.mint)}`, now);
    }
    const day = dayOf(now);
    if (!c.days.includes(day)) c.days.push(day);
    for (const w of this.notable(ev.buyerWallets, ev.deployerSniperWallets)) {
      if (!c.wallets.some((x) => x.wallet === w.wallet)) c.wallets.push(w);
      this.touchWallet(w, `${DIRS.coins}/${coinFile(c.symbol, c.mint)}`, now);
    }
    c.wallets = c.wallets.slice(0, 15);
    c.updatedMs = now;
    this.dirtyCoins.add(c.mint);
  }

  private notable(buyers: string[], snipers: string[]): NotableWallet[] {
    const out = new Map<string, NotableWallet>();
    for (const w of snipers) out.set(w, { wallet: w, cls: 'deployer-sniper' });
    if (this.sources.walletClass) {
      for (const w of buyers.slice(0, 80)) {
        if (out.has(w)) continue;
        const cls = this.sources.walletClass(w);
        if (cls === 'proven' || cls === 'dumper') out.set(w, { wallet: w, cls });
      }
    }
    return [...out.values()].slice(0, 15);
  }

  private touchWallet(w: NotableWallet, coinPath: string | null, now: number): void {
    let s = this.wallets.get(w.wallet);
    if (!s) {
      s = { wallet: w.wallet, cls: w.cls, rec: null, coins: [], lastSeenMs: now, writtenMs: 0 };
      this.wallets.set(w.wallet, s);
    }
    if (w.cls === 'deployer-sniper' || s.cls !== 'deployer-sniper') s.cls = w.cls;
    if (coinPath && !s.coins.includes(coinPath)) s.coins = [...s.coins, coinPath].slice(-30);
    s.lastSeenMs = now;
    if (now - s.writtenMs >= WALLET_REFRESH_MS) this.dirtyWallets.add(w.wallet);
  }

  private touchDeployer(creator: string, cls: DeployerClass, coinPath: string | null, now: number): void {
    let s = this.deployers.get(creator);
    if (!s) {
      s = { creator, cls, rec: null, coins: [], lastSeenMs: now, writtenMs: 0 };
      this.deployers.set(creator, s);
    }
    s.cls = cls;
    if (coinPath && !s.coins.includes(coinPath)) s.coins = [...s.coins, coinPath].slice(-30);
    s.lastSeenMs = now;
    if (now - s.writtenMs >= WALLET_REFRESH_MS) this.dirtyDeployers.add(creator);
  }

  // ───────────────────────────── trades ─────────────────────────────
  private async onBusTrade(d: BusTrade, now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    const pos = this.sources.positionFor ? await this.sources.positionFor(d.mint).catch(() => null) : null;
    const ev = tradeFromBus(d, pos);
    const day = dayOf(now);
    const logPath = path.join(this.vault, DIRS.trades, `${day}.md`);
    try {
      await fs.access(logPath);
    } catch {
      await fs.writeFile(logPath, tradeLogHeader(day));
    }
    await fs.appendFile(logPath, tradeLogLine({ atMs: now, entry: ev.type === 'entry', symbol: ev.symbol ?? null, mint: ev.mint, strategy: ev.strategy, sizeSol: ev.sizeSol, pnlSol: ev.pnlSol, pnlPct: ev.pnlPct, score: ev.score, mcUsd: ev.marketCapUsd, exitReason: ev.exitReason, multiple: ev.multiple }));
    // The coin note: a trade = the bot really bought it.
    let c = this.coins.get(ev.mint);
    if (!c) {
      c = { mint: ev.mint, symbol: ev.symbol ?? null, name: null, strategies: [], firstSeenMs: pos?.openedAtMs ?? now, mcUsd: ev.marketCapUsd ?? null, migrated: false, verdict: 'bought', score: ev.score ?? null, threshold: null, why: ev.explanation ?? 'bought', crowdNote: null, dumpCrew: false, provenCrowd: false, wallets: [], trades: [], days: [], updatedMs: now };
      this.coins.set(ev.mint, c);
    }
    c.verdict = 'bought';
    if (!c.strategies.includes(ev.strategy)) c.strategies.push(ev.strategy);
    if (!c.days.includes(day)) c.days.push(day);
    if (ev.explanation && c.why.length < 40) c.why = ev.explanation;
    if (ev.type === 'exit' && ev.closed !== false) {
      const note = tradeNote({
        mint: ev.mint, symbol: ev.symbol ?? null, strategy: ev.strategy, atMs: now, pnlSol: ev.pnlSol ?? null, pnlPct: ev.pnlPct ?? null, peakMultiple: ev.multiple ?? null,
        exitReason: ev.exitReason ?? null, score: ev.score ?? null, mcUsd: ev.marketCapUsd ?? null, sizeSol: ev.sizeSol ?? null,
        heldMin: pos?.openedAtMs ? (now - pos.openedAtMs) / 60_000 : null, explanation: ev.explanation ?? null, wallets: c.wallets,
      });
      await this.write(note);
      this.counts.trades++;
      const p = note.path.replace(/\.md$/, '');
      c.trades.push(p);
      this.tradeNotes.set(day, [...(this.tradeNotes.get(day) ?? []), p]);
      for (const w of c.wallets) this.touchWallet(w, `${DIRS.coins}/${coinFile(c.symbol, c.mint)}`, now);
    }
    c.updatedMs = now;
    this.dirtyCoins.add(ev.mint);
    await this.write(coinNote(c));
    this.dirtyCoins.delete(ev.mint);
  }

  // ───────────────────────────── the 10-minute flush ─────────────────────────────
  async flush(now = Date.now()): Promise<void> {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      await this.writeSummaries(now);
      for (const mint of [...this.dirtyCoins]) {
        const c = this.coins.get(mint);
        if (c) { await this.write(coinNote(c)); this.counts.coins++; }
        this.dirtyCoins.delete(mint);
      }
      for (const w of this.sources.topWallets?.() ?? []) this.touchWallet({ wallet: w.wallet, cls: w.cls }, null, now);
      for (const w of walletEvictions([...this.wallets.values()], this.cfg.maxWalletNotes ?? 2000)) { this.wallets.delete(w); this.dirtyWallets.delete(w); }
      for (const w of [...this.dirtyWallets]) {
        const s = this.wallets.get(w);
        if (s) {
          s.rec = this.sources.walletRec?.(w) ?? s.rec;
          await this.write(walletNote(s));
          s.writtenMs = now;
          this.counts.wallets++;
        }
        this.dirtyWallets.delete(w);
      }
      for (const c of deployerEvictionsForNotes([...this.deployers.values()], MAX_DEPLOYER_NOTES)) { this.deployers.delete(c); this.dirtyDeployers.delete(c); }
      for (const c of [...this.dirtyDeployers]) {
        const s = this.deployers.get(c);
        if (s) {
          s.rec = this.sources.deployerRec?.(c) ?? s.rec;
          await this.write(deployerNote(s, now));
          s.writtenMs = now;
        }
        this.dirtyDeployers.delete(c);
      }
      if (this.sources.tips) await this.write(tipRepliesNote(await this.sources.tips(), now));
      if (this.sources.memory) await this.write(memoryNote(await this.sources.memory(), now));
      await this.writeIndex(now);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'obsidian flush failed');
    } finally {
      this.flushing = false;
    }
  }

  /** Today's note, one note per strategy, the AI's latest insights (also called by tests). */
  async writeSummaries(now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    const day = dayOf(now);
    const closed = this.sources.closedSince ? await this.sources.closedSince(Date.parse(`${day}T00:00:00Z`)) : [];
    const label = (t: { symbol: string | null; pnlSol: number }) => `${t.symbol ?? '?'} ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(3)} SOL`;
    const sorted = [...closed].sort((a, b) => b.pnlSol - a.pnlSol);
    const byStrategy = new Map<string, { trades: number; pnl: number }>();
    for (const t of closed) {
      const s = byStrategy.get(t.strategy) ?? { trades: 0, pnl: 0 };
      s.trades += 1;
      s.pnl += t.pnlSol;
      byStrategy.set(t.strategy, s);
    }
    await this.write(dailyNote(day, {
      trades: closed.length,
      wins: closed.filter((t) => t.pnlSol > 0).length,
      pnlSol: closed.reduce((a, t) => a + t.pnlSol, 0),
      bestTrade: sorted[0] ? label(sorted[0]) : undefined,
      worstTrade: sorted.length > 1 ? label(sorted[sorted.length - 1]!) : undefined,
      byStrategy: [...byStrategy].map(([strategy, v]) => ({ strategy, ...v })),
      tradeLinks: this.tradeNotes.get(day) ?? [],
    }));
    const rules = this.sources.sniperRules?.() ?? [];
    for (const s of this.sources.strategies?.() ?? []) await this.write(strategyNote(s.strategy, s, rules, now));
    const ins = this.sources.insights ? await this.sources.insights() : [];
    if (ins.length) await this.write(insightsNote(ins, now));
  }

  // ───────────────────────────── inbox (owner → brain) ─────────────────────────────
  /** New lines in 00 Inbox/Tips.md become brain tips (deduped forever by their hash). */
  async pollInbox(): Promise<number> {
    if (!this.enabled || !this.sources.addTip || !this.sources.markSeen) return 0;
    let text: string;
    try {
      text = await fs.readFile(path.join(this.vault, DIRS.inbox, 'Tips.md'), 'utf8');
    } catch {
      return 0;
    }
    let added = 0;
    for (const line of parseInbox(text).slice(0, 50)) {
      try {
        if (!(await this.sources.markSeen('obs:tips:seen', inboxKey(line)))) continue;
        await this.sources.addTip(line.slice(0, 1000));
        added++;
        log.info({ tip: line.slice(0, 120) }, '📝 tip from the Obsidian inbox');
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'inbox tip failed');
      }
    }
    if (added && this.sources.tips) await this.write(tipRepliesNote(await this.sources.tips())).catch(() => undefined);
    return added;
  }

  /** The owner's free-form notes (00 Inbox/Notes.md, last 4,000 characters) for the AI coach's prompt. */
  async ownerNotes(maxChars = 4000): Promise<string> {
    if (!this.enabled) return '';
    try {
      const t = await fs.readFile(path.join(this.vault, DIRS.inbox, 'Notes.md'), 'utf8');
      return t.length > maxChars ? t.slice(-maxChars) : t;
    } catch {
      return '';
    }
  }

  // ───────────────────────────── AI coach → diary + memory ─────────────────────────────
  async onReview(e: Omit<DiaryEntry, 'changes'> & { memory: string[] }): Promise<void> {
    if (!this.enabled) return;
    try {
      const changes = this.sources.changesSince ? await this.sources.changesSince(this.lastDiaryMs || e.atMs - 3600_000) : [];
      const day = dayOf(e.atMs);
      const fp = path.join(this.vault, DIRS.diary, `${day}.md`);
      await ensureDir(path.dirname(fp));
      try {
        await fs.access(fp);
      } catch {
        await fs.writeFile(fp, diaryHeader(day));
      }
      await fs.appendFile(fp, diaryEntryText({ ...e, changes }));
      await this.write(memoryNote(e.memory, e.atMs));
      this.lastDiaryMs = e.atMs;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'obsidian diary failed');
    }
  }

  /** A short diary entry outside an AI review (the self-improving loop's steps). */
  async appendDiary(atMs: number, title: string, lines: readonly string[]): Promise<void> {
    if (!this.enabled) return;
    try {
      const day = dayOf(atMs);
      const fp = path.join(this.vault, DIRS.diary, `${day}.md`);
      await ensureDir(path.dirname(fp));
      try {
        await fs.access(fp);
      } catch {
        await fs.writeFile(fp, diaryHeader(day));
      }
      const time = new Date(atMs).toISOString().slice(11, 16);
      await fs.appendFile(fp, ['', `## ${time} — ${title}`, ...lines.map((l) => `- ${l}`), ''].join('\n'));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'obsidian diary failed');
    }
  }

  snapshot(): { coins: number; wallets: number; trades: number; vault: string } {
    return { ...this.counts, vault: this.vault };
  }

  private async writeIndex(now = Date.now()): Promise<void> {
    const days = [...new Set([...this.tradeNotes.keys(), dayOf(now)])].sort().reverse().slice(0, 3);
    await this.write(indexNote({ recentDays: days, recentDiary: days, strategies: (this.sources.strategies?.() ?? []).map((s) => s.strategy), counts: this.counts }, now));
  }

  private async write(n: Note): Promise<void> {
    const fp = path.join(this.vault, n.path);
    await ensureDir(path.dirname(fp));
    await fs.writeFile(fp, n.content);
  }
}
