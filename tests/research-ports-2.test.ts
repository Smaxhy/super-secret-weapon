import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { MIGRATIONS, applyMigration } from '../src/config/migrations';
import { hasTelegramLink, launchFeatures } from '../src/evaluator/launch-features';
import { crowdQuality, firstBuyersHolding } from '../src/evaluator/crowd-quality';
import { holderRewardsTimeLimits } from '../src/executor/sell-manager';
import { autoApplicable } from '../src/learner/strategy-lab';
import { replayTape, type BacktestTrade } from '../src/learner/backtester';
import { slotLadderOf } from '../src/learner/virtual-book';
import type { CrowdTrade } from '../src/scanner/crowd-tracker';

const T0 = 1_700_000_000_000;
// pump.fun defaults: 30 SOL / 1.073B tokens virtual, 1B supply (6 decimals)
const BASE = { initVSolLamports: 30_000_000_000n, initVTokRaw: 1_073_000_000_000_000n, supplyRaw: 1_000_000_000_000_000n, adopted: false };

describe('v11.11 launch covariates (features only)', () => {
  it('finds a Telegram link in the socials, website or description', () => {
    expect(hasTelegramLink({ telegram: 'https://t.me/mycoin' })).toBe(true);
    expect(hasTelegramLink({ description: 'join us telegram.me/abc now' })).toBe(true);
    expect(hasTelegramLink({ website: 'https://notat.me/x', description: 'no links' })).toBe(false);
  });

  it("measures the creator's launch buy: SOL, launch MC and % of supply", () => {
    // 2 SOL into the default curve buys ~67.06M tokens → MC ≈ 31.8 SOL (default launch ≈ 27.96)
    const f = launchFeatures({ ...BASE, description: 't.me/coin', devBuyLamports: 2_000_000_000n, devBuyTokens: 67_062_500_000_000n, devBoughtRaw: 67_062_500_000_000n });
    expect(f.telegram).toBe(1);
    expect(f.initialBuySol).toBe(2);
    expect(f.initialMcSol!).toBeGreaterThan(31);
    expect(f.initialMcSol!).toBeLessThan(33);
    expect(f.devSelfBuyPct!).toBeCloseTo(6.71, 1);
  });

  it('no creator buy at all = the default launch; unknown / adopted = null', () => {
    const none = launchFeatures({ ...BASE, devBuyLamports: null, devBuyTokens: null, devBoughtRaw: 0n });
    expect(none).toMatchObject({ telegram: 0, initialBuySol: 0, devSelfBuyPct: 0 });
    expect(none.initialMcSol!).toBeCloseTo(27.96, 1);
    expect(launchFeatures({ ...BASE, devBuyLamports: null, devBuyTokens: null, devBoughtRaw: 5n })).toMatchObject({ initialBuySol: null, initialMcSol: null });
    expect(launchFeatures({ ...BASE, adopted: true, devBuyLamports: 1n, devBuyTokens: 1n, devBoughtRaw: 1n })).toMatchObject({ initialMcSol: null, devSelfBuyPct: null });
  });

  it('the AI coach / rule search see the launch section', async () => {
    const { flattenFeatures } = await import('../src/learner/ai-coach');
    const flat = flattenFeatures({ launch: { telegram: 1, initialBuySol: 2, initialMcSol: 31.8, devSelfBuyPct: 6.7 } });
    expect(flat['launch.telegram']).toBe(1);
    expect(flat['launch.devSelfBuyPct']).toBe(6.7);
  });
});

const tr = (t: number, w: string, buy: boolean, sol: number, tok: number): CrowdTrade => ({ t: T0 + t, w, buy, sol, tok, px: sol / tok });

describe('v11.11 first buyers still holding', () => {
  const trades = [
    tr(0, 'dev', true, 1, 30e6), // creator — excluded
    tr(2_000, 'a', true, 1, 30e6), // sells everything later
    tr(5_000, 'b', true, 3, 60e6), // keeps it all
    tr(30_000, 'late', true, 5, 50e6), // not a launch buyer
    tr(60_000, 'a', false, 1.2, 30e6),
  ];

  it('SOL-weighted share of the launch buys still held + bags as % of supply', () => {
    const fb = firstBuyersHolding(trades, T0, 'dev', 1e9)!;
    expect(fb.wallets).toBe(2);
    expect(fb.holdingPct).toBe(75); // a: 1 SOL, 0 held; b: 3 SOL, all held
    expect(fb.bagPct).toBe(6); // 60M of 1B
  });

  it("unknown when the crowd log doesn't reach the launch", () => {
    expect(firstBuyersHolding(trades.slice(3), T0, 'dev', 1e9)).toBeNull();
    expect(firstBuyersHolding(trades, null, 'dev', 1e9)).toBeNull();
  });

  const book = { minSells: 6, provenWinRate: 0.55, provenPf: 1.3, dumperMinEvents: 3 };
  const cfg = { ...DEFAULT_CONFIG.wallets.entry };
  const run = (c: typeof cfg) => crowdQuality({ trades, now: T0 + 70_000, windowMs: 120_000, launchMs: T0, creator: 'dev', supply: 1e9 }, () => undefined, () => null, book, c)!;

  it('off by default: a feature only', () => {
    const q = run(cfg);
    expect(q.firstBuyersHoldingPct).toBe(75);
    expect(q.firstBuyersBagPct).toBe(6);
    expect(q.fails.some((f) => f.startsWith('launch buyers'))).toBe(false);
  });

  it('the owner can switch the rule on (holding share AND bag size)', () => {
    expect(run({ ...cfg, maxFirstBuyersHoldingPct: 50 }).fails).toContain('launch buyers still hold 75% of their bags (6% of the supply)');
    expect(run({ ...cfg, maxFirstBuyersHoldingPct: 50, firstBuyersMinBagPct: 10 }).fails.some((f) => f.startsWith('launch buyers'))).toBe(false);
    expect(run({ ...cfg, maxFirstBuyersHoldingPct: 80 }).fails.some((f) => f.startsWith('launch buyers'))).toBe(false);
  });
});

