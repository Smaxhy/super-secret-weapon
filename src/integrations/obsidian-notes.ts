/**
 * Obsidian shared brain — PURE note builders (no fs, no Redis). Every builder returns the vault-relative path and the
 * note's full content: YAML frontmatter + wikilinks, so the graph view links coins ↔ wallets ↔ trades ↔ strategies ↔ days.
 *
 * Vault layout (bot-owned unless noted):
 *   00 Inbox/            owner-owned: Tips.md (lines → brain tips), Notes.md (free text the AI coach reads)
 *   10 Trades/<day>.md + 10 Trades/<strategy>/<SYMBOL-mint8>-<day>-<time>.md
 *   20 Coins/<SYMBOL-mint8>.md      30 Wallets/<wallet12>.md      40 Strategies/<strategy>.md
 *   50 Daily/<day>.md               90 Brain/{Insights,Memory,Tip replies}.md + 90 Brain/Diary/<day>.md
 *   _Dashboard.md (Dataview) · _Index.md · _How to read this vault.md
 */
import { createHash } from 'crypto';
import type { WalletRec, WalletClass } from '../learner/wallet-book';
import { launchTiming, type DeployerClass, type DeployerRec } from '../learner/deployer-book';

export const DIRS = {
  inbox: '00 Inbox',
  trades: '10 Trades',
  coins: '20 Coins',
  wallets: '30 Wallets',
  deployers: '35 Deployers',
  strategies: '40 Strategies',
  daily: '50 Daily',
  brain: '90 Brain',
  diary: '90 Brain/Diary',
} as const;

export interface Note { path: string; content: string }

export function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*#^[\]]/g, '_').trim().slice(0, 60) || '_';
}
export const mintShort = (mint: string): string => mint.slice(0, 8);
export const walletShort = (w: string): string => w.slice(0, 12);
export const coinFile = (symbol: string | null | undefined, mint: string): string => `${sanitize(symbol || mintShort(mint))}-${mintShort(mint)}`;
export const walletFile = (w: string): string => sanitize(walletShort(w));
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const timeOf = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** [[path|label]] — the path has no .md. */
export const link = (p: string, label?: string): string => `[[${p}${label ? `|${label}` : ''}]]`;
export const coinLink = (symbol: string | null | undefined, mint: string): string => link(`${DIRS.coins}/${coinFile(symbol, mint)}`, symbol || mintShort(mint));
export const walletLink = (w: string, cls?: string): string => link(`${DIRS.wallets}/${walletFile(w)}`, `${walletShort(w)}…${cls ? ` (${cls})` : ''}`);
export const strategyLink = (s: string): string => link(`${DIRS.strategies}/${sanitize(s)}`, s);
export const deployerLink = (c: string, cls?: string | null): string => link(`${DIRS.deployers}/${walletFile(c)}`, `${walletShort(c)}…${cls ? ` (${cls})` : ''}`);
export const dayLink = (day: string): string => link(`${DIRS.daily}/${day}`, day);
export const diaryLink = (day: string): string => link(`${DIRS.diary}/${day}`, `diary ${day}`);

