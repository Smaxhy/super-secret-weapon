/**
 * The bot's own chart: hourly candles + what it sees (trendlines, support / resistance, yesterday's range, Asian
 * range) + its open paper trades (entry, stop, target). Plain SVG, scales to the card width.
 */
export interface ChartLine { kind: 'support' | 'resistance'; t1: number; p1: number; t2: number; p2: number; pNow: number; touches: number; broken: boolean }
export interface ChartLevel { kind: 'support' | 'resistance'; price: number; touches: number }
export interface ChartDrawings { lines: ChartLine[]; levels: ChartLevel[]; prevDay: { h: number; l: number } | null; asia: { h: number; l: number } | null }
export interface ChartTrade { side: 1 | -1; entryT: number; entry: number; stop: number; target: number | null; strategy: string }

const W = 800;
const PAD_R = 64;

export function MarketChart({ bars, drawings, trades = [], digits = 5, height = 340, show = { lines: true, levels: true, ranges: true, trades: true } }: { bars: number[][]; drawings?: ChartDrawings | null; trades?: ChartTrade[]; digits?: number; height?: number; show?: { lines: boolean; levels: boolean; ranges: boolean; trades: boolean } }) {
  if (bars.length < 2) return <div className="grid h-40 place-items-center text-sm text-muted">No candles yet.</div>;
  const H = height;
  const t0 = bars[0]![0]!;
  const t1 = bars[bars.length - 1]![0]!;
  const step = (t1 - t0) / (bars.length - 1);
  let lo = Math.min(...bars.map((b) => b[3]!));
  let hi = Math.max(...bars.map((b) => b[4]!), ...bars.map((b) => b[2]!));
  const near = (p: number) => p > lo - (hi - lo) * 0.4 && p < hi + (hi - lo) * 0.4;
  const extra: number[] = [];
  if (show.trades) for (const t of trades) extra.push(t.entry, t.stop, ...(t.target !== null ? [t.target] : []));
  for (const p of extra) if (near(p)) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const pad = (hi - lo) * 0.06 || 0.0001;
  lo -= pad;
  hi += pad;
  const cw = W - PAD_R;
  const x = (t: number) => ((t - t0) / (t1 - t0 + step)) * cw + (cw / bars.length) / 2;
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const bw = Math.max(1, (cw / bars.length) * 0.65);
  const last = bars[bars.length - 1]![4]!;
  const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 5);
  const clipY = (p: number) => Math.max(-2, Math.min(H + 2, y(p)));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none" role="img" aria-label="Price chart with the bot's lines and trades">
      {ticks.map((p) => (
        <g key={p}>
          <line x1={0} x2={cw} y1={y(p)} y2={y(p)} className="stroke-line" strokeWidth={1} />
          <text x={W - 4} y={y(p) + 4} textAnchor="end" className="fill-muted text-[11px]">{p.toFixed(digits)}</text>
        </g>
      ))}
      {show.ranges && drawings?.prevDay && (
        <g>
          {[drawings.prevDay.h, drawings.prevDay.l].filter(near).map((p, k) => (
            <line key={k} x1={0} x2={cw} y1={y(p)} y2={y(p)} stroke="#a78bfa" strokeWidth={1} strokeDasharray="2 4" opacity={0.8} />
          ))}
        </g>
      )}
      {show.ranges && drawings?.asia && (
        <rect x={0} width={cw} y={y(drawings.asia.h)} height={Math.max(1, y(drawings.asia.l) - y(drawings.asia.h))} fill="#38bdf8" opacity={0.07} />
      )}
      {show.levels && drawings?.levels.filter((l) => near(l.price)).map((l, k) => (
        <g key={k}>
          <line x1={0} x2={cw} y1={y(l.price)} y2={y(l.price)} stroke={l.kind === 'support' ? '#22c55e' : '#ef4444'} strokeWidth={1 + Math.min(2, l.touches / 3)} strokeDasharray="8 5" opacity={0.55} />
        </g>
      ))}
      {bars.map((b) => {
        const up = b[4]! >= b[1]!;
        const cx = x(b[0]!);
        return (
          <g key={b[0]}>
            <line x1={cx} x2={cx} y1={y(b[2]!)} y2={y(b[3]!)} stroke={up ? '#16a34a' : '#dc2626'} strokeWidth={1} />
            <rect x={cx - bw / 2} width={bw} y={y(Math.max(b[1]!, b[4]!))} height={Math.max(1, Math.abs(y(b[1]!) - y(b[4]!)))} fill={up ? '#16a34a' : '#dc2626'} />
          </g>
        );
      })}
      {show.lines && drawings?.lines.map((l, k) => {
        // extend the line from its first point to the last bar
        const slope = (l.p2 - l.p1) / (l.t2 - l.t1);
        const xa = Math.max(t0, l.t1);
        const pa = l.p1 + slope * (xa - l.t1);
        return <line key={k} x1={x(xa)} y1={clipY(pa)} x2={x(t1)} y2={clipY(l.pNow)} stroke={l.kind === 'support' ? '#22c55e' : '#ef4444'} strokeWidth={2} strokeDasharray={l.broken ? '6 4' : undefined} />;
      })}
      {show.trades && trades.map((t, k) => {
        const xa = Math.max(0, x(Math.max(t0, t.entryT)));
        return (
          <g key={k}>
            <line x1={xa} x2={cw} y1={clipY(t.entry)} y2={clipY(t.entry)} stroke="#6366f1" strokeWidth={1.5} />
            <line x1={xa} x2={cw} y1={clipY(t.stop)} y2={clipY(t.stop)} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
            {t.target !== null && <line x1={xa} x2={cw} y1={clipY(t.target)} y2={clipY(t.target)} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" />}
            <path d={t.side === 1 ? `M${xa} ${clipY(t.entry) + 12} l-6 8 h12 z` : `M${xa} ${clipY(t.entry) - 12} l-6 -8 h12 z`} fill={t.side === 1 ? '#16a34a' : '#dc2626'} />
          </g>
        );
      })}
      <line x1={0} x2={cw} y1={y(last)} y2={y(last)} stroke="#6366f1" strokeWidth={1} strokeDasharray="1 3" />
      <rect x={cw + 2} y={y(last) - 9} width={PAD_R - 4} height={18} rx={4} fill="#6366f1" />
      <text x={W - 6} y={y(last) + 4} textAnchor="end" className="fill-white text-[11px] font-semibold">{last.toFixed(digits)}</text>
    </svg>
  );
}
