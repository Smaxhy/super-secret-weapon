import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS, applyMigration } from '../src/config/migrations';
import { overrideConfig } from '../src/config/runtime-config';
import { sniperEntryFails, type SniperConfig } from '../src/evaluator/sniper';
import { classifyDeployer, decayDeployer, DeployerBook, deployerEvictions, deployerView, emptyDeployer, launchTiming, seedDeployers, type DeployerRec } from '../src/learner/deployer-book';

const C = DEFAULT_CONFIG.deployers;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const rec = (p: Partial<DeployerRec>): DeployerRec => ({ ...emptyDeployer(NOW - 30 * DAY), ...p });

describe('deployer book: classify', () => {
  it('new / serial / proven / rugger / mixed', () => {
    expect(classifyDeployer(undefined, false, C)).toBe('new');
    expect(classifyDeployer(rec({ l: 1 }), false, C)).toBe('new');
    expect(classifyDeployer(rec({ l: 5, g: 0, df: 3 }), false, C)).toBe('serial');
    expect(classifyDeployer(rec({ l: 5, g: 0, df: 2 }), false, C)).toBe('mixed'); // 40% died fast < 60%
    expect(classifyDeployer(rec({ l: 3, g: 1, df: 1 }), false, C)).toBe('proven');
    expect(classifyDeployer(rec({ l: 3, g: 1, df: 2 }), false, C)).toBe('mixed'); // 67% died fast > 40%
    expect(classifyDeployer(rec({ l: 3, g: 2, rugs: 1 }), false, C)).toBe('rugger');
    expect(classifyDeployer(rec({ l: 3, g: 2 }), true, C)).toBe('rugger');
  });
  it('fades with a half-life and evicts the oldest', () => {
    const d = decayDeployer(rec({ l: 8, g: 2, df: 4, rugs: 1 }), 30, 30);
    expect(d.l).toBeCloseTo(4);
    expect(d.rugs).toBeCloseTo(0.5);
    const e = deployerEvictions([['a', rec({ last: 1 })], ['b', rec({ last: 3 })], ['c', rec({ last: 2 })]], 2);
    expect(e).toEqual(['a']);
  });
});

