/**
 * Live market-cap chart for one position.
 *
 * - Loads the recorded history once from /api/positions/:id/chart.
 * - Then appends a new point every time the bot pushes a 'positions' event
 *   over the WebSocket (~every 2s), so the line moves in real time.
 * - Y axis is market cap in SOL (friendlier than tiny token prices).
 * - Dashed lines: our entry, each take-profit level (✓ when already hit),
 *   the stop loss and the trailing stop when it is active.
 *
 * Same chart rules as Charts.tsx: thin 2px line, one y-axis, recessive grid,
 * colours read via useThemeColors (Recharts can't read CSS variables).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useThemeColors } from '../hooks/useThemeColors';
import { useBotEvents, type BotEvent } from '../hooks/useWebSocket';
import type { LivePosition } from '../hooks/useLivePositions';
import { api } from '../lib/api';
import { mcSol, usd } from '../lib/format';
import type { LivePositionUpdate, PositionChartData } from '../lib/types';
import { ChartTable, TooltipBox } from './Charts';

type Point = { t: number; priceSol: number; marketCapSol: number };

/** Keep the chart light: when it gets long, thin out the older half. */
const MAX_POINTS = 3000;
function cap(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const half = Math.floor(points.length / 2);
  return [...points.slice(0, half).filter((_, i) => i % 2 === 0), ...points.slice(half)];
}

const RANGES: Array<[string, number]> = [
  ['All', 0],
  ['30m', 30 * 60_000],
  ['5m', 5 * 60_000],
];

