// ChadGPT service worker — cache the shell so the app opens instantly even
// on a flaky connection. We never cache /api responses: those must stay live.

const CACHE = 'chadgpt-shell-v2';
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache the API — every chat / usage / admin call must be live.
  if (url.pathname.startsWith('/api/')) return;
  // Only handle same-origin GETs.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      // Stale-while-revalidate for shell assets.
      const live = fetch(req)
        .then((res) => {
          // Only cache successful opaque/basic responses with status 200.
          if (res && res.status === 200 && res.type !== 'opaqueredirect') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});
