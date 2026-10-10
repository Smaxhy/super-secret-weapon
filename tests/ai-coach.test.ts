import { describe, expect, it } from 'vitest';
import { aiRuleVerdict, flattenFeatures, matchRule, nextStatus, ruleStats, setAiRules, type AiRule, type CoachTrade } from '../src/learner/ai-coach';

const C = { minForward: 8, edgePct: 5, probeEvery: 5, preferBarDelta: -4 };
const rule = (o: Partial<AiRule> = {}): AiRule => ({
  id: 'r1', title: 'paper hands dump it', why: '', strategy: 'CURVE_SNIPE', action: 'avoid',
  conditions: [{ feature: 'crowd.paperHandsPct', op: 'gt', value: 40 }],
  createdAt: '2026-10-10T00:00:00Z', status: 'testing', statusWhy: '', backtest: null, forward: null, ...o,
});
const t = (paper: number, pnl: number, strategy = 'CURVE_SNIPE'): CoachTrade => ({ strategy, pnlPct: pnl, openedAtMs: 0, flat: { 'crowd.paperHandsPct': paper } });

describe('AI coach rules', () => {
  it('flattens the evaluation features into one namespaced map (numbers + booleans only)', () => {
    const f = flattenFeatures({ market: { top10HolderPct: 31.5, onAmm: false, name: 'x' }, crowd: { paperHandsPct: 12 }, junk: { a: 1 } }, { score: 77, kols: null });
    expect(f).toEqual({ 'market.top10HolderPct': 31.5, 'market.onAmm': 0, 'crowd.paperHandsPct': 12, 'entry.score': 77 });
  });
  it('matches only its strategy, and a missing feature never matches', () => {
    expect(matchRule(rule(), 'CURVE_SNIPE', { 'crowd.paperHandsPct': 55 })).toBe(true);
    expect(matchRule(rule(), 'SOON', { 'crowd.paperHandsPct': 55 })).toBe(false);
    expect(matchRule(rule(), 'CURVE_SNIPE', {})).toBe(false);
    expect(matchRule(rule({ strategy: null }), 'SOON', { 'crowd.paperHandsPct': 55 })).toBe(true);
  });
  it('goes live only when new trades prove it; retired when they do not', () => {
    const losing = [...Array.from({ length: 10 }, () => t(60, -14)), ...Array.from({ length: 10 }, () => t(10, 6))];
    const r = rule({ forward: ruleStats(rule(), losing) });
    expect(r.forward).toMatchObject({ n: 10, avgPct: -14, restAvgPct: 6 });
    expect(nextStatus(r, C).status).toBe('live');
    const fine = [...Array.from({ length: 10 }, () => t(60, 8)), ...Array.from({ length: 10 }, () => t(10, 2))];
    expect(nextStatus(rule({ status: 'live', forward: ruleStats(rule(), fine) }), C).status).toBe('retired');
    expect(nextStatus(rule({ forward: ruleStats(rule(), losing.slice(0, 3)) }), C).status).toBe('testing');
    // Past trades say the opposite → retired straight away.
    expect(nextStatus(rule({ backtest: ruleStats(rule(), fine) }), C).status).toBe('retired');
  });
  it('live avoid rules refuse the buy (1 in 5 still goes through as a probe); prefer rules lower the bar', () => {
    setAiRules([rule({ status: 'live' }), rule({ id: 'r2', action: 'prefer', status: 'live', conditions: [{ feature: 'entry.kols', op: 'gt', value: 2 }] }), rule({ id: 'r3', status: 'testing' })]);
    const verdicts = Array.from({ length: 5 }, () => aiRuleVerdict('CURVE_SNIPE', { 'crowd.paperHandsPct': 70 }, C));
    expect(verdicts.filter((v) => v.fail).length).toBe(4);
    expect(aiRuleVerdict('CURVE_SNIPE', { 'entry.kols': 3 }, C)).toMatchObject({ fail: null, barDelta: -4 });
    expect(aiRuleVerdict('CURVE_SNIPE', { 'crowd.paperHandsPct': 5 }, C)).toMatchObject({ fail: null, barDelta: 0 });
    setAiRules([]);
  });
});
