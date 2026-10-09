/** Full evaluation breakdown for one token. */
import { Link, useParams } from 'react-router-dom';
import { ScoreGauge } from '../components/ScoreGauge';
import { SocialLinks } from '../components/SocialLinks';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pnl } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { ago, EXIT_LABEL, num, pct, shortAddr, sol } from '../lib/format';

interface Detail {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: string;
  status: string;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  metadataFetchedAt: string | null;
  safetyChecks: Array<{ score: number; hardFail: boolean; checks: Array<{ id: string; label: string; severity: 'PASS' | 'WARN' | 'FAIL'; detail: string }> }>;
  evaluations: Array<{ id: string; createdAt: string; combinedScore: number; decision: string; reasons: string[]; features: { checkpointSec?: number; contributions?: Record<string, number>; features?: Record<string, number> } }>;
  snapshots: Array<{ interval: string; holderCount: number; marketCapSol: number; bondingCurvePct: number; volumeSol: number; devHoldingPct: number; top10HolderPct: number }>;
  positions: Array<{ id: string; status: string; sizeSol: number; realizedPnlSol: number; exitReason: string | null; entryPriceSol: number; peakPriceSol: number; trades: Array<{ id: string; side: string; amountSol: number; reason: string; createdAt: string }> }>;
  live: { holderCount: number; marketCapSol: number; bondingCurvePct: number; volumeSol: number; devHoldingPct: number; top10HolderPct: number; earlyBuyerPct: number; buySellRatio: number } | null;
}

const FEATURE_LABEL: Record<string, string> = {
  safety: 'Safety', holders: 'Holders', buyPressure: 'Buy pressure', volume: 'Volume', curveVelocity: 'Curve speed', distribution: 'Distribution',
  devHolding: 'Dev holding', devBehavior: 'Dev not selling', snipers: 'Few snipers', retention: 'Holder retention', creatorLaunches: 'Dev not a serial launcher',
  creatorSuccess: "Dev's past success", funderReuse: 'Funding source', walletAge: 'Dev wallet age', socials: 'Socials (X / TG / site)', narrative: 'Keywords',
};

