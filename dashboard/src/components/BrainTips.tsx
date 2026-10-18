/**
 * Brain page: "Talk to the brain" — the owner writes tips like talking to it; the AI coach turns each one into live
 * rules and/or setting changes and answers what it did.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card } from './ui';

interface Tip {
  id: string;
  at: string;
  text: string;
  status: 'new' | 'done';
  response: string | null;
  rules: string[];
  settings: string[];
  answeredAt: string | null;
}

export function BrainTips() {
  const { data, error, reload } = useApi<{ tips: Tip[]; hasKey: boolean; lastError: string | null }>('/api/brain/tips', 20_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    if (text.trim().length < 3) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ review: { ran: boolean; why: string } }>('/api/brain/tips', { method: 'POST', body: JSON.stringify({ text }) });
      setText('');
      setMsg({ ok: true, text: r.review.ran ? 'Done. Its answer is below.' : `Saved. ${r.review.why}` });
      void reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/api/brain/tips/${id}`, { method: 'DELETE' }).catch(() => undefined);
    void reload();
  }

  return (
    <Card title="Talk to the brain" subtitle="Write a tip like you're talking to it. It turns it into rules and settings right away and says what it did. Remove a tip to undo its rules.">
      {data && !data.hasKey && <p className="mb-3 rounded-xl bg-critical/10 px-3 py-2 text-sm text-down">No ANTHROPIC_API_KEY on the server: tips are saved but can't be worked in.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="rounded-2xl border border-line-strong bg-surface p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30"
      >
        <textarea
          aria-label="Your tip"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
          rows={3}
          maxLength={1000}
          placeholder="e.g. only buy migrated coins with at least 300 holders and $40k liquidity"
          className="w-full min-w-0 resize-none bg-transparent px-2 py-1.5 text-base text-ink outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="tabular text-xs text-muted">{text.length}/1000</span>
          <Button type="submit" size="sm" disabled={busy || text.trim().length < 3}>
            {busy ? 'Thinking…' : 'Send'}
          </Button>
        </div>
      </form>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <ol className="mt-5 flex flex-col gap-4">
        {(data?.tips ?? []).map((t) => (
          <li key={t.id} className="flex flex-col gap-2">
            <div className="ml-auto max-w-[92%] rounded-2xl rounded-br-md bg-accent/12 px-3.5 py-2.5">
              <p className="break-words text-sm text-ink">{t.text}</p>
              <div className="mt-1 flex items-center justify-end gap-3 text-xs text-muted">
                <span>{ago(t.at)}</span>
                <button type="button" onClick={() => void remove(t.id)} className="min-h-6 font-medium hover:text-down">Remove</button>
              </div>
            </div>
            <div className="mr-auto max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-surface-2/60 px-3.5 py-2.5">
              {t.status === 'new' && !t.response ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" /> Working on it…
                </p>
              ) : (
                <p className="break-words text-sm text-ink-2">{t.response ?? 'Saved.'}</p>
              )}
              {[...t.settings, ...t.rules].length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-ink-2">
                  {t.settings.map((x) => (
                    <li key={`s${x}`} className="flex gap-2"><Badge>setting</Badge><span className="min-w-0 break-words">{x}</span></li>
                  ))}
                  {t.rules.map((x) => (
                    <li key={`r${x}`} className="flex gap-2"><Badge tone="accent">rule</Badge><span className="min-w-0 break-words">{x}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
        {data && !data.tips.length && <p className="text-sm text-muted">No tips yet.</p>}
      </ol>
    </Card>
  );
}