const yv = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 10_000) / 10_000) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.length ? `\n${v.map((x) => `  - ${yv(x)}`).join('\n')}` : '[]';
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
};
/** YAML frontmatter block. */
export function fm(obj: Record<string, unknown>): string {
  return `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${yv(v)}`).join('\n')}\n---\n`;
}
const fmtUsd = (v: number | null | undefined): string => (!v ? '?' : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : v.toFixed(0));
const pct = (v: number | null | undefined, d = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '?' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const sol = (v: number | null | undefined, d = 3): string => (v === null || v === undefined || !Number.isFinite(v) ? '?' : `${v >= 0 ? '+' : ''}${v.toFixed(d)} SOL`);

// ───────────────────────────── coins ─────────────────────────────
export interface NotableWallet { wallet: string; cls: WalletClass | 'deployer-sniper' }
export interface CoinState {
  mint: string;
  symbol: string | null;
  name: string | null;
  strategies: string[];
  firstSeenMs: number;
  mcUsd: number | null;
  migrated: boolean;
  /** signal = the bot wanted it; bought = a trade happened; skipped = a rule / the score said no */
  verdict: 'bought' | 'signal' | 'skipped';
  score: number | null;
  threshold: number | null;
  /** first rule fail or the buy reason */
  why: string;
  crowdNote: string | null;
  dumpCrew: boolean;
  provenCrowd: boolean;
  wallets: NotableWallet[];
  /** trade note paths (no .md) */
  trades: string[];
  days: string[];
  updatedMs: number;
  /** v11.10 deployer history */
  creator?: string | null;
  deployerClass?: string | null;
  deployerNote?: string | null;
}

export function coinNote(c: CoinState): Note {
  const sym = c.symbol || mintShort(c.mint);
  const tags = ['coin', ...c.strategies.map((s) => s.toLowerCase()), ...(c.dumpCrew ? ['dumpcrew'] : []), ...(c.provenCrowd ? ['proven-crowd'] : []), ...(c.deployerClass ? [`dev-${c.deployerClass}`] : []), c.verdict];
  const wallets = c.wallets.slice(0, 15);
  const body = [
    `# ${sym}${c.name && c.name !== sym ? ` — ${c.name}` : ''}`,
    '',
    `**${c.verdict.toUpperCase()}** · score ${c.score?.toFixed(1) ?? '?'}${c.threshold !== null ? ` vs bar ${c.threshold.toFixed(0)}` : ''} · MC $${fmtUsd(c.mcUsd)} · ${c.migrated ? 'migrated' : 'on the curve'} · first seen ${dayOf(c.firstSeenMs)} ${timeOf(c.firstSeenMs)}`,
    '',
    `## What the bot decided`,
    c.why || '—',
    ...(c.crowdNote ? ['', `## Who was buying`, c.crowdNote] : []),
    '',
    `## Links`,
    `- Strategy: ${c.strategies.map(strategyLink).join(', ') || '—'}`,
    ...(c.creator && c.deployerClass && c.deployerClass !== 'new' ? [`- Deployer: ${deployerLink(c.creator, c.deployerClass)}${c.deployerNote ? ` — ${c.deployerNote}` : ''}`] : []),
    `- Days: ${c.days.map(dayLink).join(', ') || '—'}`,
    ...(c.trades.length ? [`- Trades:`, ...c.trades.map((t) => `  - ${link(t)}`)] : [`- Trades: none`]),
    ...(wallets.length ? [`- Notable wallets:`, ...wallets.map((w) => `  - ${walletLink(w.wallet, w.cls)}`)] : [`- Notable wallets: none seen`]),
    '',
    `Mint: \`${c.mint}\``,
    '',
  ].join('\n');
  return {
    path: `${DIRS.coins}/${coinFile(c.symbol, c.mint)}.md`,
    content: fm({
      type: 'coin', mint: c.mint, symbol: sym, name: c.name, strategy_seen: c.strategies, first_seen: new Date(c.firstSeenMs).toISOString(),
      mc_usd: c.mcUsd, migrated: c.migrated, verdict: c.verdict, score: c.score, dump_crew: c.dumpCrew, proven_crowd: c.provenCrowd, deployer_class: c.deployerClass ?? null,
      wallets: wallets.length, trades: c.trades.length, updated: new Date(c.updatedMs).toISOString(), tags,
    }) + body,
  };
}

// ───────────────────────────── wallets ─────────────────────────────
export interface WalletState {
  wallet: string;
  cls: WalletClass | 'deployer-sniper';
  rec: WalletRec | null;
  /** coin note paths (no .md), newest last, ≤ 30 */
  coins: string[];
  lastSeenMs: number;
  writtenMs: number;
}

export function walletNote(w: WalletState): Note {
  const r = w.rec;
  const wr = r && r.n > 0 ? (r.w / r.n) * 100 : null;
  const pf = r && r.gl > 0 ? r.gw / r.gl : r && r.gw > 0 ? 99 : null;
  const words = [
    w.cls === 'proven' ? 'A wallet with a real record: it sells at a profit more often than not.' : '',
    w.cls === 'dumper' ? 'A dumper: its big sells are followed by sharp drops. The bot refuses coins it is still inside.' : '',
    w.cls === 'deployer-sniper' ? 'Funded by the coin\'s deployer and bought in the launch block — an exit-liquidity machine. Refused everywhere.' : '',
    w.cls === 'loser' ? 'Loses more often than it wins.' : '',
    w.cls === 'bot' ? 'Repeats the same buy size — a bot.' : '',
  ].filter(Boolean).join(' ');
  const body = [
    `# ${walletShort(w.wallet)}… (${w.cls})`,
    '',
    words,
    '',
    `| Record | |`,
    `|---|---|`,
    `| Sells with a cost basis | ${r?.n ?? 0} |`,
    `| Win rate | ${wr === null ? '?' : `${wr.toFixed(0)}%`} |`,
    `| Profit factor | ${pf === null ? '?' : pf.toFixed(2)} |`,
    `| Realised | ${sol(r?.pnl ?? 0)} |`,
    `| Usual hold | ${r && r.hold >= 0 ? `${Math.round(r.hold)} s` : '?'} |`,
    `| Dump events | ${r?.dumps ?? 0} |`,
    `| Got dumped on | ${r?.dumpedOn ?? 0} |`,
    `| Coins traded | ${r?.coins ?? 0} |`,
    '',
    `## Coins it appeared in`,
    ...(w.coins.length ? w.coins.slice(-30).map((c) => `- ${link(c)}`) : ['- none recorded yet']),
    '',
    `Address: \`${w.wallet}\``,
    '',
  ].join('\n');
  return {
    path: `${DIRS.wallets}/${walletFile(w.wallet)}.md`,
    content: fm({
      type: 'wallet', address: w.wallet, class: w.cls, win_rate: wr === null ? null : Math.round(wr), pf: pf === null ? null : Math.round(pf * 100) / 100, sells: r?.n ?? 0,
      realised_sol: r?.pnl ?? 0, usual_hold_sec: r && r.hold >= 0 ? Math.round(r.hold) : null, dump_events: r?.dumps ?? 0, dumped_on: r?.dumpedOn ?? 0, coins_seen: w.coins.length,
      last_seen: new Date(w.lastSeenMs).toISOString(), tags: ['wallet', w.cls],
    }) + body,
  };
}