describe('deployer book: entry verdict', () => {
  it('serial launcher / rugger / linked serials → rule fails with the exact strings', () => {
    const serial = deployerView(rec({ l: 5, g: 0, df: 3 }), { inRugMemory: false, linked: 0, linkedSerial: 0 }, C);
    expect(serial.class).toBe('serial');
    expect(serial.fails).toEqual(['deployer: serial launcher (5 launches, 0 graduated, 60% died fast)']);
    const rugger = deployerView(rec({ l: 2, g: 1, rugs: 1 }), { inRugMemory: false, linked: 0, linkedSerial: 0 }, C);
    expect(rugger.fails).toEqual(['deployer: rugged before (1×)']);
    const linked = deployerView(rec({ l: 2, g: 0 }), { inRugMemory: false, linked: 4, linkedSerial: 3 }, C);
    expect(linked.fails[0]).toMatch(/funded alongside 3 serial launchers/);
    expect(deployerView(rec({ l: 2, g: 0 }), { inRugMemory: false, linked: 4, linkedSerial: 2 }, C).fails).toEqual([]);
  });
  it('proven → points + note; new → nothing', () => {
    const p = deployerView(rec({ l: 3, g: 1, df: 1 }), { inRugMemory: false, linked: 0, linkedSerial: 0 }, C);
    expect(p.points).toBe(C.points.proven);
    expect(p.note).toBe('deployer: proven (3 launches, 1 graduated)');
    const n = deployerView(undefined, { inRugMemory: false, linked: 0, linkedSerial: 0 }, C);
    expect(n).toMatchObject({ class: 'new', points: 0, fails: [], note: 'deployer: first launch' });
  });
  it('a second launch within 24 h → "already launched N other coins today (serial)"', () => {
    const b = new DeployerBook(null);
    b.onLaunch('dev', 'A', NOW - 3 * 3_600_000);
    b.onLaunch('dev', 'B', NOW);
    const v = b.view('dev', false, 'B', NOW);
    expect(v.launchesToday).toBe(1);
    expect(v.fails).toContain('deployer: already launched 1 other coin today (serial)');
    // the first coin itself, judged at its own launch, had no other launch that day
    expect(b.view('dev', false, 'A', NOW - 3 * 3_600_000).launchesToday).toBe(0);
    // a launch 2 days ago does not count
    const b2 = new DeployerBook(null);
    b2.onLaunch('dev', 'A', NOW - 2 * DAY);
    b2.onLaunch('dev', 'B', NOW);
    expect(b2.view('dev', false, 'B', NOW).fails).toEqual([]);
    // switched off
    overrideConfig({ deployers: { maxLaunchesPerDay: 0 } });
    try {
      expect(b.view('dev', false, 'B', NOW).fails).toEqual([]);
    } finally {
      overrideConfig({ deployers: { maxLaunchesPerDay: C.maxLaunchesPerDay } });
    }
  });
  it('a proven creator quiet for ≥7 days before this launch gets the extra points', () => {
    const quiet = rec({ l: 2, g: 1, df: 0, mints: ['X', 'Y'], lts: [NOW - 10 * DAY, NOW] });
    const v = deployerView(quiet, { inRugMemory: false, linked: 0, linkedSerial: 0, currentMint: 'Y', nowMs: NOW }, C);
    expect(v.daysSinceLastLaunch).toBe(10);
    expect(v.points).toBe(C.points.proven + C.points.quietProven);
    expect(v.note).toMatch(/quiet for 10 days/);
    const busy = rec({ l: 2, g: 1, df: 0, mints: ['X', 'Y'], lts: [NOW - 2 * DAY, NOW] });
    expect(deployerView(busy, { inRugMemory: false, linked: 0, linkedSerial: 0, currentMint: 'Y', nowMs: NOW }, C).points).toBe(C.points.proven);
    expect(launchTiming(undefined, null, NOW)).toEqual({ launchesToday: 0, daysSinceLastLaunch: null });
  });
});

