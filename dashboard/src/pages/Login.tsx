import { useState, type FormEvent } from 'react';
import { InstallButton } from '../components/InstallButton';
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
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-ink">Solbot</h1>
        <p className="mb-6 mt-1 text-ink-2">Log in to see your bot.</p>

        <label htmlFor="pw" className="mb-1 block text-sm font-medium text-ink">
          Password
        </label>
        <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mb-4 w-full rounded-lg border border-line bg-page px-3 py-2.5 text-ink" />

        <details className="mb-5">
          <summary className="cursor-pointer text-sm text-ink-2">Bot address</summary>
          <label htmlFor="url" className="mb-1 mt-3 block text-sm text-ink-2">
            API URL (e.g. https://209-250-254-34.sslip.io)
          </label>
          <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink" />
        </details>

        {error && (
          <p role="alert" className="mb-4 text-sm text-down">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full rounded-lg bg-accent py-2.5 font-semibold text-white disabled:opacity-60">
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <div className="mt-4 flex justify-center">
          <InstallButton compact />
        </div>
      </form>
    </main>
  );
}
