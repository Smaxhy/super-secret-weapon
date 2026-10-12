/**
 * "Notifications": turn on phone notifications for this device (Web Push to the installed app) and choose what
 * to be told about. Default: every trade that closes in profit, with the amount.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Card } from './ui';

interface Settings { profitClose: boolean; minProfitSol: number; lossClose: boolean; takeProfit: boolean }
interface PushInfo { publicKey: string; subscribers: number; settings: Settings }

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function Notifications() {
  const { data, reload } = useApi<PushInfo>('/api/push', 0);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Make sure the SERVER has this phone: re-send the subscription, and make a fresh one if it was made with an
  // old key (otherwise the phone says "on" while nothing ever arrives).
  useEffect(() => {
    if (!supported() || !data) return;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) return setOn(false);
        const key = sub.options?.applicationServerKey;
        const sameKey = !key || new Uint8Array(key).join(',') === toKey(data.publicKey).join(',');
        if (!sameKey) {
          await sub.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(data.publicKey) });
        }
        await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
        setOn(true);
      } catch {
        setOn(false);
      }
    })();
  }, [data?.publicKey]);

  async function enable() {
    if (!data) return;
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications are blocked — allow them for this app in your phone settings.');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(data.publicKey) }));
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      setOn(true);
      setMsg({ ok: true, text: '✓ Notifications are on for this device.' });
      void reload();
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setOn(false);
      setMsg({ ok: true, text: 'Notifications are off for this device.' });
      void reload();
    } finally {
      setBusy(false);
    }
  }
  async function setSetting(patch: Partial<Settings>) {
    await api('/api/push/settings', { method: 'PUT', body: JSON.stringify(patch) });
    void reload();
  }
  async function test() {
    setMsg(null);
    try {
      // Re-send this phone's subscription first, so the test always reaches it.
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      const r = await api<{ sent: number; failed: number; subscribers: number; errors?: string[] }>('/api/push/test', { method: 'POST' });
      if (r.sent) setMsg({ ok: true, text: `✓ Sent to ${r.sent} device${r.sent > 1 ? 's' : ''}. If nothing shows, check the phone's notification settings for this app (and Focus / Do Not Disturb).` });
      else if (!r.subscribers) setMsg({ ok: false, text: '⚠ The server has no device saved — tap "Turn off", then "Turn on notifications" again.' });
      else setMsg({ ok: false, text: `⚠ The push service refused it: ${(r.errors ?? []).join(' · ') || 'unknown error'}. Tap "Turn off", then "Turn on" again.` });
      void reload();
    } catch (err) {
      setMsg({ ok: false, text: `⚠ ${(err as Error).message}` });
    }
  }

  const s = data?.settings;
  return (
    <Card title="Notifications">
      <div className="space-y-3 text-sm">
        {!supported() ? (
          <p className="text-ink-2">{isIos() ? 'On iPhone: open this site in Safari, tap Share → "Add to Home Screen", open the app from the home screen, then turn notifications on here.' : "This browser can't show notifications. Use Chrome on Android, or install the app."}</p>
        ) : isIos() && !standalone() ? (
          <p className="text-ink-2">On iPhone notifications only work in the installed app: Share → "Add to Home Screen", open it from there, then come back here.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {on ? (
              <>
                <span className="font-medium text-up">● On for this device</span>
                <button type="button" disabled={busy} onClick={() => void test()} className="rounded-lg px-3 py-2 text-sm text-accent hover:bg-surface-2">Send a test</button>
                <button type="button" disabled={busy} onClick={() => void disable()} className="rounded-lg px-3 py-2 text-sm text-ink-2 hover:bg-surface-2">Turn off</button>
              </>
            ) : (
              <button type="button" disabled={busy || !data} onClick={() => void enable()} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Turning on…' : 'Turn on notifications'}
              </button>
            )}
            {data && <span className="text-xs text-muted">{data.subscribers} device{data.subscribers === 1 ? '' : 's'} subscribed</span>}
          </div>
        )}
        {s && (
          <div className="space-y-2 border-t border-line pt-3">
            <Toggle label="A trade closes in profit (with the amount)" checked={s.profitClose} onChange={(v) => void setSetting({ profitClose: v })} />
            <Toggle label="A take-profit is sold while the trade keeps running" checked={s.takeProfit} onChange={(v) => void setSetting({ takeProfit: v })} />
            <Toggle label="A trade closes at a loss" checked={s.lossClose} onChange={(v) => void setSetting({ lossClose: v })} />
            <label className="flex items-center justify-between gap-3 text-ink-2">
              <span>Only profits of at least</span>
              <span className="flex items-center gap-1">
                <input type="number" min={0} step="0.01" inputMode="decimal" defaultValue={s.minProfitSol} onBlur={(e) => void setSetting({ minProfitSol: Number(e.target.value) || 0 })} className="w-20 rounded-lg border border-line bg-page px-2 py-1.5 text-right text-ink tabular" />
                <span>SOL</span>
              </span>
            </label>
          </div>
        )}
        {msg && <p className={msg.ok ? 'text-up' : 'text-down'}>{msg.text}</p>}
      </div>
    </Card>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-ink-2">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
    </label>
  );
}
