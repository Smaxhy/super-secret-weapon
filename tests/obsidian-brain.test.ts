import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DIRS, coinNote, dashboardNote, inboxKey, mergeMemory, parseInbox, sniperRuleLines, strategyNote, tradeNote, walletEvictions, walletNote, withinDailyCap, type CoinState, type WalletState,
} from '../src/integrations/obsidian-notes';
import { ObsidianSync } from '../src/integrations/obsidian-sync';
import { emptyRec } from '../src/learner/wallet-book';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS } from '../src/config/migrations';

const coin: CoinState = {
  mint: 'So11111111111111111111111111111111111111112', symbol: 'PEPE', name: 'Pepe', strategies: ['SOON'], firstSeenMs: Date.parse('2026-10-18T10:00:00Z'), mcUsd: 61_000, migrated: false,
  verdict: 'signal', score: 81.2, threshold: 73, why: 'score 81.2 ≥ 73 and all entry rules passed', crowdNote: 'crowd: 38% of buying from proven wallets, 0 dump crews', dumpCrew: false, provenCrowd: true,
  wallets: [{ wallet: 'ProvenWallet1111111111111111111111111111111', cls: 'proven' }, { wallet: 'DumperWallet111111111111111111111111111111', cls: 'dumper' }],
  trades: ['10 Trades/SOON/PEPE-So111111-2026-10-18-101500'], days: ['2026-10-18'], updatedMs: Date.parse('2026-10-18T10:20:00Z'),
};