// ───────────────────────────── deployers (v11.10) ─────────────────────────────
export interface DeployerState {
  creator: string;
  cls: DeployerClass;
  rec: DeployerRec | null;
  /** coin note paths (no .md), newest last, ≤ 30 */
  coins: string[];
  lastSeenMs: number;
  writtenMs: number;
}

export function deployerNote(d: DeployerState, now = Date.now()): Note {
  const r = d.rec;
  const launches = Math.round(r?.l ?? 0);
  const graduated = Math.round(r?.g ?? 0);
  const df = r && r.l > 0 ? Math.round((r.df / r.l) * 100) : 0;
  const timing = launchTiming(r, null, now);
  const peak = r && r.mcs.length ? Math.max(...r.mcs) : null;
  const words = [
    d.cls === 'proven' ? 'A creator with a real record: at least one of its coins graduated and it has not rugged. Its coins get points.' : '',
    d.cls === 'serial' ? 'A serial launcher: launches coin after coin, none graduate, most die within half an hour. Its coins are refused.' : '',
    d.cls === 'rugger' ? 'A creator whose coin rugged the bot (or is in the rugger memory). Its coins are refused.' : '',
    d.cls === 'mixed' ? 'A mixed record — neither proven nor serial yet.' : '',
    d.cls === 'new' ? 'Too few launches to judge.' : '',
  ].filter(Boolean).join(' ');
  const body = [
    `# ${walletShort(d.creator)}… (${d.cls})`,
    '',
    words,
    '',
    `| Record | |`,
    `|---|---|`,
    `| Launches | ${launches} |`,
    `| Graduated | ${graduated} |`,
    `| Died fast | ${df}% |`,
    `| Rugs | ${Math.round(r?.rugs ?? 0)} |`,
    `| Other launches in the last 24 h | ${timing.launchesToday} |`,
    `| Days since the previous launch | ${timing.daysSinceLastLaunch === null ? '?' : timing.daysSinceLastLaunch.toFixed(1)} |`,
    `| Best peak MC | ${peak === null ? '?' : `$${fmtUsd(peak)}`} |`,
    `| Last launch | ${r ? `${dayOf(r.last)} ${timeOf(r.last)}` : '?'} |`,
    '',
    `## Coins it launched (that the bot looked at)`,
    ...(d.coins.length ? d.coins.slice(-30).map((c) => `- ${link(c)}`) : ['- none recorded yet']),
    '',
    `Address: \`${d.creator}\``,
    '',
  ].join('\n');
  return {
    path: `${DIRS.deployers}/${walletFile(d.creator)}.md`,
    content: fm({
      type: 'deployer', address: d.creator, class: d.cls, launches, graduated, died_fast_pct: df, rugs: Math.round(r?.rugs ?? 0),
      launches_today: timing.launchesToday, days_since_last_launch: timing.daysSinceLastLaunch === null ? null : Math.round(timing.daysSinceLastLaunch * 10) / 10,
      peak_mc_usd: peak, coins_seen: d.coins.length, last_seen: new Date(d.lastSeenMs).toISOString(), tags: ['deployer', d.cls],
    }) + body,
  };
}

export function deployerEvictionsForNotes(states: ReadonlyArray<DeployerState>, max: number): string[] {
  if (states.length <= max) return [];
  return [...states].sort((a, b) => a.lastSeenMs - b.lastSeenMs).slice(0, states.length - max).map((s) => s.creator);
}

// ───────────────────────────── trades ─────────────────────────────
export interface TradeNoteInput {
  mint: string;
  symbol: string | null;
  strategy: string;
  atMs: number;
  pnlSol: number | null;
  pnlPct: number | null;
  peakMultiple: number | null;
  exitReason: string | null;
  score: number | null;
  mcUsd: number | null;
  sizeSol: number | null;
  heldMin: number | null;
  explanation: string | null;
  wallets: NotableWallet[];
}

