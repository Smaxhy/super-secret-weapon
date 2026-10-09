/**
 * Web-app install support.
 * - Registers the service worker (production builds only).
 * - Captures Android/Chrome's install prompt so we can show our own button.
 * - Detects iPhone, where installing is manual (Share → Add to Home Screen).
 */
import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const subs = new Set<() => void>();

export function registerPwa(): void {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    subs.forEach((s) => s());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    subs.forEach((s) => s());
  });
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function useInstall(): { canPrompt: boolean; install: () => Promise<void>; showIosHint: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    subs.add(s);
    return () => void subs.delete(s);
  }, []);
  return {
    canPrompt: !!deferred && !isStandalone(),
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      subs.forEach((s) => s());
    },
    showIosHint: isIos() && !isStandalone(),
  };
}
