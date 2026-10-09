/**
 * Token-bucket rate limiter.
 *
 * Think of a bucket that holds `capacity` tokens and refills at
 * `refillPerSecond`. Every request takes one token; if the bucket is empty the
 * request waits until a token drips back in. This keeps us under the Helius
 * plan limit no matter how many launches happen at once.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number = Math.max(1, Math.ceil(refillPerSecond)),
  ) {
    this.tokens = capacity;
  }

  /** Resolves when the caller is allowed to make one request. */
  acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.waiters.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.schedule();
    });
  }

  /** Run `fn` once a slot is free. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  get pending(): number {
    return this.waiters.length;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  private schedule(): void {
    if (this.timer) return;
    const msPerToken = 1000 / this.refillPerSecond;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill();
      while (this.tokens >= 1 && this.waiters.length > 0) {
        this.tokens -= 1;
        this.waiters.shift()!();
      }
      if (this.waiters.length > 0) this.schedule();
    }, msPerToken);
  }
}
