/*
 * Service worker: makes the dashboard installable and lets the app shell open
 * offline. Only the dashboard's own files are cached — bot data (the API on
 * your VPS) is always fetched live and never stored on the phone.
 */
const CACHE = 'solbot-shell-__BUILD_ID__';

const CACHE_VERSION_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png'];

/** Cache the shell plus every script/stylesheet index.html references (their names are hashed per build). */
async function precache() {
  const c = await caches.open(CACHE);
  await c.addAll(CACHE_VERSION_FILES);
  const html = await (await fetch('./index.html', { cache: 'no-store' })).text();
  const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await c.addAll(assets);
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch API calls or anything on another origin.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The version check must always ask GitHub Pages (and never fill the cache with ?t= copies).
  if (url.pathname.endsWith('/version.json')) return;

  // Pages: network first (always get the latest version), cached copy when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreVary: true })),
    );
    return;
  }

  // Built assets have hashed names, so cache-first is safe.
  e.respondWith(
    // ignoreVary: module scripts send an Origin header the precache request didn't.
    caches.match(e.request, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});

// Phone notifications from the bot (e.g. "💰 $COIN closed +0.120 SOL").
self.addEventListener('push', (e) => {
  let m = { title: 'Solbot', body: '', url: '/', tag: undefined };
  try {
    m = { ...m, ...e.data.json() };
  } catch {
    if (e.data) m.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(m.title, { body: m.body, tag: m.tag, renotify: !!m.tag, icon: './icon-192.png', badge: './icon-192.png', data: { url: m.url } }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(`./#${(e.notification.data && e.notification.data.url) || '/'}`, self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(target).catch(() => undefined);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