export function tradeNote(t: TradeNoteInput): Note {
  const day = dayOf(t.atMs);
  const time = timeOf(t.atMs);
  const sym = t.symbol || mintShort(t.mint);
  const win = (t.pnlSol ?? 0) > 0;
  const file = `${DIRS.trades}/${sanitize(t.strategy)}/${sanitize(sym)}-${mintShort(t.mint)}-${day}-${time.replace(/:/g, '')}`;
  const body = [
    `# ${win ? '✅' : '❌'} ${sym} — ${t.strategy}`,
    '',
    `**${day} ${time}** · ${pct(t.pnlPct)} · ${sol(t.pnlSol, 4)} · peak ${t.peakMultiple?.toFixed(2) ?? '?'}x · held ${t.heldMin?.toFixed(1) ?? '?'} min`,
    '',
    `## Entry`,
    `- Score: ${t.score ?? '?'}`,
    `- Market cap: $${fmtUsd(t.mcUsd)}`,
    `- Size: ${t.sizeSol?.toFixed(3) ?? '?'} SOL`,
    ...(t.explanation ? ['', `## Why it bought`, t.explanation] : []),
    '',
    `## Exit`,
    `- Reason: ${t.exitReason ?? 'unknown'}`,
    `- P&L: ${sol(t.pnlSol, 4)} (${pct(t.pnlPct)})`,
    '',
    `## Links`,
    `- Coin: ${coinLink(t.symbol, t.mint)}`,
    `- Strategy: ${strategyLink(t.strategy)}`,
    `- Day: ${dayLink(day)}`,
    ...(t.wallets.length ? [`- Notable wallets:`, ...t.wallets.slice(0, 15).map((w) => `  - ${walletLink(w.wallet, w.cls)}`)] : []),
    '',
  ].join('\n');
  return {
    path: `${file}.md`,
    content: fm({
      type: 'trade', mint: t.mint, symbol: sym, strategy: t.strategy, date: day, time, result: win ? 'WIN' : 'LOSS',
      pnl_sol: t.pnlSol, pnl_pct: t.pnlPct, peak_multiple: t.peakMultiple, exit_reason: t.exitReason, score: t.score, mc_usd: t.mcUsd, size_sol: t.sizeSol, held_min: t.heldMin,
      tags: ['trade', t.strategy.toLowerCase(), win ? 'win' : 'loss'],
    }) + body,
  };
}

/** The day's trade log: one table row per buy / sell (appended by the sync). */
export function tradeLogHeader(day: string): string {
  return fm({ type: 'daily-trades', date: day, tags: ['daily-trades'] }) + `# Trades — ${day}\n\nDay note: ${dayLink(day)}\n\n| Time | Action | Token | Strategy | Size / P&L | Details | Extra |\n|------|--------|-------|----------|------------|---------|-------|\n`;
}
export function tradeLogLine(x: { atMs: number; entry: boolean; symbol: string | null; mint: string; strategy: string; sizeSol?: number | null; pnlSol?: number | null; pnlPct?: number | null; score?: number | null; mcUsd?: number | null; exitReason?: string | null; multiple?: number | null }): string {
  const sym = coinLink(x.symbol, x.mint);
  return x.entry
    ? `| ${timeOf(x.atMs)} | 🟢 BUY | ${sym} | ${strategyLink(x.strategy)} | ${x.sizeSol?.toFixed(3) ?? '?'} SOL | score ${x.score ?? '?'} | MC $${fmtUsd(x.mcUsd)} |\n`
    : `| ${timeOf(x.atMs)} | ${(x.pnlSol ?? 0) > 0 ? '🟢' : '🔴'} SELL | ${sym} | ${strategyLink(x.strategy)} | ${sol(x.pnlSol)} (${pct(x.pnlPct)}) | ${x.exitReason ?? '?'} | ${x.multiple?.toFixed(2) ?? '?'}x |\n`;
}

// ───────────────────────────── daily / strategies / brain ─────────────────────────────
export interface DailyData {
  trades: number;
  wins: number;
  pnlSol: number;
  bestTrade?: string;
  worstTrade?: string;
  byStrategy?: Array<{ strategy: string; trades: number; pnl: number }>;
  /** trade note paths (no .md) */
  tradeLinks?: string[];
}
export function dailyNote(day: string, d: DailyData): Note {
  const wr = d.trades > 0 ? (d.wins / d.trades) * 100 : 0;
  const body = [
    `# ${day}`,
    '',
    `| | |`, `|---|---|`,
    `| Trades | ${d.trades} |`, `| Wins | ${d.wins} (${wr.toFixed(0)}%) |`, `| P&L | ${sol(d.pnlSol, 4)} |`,
    ...(d.bestTrade ? [`| Best | ${d.bestTrade} |`] : []),
    ...(d.worstTrade ? [`| Worst | ${d.worstTrade} |`] : []),
    '',
    ...(d.byStrategy?.length ? [`## By strategy`, `| Strategy | Trades | P&L |`, `|---|---|---|`, ...d.byStrategy.map((s) => `| ${strategyLink(s.strategy)} | ${s.trades} | ${sol(s.pnl, 4)} |`), ''] : []),
    `## Trades`,
    ...(d.tradeLinks?.length ? d.tradeLinks.map((t) => `- ${link(t)}`) : ['- none closed yet']),
    '',
    `## Brain`,
    `- ${diaryLink(day)} — what the AI coach noticed and changed today`,
    `- ${link(`${DIRS.trades}/${day}`, 'trade log')}`,
    '',
  ].join('\n');
  return { path: `${DIRS.daily}/${day}.md`, content: fm({ type: 'daily', date: day, trades: d.trades, wins: d.wins, pnl_sol: d.pnlSol, win_rate: Math.round(wr * 10) / 10, tags: ['daily'] }) + body };
}