describe('v11.11 Holder Rewards coins hold longer', () => {
  const t = { staleMinutes: 10, maxHoldMinutes: 30, holdLongerMaxHours: 8 };
  it('stretches only the time limits, with a note', () => {
    const r = holderRewardsTimeLimits(t, true, 1.5);
    expect(r).toEqual({ staleMinutes: 15, maxHoldMinutes: 45, holdLongerMaxHours: 12, note: 'holder-rewards coin: time limits ×1.5' });
    expect(Object.keys(r).sort()).toEqual(['holdLongerMaxHours', 'maxHoldMinutes', 'note', 'staleMinutes']);
  });
  it('normal coins / factor 1 → unchanged', () => {
    expect(holderRewardsTimeLimits(t, false, 1.5)).toEqual({ ...t, note: null });
    expect(holderRewardsTimeLimits(t, true, 1)).toEqual({ ...t, note: null });
  });
  it('default factor is 1.5 and editable', () => {
    expect(DEFAULT_CONFIG.exit.holderRewardsHoldFactor).toBe(1.5);
  });
});

describe('v11.11 lab variant E (early ladder)', () => {
  const E = DEFAULT_CONFIG.lab.variants.find((v) => v.id === 'E')!;

  it('new pairs + SOON only, never applied automatically', () => {
    expect(E.strategies).toEqual(['CURVE_SNIPE', 'SOON']);
    expect(autoApplicable(E)).toBe(false);
    expect(autoApplicable({ ownerOnly: false })).toBe(true);
    expect(autoApplicable({ ownerOnly: true })).toBe(false);
    expect(slotLadderOf(E.exit)!.map((l) => l.sellPct).reduce((a, b) => a + b, 0)).toBe(100);
  });

  // flat price, a trade every 200 ms for 20 s
  const flat = (): CrowdTrade[] => Array.from({ length: 100 }, (_, k) => ({ t: T0 + k * 200, w: `w${k % 9}`, buy: k % 2 === 0, sol: 0.3, tok: 3e6, px: 1e-7, pp: 1e-7 }));
  const variants = [{ id: 'L', name: 'Live', exit: {} }, E];

  it('sells the legs by time since the buy, whatever the price, and is done after the last leg', () => {
    const trade: BacktestTrade = { id: 'p1', mint: 'M', symbol: 'X', strategy: 'CURVE_SNIPE', openedAtMs: T0, onAmm: false, actualPnlPct: 0 };
    const res = replayTape('M', flat(), [trade], variants);
    const e = res.get('p1:E')!;
    expect(e.reason).toContain('early ladder leg 5');
    // last leg at 7.2 s (holdSec is whole seconds)
    expect(e.holdSec).toBeGreaterThanOrEqual(7);
    expect(e.holdSec).toBeLessThanOrEqual(8);
    // the live exits are still holding at the end of a flat 20 s tape
    expect(res.get('p1:L')!.reason).toContain('tape ended');
  });

  it('a migrated trade never gets variant E', () => {
    const trade: BacktestTrade = { id: 'p2', mint: 'M', symbol: 'X', strategy: 'MIGRATION_MOMENTUM', openedAtMs: T0, onAmm: true, actualPnlPct: 0 };
    const res = replayTape('M', flat(), [trade], variants);
    expect(res.has('p2:E')).toBe(false);
    expect(res.has('p2:L')).toBe(true);
  });
});

describe('v11.11 migration v42', () => {
  it('pushes the new keys + variant E into saved rows', () => {
    const m = MIGRATIONS.find((x) => x.version === 42)!;
    const out = applyMigration({ wallets: { entry: { enabled: true } }, exit: { staleMinutes: {} }, lab: { variants: [{ id: 'L', name: 'Live', exit: {} }] } }, m) as Record<string, Record<string, unknown>>;
    expect((out.wallets!.entry as Record<string, unknown>).maxFirstBuyersHoldingPct).toBe(0);
    expect(out.exit!.holderRewardsHoldFactor).toBe(1.5);
    expect((out.lab!.variants as Array<{ id: string }>).some((v) => v.id === 'E')).toBe(true);
  });
});
