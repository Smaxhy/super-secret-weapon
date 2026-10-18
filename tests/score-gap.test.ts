import { describe, expect, it } from 'vitest';
import { scoreGapStrategies, scoreGapTable, scoreOnly } from '../src/tools/score-gap';

describe('score-gap diagnostic', () => {
  it('classifies score-only and sniper-only skips', () => {
    expect(scoreOnly('score 41.2 < 50')).toBe('score');
    expect(scoreOnly('score under the bar')).toBe('score');
    expect(scoreOnly('sniper: volume 22 buyers < 30')).toBe('sniper');
    expect(scoreOnly('bundlers hold 30% > 18%')).toBeNull();
  });
  it('bands coins by how far under the bar they were', () => {
    const row = (score: number, pnlPct: number) => ({ strategy: 'MIGRATION_MOMENTUM', score, bar: 50, why: 'score', pnlPct, at: 0, src: 'shadow' as const });
    const t = scoreGapTable([row(47, 10), row(46, -5), row(38, -20)]);
    expect(t).toContain('3 coins held back only by score');
    expect(t).toMatch(/0–5 under\s+n=\s+2\s+wins\s+50%\s+avg \+2\.5%/);
    expect(t).toMatch(/10–15 under\s+n=\s+1/);
  });
});

describe('score-gap verdict', () => {
  const row = (score: number, pnlPct: number) => ({ strategy: 'MIGRATION_MOMENTUM', score, bar: 50, why: 'score', pnlPct, at: 0, src: 'shadow' as const });
  it('says the bar is too high when coins just under it made money', () => {
    const s = scoreGapStrategies(Array.from({ length: 12 }, (_, i) => row(45, i % 3 === 0 ? -10 : 15)));
    expect(s[0]!.verdict).toBe('too_high');
  });
  it('says the bar is right when coins just under it lost', () => {
    expect(scoreGapStrategies(Array.from({ length: 12 }, () => row(46, -8)))[0]!.verdict).toBe('right');
  });
  it('waits for enough coins', () => {
    expect(scoreGapStrategies([row(48, 20), row(30, 5)])[0]!.verdict).toBe('unclear');
  });
});
