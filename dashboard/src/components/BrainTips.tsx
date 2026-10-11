/**
 * Brain page: "Talk to the brain" — the owner writes tips like talking to it; the AI coach turns each one into live
 * rules and/or setting changes and answers what it did.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Card } from './ui';

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
      setMsg({ ok: true, text: r.review.ran ? '✓ Done — see its answer below.' : `Saved. ${r.review.why}` });
      void reload();
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/api/brain/tips/${id}`, { method: 'DELETE' }).catch(() => undefined);
    void reload();
  }

  return (
    <Card title="Talk to the brain">
      <p className="mb-2 text-xs text-muted">Write a tip like you're talking to it ("stop buying migrated coins under $40k", "avoid coins where the dev still holds a lot"). It turns it into rules and settings right away and tells you what it did. Remove a tip to undo its rules.</p>
      {data && !data.hasKey && <p className="mb-2 text-sm text-down">No ANTHROPIC_API_KEY on the server — tips are saved but can't be worked in.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex flex-col gap-2"
      >
        <textarea
          aria-label="Your tip"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="e.g. only buy migrated coins with at least 300 holders and $40k liquidity"
          className="w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink"
        />
        <button type="submit" disabled={busy || text.trim().length < 3} className="self-start rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Thinking…' : 'Send to the brain'}
        </button>
      </form>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <div className="mt-4 space-y-3">
        {(data?.tips ?? []).map((t) => (
          <div key={t.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 break-words text-sm font-medium text-ink">“{t.text}”</p>
              <button type="button" onClick={() => void remove(t.id)} className="shrink-0 text-xs text-muted hover:text-down">
                Remove
              </button>
            </div>
            <div className="mt-1 text-xs text-muted">{ago(t.at)}{t.status === 'new' ? ' · working on it…' : ''}</div>
            {t.response && <p className="mt-2 text-sm text-ink-2">{t.response}</p>}
            {[...t.settings, ...t.rules].length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                {t.settings.map((x) => (
                  <li key={`s${x}`}>⚙ {x}</li>
                ))}
                {t.rules.map((x) => (
                  <li key={`r${x}`}>📏 {x}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {data && !data.tips.length && <p className="text-sm text-muted">No tips yet.</p>}
      </div>
    </Card>
  );
}