export function TokenDetail() {
  const { mint = '' } = useParams();
  const { data: d, error, loading } = useApi<Detail>(`/api/detections/${mint}`, 10_000, ['safety', 'evaluation', 'trade']);
  if (loading && !d) return <Loading />;
  if (error && !d) return <ErrorBox message={error} />;
  if (!d) return null;

  const safety = d.safetyChecks[0];
  const evaluation = d.evaluations[0];
  const contributions = Object.entries(evaluation?.features?.contributions ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <Link to="/feed" className="mb-3 inline-block text-sm text-accent hover:underline">
        ← Live feed
      </Link>
      <PageHeader
        title={`${d.symbol} · ${d.name}`}
        subtitle={`Launched ${ago(d.createdAt)} · status ${d.status.toLowerCase()}`}
        action={
          <div className="flex gap-2 text-sm">
            <a className="rounded-lg border border-line bg-surface px-3 py-2 hover:bg-surface-2" href={`https://pump.fun/coin/${d.mint}`} target="_blank" rel="noreferrer">
              Pump.fun ↗
            </a>
            <a className="rounded-lg border border-line bg-surface px-3 py-2 hover:bg-surface-2" href={`https://solscan.io/token/${d.mint}`} target="_blank" rel="noreferrer">
              Solscan ↗
            </a>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {d.metadataFetchedAt ? <SocialLinks twitter={d.twitter} telegram={d.telegram} website={d.website} size="md" /> : <span className="text-sm text-muted">Socials not checked yet (checked once it reaches 10 holders)</span>}
      </div>
      {d.description && <p className="mb-3 max-w-3xl text-ink-2">“{d.description}”</p>}
      <p className="mb-4 break-all text-sm text-ink-2">
        Mint <code className="text-ink">{d.mint}</code> · Dev <a className="underline" href={`https://solscan.io/account/${d.creator}`} target="_blank" rel="noreferrer">{shortAddr(d.creator)}</a>
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Score">
          {evaluation ? (
            <>
              <ScoreGauge score={evaluation.combinedScore} size="lg" />
              <div className="mt-3 font-semibold text-ink">
                Decision: {evaluation.decision === 'BUY' ? '✓ Buy' : evaluation.decision === 'REJECT' ? '✕ Reject' : '– Skip'}
                {evaluation.features?.checkpointSec !== undefined && <span className="font-normal text-muted"> at {evaluation.features.checkpointSec}s</span>}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
                {evaluation.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          ) : (
            <Empty>Not scored (didn't reach a checkpoint or scored under 60).</Empty>
          )}
        </Card>

        <Card title="Live numbers">
          {d.live ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Market cap', sol(d.live.marketCapSol, 1)],
                ['Holders', num(d.live.holderCount)],
                ['Curve', pct(d.live.bondingCurvePct)],
                ['Volume', sol(d.live.volumeSol, 1)],
                ['Dev holds', pct(d.live.devHoldingPct)],
                ['Top 10 hold', pct(d.live.top10HolderPct)],
                ['Snipers hold', pct(d.live.earlyBuyerPct)],
                ['Buys per sell', d.live.buySellRatio.toFixed(1)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="tabular text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>No live data (token older than 24h).</Empty>
          )}
        </Card>

        <Card title={`Safety ${safety ? (safety.hardFail ? '— FAIL' : `— ${safety.score}/100`) : ''}`}>
          {safety ? (
            <ul className="space-y-1.5 text-sm">
              {safety.checks.map((c) => (
                <li key={c.id} className="flex gap-2">
                  <span aria-label={c.severity} className={c.severity === 'PASS' ? 'text-up' : c.severity === 'WARN' ? 'text-warning' : 'text-down'}>
                    {c.severity === 'PASS' ? '✓' : c.severity === 'WARN' ? '!' : '✕'}
                  </span>
                  <span className="text-ink">
                    {c.label}
                    {c.severity !== 'PASS' && <span className="block text-ink-2">{c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Safety check pending.</Empty>
          )}
        </Card>
      </div>

      {contributions.length > 0 && (
        <Card title="What made up the score" className="mt-4">
          <ul className="space-y-2">
            {contributions.map(([k, v]) => {
              const f = evaluation?.features?.features?.[k] ?? 0;
              return (
                <li key={k} className="grid grid-cols-[10rem_1fr_3.5rem] items-center gap-3 text-sm">
                  <span className="text-ink-2">{FEATURE_LABEL[k] ?? k}</span>
                  <span className="h-2 rounded-full bg-[color-mix(in_srgb,var(--series-1)_15%,transparent)]">
                    <span className="block h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${Math.round(f * 100)}%` }} />
                  </span>
                  <span className="tabular text-right text-ink">+{v.toFixed(1)}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-muted">Bar = how good this signal looked (0-100%). Number = points it added to the score.</p>
        </Card>
      )}

      {d.positions.length > 0 && (
        <Card title="Bot trades on this token" className="mt-4">
          {d.positions.map((p) => (
            <div key={p.id} className="text-sm">
              <div className="mb-2 text-ink">
                {sol(p.sizeSol, 2)} position · {p.status.toLowerCase()} {p.exitReason ? `(${EXIT_LABEL[p.exitReason] ?? p.exitReason})` : ''} · result <Pnl value={p.realizedPnlSol} /> · max profit{' '}
                <span className="text-up">{pct((p.peakPriceSol / p.entryPriceSol - 1) * 100, 0, true)}</span> ({(p.peakPriceSol / p.entryPriceSol).toFixed(2)}×)
              </div>
              <ul className="space-y-1 text-ink-2">
                {p.trades.map((t) => (
                  <li key={t.id}>
                    {new Date(t.createdAt).toLocaleTimeString()} — {t.side} {sol(t.amountSol, 4)} · {t.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}

      {d.snapshots.length > 0 && (
        <Card title="Snapshots" className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm tabular">
              <thead>
                <tr className="text-left text-ink-2">
                  {['Age', 'Holders', 'Market cap', 'Curve', 'Volume', 'Dev', 'Top 10'].map((h) => (
                    <th key={h} className="pb-2 pr-4 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.snapshots.map((s) => (
                  <tr key={s.interval} className="border-t border-line text-ink">
                    <td className="py-1.5 pr-4">{s.interval === 'CREATION' ? 'Launch' : s.interval.replace('M', '').replace('H', '') + (s.interval.startsWith('M') ? 'm' : 'h')}</td>
                    <td className="pr-4">{num(s.holderCount)}</td>
                    <td className="pr-4">{sol(s.marketCapSol, 1)}</td>
                    <td className="pr-4">{pct(s.bondingCurvePct)}</td>
                    <td className="pr-4">{sol(s.volumeSol, 1)}</td>
                    <td className="pr-4">{pct(s.devHoldingPct)}</td>
                    <td className="pr-4">{pct(s.top10HolderPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