export interface StrategyData { trades: number; winRate: number; avgPnl: number; totalPnl: number; verdict?: string; topSkips?: string[] }
export function strategyNote(strategy: string, d: StrategyData, sniperRules: string[] = [], now = Date.now()): Note {
  const body = [
    `# ${strategy}`,
    '',
    `| Metric | Value |`, `|---|---|`,
    `| Trades | ${d.trades} |`, `| Win rate | ${d.winRate.toFixed(1)}% |`, `| Avg P&L | ${pct(d.avgPnl, 2)} |`, `| Total P&L | ${sol(d.totalPnl, 4)} |`, `| Verdict | ${d.verdict ?? '—'} |`,
    '',
    ...(d.topSkips?.length ? [`## Top skip reasons`, ...d.topSkips.map((s) => `- ${s}`), ''] : []),
    ...(sniperRules.length ? [`## Sniper mode rules in force`, ...sniperRules.map((r) => `- ${r}`), ''] : []),
    `## Its trades (Dataview)`,
    '```dataview',
    `TABLE date, pnl_sol AS "P&L SOL", pnl_pct AS "P&L %", exit_reason AS "Exit" FROM "${DIRS.trades}/${sanitize(strategy)}" WHERE type = "trade" SORT date DESC LIMIT 50`,
    '```',
    '',
    `## Coins it looked at (Dataview)`,
    '```dataview',
    `TABLE verdict, score, mc_usd AS "MC $", dump_crew FROM "${DIRS.coins}" WHERE contains(strategy_seen, "${strategy}") SORT updated DESC LIMIT 100`,
    '```',
    '',
  ].join('\n');
  return { path: `${DIRS.strategies}/${sanitize(strategy)}.md`, content: fm({ type: 'strategy', strategy, trades: d.trades, win_rate: d.winRate, avg_pnl_pct: d.avgPnl, total_pnl_sol: d.totalPnl, verdict: d.verdict ?? 'unknown', updated: new Date(now).toISOString(), tags: ['strategy'] }) + body };
}

export function insightsNote(insights: Array<{ text: string; confidence?: number; at?: string }>, now = Date.now()): Note {
  const body = [`# Insights`, '', `What the AI coach has noticed, newest first. Its durable memory is ${link(`${DIRS.brain}/Memory`, 'Memory')}; the day-by-day story is in Diary.`, '', ...insights.map((i, n) => `${n + 1}. ${i.at ? `*${i.at.slice(0, 16).replace('T', ' ')}* — ` : ''}${i.text}`), ''].join('\n');
  return { path: `${DIRS.brain}/Insights.md`, content: fm({ type: 'brain-insights', updated: new Date(now).toISOString(), count: insights.length, tags: ['brain', 'ai-insights'] }) + body };
}

export function memoryNote(bullets: string[], now = Date.now()): Note {
  const body = [`# Memory`, '', `What the AI coach knows for sure so far (it reads this before every review; a deep review may rewrite it, a normal review may only add up to 3 lines).`, '', ...(bullets.length ? bullets.map((b) => `- ${b}`) : ['- nothing yet']), ''].join('\n');
  return { path: `${DIRS.brain}/Memory.md`, content: fm({ type: 'brain-memory', updated: new Date(now).toISOString(), bullets: bullets.length, tags: ['brain', 'memory'] }) + body };
}

