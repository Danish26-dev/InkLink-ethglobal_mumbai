/* Inklink service worker (served at /sw.js, scope /).
 * Caches the PWA's static shell only. Never caches /api: job state, documents,
 * quotes and the event stream must always come from the backend. The landing
 * page at / is passed through untouched. */
const CACHE = 'inklink-shell-v2';
const SHELL = ['/pwa/', '/pwa/icon.svg', '/pwa/manifest.webmanifest'];
const PWA_ROUTE = /^\/(app|shop|demo|portal|jury)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return; // network only, never cached

  // PWA navigations: network first, cached shell when offline.
  if (req.mode === 'navigate') {
    if (PWA_ROUTE.test(url.pathname)) event.respondWith(fetch(req).catch(() => caches.match('/pwa/')));
    return;
  }
  // PWA static assets (hashed by Vite): cache first.
  if (url.pathname.startsWith('/pwa/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
