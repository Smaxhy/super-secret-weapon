/**
 * Obsidian Vault Integration — bidirectional sync between the bot and an
 * Obsidian vault for unified knowledge management.
 *
 * ## What this does:
 *
 * 1. **Trade Journal** — Every trade (entry + exit) gets a markdown note in
 *    `vault/Trades/YYYY-MM-DD/` with full context: strategy, score, features,
 *    entry/exit reasons, P&L, chart state, and what the bot "saw" at decision time.
 *    These are Obsidian-native — you can tag, link, and query them with Dataview.
 *
 * 2. **Strategy Performance** — Daily rollup notes in `vault/Performance/` with
 *    win rates, P&L by strategy, regime stats, and weight changes. Obsidian's
 *    graph view shows which strategies connect to which outcomes.
 *
 * 3. **Pattern Learnings** — When the Bayesian updater finds a pattern with
 *    strong signal (P(good) > 0.7 or < 0.3 with enough observations), it writes
 *    a note to `vault/Patterns/` explaining what the pattern means in plain English.
 *
 * 4. **Parameter Change Log** — Every config or weight change gets logged to
 *    `vault/Config/changelog.md` so you can trace exactly what changed when.
 *
 * 5. **Market Regime Diary** — Regime transitions logged in `vault/Regimes/`
 *    with the stats that triggered the change.
 *
 * 6. **Reading from Vault** — The bot reads `vault/Strategy-Notes/` at startup.
 *    Drop a markdown file there with YAML frontmatter and the bot will parse
 *    strategy overrides, watchlists, blacklists, and manual observations.
 *
 * ## Setup:
 *
 * 1. Set OBSIDIAN_VAULT_PATH to your vault's absolute path in .env
 * 2. Install the Obsidian Dataview plugin for querying trade data
 * 3. The bot creates all folders on first run — no manual setup needed
 * 4. For remote sync, use Obsidian Sync or Git-based sync (obsidian-git plugin)
 *
 * ## Vault Structure:
 *
 *   vault/
 *   ├── Trades/           ← one note per trade, organized by date
 *   │   └── 2026-10-17/
 *   │       ├── BUY-PEPE-abc123.md
 *   │       └── SELL-PEPE-abc123.md
 *   ├── Performance/      ← daily/weekly rollups
 *   │   ├── daily-2026-10-17.md
 *   │   └── weekly-2026-W42.md
 *   ├── Patterns/         ← Bayesian pattern learnings
 *   │   └── snipers-gt-10.md
 *   ├── Regimes/          ← market regime transitions
 *   │   └── 2026-10-17-HOT.md
 *   ├── Config/           ← parameter changelog
 *   │   └── changelog.md
 *   ├── Strategy-Notes/   ← YOUR notes (bot reads these)
 *   │   ├── curve-snipe-rules.md
 *   │   └── watchlist.md
 *   └── Dashboard/        ← auto-generated overview
 *       └── bot-status.md
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { moduleLogger } from '../lib/logger';
import { bus } from '../lib/bus';

const log = moduleLogger('obsidian');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ?? '';

const FOLDERS = [
  'Trades',
  'Performance',
  'Patterns',
  'Regimes',
  'Config',
  'Strategy-Notes',
  'Dashboard',
] as const;

// ---------------------------------------------------------------------------
// Vault filesystem helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeNote(relativePath: string, content: string): Promise<void> {
  if (!VAULT_PATH) return;
  const full = path.join(VAULT_PATH, relativePath);
  await ensureDir(path.dirname(full));
  await fs.writeFile(full, content, 'utf-8');
}

async function appendToNote(relativePath: string, content: string): Promise<void> {
  if (!VAULT_PATH) return;
  const full = path.join(VAULT_PATH, relativePath);
  await ensureDir(path.dirname(full));
  try {
    const existing = await fs.readFile(full, 'utf-8');
    await fs.writeFile(full, existing + '\n' + content, 'utf-8');
  } catch {
    await fs.writeFile(full, content, 'utf-8');
  }
}

async function readNote(relativePath: string): Promise<string | null> {
  if (!VAULT_PATH) return null;
  try {
    return await fs.readFile(path.join(VAULT_PATH, relativePath), 'utf-8');
  } catch {
    return null;
  }
}

async function listNotes(relativeDir: string): Promise<string[]> {
  if (!VAULT_PATH) return [];
  try {
    const entries = await fs.readdir(path.join(VAULT_PATH, relativeDir));
    return entries.filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Note templates
// ---------------------------------------------------------------------------

function tradeEntryNote(data: {
  mint: string;
  symbol: string;
  strategy: string;
  score: number;
  threshold: number;
  sizeSol: number;
  entryPrice: number;
  market: Record<string, unknown>;
  features: Record<string, number>;
  regime: string;
  timestamp: Date;
}): string {
  const d = data;
  return `---
type: trade-entry
mint: "${d.mint}"
symbol: "${d.symbol}"
strategy: "${d.strategy}"
score: ${d.score.toFixed(1)}
threshold: ${d.threshold.toFixed(1)}
sizeSol: ${d.sizeSol.toFixed(4)}
entryPrice: ${d.entryPrice}
regime: "${d.regime}"
date: ${d.timestamp.toISOString().slice(0, 10)}
time: ${d.timestamp.toISOString().slice(11, 19)}
tags: [trade, entry, ${d.strategy.toLowerCase()}]
---

# 🟢 BUY ${d.symbol}

**Strategy:** ${d.strategy} | **Score:** ${d.score.toFixed(1)} / ${d.threshold.toFixed(1)} | **Regime:** ${d.regime}
**Size:** ${d.sizeSol.toFixed(4)} SOL @ ${d.entryPrice.toFixed(10)} SOL/token

## Market State at Entry
| Metric | Value |
|--------|-------|
${Object.entries(d.market).map(([k, v]) => `| ${k} | ${typeof v === 'number' ? (v as number).toFixed(4) : v} |`).join('\n')}

## Feature Scores
${Object.entries(d.features).map(([k, v]) => `- **${k}:** ${(v * 100).toFixed(1)}%`).join('\n')}
`;
}

function tradeExitNote(data: {
  mint: string;
  symbol: string;
  strategy: string;
  exitReason: string;
  pnlSol: number;
  holdTimeSec: number;
  peakMultiple: number;
  entryPrice: number;
  exitPrice: number;
  timestamp: Date;
}): string {
  const d = data;
  const emoji = d.pnlSol > 0 ? '🟢' : '🔴';
  return `---
type: trade-exit
mint: "${d.mint}"
symbol: "${d.symbol}"
strategy: "${d.strategy}"
exitReason: "${d.exitReason}"
pnlSol: ${d.pnlSol.toFixed(4)}
holdTimeSec: ${d.holdTimeSec}
peakMultiple: ${d.peakMultiple.toFixed(2)}
date: ${d.timestamp.toISOString().slice(0, 10)}
tags: [trade, exit, ${d.pnlSol > 0 ? 'win' : 'loss'}, ${d.strategy.toLowerCase()}]
---

# ${emoji} EXIT ${d.symbol} — ${d.exitReason}

**P&L:** ${d.pnlSol > 0 ? '+' : ''}${d.pnlSol.toFixed(4)} SOL | **Hold:** ${Math.round(d.holdTimeSec / 60)}m | **Peak:** ${d.peakMultiple.toFixed(2)}x
**Entry:** ${d.entryPrice.toFixed(10)} → **Exit:** ${d.exitPrice.toFixed(10)}

---
*See entry note: [[BUY-${d.symbol}-${d.mint.slice(0, 8)}]]*
`;
}

function dailyPerformanceNote(data: {
  date: string;
  trades: number;
  wins: number;
  pnlSol: number;
  byStrategy: Array<{ strategy: string; trades: number; wins: number; pnl: number }>;
  regime: string;
  regimeStats?: Record<string, unknown>;
}): string {
  const d = data;
  const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : 'N/A';
  return `---
type: daily-performance
date: ${d.date}
trades: ${d.trades}
wins: ${d.wins}
winRate: ${wr}
pnlSol: ${d.pnlSol.toFixed(4)}
regime: "${d.regime}"
tags: [performance, daily]
---

# 📊 Daily Report — ${d.date}

**Trades:** ${d.trades} | **Win Rate:** ${wr}% | **P&L:** ${d.pnlSol > 0 ? '+' : ''}${d.pnlSol.toFixed(4)} SOL
**Regime:** ${d.regime}

## By Strategy
| Strategy | Trades | Wins | Win Rate | P&L (SOL) |
|----------|--------|------|----------|-----------|
${d.byStrategy.map(s => `| ${s.strategy} | ${s.trades} | ${s.wins} | ${s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : 'N/A'}% | ${s.pnl > 0 ? '+' : ''}${s.pnl.toFixed(4)} |`).join('\n')}

${d.regimeStats ? `## Regime Stats\n${JSON.stringify(d.regimeStats, null, 2)}` : ''}
`;
}

function patternNote(data: {
  pattern: string;
  probability: number;
  observations: number;
  meaning: string;
}): string {
  const d = data;
  const signal = d.probability > 0.6 ? '🟢 Bullish' : d.probability < 0.4 ? '🔴 Bearish' : '⚪ Neutral';
  return `---
type: pattern
pattern: "${d.pattern}"
probability: ${d.probability.toFixed(3)}
observations: ${d.observations}
signal: "${signal}"
tags: [pattern, bayesian]
---

# Pattern: \`${d.pattern}\`

**Signal:** ${signal} | **P(good):** ${(d.probability * 100).toFixed(1)}% | **Observations:** ${d.observations}

## What This Means
${d.meaning}
`;
}

function regimeTransitionNote(data: {
  from: string;
  to: string;
  stats: Record<string, unknown>;
  timestamp: Date;
}): string {
  const d = data;
  return `---
type: regime-transition
from: "${d.from}"
to: "${d.to}"
date: ${d.timestamp.toISOString().slice(0, 10)}
time: ${d.timestamp.toISOString().slice(11, 19)}
tags: [regime, ${d.to.toLowerCase()}]
---

# 🌡️ Regime: ${d.from} → ${d.to}

${JSON.stringify(d.stats, null, 2)}
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ObsidianSync {
  private enabled = false;

  async start(): Promise<void> {
    if (!VAULT_PATH) {
      log.info('OBSIDIAN_VAULT_PATH not set — Obsidian sync disabled');
      return;
    }

    // Create folder structure
    for (const folder of FOLDERS) {
      await ensureDir(path.join(VAULT_PATH, folder));
    }

    this.enabled = true;
    log.info({ vault: VAULT_PATH }, 'Obsidian sync enabled');

    // Subscribe to bot events
    this.subscribeToBusEvents();
  }

  private subscribeToBusEvents(): void {
    bus.subscribe(async (event) => {
      if (!this.enabled) return;
      try {
        switch (event.type) {
          case 'regime_change':
            await this.logRegimeTransition(event.data);
            break;
          case 'weights_adjusted':
            await this.logConfigChange(event.data);
            break;
          // Trade entry/exit notes are written directly by the caller
          // (Trader/SellManager) via obsidianSync.logTradeEntry/logTradeExit
          // because bus 'trade' events don't carry enough context for the
          // full note templates. The bus events are kept lean for the
          // dashboard WebSocket.
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, type: event.type }, 'Failed to sync event to Obsidian');
      }
    });
  }

  /** Write a trade entry note. */
  async logTradeEntry(data: Parameters<typeof tradeEntryNote>[0]): Promise<void> {
    if (!this.enabled) return;
    const date = data.timestamp.toISOString().slice(0, 10);
    const filename = `BUY-${data.symbol}-${data.mint.slice(0, 8)}.md`;
    await writeNote(`Trades/${date}/${filename}`, tradeEntryNote(data));
  }

  /** Write a trade exit note. */
  async logTradeExit(data: Parameters<typeof tradeExitNote>[0]): Promise<void> {
    if (!this.enabled) return;
    const date = data.timestamp.toISOString().slice(0, 10);
    const filename = `SELL-${data.symbol}-${data.mint.slice(0, 8)}.md`;
    await writeNote(`Trades/${date}/${filename}`, tradeExitNote(data));
  }

  /** Write a daily performance rollup. */
  async logDailyPerformance(data: Parameters<typeof dailyPerformanceNote>[0]): Promise<void> {
    if (!this.enabled) return;
    await writeNote(`Performance/daily-${data.date}.md`, dailyPerformanceNote(data));
  }

  /** Write or update a pattern learning note. */
  async logPattern(data: Parameters<typeof patternNote>[0]): Promise<void> {
    if (!this.enabled) return;
    const slug = data.pattern.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    await writeNote(`Patterns/${slug}.md`, patternNote(data));
  }

  /** Log a regime transition. */
  async logRegimeTransition(data: { from: string; to: string; stats: Record<string, unknown> }): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    await writeNote(`Regimes/${date}-${data.to}.md`, regimeTransitionNote({ ...data, timestamp: now }));
  }

  /** Append a config/weight change to the changelog. */
  async logConfigChange(data: { message: string; changes?: unknown }): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();
    const entry = `\n## ${now.toISOString()}\n${data.message}\n${data.changes ? '\n```json\n' + JSON.stringify(data.changes, null, 2) + '\n```\n' : ''}`;
    await appendToNote('Config/changelog.md', entry);
  }

  /** Write the dashboard status note. */
  async updateDashboard(data: {
    balance: number;
    openPositions: number;
    todayPnl: number;
    todayTrades: number;
    regime: string;
    uptime: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const d = data;
    const now = new Date();
    const content = `---
type: dashboard
updated: ${now.toISOString()}
tags: [dashboard, auto-generated]
---

# 🤖 Bot Status

*Auto-updated: ${now.toISOString()}*

| Metric | Value |
|--------|-------|
| Balance | ${d.balance.toFixed(4)} SOL |
| Open Positions | ${d.openPositions} |
| Today's P&L | ${d.todayPnl > 0 ? '+' : ''}${d.todayPnl.toFixed(4)} SOL |
| Today's Trades | ${d.todayTrades} |
| Market Regime | ${d.regime} |
| Uptime | ${d.uptime} |
`;
    await writeNote('Dashboard/bot-status.md', content);
  }

  // ---------------------------------------------------------------------------
  // Reading from vault (your notes → bot config)
  // ---------------------------------------------------------------------------

  /** Read strategy notes you've written and parse any YAML frontmatter overrides. */
  async readStrategyNotes(): Promise<Array<{ file: string; frontmatter: Record<string, unknown>; body: string }>> {
    const notes = await listNotes('Strategy-Notes');
    const results: Array<{ file: string; frontmatter: Record<string, unknown>; body: string }> = [];
    for (const file of notes) {
      const content = await readNote(`Strategy-Notes/${file}`);
      if (!content) continue;
      const { frontmatter, body } = parseFrontmatter(content);
      results.push({ file, frontmatter, body });
    }
    return results;
  }

  /** Read watchlist entries from vault. */
  async readWatchlist(): Promise<string[]> {
    const content = await readNote('Strategy-Notes/watchlist.md');
    if (!content) return [];
    const { body } = parseFrontmatter(content);
    // Parse lines that look like Solana addresses (base58, 32-44 chars)
    return body.split('\n')
      .map(l => l.trim().replace(/^[-*]\s*/, ''))
      .filter(l => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l));
  }

  /** Read blacklist entries from vault. */
  async readBlacklist(): Promise<string[]> {
    const content = await readNote('Strategy-Notes/blacklist.md');
    if (!content) return [];
    const { body } = parseFrontmatter(content);
    return body.split('\n')
      .map(l => l.trim().replace(/^[-*]\s*/, ''))
      .filter(l => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l));
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Basic type coercion
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+(\.\d+)?$/.test(val as string)) val = Number(val);
    else if ((val as string).startsWith('"') && (val as string).endsWith('"')) val = (val as string).slice(1, -1);
    fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] };
}

/** Singleton */
export const obsidianSync = new ObsidianSync();
