import { useState, type FormEvent } from 'react';
import { Brand } from '../components/Brand';
import { InstallButton } from '../components/InstallButton';
import { Button, inputCls } from '../components/ui';
import { getApiUrl, login, setApiUrl } from '../lib/api';

export function Login() {
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(getApiUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setApiUrl(url);
    try {
      await login(password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="hero-glow flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card pop w-full max-w-sm p-6 sm:p-7">
        <Brand />
        <p className="mb-6 mt-3 text-sm text-ink-2">Log in to see your bot.</p>

        <label htmlFor="pw" className="mb-1 block text-xs font-medium text-muted">
          Password
        </label>
        <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputCls} mb-4 w-full`} />

        <details className="mb-5">
          <summary className="cursor-pointer text-sm text-ink-2 hover:text-ink">Bot address</summary>
          <label htmlFor="url" className="mb-1 mt-3 block text-xs font-medium text-muted">
            API URL (e.g. https://209-250-254-34.sslip.io)
          </label>
          <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={`${inputCls} w-full`} />
        </details>

        {error && (
          <p role="alert" className="mb-4 rounded-xl border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={busy} className="w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
        <div className="mt-4 flex justify-center">
          <InstallButton compact />
        </div>
      </form>
    </main>
  );
}
