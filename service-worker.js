// MattMusic service worker — caches the app shell so it launches offline.
// Your mp3 files themselves live in IndexedDB (see db.js), not the cache.

const CACHE_NAME = 'mattmusic-shell-v16';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app code (html/js/css/manifest) so updates show up on
// the very next launch; the cache is only the offline fallback. Big static
// assets (rain.mp3, icons) stay cache-first so they aren't re-downloaded.
// Cross-origin requests (e.g. searching/downloading from archive.org) are
// left alone entirely so the service worker never interferes with them.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const isStatic = /\/(rain\.mp3|icons\/[^/]+)$/.test(new URL(event.request.url).pathname);

  const fromNetwork = () =>
    fetch(event.request, { cache: 'no-cache' }).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    });

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fromNetwork())
    );
  } else {
    event.respondWith(
      fromNetwork().catch(() => caches.match(event.request))
    );
  }
});
