/**
 * Controls → System: Live trading (v11.14). Shows the mode, the bot wallet (first4…last4 only), its balance, the paper
 * dry run of the real transactions and the live caps. "Go live" needs the owner to type the wallet's first 4 characters;
 * the server re-checks every gate (TRADING_MODE=LIVE + WALLET_SECRET in the VPS .env, a sender, the balance) and restarts.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Badge, Button, Card, ErrorBox, inputCls, Loading, Row, Rows, SectionLabel } from './ui';

interface LiveInfo {
  status: { activeMode: 'PAPER' | 'LIVE'; envMode: 'PAPER' | 'LIVE'; wallet: string | null; walletError: string | null; sender: string; senderReady: boolean; enabledAt: string | null; blockers: string[] } | null;
  balanceSol: number | null;
  openLive: number;
  activeMode: 'PAPER' | 'LIVE';
  sim: { n: number; ok: number; funds: number; error: number; okPct: number | null; last: Array<{ t: number; side: string; kind: string | null; cat: string; err: string | null; cu: number | null }> };
  caps: { maxPositionSol: number; maxOpen: number; reserveSol: number; minBalanceSol: number; buySlippageBps: number; sellSlippageBps: number; maxPriorityMicroLamports: number; tipLamports: number; dryRun: { enabled: boolean } };
}

const SENDERS: Record<string, string> = { 'helius-sender': 'Helius Sender', shield: 'FluxRPC shield', rpc: 'normal RPC', none: 'none' };
const KINDS: Record<string, string> = { curve_buy: 'curve buy', curve_sell: 'curve sell', amm_buy: 'PumpSwap buy', amm_sell: 'PumpSwap sell' };

export function LiveTrading() {
  const q = useApi<LiveInfo>('/api/controls/live', 30_000);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = q.data;
  const live = d?.activeMode === 'LIVE';
  const st = d?.status ?? null;

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; restarting?: boolean }>('/api/controls/live', { method: 'PUT', body: JSON.stringify(body) });
      setMsg({ ok: true, text: r.restarting ? 'Saved — the bot restarts now (about 30 s).' : 'Saved.' });
      setTyped('');
      setTimeout(() => void q.reload(), 2_000);
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className={live ? 'border-critical/60' : undefined}
      title={
        <span className="inline-flex items-center gap-2">
          Live trading <Badge tone={live ? 'down' : 'neutral'}>{live ? 'LIVE — real SOL' : 'paper'}</Badge>
        </span>
      }
      subtitle="Real trades from a dedicated bot wallet. Off until the VPS .env has TRADING_MODE=LIVE and WALLET_SECRET and you confirm here."
    >
      {q.error && <ErrorBox message={q.error} />}
      {!d && !q.error && <Loading kind="rows" />}
      {d && (
        <div className="space-y-5">
          <Rows>
            <Row label="Mode now" value={<span className={live ? 'font-semibold text-down' : ''}>{live ? 'LIVE' : 'PAPER'}</span>} sub={st ? `.env says ${st.envMode}${st.enabledAt ? ` · confirmed ${new Date(st.enabledAt).toLocaleString()}` : ''}` : undefined} />
            <Row label="Bot wallet" value={st?.wallet ?? '—'} sub={st?.wallet ? undefined : st?.walletError ?? 'no WALLET_SECRET in the VPS .env'} tone={st?.wallet ? undefined : 'muted'} />
            <Row label="Wallet balance" value={d.balanceSol !== null ? `${d.balanceSol.toFixed(3)} SOL` : '—'} sub={`needs ${d.caps.minBalanceSol} SOL · keeps ${d.caps.reserveSol} SOL for fees`} tone={d.balanceSol !== null && d.balanceSol < d.caps.minBalanceSol ? 'down' : undefined} />
            <Row label="Sends through" value={SENDERS[st?.sender ?? 'none'] ?? st?.sender ?? '—'} sub={st?.senderReady ? 'ready' : 'not ready'} tone={st?.senderReady ? undefined : 'muted'} />
            <Row label="Live trades open" value={d.openLive} />
          </Rows>

          <div>
            <SectionLabel>Dry run (paper fills → the real transaction, simulated)</SectionLabel>
            <Rows>
              <Row
                label="Simulated"
                value={d.sim.n.toLocaleString()}
                sub={d.caps.dryRun.enabled ? `${d.sim.ok} ok · ${d.sim.funds} stopped at funds (layout fine) · ${d.sim.error} would fail` : 'dry run is off'}
              />
              <Row label="OK" value={d.sim.okPct !== null ? `${d.sim.okPct}%` : '—'} sub="go live only after ≥ 95% for a full day" tone={d.sim.okPct !== null && d.sim.okPct < 95 ? 'down' : d.sim.okPct !== null ? 'up' : undefined} />
            </Rows>
            {d.sim.last.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {d.sim.last.slice(0, 5).map((s) => (
                  <li key={`${s.t}-${s.side}`} className="break-words">
                    <span className="tabular text-ink-2">{new Date(s.t).toLocaleTimeString()}</span> {s.kind ? KINDS[s.kind] ?? s.kind : s.side.toLowerCase()} —{' '}
                    <span className={s.cat === 'error' ? 'text-down' : s.cat === 'ok' ? 'text-up' : ''}>{s.cat}</span>
                    {s.cu ? ` · ${s.cu.toLocaleString()} CU` : ''}
                    {s.err ? ` · ${s.err}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <SectionLabel>Live caps (on top of every normal cap — edit under Rules → Live trading)</SectionLabel>
            <Rows>
              <Row label="Per trade" value={`≤ ${d.caps.maxPositionSol} SOL`} sub={`max ${d.caps.maxOpen} open`} />
              <Row label="Slippage" value={`buy ${d.caps.buySlippageBps / 100}% · sell ${d.caps.sellSlippageBps / 100}%`} sub="the buy never spends more than its size" />
              <Row label="Fees" value={`priority ≤ ${d.caps.maxPriorityMicroLamports.toLocaleString()} µlamports/CU`} sub={`tip ${d.caps.tipLamports / 1e9} SOL (Helius Sender)`} />
              <Row label="Loss limits" value="always on in live" sub="daily loss limit + strategy cool-off; the self-improving loop never runs" />
            </Rows>
          </div>

          {msg && <p className={`text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}

          {live ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-2">Back to paper: sell every live trade first (Trading → Sell all &amp; stop), then switch.</p>
              <Button variant="outline" disabled={busy} onClick={() => void send({ action: 'paper' })}>
                Back to paper
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {st && st.blockers.length > 0 && (
                <div>
                  <SectionLabel>Not ready yet</SectionLabel>
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
                    {st.blockers.filter((b) => !/not confirmed on Controls/.test(b)).map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="grid gap-1.5 text-sm">
                <span className="text-ink-2">Type the bot wallet's first 4 characters to go live</span>
                <input
                  className={`${inputCls} w-32 font-mono`}
                  value={typed}
                  maxLength={4}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label="First 4 characters of the bot wallet"
                />
              </label>
              <Button variant="danger" disabled={busy || typed.trim().length !== 4 || !st?.wallet} onClick={() => void send({ action: 'live', confirm: typed.trim() })}>
                Go live with real SOL
              </Button>
              {st?.enabledAt && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send({ action: 'paper' })}>
                  Remove the live confirmation
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
