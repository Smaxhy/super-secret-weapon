/**
 * Tiny in-memory stand-in for ioredis — just the commands LiveState uses,
 * so the profit/pricing tests can run the real live-state code without a server.
 */
type Val = Map<string, string> | Set<string> | Map<string, number>;

export class FakeRedis {
  readonly data = new Map<string, Val>();
  private readonly scripts = new Map<string, string>();

  defineCommand(name: string, _o: { numberOfKeys: number; lua: string }): void {
    this.scripts.set(name, name);
    (this as unknown as Record<string, unknown>)[name] = (...args: string[]) => Promise.resolve(this.custom(name, args));
  }

  private hash(k: string): Map<string, string> {
    let h = this.data.get(k) as Map<string, string> | undefined;
    if (!h) this.data.set(k, (h = new Map()));
    return h;
  }
  private setOf(k: string): Set<string> {
    let s = this.data.get(k) as Set<string> | undefined;
    if (!s) this.data.set(k, (s = new Set()));
    return s;
  }

  private custom(name: string, [k, a, b]: string[]): number {
    if (name === 'balanceDelta') {
      const h = this.hash(k!);
      const v = BigInt(h.get(a!) ?? '0') + BigInt(b!);
      if (v <= 0n) h.delete(a!);
      else h.set(a!, v.toString());
      return Number(v);
    }
    if (name === 'balanceSet') {
      const h = this.hash(k!);
      if (BigInt(b!) <= 0n) h.delete(a!);
      else h.set(a!, b!);
      return 1;
    }
    if (name === 'trackOutcome') return 0;
    return 0;
  }

  // --- commands -------------------------------------------------------------
  async hset(k: string, ...args: unknown[]): Promise<number> {
    const h = this.hash(k);
    if (args.length === 1 && typeof args[0] === 'object') for (const [f, v] of Object.entries(args[0] as object)) h.set(f, String(v));
    else for (let i = 0; i < args.length; i += 2) h.set(String(args[i]), String(args[i + 1]));
    return 1;
  }
  async hget(k: string, f: string): Promise<string | null> {
    return (this.data.get(k) as Map<string, string> | undefined)?.get(f) ?? null;
  }
  async hmget(k: string, ...fs: string[]): Promise<Array<string | null>> {
    const h = this.data.get(k) as Map<string, string> | undefined;
    return fs.map((f) => h?.get(f) ?? null);
  }
  async hgetall(k: string): Promise<Record<string, string>> {
    return Object.fromEntries((this.data.get(k) as Map<string, string> | undefined) ?? []);
  }
  async hincrby(k: string, f: string, by: number | string): Promise<number> {
    const h = this.hash(k);
    const v = BigInt(h.get(f) ?? '0') + BigInt(by);
    h.set(f, v.toString());
    return Number(v);
  }
  async hdel(k: string, f: string): Promise<number> {
    return (this.data.get(k) as Map<string, string> | undefined)?.delete(f) ? 1 : 0;
  }
  async hlen(k: string): Promise<number> {
    return (this.data.get(k) as Map<string, string> | undefined)?.size ?? 0;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async zadd(k: string, score: number, m: string): Promise<number> {
    (this.hash(k) as Map<string, string>).set(m, String(score));
    return 1;
  }
  async zrem(k: string, m: string): Promise<number> {
    return this.hdel(k, m);
  }
  async pfadd(k: string, m: string): Promise<number> {
    this.setOf(k).add(m);
    return 1;
  }
  async pfcount(k: string): Promise<number> {
    return (this.data.get(k) as Set<string> | undefined)?.size ?? 0;
  }
  async sadd(k: string, m: string): Promise<number> {
    this.setOf(k).add(m);
    return 1;
  }
  async smembers(k: string): Promise<string[]> {
    return [...((this.data.get(k) as Set<string> | undefined) ?? [])];
  }
  async lpush(k: string, ...vals: string[]): Promise<number> {
    const l = (this.data.get(k) as string[] | undefined) ?? [];
    for (const v of vals) l.unshift(v);
    this.data.set(k, l as never);
    return l.length;
  }
  async ltrim(k: string, start: number, stop: number): Promise<string> {
    const l = (this.data.get(k) as string[] | undefined) ?? [];
    this.data.set(k, l.slice(start, stop + 1) as never);
    return 'OK';
  }
  async lrange(k: string, start: number, stop: number): Promise<string[]> {
    const l = (this.data.get(k) as string[] | undefined) ?? [];
    return l.slice(start, stop < 0 ? undefined : stop + 1);
  }
  async get(k: string): Promise<string | null> {
    const v = this.data.get(k);
    return typeof v === 'string' ? v : null;
  }
  async set(k: string, v: string): Promise<string> {
    this.data.set(k, v as never);
    return 'OK';
  }
  async del(...ks: string[]): Promise<number> {
    ks.forEach((k) => this.data.delete(k));
    return ks.length;
  }

  /** multi() and pipeline() queue calls and run them in order on exec(). */
  multi(): Record<string, unknown> {
    const queue: Array<() => Promise<unknown>> = [];
    const self = this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'exec') return async () => {
            const out: Array<[Error | null, unknown]> = [];
            for (const q of queue) out.push([null, await q()]);
            return out;
          };
          return (...args: unknown[]) => {
            queue.push(() => self[prop]!.apply(this, args));
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  pipeline(): Record<string, unknown> {
    return this.multi();
  }
}
