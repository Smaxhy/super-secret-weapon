/** Minimal in-memory Redis for the narrative / keyword-learner tests. */
export class NarrativeFakeRedis {
  readonly h = new Map<string, Map<string, string>>();
  readonly z = new Map<string, Map<string, number>>();
  readonly s = new Map<string, string>();

  private hash(k: string) {
    let m = this.h.get(k);
    if (!m) this.h.set(k, (m = new Map()));
    return m;
  }
  private zset(k: string) {
    let m = this.z.get(k);
    if (!m) this.z.set(k, (m = new Map()));
    return m;
  }

  async get(k: string) {
    return this.s.get(k) ?? null;
  }
  async set(k: string, v: string, ...opts: unknown[]) {
    if (opts.includes('NX') && this.s.has(k)) return null;
    this.s.set(k, v);
    return 'OK';
  }
  async del(...ks: string[]) {
    let n = 0;
    for (const k of ks) if (this.h.delete(k) || this.z.delete(k) || this.s.delete(k)) n++;
    return n;
  }
  async expire() {
    return 1;
  }
  async hmget(k: string, ...fs: string[]) {
    return fs.map((f) => this.h.get(k)?.get(f) ?? null);
  }
  async hgetall(k: string) {
    return Object.fromEntries(this.h.get(k) ?? []);
  }
  async hlen(k: string) {
    return this.h.get(k)?.size ?? 0;
  }
  async hset(k: string, obj: Record<string, string>) {
    const m = this.hash(k);
    for (const [f, v] of Object.entries(obj)) m.set(f, String(v));
    return 1;
  }
  async hincrbyfloat(k: string, f: string, by: number) {
    const m = this.hash(k);
    const v = Number(m.get(f) ?? 0) + by;
    m.set(f, String(v));
    return String(v);
  }
  async scard() {
    return 0;
  }
  async zadd(k: string, score: number, member: string) {
    this.zset(k).set(member, score);
    return 1;
  }
  async zcount(k: string, min: number, _max: string) {
    return [...(this.z.get(k) ?? new Map<string, number>()).values()].filter((v) => v >= min).length;
  }
  async zrangebyscore(k: string, min: number, _max: string, ..._rest: unknown[]) {
    const rows = [...(this.z.get(k) ?? new Map<string, number>())].filter(([, v]) => v >= min).sort((a, b) => a[1] - b[1]);
    return rows.flatMap(([m, v]) => [m, String(v)]);
  }
  multi() {
    const q: Array<() => Promise<unknown>> = [];
    const proxy: Record<string, unknown> = {
      exec: async () => {
        const out: Array<[null, unknown]> = [];
        for (const f of q) out.push([null, await f()]);
        return out;
      },
    };
    for (const name of ['del', 'hset', 'hincrbyfloat', 'zadd', 'zcount', 'expire', 'set']) {
      proxy[name] = (...args: unknown[]) => {
        q.push(() => (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args));
        return proxy;
      };
    }
    return proxy;
  }
}
