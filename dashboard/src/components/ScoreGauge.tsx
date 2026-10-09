/** Score 0-100 as a number plus a meter bar (same-hue track). */
export function ScoreGauge({ score, threshold = 70, size = 'sm' }: { score: number | null | undefined; threshold?: number; size?: 'sm' | 'lg' }) {
  if (score === null || score === undefined) return <span className="text-muted">—</span>;
  const w = Math.max(0, Math.min(100, score));
  return (
    <div className={size === 'lg' ? 'w-full' : 'w-24'} title={`Score ${score.toFixed(1)} (buy threshold ${threshold})`}>
      <div className={`tabular font-semibold text-ink ${size === 'lg' ? 'text-3xl' : 'text-sm'}`}>
        {score.toFixed(size === 'lg' ? 1 : 0)}
        <span className="text-muted font-normal">/100</span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-[color-mix(in_srgb,var(--series-1)_18%,transparent)]" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Score">
        <div className="h-1.5 rounded-full bg-[var(--series-1)]" style={{ width: `${w}%` }} />
        <div className="absolute top-[-3px] h-[12px] w-[2px] bg-ink-2" style={{ left: `${threshold}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}
