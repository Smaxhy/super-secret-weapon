import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ObsidianSync, tradeFromBus } from '../src/integrations/obsidian-sync';

describe('obsidian sync', () => {
  it('maps the bus trade event (type event / trade) to a journal line', () => {
    const buy = tradeFromBus({ mint: 'M1', symbol: 'PEPE', side: 'BUY', mode: 'PAPER', amountSol: 1, reason: 'buy' }, { strategy: 'SOON', sizeSol: 1, score: 82, mcUsd: 61_000 });
    expect(buy).toMatchObject({ type: 'entry', strategy: 'SOON', sizeSol: 1, score: 82, marketCapUsd: 61_000 });
    const sell = tradeFromBus({ mint: 'M1', symbol: 'PEPE', side: 'SELL', mode: 'PAPER', amountSol: 1.3, reason: 'TAKE_PROFIT 1.5x', pnlSol: 0.3, peakMultiple: 1.6, closed: true }, { strategy: 'SOON', sizeSol: 1 });
    expect(sell).toMatchObject({ type: 'exit', pnlSol: 0.3, pnlPct: 30, exitReason: 'TAKE_PROFIT 1.5x', multiple: 1.6 });
    expect(tradeFromBus({ mint: 'M2', side: 'SELL', mode: 'PAPER', amountSol: 0.5, reason: 'STOP_LOSS' }, null).strategy).toBe('unknown');
  });

  it('writes the daily note, a note per strategy and the AI insights from its sources', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-'));
    const o = new ObsidianSync({ enabled: true, vaultPath: vault }, {
      closedSince: async () => [
        { symbol: 'PEPE', strategy: 'SOON', pnlSol: 0.3, sizeSol: 1 },
        { symbol: 'DOGE', strategy: 'MIGRATION_MOMENTUM', pnlSol: -0.12, sizeSol: 1 },
      ],
      strategies: () => [{ strategy: 'SOON', trades: 12, winRate: 58, avgPnl: 4.2, totalPnl: 0.9, verdict: 'unproven' }],
      insights: async () => [{ text: 'Buying into +30% candles loses.' }],
    });
    await o.writeSummaries(Date.parse('2026-10-18T12:00:00Z'));
    const daily = await fs.readFile(path.join(vault, 'Performance', '2026-10-18.md'), 'utf8');
    expect(daily).toContain('PEPE +0.300 SOL');
    expect(daily).toContain('DOGE -0.120 SOL');
    const strat = await fs.readFile(path.join(vault, 'Strategies', 'SOON.md'), 'utf8');
    expect(strat).toContain('trades: 12');
    const brain = await fs.readFile(path.join(vault, 'Brain', 'insights.md'), 'utf8');
    expect(brain).toContain('Buying into +30% candles loses.');
  });

  it('does nothing when off', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-off-'));
    const o = new ObsidianSync({ enabled: false, vaultPath: vault }, { closedSince: async () => [{ symbol: 'X', strategy: 'SOON', pnlSol: 1, sizeSol: 1 }] });
    await o.writeSummaries();
    await expect(fs.access(path.join(vault, 'Performance'))).rejects.toBeTruthy();
  });
});
