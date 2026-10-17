/**
 * Obsidian vault sync — writes trading data as Markdown files.
 *
 * When `OBSIDIAN_VAULT_PATH` is set (env or BotConfig `obsidian.vaultPath`), the bot writes:
 *   - Daily trade logs:        <vault>/Trades/YYYY-MM-DD.md
 *   - Trade details:           <vault>/Trades/<strategy>/<mint-short>.md
 *   - Strategy summaries:      <vault>/Strategies/<strategy>.md
 *   - Daily P&L:               <vault>/Performance/YYYY-MM-DD.md
 *   - Brain insights:          <vault>/Brain/insights.md
 *
 * Files use Obsidian-compatible YAML frontmatter + wikilinks.
 * The sync runs on trade events (bus) and on a 10-minute timer for summaries.
 * On the VPS: set OBSIDIAN_VAULT_PATH=/root/obsidian-vault, then rsync or Obsidian Sync to your PC.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { moduleLogger } from '../lib/logger';
import { bus, type BusEvent } from '../lib/bus';

const log = moduleLogger('obsidian');

export interface ObsidianConfig {
  enabled: boolean;
  vaultPath: string;
}

interface TradeEvent {
  type: 'entry' | 'exit';
  mint: string;
  symbol?: string;
  strategy: string;
  priceSol?: number;
  sizeSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  exitReason?: string;
  explanation?: string;
  score?: number;
  marketCapUsd?: number;
  entryAt?: string;
  exitAt?: string;
  multiple?: number;
  features?: Record<string, unknown>;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeStr(): string {
  return new Date().toISOString().slice(11, 19);
}

function mintShort(mint: string): string {
  return mint.slice(0, 8);
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
}

type BusTrade = Extract<BusEvent, { type: 'trade' }>['data'];
export interface PositionInfo { strategy: string; sizeSol: number; score?: number | null; mcUsd?: number | null }
/** Where the summaries come from (wired in index.ts); every source is optional. */
export interface ObsidianSources {
  closedSince?: (sinceMs: number) => Promise<Array<{ symbol: string | null; strategy: string; pnlSol: number; sizeSol: number }>>;
  positionFor?: (mint: string) => Promise<PositionInfo | null>;
  strategies?: () => Array<{ strategy: string; trades: number; winRate: number; avgPnl: number; totalPnl: number; verdict?: string; topSkips?: string[] }>;
  insights?: () => Promise<Array<{ text: string; confidence?: number }>>;
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
  };
}

