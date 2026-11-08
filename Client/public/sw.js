/*
 * AIDis service worker (0.5.9, web only): makes the web client an installable app and starts it
 * fast, also on a flaky network. Deliberately small:
 *
 *  - pages (navigations): network first, the last good index.html when offline, so a new
 *    deployment is always picked up and the app still opens (and then shows "connecting");
 *  - /assets/* (hashed Vite files, never change) and /cosmetics/*: cache first;
 *  - everything else (API, Socket.IO, LiveKit, uploads, images through the API) is NOT touched.
 *
 * Old caches are dropped when a new version activates.
 */
const VERSION = 'aidis-sw-1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS]);
      for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL);
            await cache.put('/index.html', response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match('/index.html');
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/cosmetics/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // Same origin only (checked above), so an ok response is our own file.
        if (response.ok) {
          const cache = await caches.open(ASSETS);
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