export interface DiaryEntry {
  atMs: number;
  model: string;
  deep: boolean;
  tradesReviewed: number;
  insights: string[];
  rulesProposed: string[];
  rulesLive: number;
  rulesRetired: number;
  settingsChanged: string[];
  changes: Array<{ at: string; source: string; what: string; why: string }>;
  resultsBefore: { n: number; avgPct: number } | null;
  resultsAfterPrevious: { n: number; avgPct: number | null } | null;
  memoryAdded: string[];
}
export function diaryHeader(day: string): string {
  return fm({ type: 'diary', date: day, tags: ['brain', 'diary'] }) + `# Diary — ${day}\n\nDay note: ${dayLink(day)} · ${link(`${DIRS.brain}/Memory`, 'Memory')} · ${link(`${DIRS.brain}/Insights`, 'Insights')}\n`;
}
export function diaryEntryText(e: DiaryEntry): string {
  return [
    '',
    `## ${timeOf(e.atMs)} — ${e.deep ? 'deep review' : 'review'} (${e.model})`,
    `Read ${e.tradesReviewed} trades.${e.resultsAfterPrevious && e.resultsAfterPrevious.avgPct !== null ? ` Since my previous review: ${e.resultsAfterPrevious.n} trades averaging ${pct(e.resultsAfterPrevious.avgPct)}.` : ''}`,
    ...(e.insights.length ? ['', `**Noticed**`, ...e.insights.map((i) => `- ${i}`)] : []),
    ...(e.rulesProposed.length ? ['', `**Rules proposed**`, ...e.rulesProposed.map((r) => `- ${r}`)] : []),
    `**Rules now:** ${e.rulesLive} live, ${e.rulesRetired} retired.`,
    ...(e.settingsChanged.length ? ['', `**Settings changed**`, ...e.settingsChanged.map((s) => `- ${s}`)] : []),
    ...(e.changes.length ? ['', `**The bot changed since my last entry**`, ...e.changes.map((c) => `- ${c.at.slice(11, 16)} ${c.source}: ${c.what} — ${c.why}`)] : []),
    ...(e.memoryAdded.length ? ['', `**Remembered**`, ...e.memoryAdded.map((m) => `- ${m}`)] : []),
    '',
  ].join('\n');
}

export interface TipView { id: string; at: string; text: string; status: string; response: string | null; rules: string[]; settings: string[] }
export function tipRepliesNote(tips: TipView[], now = Date.now()): Note {
  const body = [
    `# Tip replies`,
    '',
    `Every line you write in ${link(`${DIRS.inbox}/Tips`, '00 Inbox/Tips.md')} becomes a tip to the brain; its answer lands here within an hour (sooner when it has budget).`,
    '',
    ...(tips.length ? tips.flatMap((t) => [`## ${t.at.slice(0, 16).replace('T', ' ')} · ${t.status === 'done' ? 'answered' : 'waiting'}`, `> ${t.text}`, '', t.response ?? '*(no answer yet)*', ...(t.rules.length ? ['', `Rules: ${t.rules.join('; ')}`] : []), ...(t.settings.length ? [`Settings: ${t.settings.join('; ')}`] : []), '']) : ['*No tips yet — write one line per tip in 00 Inbox/Tips.md.*', '']),
  ].join('\n');
  return { path: `${DIRS.brain}/Tip replies.md`, content: fm({ type: 'tip-replies', updated: new Date(now).toISOString(), tips: tips.length, tags: ['brain', 'tips'] }) + body };
}

// ───────────────────────────── dashboard / index / how-to ─────────────────────────────
const dv = (q: string): string => '```dataview\n' + q + '\n```';
export function dashboardNote(now = Date.now()): Note {
  const body = [
    `# Dashboard`,
    '',
    `Live tables (needs the free **Dataview** community plugin: Settings → Community plugins → Browse → Dataview). Start at ${link('_Index', 'the index')} or ${link('_How to read this vault', 'how to read this vault')}.`,
    '',
    `## Trades this week, best to worst`,
    dv(`TABLE date, strategy, pnl_sol AS "P&L SOL", pnl_pct AS "P&L %", peak_multiple AS "Peak", exit_reason AS "Exit" FROM "${DIRS.trades}" WHERE type = "trade" AND date >= dateformat(date(today) - dur(7 days), "yyyy-MM-dd") SORT pnl_sol DESC`),
    '',
    `## Today's trades`,
    dv(`TABLE time, strategy, pnl_sol AS "P&L SOL", pnl_pct AS "P&L %", exit_reason AS "Exit" FROM "${DIRS.trades}" WHERE type = "trade" AND date = dateformat(date(today), "yyyy-MM-dd") SORT time DESC`),
    '',
    `## Coins with a dump crew inside (refused)`,
    dv(`TABLE symbol, score, mc_usd AS "MC $", updated FROM "${DIRS.coins}" WHERE dump_crew = true SORT updated DESC LIMIT 50`),
    '',
    `## Coins the bot wanted (signals and buys)`,
    dv(`TABLE verdict, score, mc_usd AS "MC $", strategy_seen AS "Strategy", updated FROM "${DIRS.coins}" WHERE verdict != "skipped" SORT updated DESC LIMIT 50`),
    '',
    `## Best proven wallets`,
    dv(`TABLE win_rate AS "Win %", pf AS "PF", sells, realised_sol AS "Realised SOL", usual_hold_sec AS "Hold s", coins_seen FROM "${DIRS.wallets}" WHERE class = "proven" SORT realised_sol DESC LIMIT 25`),
    '',
    `## Worst dumpers`,
    dv(`TABLE dump_events AS "Dumps", sells, realised_sol AS "Realised SOL", coins_seen, last_seen FROM "${DIRS.wallets}" WHERE class = "dumper" OR class = "deployer-sniper" SORT dump_events DESC LIMIT 25`),
    '',
    `## Strategies`,
    dv(`TABLE trades, win_rate AS "Win %", avg_pnl_pct AS "Avg %", total_pnl_sol AS "Total SOL", verdict FROM "${DIRS.strategies}" WHERE type = "strategy" SORT total_pnl_sol DESC`),
    '',
    `## Days`,
    dv(`TABLE trades, wins, pnl_sol AS "P&L SOL", win_rate AS "Win %" FROM "${DIRS.daily}" WHERE type = "daily" SORT date DESC LIMIT 30`),
    '',
  ].join('\n');
  return { path: '_Dashboard.md', content: fm({ type: 'dashboard', updated: new Date(now).toISOString(), tags: ['dashboard'] }) + body };
}

