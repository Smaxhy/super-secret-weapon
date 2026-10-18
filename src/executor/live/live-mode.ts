/**
 * Which executor runs, decided once at startup. LIVE only when ALL of: TRADING_MODE=LIVE in the VPS .env, a wallet key
 * there, a sender that can send, the owner's typed confirmation on Controls (BotConfig `_live`), and a wallet balance
 * ≥ live.minBalanceSol. Anything missing → PAPER (with the reasons logged and shown on Controls). Switching mode is a
 * restart: the Controls card saves `_live` and the process exits; Docker starts it again.
 */
import { prisma } from '../../lib/prisma';

export const LIVE_KEY = '_live';

export interface LiveSettings { enabledAt: string | null; by?: string }

export async function loadLiveSettings(): Promise<LiveSettings> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: LIVE_KEY } });
    const v = (row?.value ?? {}) as { enabledAt?: unknown };
    return { enabledAt: typeof v.enabledAt === 'string' ? v.enabledAt : null };
  } catch {
    return { enabledAt: null };
  }
}

export async function enableLive(): Promise<void> {
  const value = { enabledAt: new Date().toISOString(), by: 'owner' };
  await prisma.botConfig.upsert({ where: { key: LIVE_KEY }, update: { value }, create: { key: LIVE_KEY, value } });
}

export async function disableLive(): Promise<void> {
  await prisma.botConfig.deleteMany({ where: { key: LIVE_KEY } });
}

/** What the dashboard + Bot health show about the live path (set at startup in index.ts). */
export interface LiveStatus {
  activeMode: 'PAPER' | 'LIVE';
  envMode: 'PAPER' | 'LIVE';
  wallet: string | null;
  walletError: string | null;
  sender: string;
  senderReady: boolean;
  enabledAt: string | null;
  blockers: string[];
}

let status: LiveStatus | null = null;
export function setLiveStatus(s: LiveStatus): void {
  status = s;
}
export function liveStatus(): LiveStatus | null {
  return status;
}
