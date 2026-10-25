/**
 * v27.45 (owner: "how much it went red before it made profit, how long, how low before it bounced — and instead of a flat
 * $20, could it be $25 or $15, a smarter stop based on trade performance — and chart it"). Reads `/api/<desk>/excursion`.
 */
import { Badge, Card, Row, Rows } from './ui';
import { useApi } from '../hooks/useApi';
import { useWidth } from '../hooks/useWidth';
import { apiBase } from '../lib/ws';

interface Ex { id: string; pair: string; key: string; side: 1 | -1; closedAt: number; usd: number; win: boolean; maeUsd: number; maeR: number | null; mfeUsd: number; minsToMae: number; minsBackToEven: number | null; capped: boolean; after: { kind: 'target' | 'stop' | 'open'; usd: number; hours: number } | null }
interface CapRow { cap: number; n: number; usd: number; wins: number; losses: number; avg: number }
export interface ExcursionReport {
  at: number;
  n: number;
  currentCap: number;
  winners: { n: number; dipped: number; dippedPct: number; maeAvg: number; maeMedian: number; maeP75: number; maeP90: number; minsToMaeAvg: number; minsBackToEvenAvg: number | null; over: Record<string, number> };
  losers: { n: number; maeAvg: number; maeMedian: number };
  capped: { n: number; laterTarget: number; laterStop: number; stillOpen: number; missedUsd: number };
  caps: CapRow[];
  best: { cap: number; usd: number; vsCurrentUsd: number } | null;
  byKey: Array<{ key: string; n: number; winMaeP75: number | null; best: number | null; suggested: number }>;
  suggest: { active: boolean; def: number; byKey: Record<string, number> };
  trades: Ex[];
}

const money = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);

function Scatter({ trades, cap, suggested }: { trades: Ex[]; cap: number; suggested: number | null }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const W = Math.max(280, w);
  const H = 220;
  const pad = { l: 44, r: 10, t: 10, b: 30 };
  const xs = trades.map((t) => t.maeUsd);
  const ys = trades.map((t) => t.usd);
  const xMax = Math.max(cap * 1.6, 30, ...xs.map((x) => Math.min(x, cap * 4)));
  const yMax = Math.max(10, ...ys);
  const yMin = Math.min(-10, ...ys);
  const X = (v: number) => pad.l + (Math.min(v, xMax) / xMax) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + ((yMax - v) / (yMax - yMin)) * (H - pad.t - pad.b);
  const xTicks = [0, cap / 2, cap, cap * 1.5, cap * 2, cap * 3].filter((v) => v <= xMax);
  return (
    <div ref={ref} className="w-full">
      <svg width={W} height={H} role="img" aria-label="Each trade: how far it went red (across) against what it finally made (up)">
        <line x1={pad.l} x2={W - pad.r} y1={Y(0)} y2={Y(0)} stroke="var(--axis)" />
        {xTicks.map((v) => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={pad.t} y2={H - pad.b} stroke="var(--grid)" />
            <text x={X(v)} y={H - 12} fontSize={10} textAnchor="middle" fill="var(--muted)">${v}</text>
          </g>
        ))}
        {[yMax, 0, yMin].map((v) => (
          <text key={v} x={pad.l - 6} y={Y(v) + 3} fontSize={10} textAnchor="end" fill="var(--muted)">{money(v).replace('.00', '')}</text>
        ))}
        <line x1={X(cap)} x2={X(cap)} y1={pad.t} y2={H - pad.b} stroke="var(--muted)" strokeDasharray="4 3" />
        {suggested !== null && suggested !== cap && <line x1={X(suggested)} x2={X(suggested)} y1={pad.t} y2={H - pad.b} stroke="var(--accent)" strokeWidth={2} />}
        {trades.map((t) => (
          <circle key={t.id} cx={X(t.maeUsd)} cy={Y(t.usd)} r={4} fill={t.capped ? 'none' : t.win ? 'var(--pos)' : 'var(--neg)'} stroke={t.win ? 'var(--pos)' : 'var(--neg)'} strokeWidth={t.capped ? 1.5 : 0} opacity={0.8}>
            <title>{`${t.pair} ${t.key}: went ${money(-t.maeUsd)} red, ended ${money(t.usd)}${t.capped ? ' (closed by the loss cap)' : ''}`}</title>
          </circle>
        ))}
        <text x={W - pad.r} y={H - 1} fontSize={10} textAnchor="end" fill="var(--muted)">how far it went red →</text>
      </svg>
      <p className="mt-1 text-xs text-muted">Dots: green won, red lost, rings = closed by the loss cap. Dashed line = today's ${cap} cap{suggested !== null && suggested !== cap ? `, solid line = the cap the study points to ($${suggested})` : ''}. A green dot right of the dashed line = a winner the cap would have cut today.</p>
    </div>
  );
}