export function indexNote(x: { recentDays: string[]; recentDiary: string[]; strategies: string[]; counts: { coins: number; wallets: number; trades: number } }, now = Date.now()): Note {
  const body = [
    `# Trading bot vault`,
    '',
    `${link('_Dashboard', 'Dashboard')} · ${link('_How to read this vault', 'How to read this vault')} · ${link(`${DIRS.brain}/Memory`, 'Memory')} · ${link(`${DIRS.brain}/Insights`, 'Insights')} · ${link(`${DIRS.brain}/Tip replies`, 'Tip replies')}`,
    '',
    `${x.counts.coins} coin notes · ${x.counts.wallets} wallet notes · ${x.counts.trades} trade notes`,
    '',
    `## Talk to the brain`,
    `- ${link(`${DIRS.inbox}/Tips`, 'Tips')} — one line per tip; the bot acts on each and answers in Tip replies`,
    `- ${link(`${DIRS.inbox}/Notes`, 'Notes')} — your free-form notes; the AI coach reads the last part before every review`,
    '',
    `## Strategies`,
    ...x.strategies.map((s) => `- ${strategyLink(s)}`),
    '',
    `## Newest days`,
    ...x.recentDays.map((d) => `- ${dayLink(d)} · ${diaryLink(d)}`),
    '',
    `## Folders`,
    `- ${DIRS.trades}/ — trade logs per day and one note per closed trade`,
    `- ${DIRS.coins}/ — one note per coin the bot took seriously (bought, wanted, or nearly)`,
    `- ${DIRS.wallets}/ — proven wallets, dumpers and deployer-funded snipers`,
    `- ${DIRS.strategies}/ — one note per strategy`,
    `- ${DIRS.daily}/ — one note per day`,
    `- ${DIRS.brain}/ — the AI coach's memory, insights, diary and tip replies`,
    '',
  ].join('\n');
  return { path: '_Index.md', content: fm({ type: 'index', updated: new Date(now).toISOString(), tags: ['index'] }) + body };
}

export function howToNote(): Note {
  const body = [
    `# How to read this vault`,
    '',
    `1. The bot writes everything here on the server; your PC copies it every 10 minutes. Edit nothing except the **00 Inbox** folder.`,
    `2. **00 Inbox/Tips.md** — write one line per instruction ("avoid coins under $20k", "be stricter on migrated coins"). Every new line becomes a tip to the brain; the answer appears in **90 Brain/Tip replies.md**. Lines starting with # are headings and are ignored.`,
    `3. **00 Inbox/Notes.md** — your free notes; the AI coach reads the last 4,000 characters before every review.`,
    `4. **_Dashboard.md** — live tables. Install the free *Dataview* plugin once (Settings → Community plugins → Browse → Dataview).`,
    `5. **10 Trades** — a log per day plus one note per closed trade (P&L, peak, exit reason, why it bought, who was in the coin).`,
    `6. **20 Coins** — one note per coin the bot took seriously: what it decided and why, linked to its trades and notable wallets.`,
    `7. **30 Wallets** — proven wallets (green), dumpers and deployer-funded snipers (red) with their record and the coins they were in.`,
    `7b. **35 Deployers** — creators with a record: proven (graduated before, never rugged), serial launchers and ruggers, with every coin of theirs the bot looked at.`,
    `8. **40 Strategies** — one note per strategy with its numbers and the Sniper rules in force.`,
    `9. **50 Daily** — one note per day: P&L, trades, link to the diary.`,
    `10. **90 Brain** — Memory (what the coach knows for sure), Insights, Diary (one entry per review), Tip replies.`,
    `11. Graph view: open it, click the gear → Groups, add: \`path:"20 Coins"\` blue · \`tag:#dumper\` red · \`tag:#deployer-sniper\` red · \`tag:#proven\` green · \`path:"40 Strategies"\` yellow · \`path:"30 Wallets"\` grey · \`path:"10 Trades"\` white. Raise "link distance" a little.`,
    `12. A wallet with many lines into dead coins is a dumper you can see; a coin surrounded by green wallets is a setup you can see.`,
    `13. Notes have frontmatter (the properties at the top): Dataview tables are built from those fields.`,
    `14. The bot keeps at most ~300 coin notes a day and ~2,000 wallet notes; older ones are not deleted, just no longer refreshed.`,
    `15. If a note looks stale, the 10-minute copy has not run yet — nothing is lost.`,
    '',
  ].join('\n');
  return { path: '_How to read this vault.md', content: fm({ type: 'how-to', tags: ['index'] }) + body };
}

