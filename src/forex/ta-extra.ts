/**
 * v28.16: indicators for the strategies ported from go-trader's list (richkuo/go-trader, MIT — ideas only, written fresh
 * here). Every series is causal (bar i only reads bars ≤ i) and built once per chart on first use (memo per Ctx). Pure.
 */
import type { Ctx } from './ta';

const memo = new WeakMap<Ctx, Map<string, unknown>>();
function cached<T>(c: Ctx, key: string, build: () => T): T {
  let m = memo.get(c);
  if (!m) {
    m = new Map();
    memo.set(c, m);
  }
  if (!m.has(key)) m.set(key, build());
  return m.get(key) as T;
}

function ema(src: ArrayLike<number>, n: number): number[] {
  const out: number[] = new Array(src.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seen = 0;
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    if (!Number.isFinite(x)) continue;
    if (seen < n) {
      sum += x;
      seen++;
      if (seen === n) prev = sum / n;
    } else prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(src: ArrayLike<number>, n: number): number[] {
  const out: number[] = new Array(src.length).fill(NaN);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    sum += Number.isFinite(x) ? x : 0;
    cnt += Number.isFinite(x) ? 1 : 0;
    if (i >= n) {
      const y = src[i - n]!;
      sum -= Number.isFinite(y) ? y : 0;
      cnt -= Number.isFinite(y) ? 1 : 0;
    }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}

/** Heikin-Ashi candles: [open, close, high, low]. */
export function heikinAshi(c: Ctx): { o: number[]; c: number[]; h: number[]; l: number[] } {
  return cached(c, 'ha', () => {
    const B = c.bars;
    const o: number[] = [];
    const cl: number[] = [];
    const h: number[] = [];
    const l: number[] = [];
    for (let i = 0; i < B.length; i++) {
      const b = B[i]!;
      const hc = (b.o + b.h + b.l + b.c) / 4;
      const ho = i === 0 ? (b.o + b.c) / 2 : (o[i - 1]! + cl[i - 1]!) / 2;
      o.push(ho);
      cl.push(hc);
      h.push(Math.max(b.h, ho, hc));
      l.push(Math.min(b.l, ho, hc));
    }
    return { o, c: cl, h, l };
  });
}

/** Vortex indicator VI+ / VI− over n bars. */
export function vortex(c: Ctx, n = 14): { plus: number[]; minus: number[] } {
  return cached(c, `vortex${n}`, () => {
    const B = c.bars;
    const vp: number[] = [NaN];
    const vm: number[] = [NaN];
    const tr: number[] = [NaN];
    for (let i = 1; i < B.length; i++) {
      const b = B[i]!;
      const p = B[i - 1]!;
      vp.push(Math.abs(b.h - p.l));
      vm.push(Math.abs(b.l - p.h));
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    }
    const sp = sma(vp, n);
    const sm = sma(vm, n);
    const st = sma(tr, n);
    return { plus: sp.map((x, i) => x / st[i]!), minus: sm.map((x, i) => x / st[i]!) };
  });
}

/** Aroon up / down over n bars (0–100). */
export function aroon(c: Ctx, n = 25): { up: number[]; dn: number[] } {
  return cached(c, `aroon${n}`, () => {
    const B = c.bars;
    const up: number[] = new Array(B.length).fill(NaN);
    const dn: number[] = new Array(B.length).fill(NaN);
    for (let i = n; i < B.length; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      let hiAt = i;
      let loAt = i;
      for (let j = i - n; j <= i; j++) {
        if (B[j]!.h >= hi) {
          hi = B[j]!.h;
          hiAt = j;
        }
        if (B[j]!.l <= lo) {
          lo = B[j]!.l;
          loAt = j;
        }
      }
      up[i] = (100 * (n - (i - hiAt))) / n;
      dn[i] = (100 * (n - (i - loAt))) / n;
    }
    return { up, dn };
  });
}

/** Kaufman adaptive moving average (er n, fast 2, slow 30). */
export function kama(c: Ctx, n = 10, fast = 2, slow = 30): number[] {
  return cached(c, `kama${n}`, () => {
    const x = c.close;
    const out: number[] = new Array(x.length).fill(NaN);
    const f = 2 / (fast + 1);
    const s = 2 / (slow + 1);
    let k = NaN;
    for (let i = n; i < x.length; i++) {
      let path = 0;
      for (let j = i - n + 1; j <= i; j++) path += Math.abs(x[j]! - x[j - 1]!);
      const er = path > 0 ? Math.abs(x[i]! - x[i - n]!) / path : 0;
      const sc = (er * (f - s) + s) ** 2;
      k = Number.isFinite(k) ? k + sc * (x[i]! - k) : x[i]!;
      out[i] = k;
    }
    return out;
  });
}

/** Fisher transform of the candle midpoint over n bars, and its 1-bar lag (the signal line). */
export function fisher(c: Ctx, n = 10): { f: number[]; sig: number[] } {
  return cached(c, `fisher${n}`, () => {
    const B = c.bars;
    const f: number[] = new Array(B.length).fill(NaN);
    let v = 0;
    let fp = 0;
    for (let i = n - 1; i < B.length; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        hi = Math.max(hi, B[j]!.h);
        lo = Math.min(lo, B[j]!.l);
      }
      const mid = (B[i]!.h + B[i]!.l) / 2;
      const raw = hi > lo ? 2 * ((mid - lo) / (hi - lo) - 0.5) : 0;
      v = Math.max(-0.999, Math.min(0.999, 0.33 * raw + 0.67 * v));
      fp = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * fp;
      f[i] = fp;
    }
    return { f, sig: f.map((_, i) => (i > 0 ? f[i - 1]! : NaN)) };
  });
}

/** Connors RSI = mean of RSI(3) of closes, RSI(2) of the up / down streak, and the percent rank of the 1-bar change over 100. */
export function connorsRsi(c: Ctx): number[] {
  return cached(c, 'crsi', () => {
    const x = c.close;
    const rsi = (src: number[], n: number): number[] => {
      const out: number[] = new Array(src.length).fill(NaN);
      let ag = 0;
      let al = 0;
      for (let i = 1; i < src.length; i++) {
        const d = src[i]! - src[i - 1]!;
        const g = Math.max(0, d);
        const l = Math.max(0, -d);
        if (i <= n) {
          ag += g / n;
          al += l / n;
        } else {
          ag = (ag * (n - 1) + g) / n;
          al = (al * (n - 1) + l) / n;
        }
        if (i >= n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      return out;
    };
    const streak: number[] = [0];
    for (let i = 1; i < x.length; i++) {
      const d = x[i]! - x[i - 1]!;
      const p = streak[i - 1]!;
      streak.push(d > 0 ? (p > 0 ? p + 1 : 1) : d < 0 ? (p < 0 ? p - 1 : -1) : 0);
    }
    const r3 = rsi(x, 3);
    const rs = rsi(streak, 2);
    const out: number[] = new Array(x.length).fill(NaN);
    for (let i = 101; i < x.length; i++) {
      const ch = x[i]! - x[i - 1]!;
      let below = 0;
      for (let j = i - 100; j < i; j++) if (x[j]! - x[j - 1]! < ch) below++;
      out[i] = (r3[i]! + rs[i]! + below) / 3;
    }
    return out;
  });
}

/** TRIX(n): 1-bar % change of a triple-smoothed EMA. */
export function trix(c: Ctx, n = 15): number[] {
  return cached(c, `trix${n}`, () => {
    const e3 = ema(ema(ema(c.close, n), n), n);
    return e3.map((x, i) => (i > 0 && e3[i - 1]! > 0 ? ((x - e3[i - 1]!) / e3[i - 1]!) * 100 : NaN));
  });
}

/** Awesome oscillator: SMA5 − SMA34 of the candle midpoints. */
export function awesome(c: Ctx): number[] {
  return cached(c, 'ao', () => {
    const mid = c.bars.map((b) => (b.h + b.l) / 2);
    const a = sma(mid, 5);
    const b = sma(mid, 34);
    return a.map((x, i) => x - b[i]!);
  });
}

/** EMA(13) and Elder bull / bear power. */
export function elderRay(c: Ctx): { ema13: number[]; bull: number[]; bear: number[] } {
  return cached(c, 'elder', () => {
    const e = ema(c.close, 13);
    return { ema13: e, bull: c.bars.map((b, i) => b.h - e[i]!), bear: c.bars.map((b, i) => b.l - e[i]!) };
  });
}

/** Money flow index (14); NaN where the chart has no volume. */
export function mfi(c: Ctx, n = 14): number[] {
  return cached(c, `mfi${n}`, () => {
    const B = c.bars;
    const out: number[] = new Array(B.length).fill(NaN);
    const tp = B.map((b) => (b.h + b.l + b.c) / 3);
    for (let i = n; i < B.length; i++) {
      let pos = 0;
      let neg = 0;
      let okv = true;
      for (let j = i - n + 1; j <= i; j++) {
        const v = B[j]!.v;
        if (!(typeof v === 'number' && v > 0)) {
          okv = false;
          break;
        }
        const mf = tp[j]! * v;
        if (tp[j]! > tp[j - 1]!) pos += mf;
        else if (tp[j]! < tp[j - 1]!) neg += mf;
      }
      if (okv) out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  });
}

/**
 * Dual Thrust levels for bar i: today's (UTC day) open ± k × range, range = max(highest high − lowest close, highest close −
 * lowest low) over the previous `days` complete UTC days. null until enough days exist.
 */
export function dualThrust(c: Ctx, days = 4, k = 0.5): Array<{ up: number; dn: number } | null> {
  return cached(c, `dt${days}`, () => {
    const B = c.bars;
    const D = 86_400_000;
    const done: Array<{ h: number; l: number; c: number }> = [];
    let cur: { day: number; o: number; h: number; l: number; c: number } | null = null;
    const out: Array<{ up: number; dn: number } | null> = [];
    for (let i = 0; i < B.length; i++) {
      const b = B[i]!;
      const day = Math.floor(b.t / D);
      if (!cur || cur.day !== day) {
        if (cur) done.push({ h: cur.h, l: cur.l, c: cur.c });
        cur = { day, o: b.o, h: b.h, l: b.l, c: b.c };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
      }
      if (done.length < days) {
        out.push(null);
        continue;
      }
      const w = done.slice(-days);
      const hh = Math.max(...w.map((d) => d.h));
      const ll = Math.min(...w.map((d) => d.l));
      const hc = Math.max(...w.map((d) => d.c));
      const lc = Math.min(...w.map((d) => d.c));
      const range = Math.max(hh - lc, hc - ll);
      out.push({ up: cur.o + k * range, dn: cur.o - k * range });
    }
    return out;
  });
}