describe('obsidian shared brain — note builders', () => {
  it('coin note: frontmatter + links to strategy, wallets, trades and the day', () => {
    const n = coinNote(coin);
    expect(n.path).toBe('20 Coins/PEPE-So111111.md');
    expect(n.content.startsWith('---\ntype: "coin"')).toBe(true);
    expect(n.content).toContain('proven_crowd: true');
    expect(n.content).toContain('[[40 Strategies/SOON|SOON]]');
    expect(n.content).toContain('[[30 Wallets/ProvenWallet|ProvenWallet… (proven)]]');
    expect(n.content).toContain('[[10 Trades/SOON/PEPE-So111111-2026-10-18-101500]]');
    expect(n.content).toContain('[[50 Daily/2026-10-18|2026-10-18]]');
    expect(n.content).toContain('  - "proven-crowd"');
  });

  it('wallet note carries the class tag and its coins', () => {
    const rec = { ...emptyRec(1), n: 12, w: 8, gw: 3, gl: 1.5, pnl: 1.4, hold: 240, dumps: 0, coins: 9 };
    const w: WalletState = { wallet: 'ProvenWallet1111111111111111111111111111111', cls: 'proven', rec, coins: ['20 Coins/PEPE-So111111'], lastSeenMs: 1, writtenMs: 0 };
    const n = walletNote(w);
    expect(n.path).toBe('30 Wallets/ProvenWallet.md');
    expect(n.content).toContain('class: "proven"');
    expect(n.content).toContain('win_rate: 67');
    expect(n.content).toContain('  - "proven"');
    expect(n.content).toContain('[[20 Coins/PEPE-So111111]]');
    const d = walletNote({ ...w, cls: 'deployer-sniper', rec: { ...rec, dumps: 4 } });
    expect(d.content).toContain('exit-liquidity machine');
    expect(d.content).toContain('  - "deployer-sniper"');
  });

  it('trade note links coin, strategy, day and wallets with snake_case frontmatter', () => {
    const n = tradeNote({ mint: coin.mint, symbol: 'PEPE', strategy: 'SOON', atMs: Date.parse('2026-10-18T10:15:00Z'), pnlSol: 0.3, pnlPct: 30, peakMultiple: 1.6, exitReason: 'TAKE_PROFIT', score: 81, mcUsd: 61_000, sizeSol: 1, heldMin: 12.5, explanation: 'bought the dip', wallets: coin.wallets });
    expect(n.path).toBe('10 Trades/SOON/PEPE-So111111-2026-10-18-101500.md');
    expect(n.content).toContain('pnl_sol: 0.3');
    expect(n.content).toContain('held_min: 12.5');
    expect(n.content).toContain('[[20 Coins/PEPE-So111111|PEPE]]');
    expect(n.content).toContain('[[40 Strategies/SOON|SOON]]');
    expect(n.content).toContain('[[50 Daily/2026-10-18|2026-10-18]]');
    expect(n.content).toContain('DumperWallet… (dumper)');
  });

  it('dashboard + strategy notes carry Dataview blocks; sniper rules are listed in plain words', () => {
    expect((dashboardNote().content.match(/```dataview/g) ?? []).length).toBeGreaterThanOrEqual(7);
    const rules = sniperRuleLines(DEFAULT_CONFIG.sniper, 1);
    expect(rules.length).toBe(10);
    expect(rules[0]).toContain('≥ 30 real buyers');
    const s = strategyNote('SOON', { trades: 12, winRate: 58, avgPnl: 4.2, totalPnl: 0.9, verdict: 'unproven' }, rules);
    expect(s.content).toContain('```dataview');
    expect(s.content).toContain('Sniper mode rules in force');
    expect(s.content).toContain('FROM "10 Trades/SOON"');
    expect(sniperRuleLines({ ...DEFAULT_CONFIG.sniper, enabled: false }, 1)).toEqual([]);
  });
});

describe('obsidian shared brain — inbox, memory, caps', () => {
  it('inbox parser skips headings, blanks, comments and bullets; same line → same key', () => {
    const lines = parseInbox('# My tips\n\n- avoid coins under $20k MC\n1. be stricter on migrated coins\n<!-- note -->\nok\n   Avoid coins under $20k MC  \n');
    expect(lines).toEqual(['avoid coins under $20k MC', 'be stricter on migrated coins', 'Avoid coins under $20k MC']);
    expect(inboxKey(lines[0]!)).toBe(inboxKey(lines[2]!));
    expect(inboxKey(lines[0]!)).not.toBe(inboxKey(lines[1]!));
  });

  it('memory: a normal review adds at most 3 new dated bullets, a deep review rewrites; never over 1,500 chars', () => {
    const existing = ['2026-10-16 — Chasing +30% candles loses.'];
    const normal = mergeMemory(existing, ['chasing +30% candles loses', 'Migrated coins with 30+ real buyers held up', 'Stops at 12% got hit by noise on sub-$10k coins', 'fourth', 'fifth'], false, '2026-10-18');
    expect(normal.bullets.length).toBe(4);
    expect(normal.added.length).toBe(3);
    expect(normal.bullets[0]).toBe(existing[0]);
    expect(normal.added[0]).toMatch(/^2026-10-18 — Migrated coins/);
    const deep = mergeMemory(normal.bullets, ['2026-10-18 — Only one thing matters.'], true, '2026-10-18');
    expect(deep.bullets).toEqual(['2026-10-18 — Only one thing matters.']);
    const long = mergeMemory([], Array.from({ length: 12 }, (_, i) => `${'x'.repeat(180)} ${i}`), true, '2026-10-18');
    expect(long.bullets.join('\n').length).toBeLessThanOrEqual(1500);
  });

  it('daily cap + wallet evictions', () => {
    expect(withinDailyCap(300, 300)).toBe(true);
    expect(withinDailyCap(301, 300)).toBe(false);
    expect(withinDailyCap(9999, 0)).toBe(true);
    const mk = (w: string, last: number): WalletState => ({ wallet: w, cls: 'proven', rec: null, coins: [], lastSeenMs: last, writtenMs: 0 });
    expect(walletEvictions([mk('a', 3), mk('b', 1), mk('c', 2)], 2)).toEqual(['b']);
    expect(walletEvictions([mk('a', 3)], 2)).toEqual([]);
  });

  it('migration v40 sets the inbox + caps on a saved obsidian row', () => {
    const m = MIGRATIONS.find((x) => x.version === 40)!;
    expect(m.set.map((s) => s[0])).toEqual(['obsidian', 'obsidian', 'obsidian', 'obsidian']);
    expect(DEFAULT_CONFIG.obsidian.inbox).toEqual({ enabled: true, pollSec: 60 });
    expect(DEFAULT_CONFIG.obsidian.maxCoinNotesPerDay).toBe(300);
  });
});

describe('obsidian shared brain — files land in the right folders', () => {
  it('start writes the index / dashboard / how-to; evaluations, trades, inbox, review all write their notes', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-brain-'));
    const seen = new Set<string>();
    const tips: string[] = [];
    let counter = 0;
    const o = new ObsidianSync({ enabled: true, vaultPath: vault, inbox: { enabled: true, pollSec: 60 }, maxCoinNotesPerDay: 300, maxWalletNotes: 2000, minSkippedScoreMargin: 10 }, {
      closedSince: async () => [{ symbol: 'PEPE', strategy: 'SOON', pnlSol: 0.3, sizeSol: 1 }],
      positionFor: async () => ({ strategy: 'SOON', sizeSol: 1, score: 81, mcUsd: 61_000, openedAtMs: Date.now() - 600_000 }),
      strategies: () => [{ strategy: 'SOON', trades: 12, winRate: 58, avgPnl: 4.2, totalPnl: 0.9, verdict: 'unproven' }],
      insights: async () => [{ text: 'Buying into +30% candles loses.' }],
      walletRec: () => ({ ...emptyRec(1), n: 10, w: 7, gw: 2, gl: 1 }),
      walletClass: (w) => (w.startsWith('Proven') ? 'proven' : w.startsWith('Dumper') ? 'dumper' : 'unknown'),
      topWallets: () => [{ wallet: 'ProvenTop111111111111111111111111111111111', cls: 'proven' }],
      tips: async () => tips.map((t, i) => ({ id: `t${i}`, at: '2026-10-18T10:00:00.000Z', text: t, status: 'new', response: null, rules: [], settings: [] })),
      addTip: async (t) => { tips.push(t); },
      changesSince: async () => [{ at: '2026-10-18T10:05:00.000Z', source: 'autopsy', what: 'SOON bar +5', why: 'losing' }],
      incrDaily: async () => ++counter,
      markSeen: async (_k, m) => (seen.has(m) ? false : (seen.add(m), true)),
      memory: async () => ['2026-10-18 — fact'],
      sniperRules: () => ['Rule one'],
    });
    const fakeBus = { on: () => undefined } as unknown as Parameters<ObsidianSync['start']>[0];
    await o.start(fakeBus, 60 * 60_000, 60 * 60_000);
    for (const f of ['_Index.md', '_Dashboard.md', '_How to read this vault.md']) await fs.access(path.join(vault, f));

    const now = Date.parse('2026-10-18T10:20:00Z');
    o.onEvaluation({ mint: coin.mint, symbol: 'PEPE', name: 'Pepe', strategy: 'SOON', decision: 'BUY', score: 81, threshold: 73, reasons: ['all good'], mcUsd: 61_000, migrated: false, firstSeenMs: now - 60_000, buyerWallets: ['ProvenWallet1111111111111111111111111111111', 'RandomWallet111111111111111111111111111111'], deployerSniperWallets: ['DeployerSniper11111111111111111111111111111'], crowdNote: 'crowd note', dumpCrew: true, provenCrowd: true }, now);
    o.onEvaluation({ mint: 'Far1111111111111111111111111111111111111111', symbol: 'FAR', name: null, strategy: 'SOON', decision: 'SKIP', score: 40, threshold: 73, reasons: ['too low'], mcUsd: null, migrated: false, firstSeenMs: now, buyerWallets: [], deployerSniperWallets: [], crowdNote: null, dumpCrew: false, provenCrowd: false }, now);
    await new Promise((r) => setTimeout(r, 20));
    await o.flush(now);
    const coinMd = await fs.readFile(path.join(vault, DIRS.coins, 'PEPE-So111111.md'), 'utf8');
    expect(coinMd).toContain('verdict: "signal"');
    expect(coinMd).toContain('dump_crew: true');
    expect(coinMd).toContain('DeployerSnip… (deployer-sniper)');
    await expect(fs.access(path.join(vault, DIRS.coins, 'FAR-Far11111.md'))).rejects.toBeTruthy();
    expect((await fs.readFile(path.join(vault, DIRS.wallets, 'ProvenWallet.md'), 'utf8'))).toContain('class: "proven"');
    expect((await fs.readFile(path.join(vault, DIRS.wallets, 'ProvenTop111.md'), 'utf8'))).toContain('class: "proven"');
    expect((await fs.readFile(path.join(vault, DIRS.daily, '2026-10-18.md'), 'utf8'))).toContain('PEPE +0.300 SOL');
    expect((await fs.readFile(path.join(vault, DIRS.strategies, 'SOON.md'), 'utf8'))).toContain('Rule one');
    expect((await fs.readFile(path.join(vault, DIRS.brain, 'Insights.md'), 'utf8'))).toContain('+30% candles');
    expect((await fs.readFile(path.join(vault, DIRS.brain, 'Memory.md'), 'utf8'))).toContain('2026-10-18 — fact');

    // Inbox → tips (deduped), replies note written.
    await fs.writeFile(path.join(vault, DIRS.inbox, 'Tips.md'), '# tips\n- avoid coins under $20k\n');
    expect(await o.pollInbox()).toBe(1);
    expect(await o.pollInbox()).toBe(0);
    expect(tips).toEqual(['avoid coins under $20k']);
    expect((await fs.readFile(path.join(vault, DIRS.brain, 'Tip replies.md'), 'utf8'))).toContain('avoid coins under $20k');
    await fs.writeFile(path.join(vault, DIRS.inbox, 'Notes.md'), 'x'.repeat(5000) + 'TAIL');
    const notes = await o.ownerNotes();
    expect(notes.length).toBe(4000);
    expect(notes.endsWith('TAIL')).toBe(true);

    // A review → diary entry + memory note.
    await o.onReview({ atMs: now, model: 'claude-sonnet-5-5', deep: false, tradesReviewed: 30, insights: ['Insight A'], rulesProposed: ['avoid SOON: x'], rulesLive: 2, rulesRetired: 1, settingsChanged: ['SOON bar 70 → 75'], resultsBefore: { n: 30, avgPct: -2 }, resultsAfterPrevious: { n: 8, avgPct: 1.5 }, memoryAdded: ['2026-10-18 — new fact'], memory: ['2026-10-18 — fact', '2026-10-18 — new fact'] });
    const diary = await fs.readFile(path.join(vault, DIRS.diary, '2026-10-18.md'), 'utf8');
    expect(diary).toContain('Insight A');
    expect(diary).toContain('SOON bar +5');
    expect(diary).toContain('2 live, 1 retired');
    expect((await fs.readFile(path.join(vault, DIRS.brain, 'Memory.md'), 'utf8'))).toContain('new fact');
    o.stop();
  });
});