function CapBars({ caps, current, best }: { caps: CapRow[]; current: number; best: number | null }) {
  const max = Math.max(1, ...caps.map((c) => Math.abs(c.usd)));
  return (
    <div className="space-y-1">
      {caps.map((c) => {
        const pct = (Math.abs(c.usd) / max) * 50;
        return (
          <div key={c.cap} className="flex items-center gap-2 text-xs">
            <span className={`w-12 shrink-0 text-right tabular-nums ${c.cap === current ? 'font-semibold text-ink' : 'text-ink-2'}`}>${c.cap}</span>
            <div className="relative h-3.5 flex-1">
              <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--axis)]" />
              <div
                className="absolute inset-y-0 rounded-sm"
                style={{ left: c.usd >= 0 ? '50%' : `${50 - pct}%`, width: `${pct}%`, background: c.cap === best ? 'var(--accent)' : c.usd >= 0 ? 'var(--pos)' : 'var(--neg)', opacity: c.cap === best ? 1 : 0.55 }}
              />
            </div>
            <span className={`w-16 shrink-0 text-right tabular-nums ${c.usd >= 0 ? 'text-up' : 'text-down'}`}>{money(c.usd)}</span>
          </div>
        );
      })}
      <p className="pt-1 text-xs text-muted">Total the same trades would have made under each loss cap (bold = today's, coloured = the best).</p>
    </div>
  );
}

export function ExcursionCard({ names }: { names?: Record<string, string> }) {
  const { data } = useApi<{ report: ExcursionReport | null }>(`${apiBase()}/excursion`, 120_000);
  const r = data?.report;
  if (!r) return null;
  const w = r.winners;
  const label = (k: string) => {
    const [s, tf] = k.split(':');
    return `${names?.[s ?? ''] ?? s}${tf ? ` (${tf})` : ''}`;
  };
  return (
    <Card title="How far trades go red before they win" subtitle={`Read from the candles of the bot's last ${r.n} closed trades: how deep each one dipped, how long it took to come back, and which loss cap would have made the most.`}>
      {r.n === 0 ? <p className="text-sm text-ink-2">No closed trades to study yet.</p> : (
        <div className="space-y-4">
          <p className="text-sm font-medium text-ink">
            {w.n ? <>Of {w.n} winners, {w.dipped} ({w.dippedPct}%) went at least $5 red first. Typical dip ${w.maeMedian.toFixed(2)}, 3 in 4 stayed within ${w.maeP75.toFixed(2)}, 9 in 10 within ${w.maeP90.toFixed(2)}.</> : 'No winners yet.'}
            {w.dipped > 0 && <> They hit bottom after {mins(w.minsToMaeAvg)} on average and were back to break-even {mins(w.minsBackToEvenAvg)} later.</>}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[10, 15, 20, 25].map((lvl) => (
              <div key={lvl} className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-xs text-muted">Winners that went ${lvl}+ red</div>
                <div className="text-lg font-semibold tabular-nums text-ink">{w.over[String(lvl)] ?? 0}<span className="text-xs font-normal text-muted"> of {w.n}</span></div>
              </div>
            ))}
          </div>
          <Scatter trades={r.trades} cap={r.currentCap} suggested={r.suggest.active ? r.suggest.def : r.best?.cap ?? null} />
          {r.capped.n > 0 && (
            <p className="text-xs text-ink-2">
              The ${r.currentCap} cap closed {r.capped.n} trade{r.capped.n === 1 ? '' : 's'}. Afterwards {r.capped.laterTarget} went on to the target ({money(r.capped.missedUsd)} missed), {r.capped.laterStop} hit the tested stop anyway{r.capped.stillOpen ? `, ${r.capped.stillOpen} never reached either` : ''}.
            </p>
          )}
          <CapBars caps={r.caps} current={r.currentCap} best={r.best?.cap ?? null} />
          <p className="text-sm text-ink">
            {r.suggest.active
              ? <>The bot now opens new trades with a <b>${r.suggest.def}</b> cap by default and its own cap per strategy below{r.best && r.best.cap !== r.currentCap ? ` (the best cap made ${money(r.best.vsCurrentUsd)} more than $${r.currentCap} on these trades)` : ''}.</>
              : <>Still the flat ${r.currentCap} cap: the study switches on at 30 analysed trades (now {r.n}).</>}
          </p>
          {r.byKey.length > 0 && (
            <Rows>
              {r.byKey.slice(0, 12).map((k) => (
                <Row
                  key={k.key}
                  label={<span>{label(k.key)} {r.suggest.active && <Badge tone={k.suggested > r.currentCap ? 'warn' : k.suggested < r.currentCap ? 'up' : 'neutral'}>${k.suggested} cap</Badge>}</span>}
                  sub={`${k.n} trades · winners dipped up to $${k.winMaeP75?.toFixed(2) ?? '—'} (3 in 4)${k.best !== null ? ` · its own best $${k.best}` : ' · too few trades for its own best — uses the overall one'}`}
                  value={null}
                />
              ))}
            </Rows>
          )}
          <p className="text-xs text-muted">Rough edges: a candle doesn't say whether its low or high came first (the low is assumed first), and the replay leaves the profit lock as it was. A cap only moves when a different one changes at least 3 trades for the better; each strategy's cap blends its own best with the overall one, between $10 and $40.</p>
        </div>
      )}
    </Card>
  );
}
