import { describe, expect, it } from 'vitest';
import { judgeCuts } from '../src/forex/conviction';
import { auc, JUDGE_CONFIG, JUDGE_FEATURES, JUDGE_SOFT, judgeKeeps, judgeMainP, judgeProb, judgeScores, judgeView, pickKeep, trainJudge, type JudgeModel, type JudgeRow } from '../src/forex/judge';
import type { TreeNode } from '../src/lib/gbdt';

const F = JUDGE_FEATURES.length;
const idx = (f: (typeof JUDGE_FEATURES)[number]) => JUDGE_FEATURES.indexOf(f);
const S = idx('strength');
const G = '1:0';

function rnd(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** one row: every feature random, chart 1h / not a metal; the result follows the currency strength (a hard feature) */
function makeRows(n: number, seed: number, cotKnown: (k: number) => boolean): JudgeRow[] {
  const r = rnd(seed);
  return Array.from({ length: n }, (_, k) => {
    const x = new Float64Array(F).map(() => r() * 2 - 1);
    x[idx('tf')] = 1;
    x[idx('metal')] = 0;
    if (!cotKnown(k)) x[idx('cot')] = NaN;
    const good = x[S]! > 0.2;
    const res = good ? (r() < 0.75 ? 1.5 : -1) : r() < 0.25 ? 1.5 : -1;
    return { x, r: res, t: k, exitT: k };
  });
}

/** a hand-built judge: score rises with the currency strength (10 small steps), base shifts the whole curve */
const steps = (base: number): Pick<JudgeModel, 'trees' | 'base'> => ({
  base,
  trees: Array.from({ length: 40 }, (_, k): TreeNode[] => [
    { f: S, cut: -0.975 + k * 0.05, miss: 0, l: 1, r: 2, v: 0 },
    { f: -1, cut: 0, miss: 0, l: 0, r: 0, v: 0 },
    { f: -1, cut: 0, miss: 0, l: 0, r: 0, v: 0.05 },
  ]),
});
const REQ = [idx('side'), S, idx('hurst'), idx('cot'), idx('tf'), idx('metal')];
const masks = { masked: { [G]: Array.from({ length: F }, (_, f) => f).filter((f) => !REQ.includes(f)) }, required: { [G]: REQ } };
const live = (strength: number, cot = 0.5) => {
  const x = new Float64Array(F).fill(NaN);
  x[idx('tf')] = 1;
  x[idx('metal')] = 0;
  x[idx('side')] = 1;
  x[S] = strength;
  x[idx('hurst')] = 0.5;
  x[idx('cot')] = cot;
  return x;
};

describe('v17 judge backup model (soft outside feeds)', () => {
  it('soft features are the slow outside feeds', () => {
    expect([...JUDGE_SOFT].sort()).toEqual(['carry', 'cot', 'fundZ', 'lsZ', 'mood', 'oiChg']); // v27.89: + the coin futures feeds
  });

  it('a signal missing only a soft feed is scored by the backup and held to the backup’s own bar', () => {
    // main: p ≈ 0.5 at strength 0, bar 0.6 → would skip; backup: p ≈ 0.6, bar 0.55 → keeps
    const m: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5, ...masks, fallback: { ...steps(-0.6), threshold: 0.55, keepShare: 0.6 } };
    const x = live(0, NaN);
    const v = judgeView(m, x);
    expect(v.via).toBe('fallback');
    expect(v.missing).toBeNull();
    expect(v.threshold).toBe(0.55);
    expect(v.p).toBeCloseTo(judgeProb(m.fallback!, x), 12);
    expect(v.p!).toBeLessThan(m.threshold); // against the main bar it would be skipped …
    expect(judgeKeeps(m, x)).toBe(true); // … but the backup's own bar decides
    // with the reading there, the main model scores it against its own bar
    const v2 = judgeView(m, live(0));
    expect(v2.via).toBe('main');
    expect(v2.threshold).toBe(0.6);
    expect(judgeKeeps(m, live(0))).toBe(v2.p! >= 0.6);
    // conviction cut points only ever see the main model's own score
    expect(judgeMainP(m, x)).toBeNull();
    expect(judgeMainP(m, live(0))).toBe(v2.p);
  });

  it('a missing hard reading still makes it wait, backup or not', () => {
    const m: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5, ...masks, fallback: { ...steps(-0.6), threshold: 0.55, keepShare: 0.6 } };
    const x = live(0.5);
    x[idx('hurst')] = NaN;
    const v = judgeView(m, x);
    expect(v.p).toBeNull();
    expect(v.missing).toMatch(/snap back/);
    expect(judgeKeeps(m, x)).toBe(false);
    // hard + soft missing → still waits (and says both)
    x[idx('cot')] = NaN;
    const v2 = judgeView(m, x);
    expect(v2.p).toBeNull();
    expect(v2.missing).toMatch(/snap back/);
    expect(v2.missing).toMatch(/positioning/);
    // a chart × market type it never trained on
    const y = live(0.5);
    y[idx('tf')] = 4;
    expect(judgeView(m, y).p).toBeNull();
  });

  it('a model without a backup behaves as before', () => {
    const m: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5, ...masks };
    const v = judgeView(m, live(0, NaN));
    expect(v.p).toBeNull();
    expect(v.missing).toMatch(/hedge-fund positioning/);
    expect(v.threshold).toBe(0.6);
    expect(judgeKeeps(m, live(0.9, NaN))).toBe(false);
    // with the reading: scored by the main model against its bar
    const ok = judgeView(m, live(0.9));
    expect(ok.via).toBe('main');
    expect(judgeKeeps(m, live(0.9))).toBe(ok.p! >= 0.6);
    // a pre-v17 model (no masks): always scored, NaN or not
    const old: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5 };
    const vo = judgeView(old, live(0.9, NaN));
    expect(vo.p).toBeCloseTo(judgeProb(old, live(0.9, NaN)), 12);
    expect(vo.via).toBe('main');
    expect(judgeKeeps(old, live(0.9, NaN))).toBe(vo.p! >= 0.6);
  });

  it('trained: cot known in ≥ 90% → required; a live row without it goes to a backup that passed its own exam', async () => {
    // cot known in 95% of history; in the unseen part a CFTC halt blanks it on every 3rd row
    const rows = makeRows(3000, 17, (k) => (k < 2100 ? k % 20 !== 0 : k % 3 !== 0));
    const { model, report } = await trainJudge(rows, 2100);
    expect(model).not.toBeNull();
    expect(model!.required!['1:0']).toContain(idx('cot'));
    expect(report.fallback).toBeDefined();
    expect(report.fallback!.active).toBe(true);
    expect(model!.fallback).toBeTruthy();
    expect(report.active).toBe(true);
    const oos = rows.filter((r) => r.t >= 2100);
    const halted = oos.filter((r) => !Number.isFinite(r.x[idx('cot')]!));
    for (const r of halted) {
      const v = judgeView(model!, r.x);
      expect(v.via).toBe('fallback');
      expect(v.p).not.toBeNull();
      expect(v.threshold).toBe(model!.fallback!.threshold);
      expect(judgeKeeps(model!, r.x)).toBe(v.p! >= model!.fallback!.threshold);
    }
    // the halt no longer stops every such trade …
    expect(halted.some((r) => judgeKeeps(model!, r.x))).toBe(true);
    // v17.8: … the main exam counts the main judge alone (a halted row = not kept, as before v17.7); what live keeps with
    // the backup filling in is shown apart (display only)
    expect(report.keepPct).toBe(Math.round((oos.filter((r) => judgeKeeps(model!, r.x, { backup: false })).length / oos.length) * 100));
    expect(halted.some((r) => judgeKeeps(model!, r.x, { backup: false }))).toBe(false);
    expect(report.withBackup!.keepPct).toBe(Math.round((oos.filter((r) => judgeKeeps(model!, r.x)).length / oos.length) * 100));
    expect(report.withBackup!.keepPct).toBeGreaterThan(report.keepPct);
  }, 30_000);

  it('trained: a backup that fails its exam is not stored (cot halt → wait, as before)', async () => {
    // the result follows the positioning reading itself: blank it and nothing is left to learn
    const r = rnd(5);
    const rows: JudgeRow[] = Array.from({ length: 3000 }, (_, k) => {
      const x = new Float64Array(F).map(() => r() * 2 - 1);
      x[idx('tf')] = 1;
      x[idx('metal')] = 0;
      const good = x[idx('cot')]! > 0.2;
      return { x, r: good ? (r() < 0.75 ? 1.5 : -1) : r() < 0.25 ? 1.5 : -1, t: k, exitT: k };
    });
    const { model, report } = await trainJudge(rows, 2100);
    expect(report.fallback!.active).toBe(false);
    expect(model!.fallback).toBeUndefined();
    expect(report.withBackup).toBeNull();
    const x = Float64Array.from(rows[2500]!.x);
    x[idx('cot')] = NaN;
    expect(judgeView(model!, x).p).toBeNull();
  }, 30_000);

  it('the pickiness is picked only on validation rows the main model can score (finding 6)', async () => {
    // training (first 800): the result follows strength. Validation (800–999): rows the judge can score have NO edge
    // in strength (high-strength ones win small, low-strength ones win big) → picking can't beat taking all; rows it
    // can't score (hurst missing now) follow strength strongly — counting them (scored blind) would make it picky.
    const r = rnd(29);
    const rows: JudgeRow[] = Array.from({ length: 1300 }, (_, k) => {
      const x = new Float64Array(F).map(() => r() * 2 - 1);
      x[idx('tf')] = 1;
      x[idx('metal')] = 0;
      for (const f of JUDGE_SOFT) x[idx(f)] = NaN; // no soft feeds here (keeps it to the main model)
      const s = x[S]!;
      const win = r() < 0.5;
      let res: number;
      if (k < 800 || k >= 1000) res = s > 0.2 ? (r() < 0.8 ? 1.5 : -1) : r() < 0.2 ? 1.5 : -1;
      else if ((k - 800) % 20 < 9) {
        x[idx('hurst')] = NaN; // 90 of 1000 in-sample rows → hurst still ≥ 90% known → required
        res = s > 0.2 ? 2 : -1;
      } else res = s > 0.2 ? (win ? 0.5 : -1) : win ? 3 : -1;
      return { x, r: res, t: k, exitT: k };
    });
    const { model, report } = await trainJudge(rows, 1000);
    expect(model!.required!['1:0']).toContain(idx('hurst'));
    // same pick by hand: the scorable validation rows only
    const vrows = rows.slice(800, 1000);
    const bare: JudgeModel = { ...model!, fallback: undefined };
    const ps = vrows.map((x) => judgeView(bare, x.x).p);
    expect(ps.filter((p) => p === null).length).toBe(90);
    const pick = pickKeep(vrows, ps, [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(model!.keepShare).toBe(pick.keep);
    expect(model!.threshold).toBe(pick.th);
    expect(model!.keepShare).toBe(1);
    expect(report.why).toMatch(/no level of pickiness/);
    // scoring the unscorable rows blind (the old way) would have made it picky
    const blind = pickKeep(vrows, vrows.map((x) => judgeProb(model!, x.x)), [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(blind.keep).toBeLessThan(1);
  }, 30_000);

  it('pickKeep ignores null scores', () => {
    const rows = [{ r: 1 }, { r: -1 }, { r: 5 }, { r: -5 }];
    const a = pickKeep(rows, [0.9, 0.1, null, null], [0.5]);
    const b = pickKeep(rows.slice(0, 2), [0.9, 0.1], [0.5]);
    expect(a).toEqual(b);
    expect(a.keep).toBe(0.5);
    expect(a.th).toBe(0.9);
  });

  it('conviction cut points never take an unscorable signal as a 0 score (finding 3)', () => {
    const m: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5, ...masks, fallback: { ...steps(-0.6), threshold: 0.55, keepShare: 0.6 } };
    const xs: Array<Float64Array | undefined> = [];
    for (let k = 0; k < 200; k++) {
      const x = live(-1 + (k % 100) / 50);
      if (k % 4 === 0) x[idx('hurst')] = NaN; // can't be scored
      if (k % 4 === 1) x[idx('cot')] = NaN; // only the backup could score it (other scale of cut points)
      xs.push(x);
    }
    xs.push(undefined);
    const ps = judgeScores(m, xs);
    expect(ps.length).toBe(100);
    expect(ps.every((p) => Number.isFinite(p) && p > 0)).toBe(true);
    const mainOnly = xs.filter((x): x is Float64Array => !!x && judgeView(m, x).via === 'main').map((x) => judgeView(m, x).p!);
    expect(judgeCuts(ps)).toEqual(judgeCuts(mainOnly));
    // the old way (no backup, null → 0 in the array) drags the cut points down
    const noFb: JudgeModel = { ...m, fallback: undefined };
    const old = judgeCuts(Array.from(Float64Array.from(xs.map((x) => (x ? judgeView(noFb, x).p : null)) as number[])));
    expect(old.pHi!).toBeLessThan(judgeCuts(ps).pHi!);
  });

  // ── v17.8: the backup was picked on the unseen 30% by its own exam, so it must not also grade the main judge there ──

  /** the main exam by hand: kept = scored and at its bar; unscorable = not kept (pre-v17.7 rule unless `backup`) */
  const examBy = (m: JudgeModel, oos: readonly JudgeRow[], backup: boolean) => {
    const v = oos.map((r) => judgeView(m, r.x, { backup }));
    const a = auc(v.map((s) => (s.p === null ? -Infinity : s.p)), oos.map((r) => (r.r > 0 ? 1 : 0)));
    const kept = oos.filter((_, k) => v[k]!.p !== null && v[k]!.p! >= v[k]!.threshold);
    const mean = (xs: readonly JudgeRow[]) => (xs.length ? xs.reduce((s, r) => s + r.r, 0) / xs.length : 0);
    const allR = mean(oos);
    const keptR = mean(kept);
    const c = JUDGE_CONFIG;
    return { a, kept: kept.length, pass: m.keepShare < 1 && a !== null && a >= c.minAuc && keptR >= allR + c.minGainR && kept.length >= c.minKept };
  };

  it('a failing main exam is not flipped to active by a passing backup', async () => {
    // cot known in 95% of history (→ required); in the unseen part a CFTC halt leaves it on only 1 row in 20, so the
    // main judge can score 45 of 900 unseen rows — too few to pass — while the backup (cot blanked) passes on all of them
    const rows = makeRows(3000, 17, (k) => (k < 2100 ? k % 20 !== 0 : k % 20 === 0));
    const { model, report } = await trainJudge(rows, 2100);
    const oos = rows.filter((r) => r.t >= 2100);
    expect(report.fallback!.active).toBe(true);
    expect(model!.fallback).toBeTruthy();
    expect(model!.keepShare).toBeLessThan(1);
    // the main judge alone: too few trades kept → off
    const main = examBy(model!, oos, false);
    expect(main.pass).toBe(false);
    expect(main.kept).toBeLessThan(JUDGE_CONFIG.minKept);
    expect(report.active).toBe(false);
    expect(report.why).toMatch(/only \d+ trades kept/);
    expect(Math.round((main.kept / oos.length) * 100)).toBe(report.keepPct);
    // scored with the backup filling in (the v17.7 exam) it would have passed
    const both = examBy(model!, oos, true);
    expect(both.pass).toBe(true);
    // shown for information only
    expect(report.withBackup!.keepPct).toBe(Math.round((both.kept / oos.length) * 100));
  }, 30_000);

  it('pure noise: backups never raise how often the main judge switches on', async () => {
    let active = 0;
    let unscorable = 0;
    let withFill = 0;
    let backups = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rnd(seed * 7919 + 13);
      const rows: JudgeRow[] = Array.from({ length: 2000 }, (_, k) => {
        const x = new Float64Array(F).map(() => r() * 2 - 1);
        x[idx('tf')] = 1;
        x[idx('metal')] = 0;
        if (k >= 1400 && k % 2 === 0) x[idx('cot')] = NaN; // CFTC halt on half the unseen rows
        return { x, r: r() < 0.4 ? 1.5 : -1, t: k, exitT: k }; // the result ignores every feature
      });
      const { model, report } = await trainJudge(rows, 1400);
      const oos = rows.filter((x) => x.t >= 1400);
      const bare = examBy(model!, oos, false).pass;
      expect(report.active).toBe(bare); // decided exactly as if the halted rows were unscorable
      if (report.active) active++;
      if (bare) unscorable++;
      if (examBy(model!, oos, true).pass) withFill++;
      if (model!.fallback) backups++;
    }
    expect(backups).toBeGreaterThan(0); // the case is exercised
    expect(active).toBeLessThanOrEqual(unscorable);
    // the v17.7 exam (backup filling in) can only switch the main judge on more often, never less
    expect(active).toBeLessThanOrEqual(withFill);
  }, 60_000);

  it('the honest-test "judged" row helper ignores the backup', () => {
    const m: JudgeModel = { ...steps(-1), threshold: 0.6, keepShare: 0.5, ...masks, fallback: { ...steps(-0.6), threshold: 0.55, keepShare: 0.6 } };
    const halted = live(0, NaN);
    expect(judgeKeeps(m, halted)).toBe(true); // live: the backup keeps it
    expect(judgeKeeps(m, halted, { backup: false })).toBe(false); // honest test: the main judge can't score it
    expect(judgeView(m, halted, { backup: false }).missing).toMatch(/positioning/);
    // with every reading there both agree
    for (const s of [-0.9, 0, 0.3, 0.9]) expect(judgeKeeps(m, live(s), { backup: false })).toBe(judgeKeeps(m, live(s)));
  });
});
