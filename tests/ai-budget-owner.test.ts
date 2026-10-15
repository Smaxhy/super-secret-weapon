import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { AiCoach } from '../src/learner/ai-coach';
import { DEFAULT_CONFIG } from '../src/config/default';

// Owner (Oct 15): "allow the brain commands to go regardless — tips etc — even if it's over the daily budget".
function coach(tips: Array<{ status: string }>) {
  const c = new AiCoach({} as Redis, () => ({ ...DEFAULT_CONFIG.aiCoach, enabled: true }));
  const x = c as unknown as Record<string, unknown>;
  x.client = {}; // pretend there is an API key
  x.spentToday = async () => 99; // way over the budget
  x.tips = async () => tips;
  // Getting past the budget check reaches the trade loading — stop there.
  x.loadTrades = async () => {
    throw new Error('past the budget check');
  };
  return c;
}

describe('AI coach budget vs owner requests', () => {
  it('automatic reviews stop at the daily budget', async () => {
    expect((await coach([]).review()).why).toMatch(/daily AI budget used/);
  });
  it("the owner's Run button and tips still go through", async () => {
    expect((await coach([]).review(true, false, false, true)).why).toBe('past the budget check');
    expect((await coach([{ status: 'new' }]).review(true, false, true)).why).toBe('past the budget check');
  });
  it('a pending tip turns an over-budget automatic review into a tip review', async () => {
    expect((await coach([{ status: 'new' }]).review()).why).toBe('past the budget check');
  });
});