// ───────────────────────────── inbox + memory (pure rules) ─────────────────────────────
/** Tip lines: non-empty, not a heading, not an HTML/markdown comment; bullets stripped. */
export function parseInbox(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('---') && !l.startsWith('%%'))
    .map((l) => l.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((l) => l.length >= 3);
}
export const inboxKey = (line: string): string => createHash('sha1').update(line.trim().toLowerCase()).digest('hex');

export const MEMORY_MAX_CHARS = 1500;
export const MEMORY_MAX_NEW = 3;
const norm = (s: string) => s.trim().toLowerCase().replace(/^\d{4}-\d{2}-\d{2}\s*[—-]\s*/, '').replace(/[.!\s]+$/, '');
/**
 * Memory merge: a deep review may rewrite the whole memory; a normal review may only ADD up to `maxNew` bullets.
 * Bullets get the review date when they don't carry one; the total stays under MEMORY_MAX_CHARS (oldest dropped first).
 */
export function mergeMemory(existing: readonly string[], proposed: readonly string[], deep: boolean, day: string, maxNew = MEMORY_MAX_NEW, maxChars = MEMORY_MAX_CHARS): { bullets: string[]; added: string[] } {
  const clean = (s: string) => s.replace(/^[-*•]\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const dated = (s: string) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s : `${day} — ${s}`);
  const prop = proposed.map(clean).filter((s) => s.length >= 6).map(dated);
  let bullets: string[];
  let added: string[];
  if (deep) {
    bullets = [];
    for (const b of prop) if (!bullets.some((x) => norm(x) === norm(b))) bullets.push(b);
    added = bullets.filter((b) => !existing.some((x) => norm(x) === norm(b)));
  } else {
    bullets = [...existing];
    added = [];
    for (const b of prop) {
      if (added.length >= maxNew) break;
      if (bullets.some((x) => norm(x) === norm(b))) continue;
      bullets.push(b);
      added.push(b);
    }
  }
  while (bullets.join('\n').length > maxChars && bullets.length > 1) bullets.shift();
  if (bullets.length === 1 && bullets[0]!.length > maxChars) bullets[0] = bullets[0]!.slice(0, maxChars);
  return { bullets, added: added.filter((a) => bullets.includes(a)) };
}

/** Pure: the n-th coin note of the day (1-based) is written only up to the cap. */
export const withinDailyCap = (nToday: number, cap: number): boolean => cap <= 0 || nToday <= cap;

/** Pure: which wallet states to drop to stay under the cap (oldest last-seen first). */
export function walletEvictions(states: ReadonlyArray<WalletState>, max: number): string[] {
  if (states.length <= max) return [];
  return [...states].sort((a, b) => a.lastSeenMs - b.lastSeenMs).slice(0, states.length - max).map((s) => s.wallet);
}

/** The Sniper rules in plain words, from the config (for the strategy notes). */
export function sniperRuleLines(s: { enabled: boolean; maxOpen: number; minScoreMargin: number; volume: { minBuyers: number; minBuySol: number; minBuySharePct: number; minOrganicPct: number }; exits: { takeProfitTiers: ReadonlyArray<{ multiple: number; sellPct: number }>; trailActivateMultiple: number; trailPct: number; breakEvenFromMultiple: number; stopMaxPct: number; timeStopMinutes: number; timeStopMinPeakMultiple: number } }, sizeSol: number): string[] {
  if (!s.enabled) return [];
  return [
    `Real volume: ≥ ${s.volume.minBuyers} real buyers, ≥ ${s.volume.minBuySol} SOL bought, buys ≥ ${s.volume.minBuySharePct}%, organic ≥ ${s.volume.minOrganicPct}% in the last 5 min`,
    `Score at least ${s.minScoreMargin} points over the bar`,
    `Momentum gate, entry quality, edge gate, buyers-in-control and the wallet crowd all green`,
    `No learning / probe / half-size entries`,
    `Size ${sizeSol} SOL (within the capital, budget and liquidity caps), max ${s.maxOpen} open`,
    `Sell ${s.exits.takeProfitTiers.map((t) => `${t.sellPct}% at ${t.multiple}x`).join(', ')}`,
    `Trail ${s.exits.trailPct}% from ${s.exits.trailActivateMultiple}x, break-even floor from ${s.exits.breakEvenFromMultiple}x`,
    `Stop loss at most ${s.exits.stopMaxPct}%`,
    `Time stop: ${s.exits.timeStopMinutes} min without reaching ${s.exits.timeStopMinPeakMultiple}x`,
    `Early bail / dead coin / spike sell / rug / holder clock stay on`,
  ];
}