export class ObsidianSync {
  private vault: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private cfg: ObsidianConfig, private readonly sources: ObsidianSources = {}) {
    this.vault = cfg.vaultPath;
  }

  async start(b: typeof bus, summaryEveryMs = 10 * 60_000, firstAfterMs = 20_000): Promise<void> {
    if (!this.cfg.enabled || !this.vault) return;
    await ensureDir(path.join(this.vault, 'Trades'));
    await ensureDir(path.join(this.vault, 'Strategies'));
    await ensureDir(path.join(this.vault, 'Performance'));
    await ensureDir(path.join(this.vault, 'Brain'));
    b.on('event', (ev: BusEvent) => {
      if (ev.type !== 'trade') return;
      void this.onBusTrade(ev.data).catch((e) => log.warn({ err: (e as Error).message }, 'obsidian trade write failed'));
    });
    this.timer = setInterval(() => void this.writeSummaries(), summaryEveryMs);
    setTimeout(() => void this.writeSummaries(), firstAfterMs);
    log.info({ vault: this.vault }, 'obsidian sync started');
  }

  private async onBusTrade(d: BusTrade): Promise<void> {
    const pos = this.sources.positionFor ? await this.sources.positionFor(d.mint).catch(() => null) : null;
    await this.onTrade(tradeFromBus(d, pos));
  }

  /** Today's P&L note, one note per strategy, the AI's latest insights. Runs on the timer and once at start. */
  async writeSummaries(now = Date.now()): Promise<void> {
    if (!this.cfg.enabled || !this.vault) return;
    try {
      const day = new Date(now).toISOString().slice(0, 10);
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
      await this.writeDailyPerformance(day, {
        trades: closed.length,
        wins: closed.filter((t) => t.pnlSol > 0).length,
        pnlSol: closed.reduce((a, t) => a + t.pnlSol, 0),
        bestTrade: sorted[0] ? label(sorted[0]) : undefined,
        worstTrade: sorted.length > 1 ? label(sorted[sorted.length - 1]!) : undefined,
        byStrategy: [...byStrategy].map(([strategy, v]) => ({ strategy, ...v })),
      });
      for (const s of this.sources.strategies?.() ?? []) await this.writeStrategySummary(s.strategy, s);
      const ins = this.sources.insights ? await this.sources.insights() : [];
      if (ins.length) await this.writeBrainInsights(ins);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'obsidian summaries failed');
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async onTrade(ev: TradeEvent): Promise<void> {
    const day = today();
    const time = timeStr();
    const sym = ev.symbol ?? mintShort(ev.mint);

    // Append to daily log
    const dailyPath = path.join(this.vault, 'Trades', `${day}.md`);
    const emoji = ev.type === 'entry' ? '🟢' : (ev.pnlSol && ev.pnlSol > 0 ? '🟢' : '🔴');
    let line: string;
    if (ev.type === 'entry') {
      line = `| ${time} | ${emoji} BUY | ${sym} | ${ev.strategy} | ${ev.sizeSol?.toFixed(3) ?? '?'} SOL | score ${ev.score ?? '?'} | MC $${fmtUsd(ev.marketCapUsd)} |\n`;
    } else {
      line = `| ${time} | ${emoji} SELL | ${sym} | ${ev.strategy} | ${ev.pnlSol?.toFixed(3) ?? '?'} SOL (${ev.pnlPct?.toFixed(1) ?? '?'}%) | ${ev.exitReason ?? '?'} | ${ev.multiple?.toFixed(2) ?? '?'}x |\n`;
    }

    try {
      await fs.access(dailyPath);
    } catch {
      const header = `---\ndate: ${day}\ntype: daily-trades\n---\n# Trades — ${day}\n\n| Time | Action | Token | Strategy | Size/PnL | Details | Extra |\n|------|--------|-------|----------|----------|---------|-------|\n`;
      await fs.writeFile(dailyPath, header);
    }
    await fs.appendFile(dailyPath, line);

    // Write individual trade file
    if (ev.type === 'exit') {
      await this.writeTradeDetail(ev, day, time);
    }
  }

  private async writeTradeDetail(ev: TradeEvent, day: string, time: string): Promise<void> {
    const sym = sanitize(ev.symbol ?? mintShort(ev.mint));
    const dir = path.join(this.vault, 'Trades', sanitize(ev.strategy));
    await ensureDir(dir);
    const fp = path.join(dir, `${sym}-${day}-${time.replace(/:/g, '')}.md`);
    const win = ev.pnlSol && ev.pnlSol > 0;
    const content = `---
mint: "${ev.mint}"
symbol: "${ev.symbol ?? mintShort(ev.mint)}"
strategy: "${ev.strategy}"
date: "${day}"
pnlSol: ${ev.pnlSol?.toFixed(4) ?? 0}
pnlPct: ${ev.pnlPct?.toFixed(2) ?? 0}
exitReason: "${ev.exitReason ?? 'unknown'}"
result: "${win ? 'WIN' : 'LOSS'}"
score: ${ev.score ?? 0}
marketCapUsd: ${ev.marketCapUsd ?? 0}
multiple: ${ev.multiple?.toFixed(3) ?? 0}
tags:
  - trade
  - ${ev.strategy.toLowerCase()}
  - ${win ? 'win' : 'loss'}
---
# ${win ? '✅' : '❌'} ${ev.symbol ?? mintShort(ev.mint)} — ${ev.strategy}

**${day} ${time}** · ${ev.pnlPct?.toFixed(1)}% · ${ev.pnlSol?.toFixed(4)} SOL · ${ev.multiple?.toFixed(2)}x

## Entry
- **Score:** ${ev.score ?? '?'}
- **Market cap:** $${fmtUsd(ev.marketCapUsd)}
- **Size:** ${ev.sizeSol?.toFixed(3) ?? '?'} SOL
${ev.explanation ? `\n## Why it bought\n${ev.explanation}\n` : ''}
## Exit
- **Reason:** ${ev.exitReason ?? 'unknown'}
- **P&L:** ${ev.pnlSol?.toFixed(4) ?? '?'} SOL (${ev.pnlPct?.toFixed(1) ?? '?'}%)
- **Peak multiple:** ${ev.multiple?.toFixed(2) ?? '?'}x

## Links
- [[${day}|Daily log]]
- [[${sanitize(ev.strategy)}|Strategy: ${ev.strategy}]]
`;
    await fs.writeFile(fp, content);
  }

  /** Write a strategy summary (called from the autopsy / brain). */
  async writeStrategySummary(strategy: string, data: {
    trades: number; winRate: number; avgPnl: number; totalPnl: number;
    topSkips?: string[]; verdict?: string;
  }): Promise<void> {
    if (!this.cfg.enabled) return;
    const dir = path.join(this.vault, 'Strategies');
    await ensureDir(dir);
    const fp = path.join(dir, `${sanitize(strategy)}.md`);
    const content = `---
strategy: "${strategy}"
updated: "${new Date().toISOString()}"
trades: ${data.trades}
winRate: ${data.winRate.toFixed(1)}
avgPnl: ${data.avgPnl.toFixed(2)}
totalPnl: ${data.totalPnl.toFixed(4)}
verdict: "${data.verdict ?? 'unknown'}"
tags:
  - strategy
---
# ${strategy}

**Last updated:** ${new Date().toISOString().slice(0, 16)}

| Metric | Value |
|--------|-------|
| Trades | ${data.trades} |
| Win rate | ${data.winRate.toFixed(1)}% |
| Avg P&L | ${data.avgPnl.toFixed(2)}% |
| Total P&L | ${data.totalPnl.toFixed(4)} SOL |
| Verdict | ${data.verdict ?? '—'} |

${data.topSkips?.length ? `## Top skip reasons\n${data.topSkips.map((s) => `- ${s}`).join('\n')}\n` : ''}
`;
    await fs.writeFile(fp, content);
  }

  /** Write daily performance (called from the timer or API). */
  async writeDailyPerformance(day: string, data: {
    trades: number; wins: number; pnlSol: number; bestTrade?: string; worstTrade?: string;
    byStrategy?: Array<{ strategy: string; trades: number; pnl: number }>;
  }): Promise<void> {
    if (!this.cfg.enabled) return;
    const dir = path.join(this.vault, 'Performance');
    await ensureDir(dir);
    const fp = path.join(dir, `${day}.md`);
    const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0';
    const content = `---
date: "${day}"
trades: ${data.trades}
wins: ${data.wins}
pnlSol: ${data.pnlSol.toFixed(4)}
winRate: ${wr}
tags:
  - daily-performance
---
# Performance — ${day}

| Metric | Value |
|--------|-------|
| Trades | ${data.trades} |
| Wins | ${data.wins} (${wr}%) |
| P&L | ${data.pnlSol.toFixed(4)} SOL |
${data.bestTrade ? `| Best | ${data.bestTrade} |` : ''}
${data.worstTrade ? `| Worst | ${data.worstTrade} |` : ''}

${data.byStrategy?.length ? `## By strategy\n| Strategy | Trades | P&L |\n|----------|--------|-----|\n${data.byStrategy.map((s) => `| ${s.strategy} | ${s.trades} | ${s.pnl.toFixed(4)} SOL |`).join('\n')}\n` : ''}
`;
    await fs.writeFile(fp, content);
  }

  /** Write brain insights. */
  async writeBrainInsights(insights: Array<{ text: string; confidence?: number }>): Promise<void> {
    if (!this.cfg.enabled) return;
    const dir = path.join(this.vault, 'Brain');
    await ensureDir(dir);
    const fp = path.join(dir, `insights.md`);
    const content = `---
updated: "${new Date().toISOString()}"
tags:
  - brain
  - ai-insights
---
# Brain Insights

**Last updated:** ${new Date().toISOString().slice(0, 16)}

${insights.map((i, idx) => `${idx + 1}. ${i.text}${i.confidence ? ` *(confidence: ${(i.confidence * 100).toFixed(0)}%)*` : ''}`).join('\n')}
`;
    await fs.writeFile(fp, content);
  }
}

function fmtUsd(v: number | undefined | null): string {
  if (!v) return '?';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
