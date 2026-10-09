/**
 * Chart components (Recharts), following one set of rules:
 * thin marks, recessive grid, one y-axis, hover tooltip on everything,
 * gains/losses as a blue↔red diverging pair (plus +/− signs in text), and a
 * "view as table" fallback under every chart.
 */
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useThemeColors, type ThemeColors } from '../hooks/useThemeColors';

const axisProps = (c: ThemeColors) => ({
  stroke: c.axis,
  tick: { fill: c.muted, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: c.axis },
});

export function TooltipBox({ title, rows }: { title: string; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
      <div className="mb-1 font-semibold text-ink">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 text-ink-2">
          <span>{k}</span>
          <span className="tabular text-ink">{v}</span>
        </div>
      ))}
    </div>
  );
}

const signed = (v: number, dp = 3) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}`;

export function ChartTable({ headers, rows }: { headers: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-ink-2 hover:text-ink">View as table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="w-full tabular">
          <thead>
            <tr className="text-left text-ink-2">
              {headers.map((h) => (
                <th key={h} className="py-1 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className="py-1 pr-4 text-ink">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Cumulative P&L over time — the main chart. Single series, so no legend. */
export function PnlChart({ points, height = 280 }: { points: Array<{ t: string; pnl: number; symbol?: string }>; height?: number }) {
  const c = useThemeColors();
  const data = [{ t: points[0]?.t ?? new Date().toISOString(), pnl: 0, symbol: 'start' }, ...points].map((p) => ({ ...p, ts: new Date(p.t).getTime() }));
  // Five evenly spaced time ticks; show clock time when the range is short.
  const t0 = data[0]?.ts ?? Date.now();
  const t1 = data[data.length - 1]?.ts ?? t0;
  const ticks = t1 > t0 ? Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4) : [t0];
  const short = t1 - t0 < 2 * 86_400_000;
  const fmtTick = (v: number) => (short ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  return (
    <>
      <div style={{ height }} role="img" aria-label={`Cumulative profit and loss, now ${signed(points[points.length - 1]?.pnl ?? 0)} SOL`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" ticks={ticks} tickFormatter={fmtTick} {...axisProps(c)} />
            <YAxis tickFormatter={(v: number) => signed(v, 2)} width={56} {...axisProps(c)} />
            <ReferenceLine y={0} stroke={c.axis} />
            <Tooltip
              cursor={{ stroke: c['ink-2'], strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                if (!active || !p) return null;
                return <TooltipBox title={new Date(p.ts).toLocaleString()} rows={[['Total P&L', `${signed(p.pnl)} SOL`], ['Closed trade', p.symbol ?? '']]} />;
              }}
            />
            <Line type="monotone" dataKey="pnl" stroke={c['series-1']} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={['Closed at', 'Trade', 'Total P&L (SOL)']} rows={points.slice(-200).reverse().map((p) => [new Date(p.t).toLocaleString(), p.symbol ?? '', signed(p.pnl)])} />
    </>
  );
}

/** Bars that can be positive or negative (daily returns, P&L by strategy). */
export function SignedBars({ data, labelKey, valueKey = 'pnl', valueLabel = 'P&L', unit = 'SOL', height = 220 }: { data: Array<Record<string, unknown>>; labelKey: string; valueKey?: string; valueLabel?: string; unit?: string; height?: number }) {
  const c = useThemeColors();
  return (
    <>
      <div style={{ height }} role="img" aria-label={`${valueLabel} bar chart`}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey={labelKey} {...axisProps(c)} minTickGap={16} />
            <YAxis tickFormatter={(v: number) => signed(v, 2)} width={56} {...axisProps(c)} />
            <ReferenceLine y={0} stroke={c.axis} />
            <Tooltip
              cursor={{ fill: c.grid, opacity: 0.5 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as Record<string, unknown> | undefined;
                if (!active || !p) return null;
                const extra: Array<[string, ReactNode]> = typeof p.trades === 'number' ? [['Trades', String(p.trades)]] : [];
                return <TooltipBox title={String(p[labelKey])} rows={[[valueLabel, `${signed(Number(p[valueKey]))} ${unit}`], ...extra]} />;
              }}
            />
            <Bar dataKey={valueKey} maxBarSize={36} isAnimationActive={false}>
              {data.map((d, i) => {
                const v = Number(d[valueKey]);
                return <Cell key={i} fill={v >= 0 ? c.pos : c.neg} radius={(v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]) as unknown as number} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={[labelKey === 'day' ? 'Day' : 'Group', `${valueLabel} (${unit})`]} rows={data.map((d) => [String(d[labelKey]), signed(Number(d[valueKey]))])} />
    </>
  );
}

/** Plain magnitude bars in one hue (counts, histograms). */
export function CountBars({ data, labelKey, valueKey = 'count', valueLabel = 'Count', height = 220, tickFormatter }: { data: Array<Record<string, unknown>>; labelKey: string; valueKey?: string; valueLabel?: string; height?: number; tickFormatter?: (v: string) => string }) {
  const c = useThemeColors();
  return (
    <>
      <div style={{ height }} role="img" aria-label={`${valueLabel} bar chart`}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey={labelKey} {...axisProps(c)} tickFormatter={tickFormatter} minTickGap={12} />
            <YAxis width={44} allowDecimals={false} {...axisProps(c)} />
            <Tooltip
              cursor={{ fill: c.grid, opacity: 0.5 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as Record<string, unknown> | undefined;
                if (!active || !p) return null;
                const label = tickFormatter ? tickFormatter(String(p[labelKey])) : String(p[labelKey]);
                return <TooltipBox title={label} rows={[[valueLabel, String(p[valueKey])]]} />;
              }}
            />
            <Bar dataKey={valueKey} fill={c['series-1']} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartTable headers={['Group', valueLabel]} rows={data.map((d) => [tickFormatter ? tickFormatter(String(d[labelKey])) : String(d[labelKey]), String(d[valueKey])])} />
    </>
  );
}
