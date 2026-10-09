/**
 * API client. The API address and login token live in localStorage so the
 * same build works locally and against the VPS.
 */
const KEY_URL = 'solbot.apiUrl';
const KEY_TOKEN = 'solbot.token';

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getApiUrl(): string {
  return (store()?.getItem(KEY_URL) || import.meta.env.VITE_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
}
export function setApiUrl(url: string): void {
  store()?.setItem(KEY_URL, url.trim().replace(/\/+$/, ''));
}
export function getToken(): string | null {
  return store()?.getItem(KEY_TOKEN) ?? null;
}
export function setToken(t: string | null): void {
  if (t) store()?.setItem(KEY_TOKEN, t);
  else store()?.removeItem(KEY_TOKEN);
  window.dispatchEvent(new Event('solbot-auth'));
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError(`Can't reach the bot at ${getApiUrl()}`, 0);
  }
  if (res.status === 401 && path !== '/api/auth/login') setToken(null);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export async function login(password: string): Promise<void> {
  const { token } = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
  setToken(token);
}