describe('deployer book: events, backfill, cap, seed', () => {
  it('launch / graduate / died fast / rug update one creator; the same mint never counts twice', () => {
    const b = new DeployerBook(null);
    b.onLaunch('dev', 'M1', NOW - DAY);
    b.onLaunch('dev', 'M1', NOW - DAY);
    b.onGraduated('dev', 'M1', 50_000, NOW - DAY + 600_000);
    b.onGraduated('dev', 'M1', 50_000, NOW - DAY + 700_000);
    b.onLaunch('dev', 'M2', NOW - 20 * 3_600_000);
    b.onDead('dev', 'M2', 1200, 3);
    b.onDead('dev', 'M2', 1200, 3);
    b.onDead('dev', 'M3', 7200, 3); // too old to be "died fast"
    b.onRug('dev');
    const r = b.get('dev')!;
    expect(r.l).toBe(2);
    expect(r.g).toBe(1);
    expect(r.df).toBe(1);
    expect(r.rugs).toBe(1);
    expect(r.mcs).toEqual([50_000]);
    expect(b.classOf('dev')).toBe('rugger');
    expect(b.stats()).toMatchObject({ creators: 1, ruggers: 1, launches: 2 });
  });
  it('backfill merges Token rows idempotently', () => {
    const b = new DeployerBook(null);
    const rows = [
      { creator: 'p', mint: 'A', createdAtMs: NOW - 5 * DAY, completedAtMs: NOW - 5 * DAY + 3_600_000, rugged: false, holders: 300, peakMcUsd: 80_000 },
      { creator: 'p', mint: 'B', createdAtMs: NOW - 4 * DAY, completedAtMs: null, rugged: false, holders: 40, peakMcUsd: 9_000 },
      { creator: 's', mint: 'C', createdAtMs: NOW - 3 * DAY, completedAtMs: null, rugged: false, holders: 2, peakMcUsd: null },
      { creator: 's', mint: 'D', createdAtMs: NOW - 2 * DAY, completedAtMs: null, rugged: true, holders: 1, peakMcUsd: null },
    ];
    expect(b.backfillFrom(rows, NOW)).toBe(4);
    expect(b.backfillFrom(rows, NOW)).toBe(0);
    expect(b.get('p')).toMatchObject({ l: 2, g: 1, df: 0, rugs: 0 });
    expect(b.get('s')).toMatchObject({ l: 2, g: 0, df: 2, rugs: 1 });
    expect(b.classOf('p')).toBe('proven');
    expect(b.classOf('s')).toBe('rugger');
    expect(b.top('proven', 5)[0]?.creator).toBe('p');
  });
  it('keeps at most maxCreators (LRU by last launch) and seeds from raw records', () => {
    overrideConfig({ deployers: { maxCreators: 100 } });
    try {
      const b = new DeployerBook(null);
      for (let i = 0; i < 120; i++) b.onLaunch(`c${i}`, `m${i}`, NOW - 120_000 + i * 1000);
      expect(b.size).toBeLessThanOrEqual(105);
      expect(b.get('c0')).toBeUndefined();
      expect(b.get('c119')).toBeDefined();
    } finally {
      overrideConfig({ deployers: { maxCreators: C.maxCreators } });
    }
    const s = new DeployerBook(null);
    expect(seedDeployers(s, { x: JSON.stringify(rec({ l: 3, g: 1, mints: ['a', 'b', 'c'] })), bad: 'nope' })).toBe(1);
    expect(s.get('x')!.lts).toHaveLength(3);
  });
  it('linked serial launchers through a shared funder', () => {
    const b = new DeployerBook(null);
    for (const c of ['s1', 's2', 's3']) {
      for (let i = 0; i < 5; i++) b.onLaunch(c, `${c}-${i}`, NOW - 10 * DAY + i * 3_600_000);
      for (let i = 0; i < 4; i++) b.onDead(c, `${c}-${i}`, 900, 2);
      b.noteFunder(c, 'F');
    }
    b.onLaunch('fresh', 'f-1', NOW - 5 * DAY);
    b.noteFunder('fresh', 'F');
    expect(b.linkedOf('fresh')).toEqual({ linked: 3, linkedSerial: 3 });
    expect(b.view('fresh', false, 'f-1', NOW).fails[0]).toMatch(/funded alongside 3 serial launchers/);
  });
});

describe('sniper mode + migration v41', () => {
  const SN = DEFAULT_CONFIG.sniper as unknown as SniperConfig;
  const flow = { buyers: 40, buySol: 20, buySharePct: 70, organicPct: 80 } as unknown as Parameters<typeof sniperEntryFails>[0]['flow'];
  const ok = { flow, score: 80, threshold: 65, momentumGateWhy: null, entryQualityVerdict: 'ok', edgeGatePass: null, pressureSellersInControl: false, crowd: null, explore: false, probe: false, risky: false, dipEntry: false };
  it('refuses serial launchers / ruggers unless switched off', () => {
    expect(sniperEntryFails({ ...ok, deployerClass: 'serial' }, SN)).toContain('deployer is a serial launcher');
    expect(sniperEntryFails({ ...ok, deployerClass: 'rugger' }, SN)).toContain('deployer is a known rugger');
    expect(sniperEntryFails({ ...ok, deployerClass: 'proven' }, SN)).toEqual([]);
    expect(sniperEntryFails({ ...ok, deployerClass: 'serial' }, { ...SN, requireDeployerNotSerial: false })).toEqual([]);
  });
  it('migration v41 writes the holder-growth exit + the sniper rule into saved rows', () => {
    const m = MIGRATIONS.find((x) => x.version === 41)!;
    const out = applyMigration({ exit: { earlyBail: { enabled: true } }, sniper: { enabled: true } }, m) as { exit: { holderGrowth: { enabled: boolean; sellPct: number } }; sniper: { requireDeployerNotSerial: boolean } };
    expect(out.exit.holderGrowth).toMatchObject({ enabled: true, sellPct: 50 });
    expect(out.sniper.requireDeployerNotSerial).toBe(true);
    expect(DEFAULT_CONFIG.deployers.enabled).toBe(true);
  });
});