export function PositionChart({ position, height = 180 }: { position: LivePosition; height?: number }) {
  const c = useThemeColors();
  const supply = position.totalSupplyTokens || 1_000_000_000;
  const entryMc = position.entryMarketCapSol || position.entryPriceSol * supply;
  const [points, setPoints] = useState<Point[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'missing'>('loading');
  const [range, setRange] = useState(0);

  // 1) Recorded history (once per position).
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    api<PositionChartData>(`/api/positions/${position.id}/chart`)
      .then((d) => {
        if (!alive) return;
        setPoints((live) => {
          // Keep any live points that arrived while the history was loading.
          const last = d.points[d.points.length - 1]?.t ?? 0;
          return cap([...d.points, ...live.filter((p) => p.t > last)]);
        });
        setStatus('ok');
      })
      .catch(() => {
        if (!alive) return;
        // No history yet (or older bot version): start from the entry and build up live.
        setPoints((live) => (live.length ? live : [{ t: new Date(position.openedAt).getTime(), priceSol: position.entryPriceSol, marketCapSol: entryMc }]));
        setStatus('missing');
      });
    return () => {
      alive = false;
    };
    // Only refetch when the position itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.id]);

  // 2) Live points from the WebSocket.
  const onEvent = useCallback(
    (e: BotEvent) => {
      if (e.type !== 'positions') return;
      const u = (e.data as { updates?: LivePositionUpdate[] }).updates?.find((x) => x.id === position.id);
      if (!u || !Number.isFinite(u.priceSol)) return;
      setPoints((prev) => cap([...prev, { t: Date.now(), priceSol: u.priceSol, marketCapSol: u.priceSol * supply }]));
    },
    [position.id, supply],
  );
  useBotEvents(onEvent);

  const data = useMemo(() => {
    if (!range) return points;
    const from = Date.now() - range;
    const recent = points.filter((p) => p.t >= from);
    return recent.length >= 2 ? recent : points.slice(-2);
  }, [points, range]);

  // Levels drawn as reference lines (taken from the live position so ✓ updates).
  const tps = position.targets.takeProfits.map((tp) => ({ ...tp, mc: entryMc * tp.multiple }));
  const stopMc = position.targets.stopLossPrice * supply;
  const trailMc = position.targets.trailingStopPrice ? position.targets.trailingStopPrice * supply : null;

  // Y range: the data + entry + stop, plus the next take-profit not yet hit, so it's visible.
  // Further-away levels are left off-screen rather than squashing the line flat.
  const values = data.map((p) => p.marketCapSol);
  const nextTp = tps.find((t) => !t.hit);
  let lo = Math.min(...values, entryMc, stopMc > 0 ? stopMc : entryMc);
  let hi = Math.max(...values, entryMc, nextTp ? Math.min(nextTp.mc, Math.max(...values, entryMc) * 2.5) : entryMc);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = entryMc * 0.8;
    hi = entryMc * 1.2;
  }
  const pad = (hi - lo) * 0.08 || entryMc * 0.05;
  const domain: [number, number] = [Math.max(0, lo - pad), hi + pad];

  const t0 = data[0]?.t ?? Date.now();
  const t1 = data[data.length - 1]?.t ?? t0;
  const ticks = t1 > t0 ? Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * i) / 3) : [t0];
  const fmtTick = (v: number) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const solUsd = position.solUsd;
  const lastMc = data[data.length - 1]?.marketCapSol;

  const label = (value: string, fill: string, pos: 'insideTopLeft' | 'insideBottomLeft' | 'insideTopRight' = 'insideTopLeft') => ({ value, position: pos, fill, fontSize: 11 });

  // Levels close together (e.g. entry vs stop, or several hit take-profits squashed at the bottom on a
  // 40× runner) would print their labels on top of each other. Keep the line, but only label a level
  // when it is at least ~13px from every label already placed, most important first.
  const plotH = Math.max(1, height - 36);
  const toPx = (v: number) => ((v - domain[0]) / (domain[1] - domain[0] || 1)) * plotH;
  const placed: number[] = [];
  const showLabel = (v: number | null): boolean => {
    if (v === null || v < domain[0] || v > domain[1]) return false;
    const px = toPx(v);
    if (placed.some((q) => Math.abs(q - px) < 13)) return false;
    placed.push(px);
    return true;
  };
  const labelled = {
    trail: showLabel(trailMc),
    entry: showLabel(entryMc),
    stop: stopMc > 0 && showLabel(stopMc),
    tps: [...tps].sort((a, b) => Number(a.hit) - Number(b.hit)).filter((tp) => showLabel(tp.mc)).map((tp) => tp.multiple),
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">Market cap (SOL){status === 'missing' ? ' · building live' : ''}</span>
        <div className="flex gap-1" role="group" aria-label="Chart range">
          {RANGES.map(([l, ms]) => (
            <button
              key={l}
              type="button"
              onClick={() => setRange(ms)}
              aria-pressed={range === ms}
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${range === ms ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height }} role="img" aria-label={`${position.symbol} market cap chart: bought at ${mcSol(entryMc)}, now ${mcSol(lastMc)}`}>
        {status === 'loading' && !points.length ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">Loading chart…</div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={fmtTick} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.axis }} />
              <YAxis domain={domain} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v >= 100 ? 0 : 1))} width={44} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.axis }} />
              <ReferenceLine y={entryMc} stroke={c['ink-2']} strokeDasharray="4 4" label={labelled.entry ? label('Entry', c['ink-2'], 'insideBottomLeft') : undefined} />
              {tps.map((tp) => (
                <ReferenceLine key={tp.multiple} y={tp.mc} stroke={c.good} strokeOpacity={tp.hit ? 0.9 : 0.55} strokeDasharray={tp.hit ? undefined : '2 4'} label={labelled.tps.includes(tp.multiple) ? label(`${tp.hit ? '✓ ' : ''}TP ${tp.multiple}×`, c.muted, 'insideTopRight') : undefined} />
              ))}
              {stopMc > 0 && <ReferenceLine y={stopMc} stroke={c.critical} strokeOpacity={0.7} strokeDasharray="2 4" label={labelled.stop ? label('Stop', c.muted, 'insideBottomLeft') : undefined} />}
              {trailMc && <ReferenceLine y={trailMc} stroke={c.warning} strokeOpacity={0.8} strokeDasharray="6 3" label={labelled.trail ? label('Trail stop', c.muted, 'insideTopLeft') : undefined} />}
              <Tooltip
                cursor={{ stroke: c['ink-2'], strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as Point | undefined;
                  if (!active || !p) return null;
                  const m = p.marketCapSol / entryMc;
                  return (
                    <TooltipBox
                      title={new Date(p.t).toLocaleTimeString()}
                      rows={[
                        ['Market cap', mcSol(p.marketCapSol)],
                        ['In USD', solUsd ? usd(p.marketCapSol * solUsd) : '—'],
                        ['Multiple', `${m.toFixed(2)}×`],
                      ]}
                    />
                  );
                }}
              />
              <Line type="linear" dataKey="marketCapSol" stroke={c['series-1']} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <ChartTable
        headers={['Time', 'Market cap', 'USD', 'Multiple']}
        rows={data
          .slice(-60)
          .reverse()
          .map((p) => [new Date(p.t).toLocaleTimeString(), mcSol(p.marketCapSol), solUsd ? usd(p.marketCapSol * solUsd) : '—', `${(p.marketCapSol / entryMc).toFixed(2)}×`])}
      />
    </div>
  );
}
