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
    window.addEventListener('load', async () => {
      const reg = await navigator.serviceWorker.register('./sw.js').catch(() => undefined);
      // Check GitHub Pages for a new dashboard version every 10 minutes and when reopened.
      const check = () => void reg?.update().catch(() => undefined);
      setInterval(check, 10 * 60_000);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    });
    // A new version took over → reload once so the user sees it.
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
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
